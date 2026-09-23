import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ActivityLog } from './activityLog';
import { getMaxMirrorSeq, insertMirrorRow, readActivityLogTail } from './activityLog';
import { getProcessStartTime, killProcess } from '../process/processInfo';
import { listEmployeesWithPid } from './repositories/employees';
import { reclaimExpiredLeases as reclaimExpiredLeasesRepo } from './repositories/worktrees';
import { blockAllRunningTasks } from './repositories/tasks';
import { abortStaleStreamingMessages as abortStaleStreamingMessagesRepo } from './repositories/conversationMessages';
import { setEmployeeLifetimeSpend, setProjectSpend, setTaskSpend } from './repositories/usage';
import { reconcileAllProjectsWorktrees } from '../workspace/reconcileGit';
import { promoteResumableParkedEmployees } from '../engine/parkedEmployeeResumeTick';
import { cancelCheckpoint, listPendingPermissionCheckpoints } from './repositories/checkpoints';
import { noopSecretBroker, type SecretBroker } from '../../shared/engine/seams';

export interface ReconcileReport {
  readonly orphansKilled: readonly string[];
  readonly mirrorRepaired: number;
  readonly leasesReclaimed: number;
  readonly tasksBlocked: readonly string[];
  readonly streamingMessagesAborted: number;
  readonly staleControlJsonDeleted: readonly string[];
  readonly worktreeOrphansRemoved: readonly string[];
  readonly worktreePhantomsDeleted: readonly string[];
  readonly pendingCommitsResolved: number;
  readonly usageCountersDrifted: number;
  readonly parkedEmployeesResumed: readonly string[];
  readonly stalePermissionCheckpointsCancelled: readonly string[];
}

/**
 * The four behaviors §28 M1 step 7 names, plus one more §5.1 requires
 * explicitly ("Streaming (MUST) ... On reconcile, any row still
 * `streaming` from before the app started becomes `aborted`" — found
 * while wiring the conversation_messages repository, not in the original
 * plan), plus M4's own stale-`control.json` sweep (§7.10), and, per AUDIT
 * finding #2, an activity event for every state change made along the way
 * (§21 invariant 3, §5.2's taxonomy) plus one `app.reconciled` summary
 * event at the end. Run on startup before the UI is interactive (§4.4).
 * Each behavior is independently testable; this function just sequences
 * them.
 *
 * `broker` (M6 session 3, §11.4 — optional, defaulting to the harmless
 * `noopSecretBroker` so every existing test call site keeps working
 * unchanged): the orphan sweep is one of the two real exit paths
 * `revokeForEmployee()` must fire on (`Supervisor.stop()`'s own clean-stop
 * path is the other) — an orphan killed here never went through a live
 * Supervisor's own `stop()` at all, so nothing else would ever call it
 * for this employee.
 */
export async function reconcile(
  db: Database.Database,
  activityLog: ActivityLog,
  baseDir: string,
  broker: SecretBroker = noopSecretBroker,
  /** The environment the orphan sweep's start-time read is spawned in
   *  (M11 S1-21). Injectable so a test can reproduce the shadowed-module
   *  failure against the real sweep. */
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReconcileReport> {
  const orphansKilled = sweepOrphans(db, activityLog, broker, env);
  const mirrorRepaired = repairMirror(db, activityLog);
  const leasesReclaimed = reclaimExpiredLeases(db, activityLog);
  const tasksBlocked = blockRunningTasks(db, activityLog);
  const streamingMessagesAborted = abortStaleStreamingMessages(db, activityLog);
  const staleControlJsonDeleted = sweepStaleControlJson(activityLog, baseDir);
  // §4.4/M5: after lease reclaim (Q7 — the orphan sweep above already
  // proved any live holder is dead before a lease is ever handed back),
  // make the worktrees table agree with the real repository on disk in
  // both directions, and run `git worktree prune`.
  const {
    orphansRemoved: worktreeOrphansRemoved,
    phantomsDeleted: worktreePhantomsDeleted,
    pendingCommitsResolved,
  } = await reconcileAllProjectsWorktrees(db, activityLog);
  // §28 M6 item 7: recompute the three denormalised spend counters from
  // the usage ledger, fix any drift, one event per drifted row.
  const usageCountersDrifted = reconcileUsageCounters(db, activityLog);
  // §24.3: "reconcile() re-arms this at startup: parked employees whose
  // resume_at already passed resume immediately." Same function the
  // periodic tick (parkedEmployeeResumeTick.ts) calls — one mechanism,
  // two callers.
  const parkedEmployeesResumed = promoteResumableParkedEmployees(db, activityLog);
  const stalePermissionCheckpointsCancelled = cancelStalePermissionCheckpoints(db, activityLog);

  activityLog.logEvent({
    actor: 'system',
    type: 'app.reconciled',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      orphansKilled: orphansKilled.length,
      mirrorRepaired,
      leasesReclaimed: leasesReclaimed.length,
      tasksBlocked: tasksBlocked.length,
      streamingMessagesAborted,
      staleControlJsonDeleted: staleControlJsonDeleted.length,
      worktreeOrphansRemoved: worktreeOrphansRemoved.length,
      worktreePhantomsDeleted: worktreePhantomsDeleted.length,
      pendingCommitsResolved,
      usageCountersDrifted,
      parkedEmployeesResumed: parkedEmployeesResumed.length,
      stalePermissionCheckpointsCancelled: stalePermissionCheckpointsCancelled.length,
    },
  });

  return {
    orphansKilled,
    mirrorRepaired,
    leasesReclaimed: leasesReclaimed.length,
    tasksBlocked,
    streamingMessagesAborted,
    staleControlJsonDeleted,
    worktreeOrphansRemoved,
    worktreePhantomsDeleted,
    pendingCommitsResolved,
    usageCountersDrifted,
    parkedEmployeesResumed,
    stalePermissionCheckpointsCancelled,
  };
}

/**
 * §9.1 — a `permission` checkpoint exists to release a HOLD: an agent
 * parked inside a live HTTP request, waiting for a verdict. That hold
 * lives in `PolicyHoldRegistry`, which is **in memory**. It does not
 * survive this process, and neither does the employee process that was
 * waiting on it.
 *
 * So a `permission` row still `pending` at startup is asking the user to
 * decide something that is already over. Answering it would release
 * nothing; leaving it pending would put a dead question in the
 * Checkpoints view for the rest of time. It is cancelled.
 *
 * **Deliberately NOT subject to the post-restart grace** (§9.6), and the
 * distinction is the reason the grace exists at all: the grace stops a
 * DECISION being applied on the user's behalf while they are not looking.
 * Nothing is being decided here. This is cleanup of a row whose subject —
 * a specific in-flight tool call in a process that no longer exists — is
 * provably gone. The two would be confused only by reading the grace as
 * "do not touch checkpoints for ten minutes" rather than what §9.6
 * actually says.
 */
function cancelStalePermissionCheckpoints(
  db: Database.Database,
  activityLog: ActivityLog,
): string[] {
  const stale = listPendingPermissionCheckpoints(db);
  const cancelled: string[] = [];
  for (const checkpoint of stale) {
    if (!cancelCheckpoint(db, checkpoint.id, 'system:app_restart')) continue;
    activityLog.logEvent({
      actor: 'system',
      type: 'checkpoint.cancelled',
      severity: 'info',
      project_id: checkpoint.project_id,
      task_id: checkpoint.task_id,
      employee_id: checkpoint.employee_id,
      checkpoint_id: checkpoint.id,
      payload: { reason: 'app_restart', tool: checkpoint.tool_name },
    });
    cancelled.push(checkpoint.id);
  }
  return cancelled;
}

/**
 * For every employee row with a recorded `pid`, check whether that PID is
 * alive **and** its start time matches `process_start_time` (PIDs are
 * reused). If so, kill it, emit `employee.orphan_killed` (§5.2), and
 * report it as an orphan — a `node-pty` process cannot be adopted across a
 * restart (the pty master handle is gone), so adoption is never attempted
 * (§4.4).
 */
function sweepOrphans(
  db: Database.Database,
  activityLog: ActivityLog,
  broker: SecretBroker,
  env: NodeJS.ProcessEnv,
): string[] {
  const rows = listEmployeesWithPid(db);

  const killed: string[] = [];
  for (const row of rows) {
    const read = getProcessStartTime(row.pid, env);

    // §4.4, M11 S1-21: a PID whose start time could not be READ is not a
    // dead PID. It is never killed — PIDs are reused, and the kill is
    // irreversible — and it is never passed over in silence either, which
    // is what the old `string | null` contract did: the sweep reported a
    // clean run while a live orphan kept going, kept its secrets, and had
    // no trail anywhere. S1-9's Job Object covers the common crash case,
    // so this is the second line of defence, and a second line that fails
    // quietly is worse than none.
    if (read.kind === 'unreadable') {
      activityLog.logEvent({
        actor: 'system',
        type: 'employee.orphan_unverified',
        severity: 'warn',
        project_id: null,
        task_id: null,
        employee_id: row.id,
        checkpoint_id: null,
        payload: { pid: row.pid, reason: read.reason },
      });
      continue;
    }

    const isSameProcessStillAlive =
      read.kind === 'alive' && read.startedAt === row.process_start_time;

    if (isSameProcessStillAlive) {
      killProcess(row.pid);
      killed.push(row.id);
      // §11.4: "revokeForEmployee() must be called on every stop path —
      // clean stop, fire, AND crash-reconcile." This IS the crash-
      // reconcile path — no live Supervisor exists for this employee to
      // have called it through its own stop().
      void broker.revokeForEmployee(row.id);
      activityLog.logEvent({
        actor: 'system',
        type: 'employee.orphan_killed',
        severity: 'warn',
        project_id: null,
        task_id: null,
        employee_id: row.id,
        checkpoint_id: null,
        payload: { pid: row.pid },
      });
    }
  }
  return killed;
}

/**
 * Replays `activity.jsonl`'s tail after the mirror's current `MAX(seq)`,
 * inserting whatever mirror rows are missing. This is what makes the
 * append-then-mirror ordering (§11.6) safe to interrupt: a crash between
 * the file write and the mirror insert leaves the mirror behind, and this
 * is the repair. Does not itself emit a new event — it is replaying
 * entries that already exist in the file, not creating new ones; the
 * repaired count is reported in the `app.reconciled` summary instead.
 */
function repairMirror(db: Database.Database, activityLog: ActivityLog): number {
  const maxSeq = getMaxMirrorSeq(db);
  const tail = readActivityLogTail(activityLog.filePath, maxSeq);
  const insertedAt = new Date().toISOString();
  for (const entry of tail) {
    insertMirrorRow(db, entry, insertedAt);
  }
  return tail.length;
}

/** Expired worktree leases released, one `git.lease_reclaimed` (§5.2) per
 * worktree. (`git worktree prune` — the filesystem-level half of full
 * lease release — is M5's job once real git integration exists; this is
 * the DB-level half only.) */
function reclaimExpiredLeases(
  db: Database.Database,
  activityLog: ActivityLog,
): ReturnType<typeof reclaimExpiredLeasesRepo> {
  const reclaimed = reclaimExpiredLeasesRepo(db);
  for (const lease of reclaimed) {
    activityLog.logEvent({
      actor: 'system',
      type: 'git.lease_reclaimed',
      severity: 'info',
      project_id: lease.projectId,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { worktree_id: lease.worktreeId },
    });
  }
  return reclaimed;
}

/** A task still `running` when the app starts crashed mid-flight — there is
 * no supervisor to resume it into (that's M3+), so it goes to `blocked`
 * with reason `app_restart` (§4.4), one `task.blocked` (§5.2) per task. */
function blockRunningTasks(db: Database.Database, activityLog: ActivityLog): string[] {
  const blocked = blockAllRunningTasks(db);
  for (const task of blocked) {
    activityLog.logEvent({
      actor: 'system',
      type: 'task.blocked',
      severity: 'warn',
      project_id: task.projectId,
      task_id: task.taskId,
      employee_id: null,
      checkpoint_id: null,
      payload: { reason: 'app_restart' },
    });
  }
  return blocked.map((task) => task.taskId);
}

/** §5.1 "Streaming (MUST)": on reconcile, any row still `streaming` from
 * before the app started becomes `aborted`, one `chat.stream_aborted`
 * (§5.2) per message. */
function abortStaleStreamingMessages(db: Database.Database, activityLog: ActivityLog): number {
  const aborted = abortStaleStreamingMessagesRepo(db);
  for (const message of aborted) {
    activityLog.logEvent({
      actor: 'system',
      type: 'chat.stream_aborted',
      severity: 'info',
      project_id: message.projectId,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { conversation_id: message.conversationId, message_id: message.messageId },
    });
  }
  return aborted.length;
}

/**
 * §7.10 — a `control.json` is minted from an in-memory (`TokenRegistry`)
 * token that dies with the process that minted it; one still on disk at
 * startup is unconditionally stale — no fresh process's empty token map
 * could ever match it, crash or clean exit alike. Deleting it here (rather
 * than only "invalidating" it in memory) matches §7.10's own wording and
 * means a restarted employee never has a moment where a leftover file with
 * a valid *shape* sits next to the freshly-minted real one. Not
 * conditional on whether the employee is still "supposed" to be running —
 * every prior life's tokens are gone regardless, per M4's own design
 * decision to keep tokens in-memory specifically so this sweep can be
 * unconditional.
 */
function sweepStaleControlJson(activityLog: ActivityLog, baseDir: string): string[] {
  const employeesDir = path.join(baseDir, 'employees');
  if (!fs.existsSync(employeesDir)) return [];

  const deleted: string[] = [];
  for (const employeeId of fs.readdirSync(employeesDir)) {
    const controlJsonPath = path.join(employeesDir, employeeId, 'control.json');
    if (!fs.existsSync(controlJsonPath)) continue;
    fs.rmSync(controlJsonPath, { force: true });
    deleted.push(employeeId);
    activityLog.logEvent({
      actor: 'system',
      type: 'control.stale_token_deleted',
      severity: 'warn',
      project_id: null,
      task_id: null,
      employee_id: employeeId,
      checkpoint_id: null,
      payload: { path: controlJsonPath },
    });
  }
  return deleted;
}

/**
 * §11.5.1: "A reconciliation check recomputes them from `usage` on
 * startup and logs any drift." One `SUM`-and-compare query per counter
 * (not N+1 per row) against the real ledger, for each of the three
 * denormalised counters `insertUsage`'s own transaction keeps in sync on
 * the write path — this is what catches the case that path can't: a
 * counter changed by anything OTHER than that transaction (manual DB
 * surgery, a bug in an earlier version, restoring a partial backup).
 * `cost.counter_drift_repaired` (§5.2) fires once per drifted row, with
 * the real before/after in its payload — not folded into a bare count,
 * which is what `app.reconciled`'s own summary payload gets instead.
 */
function reconcileUsageCounters(db: Database.Database, activityLog: ActivityLog): number {
  let drifted = 0;

  const taskDrift = db
    .prepare(
      `SELECT t.id as id, COALESCE(t.spend_usd_micros, 0) as stored, COALESCE(SUM(u.cost_usd_micros), 0) as ledger
         FROM tasks t LEFT JOIN usage u ON u.task_id = t.id
        GROUP BY t.id
       HAVING stored != ledger`,
    )
    .all() as { id: string; stored: number; ledger: number }[];
  for (const row of taskDrift) {
    setTaskSpend(db, row.id, row.ledger);
    logCounterDrift(activityLog, 'tasks', row.id, row.stored, row.ledger);
    drifted += 1;
  }

  // usage.project_id is explicit (migration 0005) — not re-derived
  // through tasks.project_id, which would silently miss Director-
  // attributed spend (no task_id) entirely. See that migration's own
  // comment for why this matters.
  const projectDrift = db
    .prepare(
      `SELECT p.id as id, p.spend_usd_micros as stored, COALESCE(SUM(u.cost_usd_micros), 0) as ledger
         FROM projects p LEFT JOIN usage u ON u.project_id = p.id
        GROUP BY p.id
       HAVING stored != ledger`,
    )
    .all() as { id: string; stored: number; ledger: number }[];
  for (const row of projectDrift) {
    setProjectSpend(db, row.id, row.ledger);
    logCounterDrift(activityLog, 'projects', row.id, row.stored, row.ledger);
    drifted += 1;
  }

  const employeeDrift = db
    .prepare(
      `SELECT e.id as id, e.lifetime_spend_usd_micros as stored, COALESCE(SUM(u.cost_usd_micros), 0) as ledger
         FROM employees e LEFT JOIN usage u ON u.employee_id = e.id
        GROUP BY e.id
       HAVING stored != ledger`,
    )
    .all() as { id: string; stored: number; ledger: number }[];
  for (const row of employeeDrift) {
    setEmployeeLifetimeSpend(db, row.id, row.ledger);
    logCounterDrift(activityLog, 'employees', row.id, row.stored, row.ledger);
    drifted += 1;
  }

  return drifted;
}

function logCounterDrift(
  activityLog: ActivityLog,
  table: 'tasks' | 'projects' | 'employees',
  id: string,
  beforeMicros: number,
  afterMicros: number,
): void {
  activityLog.logEvent({
    actor: 'system',
    type: 'cost.counter_drift_repaired',
    severity: 'warn',
    project_id: table === 'projects' ? id : null,
    task_id: table === 'tasks' ? id : null,
    employee_id: table === 'employees' ? id : null,
    checkpoint_id: null,
    payload: { table, id, beforeMicros, afterMicros },
  });
}
