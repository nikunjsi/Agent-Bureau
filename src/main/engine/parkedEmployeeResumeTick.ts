import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { nowIso } from '../../shared/models/ids';

/**
 * §24.3: "A single orchestrator tick (every 60s) promotes any `parked`
 * employee whose `resume_at` has passed to `off`, emits
 * `employee.resumed`, and lets normal assignment restart it." This
 * function is exactly that promotion, and nothing else — no task
 * assignment, no employee spawning (a general orchestrator is M11's
 * job). A raw DB update, not a live `Supervisor.transition()` call:
 * there is no guaranteed live `Supervisor` instance for a previously-
 * parked employee to call it on (this runs at startup, before any
 * Supervisor could exist for a park from a prior run, and periodically
 * thereafter with no live orchestrator to have kept one registered
 * either). Flagged rather than silently assumed airtight: IF a live
 * Supervisor for this employee happens to still be registered when the
 * periodic tick fires, its own in-memory `state` won't be told about
 * this transition until something else calls `transition()` on it again
 * (e.g. a fresh `assign()`) — a real, narrow desync window with no
 * production consequence today, since nothing currently keeps a
 * Supervisor alive across a park.
 */
export function promoteResumableParkedEmployees(db: Database.Database, activityLog: ActivityLog): string[] {
  const now = nowIso();
  const rows = db
    .prepare(`SELECT id FROM employees WHERE status = 'parked' AND resume_at IS NOT NULL AND resume_at <= ?`)
    .all(now) as { id: string }[];

  for (const row of rows) {
    db.prepare(`UPDATE employees SET status = 'off', resume_at = NULL WHERE id = ?`).run(row.id);
    activityLog.logEvent({
      actor: 'system',
      type: 'employee.resumed',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: row.id,
      checkpoint_id: null,
      payload: null,
    });
  }
  return rows.map((r) => r.id);
}

export interface ResumeTickHandle {
  stop(): void;
}

/** The real, minimal tick §24.3 requires — the same `setInterval`
 * primitive `Supervisor`'s own heartbeat monitor already uses as this
 * codebase's precedent for a recurring timer, not a new mechanism. */
export function startResumeTick(db: Database.Database, activityLog: ActivityLog, intervalMs = 60_000): ResumeTickHandle {
  const timer = setInterval(() => {
    promoteResumableParkedEmployees(db, activityLog);
  }, intervalMs);
  return {
    stop: () => clearInterval(timer),
  };
}
