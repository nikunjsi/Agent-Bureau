import type Database from 'better-sqlite3';
import { TaskSchema, type Task } from '../../shared/models/task';

/**
 * Which tasks may be given to someone (M11 S3-0, §F S2-4; §26.2's "ready
 * set"). **One definition**: the assignment loop and `bureau_assign_task`
 * both ask it (S3-2), so no path can pick work this refuses.
 *
 * A task is ready when:
 * - it is `queued` and nobody holds it;
 * - **its plan is the project's current plan, and approved** — the
 *   project's `plan_id`, with status `approved`. `bureau_write_plan` writes a
 *   plan's tasks as `queued` before the user has approved it (`tasks.status`
 *   has no draft value), so without this an employee could start work on a
 *   plan the user never saw approved (invariant #2). A replaced version's
 *   tasks are never ready, whatever their status says;
 * - **its phase is the plan's current one** (M11 S3-2b; §26.2 "loop until
 *   the phase is complete"): `pending` or `active`, with no earlier phase of
 *   the plan still open. The next phase starts once this one is done
 *   (phase review, S3-5);
 * - every task it depends on is `done`.
 *
 * Which *employee* may take it is S3-2's `eligibleEmployees`, a separate
 * question.
 */
const READY_SQL = `
  t.status = 'queued'
  AND t.assignee_employee_id IS NULL
  AND EXISTS (
    SELECT 1 FROM phases ph
      JOIN plans pl ON pl.id = ph.plan_id
      JOIN projects pr ON pr.id = t.project_id
     WHERE ph.id = t.phase_id AND pl.status = 'approved' AND pr.plan_id = pl.id
  )
  AND EXISTS (
    SELECT 1 FROM phases cur
     WHERE cur.id = t.phase_id AND cur.status IN ('pending', 'active')
       AND NOT EXISTS (
         SELECT 1 FROM phases earlier
          WHERE earlier.plan_id = cur.plan_id AND earlier.ordinal < cur.ordinal
            AND earlier.status NOT IN ('done', 'skipped')
       )
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id
     WHERE d.task_id = t.id AND dt.status != 'done'
  )`;

/** The ready tasks, of one project or of all, in the order they were
 *  created. */
export function readyTasks(db: Database.Database, projectId?: string): Task[] {
  const rows =
    projectId === undefined
      ? db.prepare(`SELECT t.* FROM tasks t WHERE ${READY_SQL} ORDER BY t.rowid`).all()
      : db
          .prepare(
            `SELECT t.* FROM tasks t WHERE t.project_id = ? AND ${READY_SQL} ORDER BY t.rowid`,
          )
          .all(projectId);
  return rows.map((row) => TaskSchema.parse(row));
}

/**
 * Why one task is not ready, in words a refusal can carry
 * (`bureau_assign_task`), or `null` when it is. Decided by the same
 * predicate as `readyTasks`; the words only explain it.
 */
export function taskNotReadyReason(db: Database.Database, taskId: string): string | null {
  const ready = db.prepare(`SELECT 1 FROM tasks t WHERE t.id = ? AND ${READY_SQL}`).get(taskId);
  if (ready !== undefined) return null;

  const task = db
    .prepare(
      `SELECT t.status, t.assignee_employee_id, pl.id AS plan_id, pl.status AS plan_status,
              pr.plan_id AS current_plan_id
         FROM tasks t
         JOIN projects pr ON pr.id = t.project_id
         LEFT JOIN phases ph ON ph.id = t.phase_id
         LEFT JOIN plans pl ON pl.id = ph.plan_id
        WHERE t.id = ?`,
    )
    .get(taskId) as
    | {
        status: string;
        assignee_employee_id: string | null;
        plan_id: string | null;
        plan_status: string | null;
        current_plan_id: string | null;
      }
    | undefined;
  if (task === undefined) return 'there is no such task.';
  if (task.status !== 'queued') return `the task is ${task.status}, not waiting to be assigned.`;
  if (task.assignee_employee_id !== null) return 'someone already holds the task.';
  if (task.plan_id === null) return 'the task belongs to no plan.';
  if (task.plan_status === 'draft' || task.plan_status === 'awaiting_approval') {
    return 'its plan is not approved: nothing is built before the user approves the plan.';
  }
  if (task.plan_status !== 'approved' || task.current_plan_id !== task.plan_id) {
    return "its plan is not the project's current plan: a newer version replaced it.";
  }
  const phase = db
    .prepare(
      `SELECT cur.status,
              EXISTS (SELECT 1 FROM phases earlier
                       WHERE earlier.plan_id = cur.plan_id AND earlier.ordinal < cur.ordinal
                         AND earlier.status NOT IN ('done', 'skipped')) AS earlier_open
         FROM tasks t JOIN phases cur ON cur.id = t.phase_id WHERE t.id = ?`,
    )
    .get(taskId) as { status: string; earlier_open: number } | undefined;
  if (phase !== undefined && phase.earlier_open === 1) {
    return 'its phase has not started: an earlier phase of the plan is not done yet.';
  }
  if (phase !== undefined && phase.status !== 'pending' && phase.status !== 'active') {
    return `its phase is ${phase.status}, not taking new work.`;
  }
  const waiting = db
    .prepare(
      `SELECT dt.display_key FROM task_deps d JOIN tasks dt ON dt.id = d.depends_on_task_id
        WHERE d.task_id = ? AND dt.status != 'done' ORDER BY dt.rowid`,
    )
    .all(taskId) as { display_key: string }[];
  return `it waits on ${waiting.map((w) => w.display_key).join(', ')}, not done yet.`;
}
