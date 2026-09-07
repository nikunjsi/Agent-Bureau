import type Database from 'better-sqlite3';
import type { ActivityLog } from '../activityLog';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  CheckpointSchema,
  NewCheckpointInputSchema,
  type Checkpoint,
  type CheckpointAnswer,
  type NewCheckpointInput,
} from '../../../shared/models/checkpoint';
import {
  computeExpiresAt,
  loadCheckpointTimeoutSettings,
  type CheckpointTimeoutSettings,
} from '../../checkpoints/expiry';

/**
 * **The one door.** Every checkpoint in the system is created here, and
 * this function does four things no creation path can opt out of:
 *
 *   1. **Validates** against §9.2's anatomy rules (`NewCheckpointInputSchema`).
 *      Standing rule 2 — "a guard is not a guard until something on the
 *      real path calls it" — is satisfied structurally rather than by
 *      hoping five callers remember: there is no other way to insert a
 *      row, so there is no path that skips the check.
 *   2. **Derives `expires_at`** (§9.5) through `computeExpiresAt`, the sole
 *      place any checkpoint deadline is decided. `expires_at` is no longer
 *      part of the input shape at all.
 *   3. **Inserts** the row.
 *   4. **Emits `checkpoint.raised`.**
 *
 * ## Why the event moved in here (AUDIT finding #23)
 *
 * The audit found that rows created by the budget and breaker paths emit a
 * differently-typed triggering-condition event (`employee.budget_exceeded`
 * and friends) but never a `checkpoint.raised`-shaped one — only
 * `raiseCheckpoint.ts` did that, in its own handler. A consumer filtering
 * on `checkpoint.raised` therefore missed four of the five creation paths.
 * The suggested fix offered two options ("emit uniformly, or centralize it
 * inside `insertCheckpoint`"); the second is taken, because the first is
 * four more call sites a sixth path can forget to copy. `activityLog` is a
 * **required** parameter for exactly that reason — an optional one would
 * restore the ability to create a row silently.
 *
 * ## The one parameter that is an escape hatch, and its single caller
 *
 * `timeoutSettings` exists for the permission path alone.
 * `ControlChannelServer` is the authority on how long an agent is held
 * (§7.10), and its hold duration is injectable so tests do not wait real
 * minutes. The permission checkpoint's `expires_at` and that hold must be
 * the SAME number — two that merely agree today is the shape of the bug
 * standing rule 6 was earned by — so the server resolves it once and
 * passes it here. Every other caller omits this and gets the settings
 * registry, which is why it is typed as the whole settings struct rather
 * than a loose `minutes` number that would invite general use.
 */
export function insertCheckpoint(
  db: Database.Database,
  activityLog: ActivityLog,
  input: NewCheckpointInput,
  timeoutSettings?: CheckpointTimeoutSettings,
): Checkpoint {
  const parsed = NewCheckpointInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  const expiresAt = computeExpiresAt(
    parsed,
    timeoutSettings ?? loadCheckpointTimeoutSettings(db),
    Date.parse(now),
  );

  db.prepare(
    `INSERT INTO checkpoints (
       id, project_id, task_id, employee_id, type, urgency, tool_call_id, tool_name, args_preview,
       title, context, options, preview, default_action, status, answer, answered_by,
       expires_at, answered_at, created_at, updated_at
     ) VALUES (
       @id, @project_id, @task_id, @employee_id, @type, @urgency, @tool_call_id, @tool_name, @args_preview,
       @title, @context, @options, @preview, @default_action, @status, NULL, NULL,
       @expires_at, NULL, @created_at, @updated_at
     )`,
  ).run({
    id,
    project_id: parsed.project_id,
    task_id: parsed.task_id,
    employee_id: parsed.employee_id,
    type: parsed.type,
    urgency: parsed.urgency,
    tool_call_id: parsed.tool_call_id,
    tool_name: parsed.tool_name,
    args_preview: parsed.args_preview,
    title: parsed.title,
    context: parsed.context,
    options: parsed.options === null ? null : toJsonColumn(parsed.options),
    preview: parsed.preview === null ? null : toJsonColumn(parsed.preview),
    default_action: parsed.default_action,
    status: parsed.status,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  });

  const checkpoint = getCheckpointById(db, id) as Checkpoint;

  activityLog.logEvent({
    // The raiser, where there is one. A budget or merge-conflict
    // checkpoint genuinely has no employee behind it, and `employee:null`
    // would be worse than `system`.
    actor: parsed.employee_id === null ? 'system' : `employee:${parsed.employee_id}`,
    type: 'checkpoint.raised',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: {
      type: checkpoint.type,
      urgency: checkpoint.urgency,
      title: checkpoint.title,
      expiresAt: checkpoint.expires_at,
    },
  });

  return checkpoint;
}

export function getCheckpointById(db: Database.Database, id: string): Checkpoint | null {
  const row = db.prepare('SELECT * FROM checkpoints WHERE id = ?').get(id);
  return row ? CheckpointSchema.parse(row) : null;
}

export function listPendingCheckpoints(db: Database.Database): Checkpoint[] {
  const rows = db
    .prepare("SELECT * FROM checkpoints WHERE status = 'pending' ORDER BY created_at")
    .all();
  return rows.map((row) => CheckpointSchema.parse(row));
}

/**
 * The timeout sweep's own query (§9.5), served by `idx_checkpoints_expiry`.
 *
 * `permission` is excluded here rather than at the caller, because this is
 * where the reason belongs: a permission checkpoint's deadline is owned by
 * the live in-memory hold (`PolicyHoldRegistry`, M4), which already denies
 * on expiry and is already tested. A second timer sweeping the same row on
 * a second clock is two places deciding one deadline. A permission row
 * that survives a restart has no hold and no waiting agent at all, and is
 * cancelled by `reconcile()` instead.
 */
export function listExpiredPendingCheckpoints(
  db: Database.Database,
  nowIsoTs: string,
): Checkpoint[] {
  const rows = db
    .prepare(
      `SELECT * FROM checkpoints
        WHERE status = 'pending'
          AND type != 'permission'
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY expires_at`,
    )
    .all(nowIsoTs);
  return rows.map((row) => CheckpointSchema.parse(row));
}

/** Permission rows still `pending` from a previous run — see `reconcile()`. */
export function listPendingPermissionCheckpoints(db: Database.Database): Checkpoint[] {
  const rows = db
    .prepare(
      "SELECT * FROM checkpoints WHERE status = 'pending' AND type = 'permission' ORDER BY created_at",
    )
    .all();
  return rows.map((row) => CheckpointSchema.parse(row));
}

/**
 * §9.6's write, as a **compare-and-swap on `status = 'pending'`** — the
 * same shape as `integrationMerge`'s ref CAS, and for the same reason.
 *
 * Two real resolvers can reach one row: the user answering through IPC,
 * and the timeout tick (or a hold expiring) applying the default. Without
 * the guard, whichever lands second overwrites the first — and the bad
 * ordering is the plausible one: a timeout default silently replacing a
 * real answer the user just gave.
 *
 * Returns `false` when it changed nothing. **Every caller must branch on
 * that.** Nothing downstream — no event, no unblock, no outbox row, no
 * decision-log entry — may run on a losing write, or one answer produces
 * two of each.
 */
export function recordCheckpointAnswer(
  db: Database.Database,
  checkpointId: string,
  input: {
    readonly status: 'answered' | 'auto_resolved';
    readonly answer: CheckpointAnswer;
    readonly answeredBy: string;
    readonly answeredAt?: string;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE checkpoints
          SET status = @status, answer = @answer, answered_by = @answeredBy, answered_at = @answeredAt
        WHERE id = @id AND status = 'pending'`,
    )
    .run({
      id: checkpointId,
      status: input.status,
      answer: toJsonColumn(input.answer),
      answeredBy: input.answeredBy,
      answeredAt: input.answeredAt ?? nowIso(),
    });
  return result.changes === 1;
}

/**
 * Same CAS discipline. Used by `reconcile()` for permission rows whose
 * hold died with the previous process — a real state change, so the caller
 * emits `checkpoint.cancelled` for each one that actually changed.
 */
export function cancelCheckpoint(
  db: Database.Database,
  checkpointId: string,
  reason: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE checkpoints
          SET status = 'cancelled', answered_by = @reason, answered_at = @at
        WHERE id = @id AND status = 'pending'`,
    )
    .run({ id: checkpointId, reason, at: nowIso() });
  return result.changes === 1;
}
