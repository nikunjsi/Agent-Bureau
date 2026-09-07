import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { PolicyHoldRegistry } from '../controlChannel/policyHoldRegistry';
import { nowIso } from '../../shared/models/ids';
import { getCheckpointById, recordCheckpointAnswer } from '../db/repositories/checkpoints';
import { insertOutboxMessage } from '../db/repositories/messages';
import { unblockTaskForCheckpoint } from './taskBlocking';
import { appendDecisionLog } from './decisionLog';
import type {
  Checkpoint,
  CheckpointAnswer,
  CheckpointOption,
} from '../../shared/models/checkpoint';

/**
 * §9.6 — answering. The single place a checkpoint stops being pending.
 *
 * §9.6 names five things, and CLAUDE.md invariant #3 fixes their order
 * ("every state change is committed before the side effect"):
 *
 *   1. write the answer          — committed first, as a CAS
 *   2. emit `checkpoint.answered`
 *   3. unblock the dependent task
 *   4. get the decision to the employee's next turn
 *   5. write it to project memory when it has lasting relevance
 *
 * Two entry points share one private `recordAndEmit`, so the row write and
 * its event exist in exactly one place regardless of who resolved it: the
 * user through IPC, or a timeout applying the default.
 *
 * ## Delivery goes through the outbox, not through a live Supervisor
 *
 * The obvious implementation of step 4 is
 * `supervisorRegistry.get(id)?.send(...)` — and it is wrong in a way that
 * only shows up for the case that matters. §9.7 is explicit: a message to
 * an `off` employee is **held, not dropped**, and delivered when that
 * employee next starts. A direct call silently discards the answer to a
 * question that was raised precisely because it needed one, whenever the
 * employee happens to be off — which, for a `soon` or `whenever`
 * checkpoint answered hours later, is the normal case, not the edge one.
 *
 * So the durable `messages` outbox is the only delivery path, and §9.7's
 * own diagram says why that is not a compromise: "SQLite is the source of
 * truth, the signal is only a latency optimisation." Adding a
 * direct-injection fast path *as well* would put "has this been delivered"
 * in two places one milestone after standing rule 6 was earned.
 *
 * **The honest cost, stated rather than buried:** M8 session 1 writes the
 * row and nothing delivers it. The router is session 2 (§9.7). Until then
 * an answered decision reaches the employee late rather than never — the
 * row survives restarts, keeps its `pending` status, and the router picks
 * it up with no migration and no rework.
 *
 * ## `user.checkpoint_answered` is deliberately not emitted
 *
 * §5.2 lists both `checkpoint.answered` and `user.checkpoint_answered`.
 * Answering is ONE state change, and invariant #3 allows it exactly one
 * event. `checkpoint.answered` with `actor: 'user'` carries everything the
 * second type would have; emitting both would break the invariant to
 * satisfy a taxonomy. Flagged in PROGRESS.md rather than silently decided.
 */

export interface AnswerDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  /** Electron's `userData` root — where the decision log's markdown lives. */
  readonly baseDir: string;
}

export type AnswerSource = 'user' | 'timeout';

export interface AnswerCheckpointInput {
  readonly checkpointId: string;
  readonly optionId?: string | undefined;
  readonly freeText?: string | undefined;
  readonly source: AnswerSource;
}

export type AnswerCheckpointResult =
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_pending' | 'unknown_option' | 'no_answer_given';
    }
  | {
      readonly ok: true;
      readonly checkpoint: Checkpoint;
      readonly status: 'answered' | 'auto_resolved';
      /** Null when nothing was blocked on this checkpoint. */
      readonly unblockedTaskId: string | null;
      /** Null when the checkpoint has no employee to address (a budget or
       * merge-conflict checkpoint genuinely has none). */
      readonly queuedMessageId: string | null;
      /** The `project/decisions.md` path, when §12.5 applied. */
      readonly decisionLogPath: string | null;
    };

export function answerCheckpoint(
  deps: AnswerDeps,
  input: AnswerCheckpointInput,
): AnswerCheckpointResult {
  const checkpoint = getCheckpointById(deps.db, input.checkpointId);
  if (checkpoint === null) return { ok: false, reason: 'not_found' };
  if (checkpoint.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const options = checkpoint.options ?? [];
  const chosen: CheckpointOption | null =
    input.optionId === undefined
      ? null
      : (options.find((option) => option.id === input.optionId) ?? null);

  if (input.optionId !== undefined && chosen === null) {
    return { ok: false, reason: 'unknown_option' };
  }
  // §9.2: "Free text is always accepted alongside the options" — alongside,
  // and also instead of. But an answer that is neither is not an answer,
  // and recording it would leave the checkpoint resolved with nothing in
  // it for anyone to act on. `information` checkpoints have no options at
  // all and are answered purely in free text, which this allows.
  const freeText = input.freeText?.trim() ?? '';
  if (chosen === null && freeText.length === 0) {
    return { ok: false, reason: 'no_answer_given' };
  }

  const status = input.source === 'timeout' ? 'auto_resolved' : 'answered';
  const answeredAt = nowIso();
  const answer: CheckpointAnswer = {
    ...(chosen === null ? {} : { optionId: chosen.id }),
    ...(freeText.length === 0 ? {} : { freeText }),
  };

  // ---- 1. the state change, as a CAS -------------------------------
  const won = recordCheckpointAnswer(deps.db, checkpoint.id, {
    status,
    answer,
    answeredBy: input.source === 'timeout' ? 'system:timeout' : 'user',
    answeredAt,
  });
  // Lost the race against the other resolver. Nothing below may run — the
  // winner already ran all of it, and repeating it would double the event,
  // the outbox row and the decision-log entry.
  if (!won) return { ok: false, reason: 'not_pending' };

  // ---- 2. exactly one event ----------------------------------------
  deps.activityLog.logEvent({
    actor: input.source === 'timeout' ? 'system' : 'user',
    type: input.source === 'timeout' ? 'checkpoint.auto_resolved' : 'checkpoint.answered',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: {
      type: checkpoint.type,
      optionId: chosen?.id ?? null,
      hasFreeText: freeText.length > 0,
      ...(input.source === 'timeout' ? { appliedDefault: checkpoint.default_action } : {}),
    },
  });

  // ---- 3. unblock the dependent task -------------------------------
  let unblockedTaskId: string | null = null;
  if (checkpoint.task_id !== null) {
    const unblocked = unblockTaskForCheckpoint(deps.db, deps.activityLog, {
      taskId: checkpoint.task_id,
      checkpointId: checkpoint.id,
    });
    if (unblocked) unblockedTaskId = checkpoint.task_id;
  }

  // ---- 4. queue the decision for the employee's next turn ----------
  const queuedMessageId = queueDecisionForEmployee(
    deps,
    checkpoint,
    chosen,
    freeText,
    input.source,
  );

  // ---- 5. project memory, when the decision lasts ------------------
  let decisionLogPath: string | null = null;
  if (checkpoint.type === 'decision' && checkpoint.project_id !== null) {
    decisionLogPath = appendDecisionLog(deps.db, {
      baseDir: deps.baseDir,
      projectId: checkpoint.project_id,
      checkpoint,
      chosenOption: chosen,
      freeText: freeText.length === 0 ? null : freeText,
      byTimeout: input.source === 'timeout',
      answeredAtIso: answeredAt,
    }).absolutePath;
  }

  return {
    ok: true,
    checkpoint: getCheckpointById(deps.db, checkpoint.id) as Checkpoint,
    status,
    unblockedTaskId,
    queuedMessageId,
    decisionLogPath,
  };
}

/**
 * §9.7's outbox write. `idempotency_key` is derived from the checkpoint id
 * rather than minted fresh — the column is UNIQUE, and the derived key is
 * the second line of defence that makes a redelivered or replayed answer
 * collide instead of producing two messages saying the same thing (the
 * same reasoning `sendMessage`'s own handler follows).
 */
function queueDecisionForEmployee(
  deps: AnswerDeps,
  checkpoint: Checkpoint,
  chosen: CheckpointOption | null,
  freeText: string,
  source: AnswerSource,
): string | null {
  // No addressee. A budget, quota or merge-conflict checkpoint genuinely
  // has no employee behind it; the Director is not an addressable target
  // until M11. Reported in the result rather than silently skipped.
  if (checkpoint.employee_id === null) return null;

  const lines = [`Your checkpoint "${checkpoint.title}" has been answered.`];
  if (chosen !== null) {
    lines.push(`Decision: ${chosen.label}`);
    lines.push(`What this means: ${chosen.consequence}`);
  }
  if (freeText.length > 0) lines.push(`They also said: ${freeText}`);
  if (source === 'timeout') {
    lines.push('(Nobody answered in time, so the safe default was applied.)');
  }
  lines.push('Continue from here.');

  const message = insertOutboxMessage(deps.db, {
    idempotency_key: `checkpoint-answer:${checkpoint.id}`,
    from_addr: 'user',
    to_addr: `employee:${checkpoint.employee_id}`,
    resolved_employee_id: checkpoint.employee_id,
    task_id: checkpoint.task_id,
    thread_id: checkpoint.id,
    kind: 'answer',
    // Above the default 50: an answer someone is blocked on outranks
    // ordinary handoffs in the router's `ORDER BY priority DESC`.
    priority: 80,
    subject: checkpoint.title,
    body: lines.join('\n'),
    status: 'pending',
    next_attempt_at: nowIso(),
  });

  deps.activityLog.logEvent({
    actor: 'system',
    type: 'message.sent',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: { messageId: message.id, kind: 'answer', to: message.to_addr },
  });

  return message.id;
}

// ---- permission ----------------------------------------------------

export interface AnswerPermissionDeps extends AnswerDeps {
  readonly policyHoldRegistry: PolicyHoldRegistry;
}

export type AnswerPermissionResult =
  | { readonly ok: false; readonly reason: 'not_found' | 'not_permission' | 'not_pending' }
  | {
      readonly ok: true;
      readonly allowed: boolean;
      /** False when no hold was still open — the agent gave up, died, or
       * the hold already timed out to deny. The answer is still recorded;
       * the user is told it arrived too late. */
      readonly holdReleased: boolean;
    };

/**
 * §9.1's `permission` answer — "answered with a single keypress".
 *
 * Shares steps 1 and 2 with `answerCheckpoint` and does none of 3–5, for
 * reasons rather than by omission: no task is blocked (the *agent* is held
 * inside a live HTTP request, not the task row); no outbox message is
 * needed because the HTTP response IS the delivery; and a one-off
 * allow/deny of a single tool call is not a durable project fact, so
 * §12.5 does not apply.
 *
 * The hold is M4's `PolicyHoldRegistry`, used unchanged. Its own doc
 * comment predicted this exact caller — "what a real checkpoint-answer
 * flow (M8) will call" — and **no second holding mechanism is built.**
 */
export function answerPermissionCheckpoint(
  deps: AnswerPermissionDeps,
  input: { readonly checkpointId: string; readonly allow: boolean },
): AnswerPermissionResult {
  const checkpoint = getCheckpointById(deps.db, input.checkpointId);
  if (checkpoint === null) return { ok: false, reason: 'not_found' };
  if (checkpoint.type !== 'permission') return { ok: false, reason: 'not_permission' };
  if (checkpoint.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const optionId = input.allow ? 'allow_once' : 'deny';
  const won = recordCheckpointAnswer(deps.db, checkpoint.id, {
    status: 'answered',
    answer: { optionId },
    answeredBy: 'user',
  });
  if (!won) return { ok: false, reason: 'not_pending' };

  deps.activityLog.logEvent({
    actor: 'user',
    type: 'checkpoint.answered',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: { type: 'permission', optionId, tool: checkpoint.tool_name },
  });

  // The state change is committed above, before this side effect — the
  // ordering invariant #3 requires. `tool_call_id` is the hold's own key
  // (`callId`), which is why §9.1 makes it a required column and why the
  // schema now refuses a permission checkpoint without one.
  const holdReleased =
    checkpoint.tool_call_id !== null &&
    deps.policyHoldRegistry.resolve(checkpoint.tool_call_id, input.allow ? 'allow' : 'deny');

  return { ok: true, allowed: input.allow, holdReleased };
}
