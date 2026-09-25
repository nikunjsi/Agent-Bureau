import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getSetting } from '../db/repositories/settings';

/**
 * Stalls (M11 S3-6b; §8.5: the Director "watches for stalls
 * (`stall_timeout_s`)").
 *
 * A task someone holds (`assigned` or `running`) with nothing recorded about
 * it — no event for the task, and none from its employee — for longer than
 * `orchestrator.stallTimeoutS` reaches the Director as a coalesced `stall`
 * trigger, once per silence: its key is the last thing that did happen, so a
 * later check of the same silence is the same trigger, and a new silence
 * after new activity is a new one.
 *
 * This is the one place a timer runs for it, and it wakes nobody on its own:
 * a check that finds no stall offers nothing, so no Director turn is spent
 * on a bare timer (§26.1).
 */
export interface StallWatcherDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly director?: {
    offerStall(input: { key: string; projectId: string; text: string }): void;
  };
  /** How often to look. 0 starts no timer (tests call `check`). */
  readonly intervalMs?: number;
}

export interface StallWatcher {
  check(nowMs: number): void;
  stop(): void;
}

export function createStallWatcher(deps: StallWatcherDeps): StallWatcher {
  const check = (nowMs: number): void => {
    const timeoutMs = getSetting(deps.db, 'orchestrator.stallTimeoutS') * 1000;
    const held = deps.db
      .prepare(
        `SELECT t.id, t.display_key, t.title, t.project_id, t.assignee_employee_id AS employee_id,
                e.name AS employee_name
           FROM tasks t JOIN employees e ON e.id = t.assignee_employee_id
          WHERE t.status IN ('assigned', 'running')`,
      )
      .all() as {
      id: string;
      display_key: string;
      title: string;
      project_id: string;
      employee_id: string;
      employee_name: string;
    }[];
    for (const task of held) {
      const last = deps.db
        .prepare(
          'SELECT MAX(seq) AS seq, MAX(ts) AS ts FROM events WHERE task_id = ? OR employee_id = ?',
        )
        .get(task.id, task.employee_id) as { seq: number | null; ts: string | null };
      if (last.ts === null) continue;
      const silentMs = nowMs - Date.parse(last.ts);
      if (silentMs <= timeoutMs) continue;
      const minutes = Math.round(silentMs / 60_000);
      deps.director?.offerStall({
        key: `stall:${task.id}:${last.seq}`,
        projectId: task.project_id,
        text:
          `${task.display_key} "${task.title}" looks stalled: nothing has happened on it, and ` +
          `nothing from ${task.employee_name}, for ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
          'Look at it (bureau_get_project_state), and stop the employee (bureau_stop_employee) or ' +
          'send the task back (bureau_reject_task) if it is stuck.',
      });
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if ((deps.intervalMs ?? 60_000) > 0) {
    timer = setInterval(() => check(Date.now()), deps.intervalMs ?? 60_000);
    timer.unref?.();
  }
  return {
    check,
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
