import type Database from 'better-sqlite3';
import { nowIso } from '../../shared/models/ids';
import { getProcessStartTime, killProcess } from '../process/processInfo';
import { readActivityLogTail, insertMirrorRow } from './activityLog';
import { abortStaleStreamingMessages } from './repositories/conversationMessages';

export interface ReconcileReport {
  readonly orphansKilled: readonly string[];
  readonly mirrorRepaired: number;
  readonly leasesReclaimed: number;
  readonly tasksBlocked: readonly string[];
  readonly streamingMessagesAborted: number;
}

/**
 * The four behaviors §28 M1 step 7 names, plus one more §5.1 requires
 * explicitly ("Streaming (MUST) ... On reconcile, any row still
 * `streaming` from before the app started becomes `aborted`") but §28's
 * own compressed step list doesn't call out by name — found while wiring
 * the conversation_messages repository, not in the original plan. Run on
 * startup before the UI is interactive (§4.4). Each behavior is
 * independently testable; this function just sequences them.
 */
export function reconcile(db: Database.Database, activityLogPath: string): ReconcileReport {
  return {
    orphansKilled: sweepOrphans(db),
    mirrorRepaired: repairMirror(db, activityLogPath),
    leasesReclaimed: reclaimExpiredLeases(db),
    tasksBlocked: blockRunningTasks(db),
    streamingMessagesAborted: abortStaleStreamingMessages(db),
  };
}

interface EmployeeProcessRow {
  id: string;
  pid: number | null;
  process_start_time: string | null;
}

/**
 * For every employee row with a recorded `pid`, check whether that PID is
 * alive **and** its start time matches `process_start_time` (PIDs are
 * reused). If so, kill it and report it as an orphan — a `node-pty`
 * process cannot be adopted across a restart (the pty master handle is
 * gone), so adoption is never attempted (§4.4).
 */
function sweepOrphans(db: Database.Database): string[] {
  const rows = db
    .prepare('SELECT id, pid, process_start_time FROM employees WHERE pid IS NOT NULL')
    .all() as EmployeeProcessRow[];

  const killed: string[] = [];
  for (const row of rows) {
    if (row.pid === null) continue;
    const currentStartTime = getProcessStartTime(row.pid);
    const isSameProcessStillAlive =
      currentStartTime !== null && currentStartTime === row.process_start_time;

    if (isSameProcessStillAlive) {
      killProcess(row.pid);
      killed.push(row.id);
    }
  }
  return killed;
}

/**
 * Replays `activity.jsonl`'s tail after the mirror's current `MAX(seq)`,
 * inserting whatever mirror rows are missing. This is what makes the
 * append-then-mirror ordering (§11.6) safe to interrupt: a crash between
 * the file write and the mirror insert leaves the mirror behind, and this
 * is the repair.
 */
function repairMirror(db: Database.Database, activityLogPath: string): number {
  const maxSeqRow = db.prepare('SELECT MAX(seq) as maxSeq FROM events').get() as {
    maxSeq: number | null;
  };
  const maxSeq = maxSeqRow.maxSeq ?? 0;

  const tail = readActivityLogTail(activityLogPath, maxSeq);
  const insertedAt = nowIso();
  for (const entry of tail) {
    insertMirrorRow(db, entry, insertedAt);
  }
  return tail.length;
}

/** Expired worktree leases released. (`git worktree prune` — the
 * filesystem-level half of full lease release — is M5's job once real git
 * integration exists; this is the DB-level half only.) */
function reclaimExpiredLeases(db: Database.Database): number {
  const result = db
    .prepare(
      `UPDATE worktrees
         SET lease_holder = NULL, lease_expires_at = NULL, status = 'free'
       WHERE lease_holder IS NOT NULL AND lease_expires_at < ?`,
    )
    .run(nowIso());
  return result.changes;
}

/** A task still `running` when the app starts crashed mid-flight — there is
 * no supervisor to resume it into (that's M3+), so it goes to `blocked`
 * with reason `app_restart` (§4.4). */
function blockRunningTasks(db: Database.Database): string[] {
  const running = db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as {
    id: string;
  }[];
  if (running.length === 0) return [];

  db.prepare("UPDATE tasks SET status = 'blocked', status_reason = 'app_restart' WHERE status = 'running'").run();
  return running.map((row) => row.id);
}
