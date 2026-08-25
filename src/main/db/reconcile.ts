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

export interface ReconcileReport {
  readonly orphansKilled: readonly string[];
  readonly mirrorRepaired: number;
  readonly leasesReclaimed: number;
  readonly tasksBlocked: readonly string[];
  readonly streamingMessagesAborted: number;
  readonly staleControlJsonDeleted: readonly string[];
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
 */
export function reconcile(db: Database.Database, activityLog: ActivityLog, baseDir: string): ReconcileReport {
  const orphansKilled = sweepOrphans(db, activityLog);
  const mirrorRepaired = repairMirror(db, activityLog);
  const leasesReclaimed = reclaimExpiredLeases(db, activityLog);
  const tasksBlocked = blockRunningTasks(db, activityLog);
  const streamingMessagesAborted = abortStaleStreamingMessages(db, activityLog);
  const staleControlJsonDeleted = sweepStaleControlJson(activityLog, baseDir);

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
    },
  });

  return {
    orphansKilled,
    mirrorRepaired,
    leasesReclaimed: leasesReclaimed.length,
    tasksBlocked,
    streamingMessagesAborted,
    staleControlJsonDeleted,
  };
}

/**
 * For every employee row with a recorded `pid`, check whether that PID is
 * alive **and** its start time matches `process_start_time` (PIDs are
 * reused). If so, kill it, emit `employee.orphan_killed` (§5.2), and
 * report it as an orphan — a `node-pty` process cannot be adopted across a
 * restart (the pty master handle is gone), so adoption is never attempted
 * (§4.4).
 */
function sweepOrphans(db: Database.Database, activityLog: ActivityLog): string[] {
  const rows = listEmployeesWithPid(db);

  const killed: string[] = [];
  for (const row of rows) {
    const currentStartTime = getProcessStartTime(row.pid);
    const isSameProcessStillAlive =
      currentStartTime !== null && currentStartTime === row.process_start_time;

    if (isSameProcessStillAlive) {
      killProcess(row.pid);
      killed.push(row.id);
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
