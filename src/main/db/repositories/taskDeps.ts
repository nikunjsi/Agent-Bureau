import type Database from 'better-sqlite3';
import { TaskDepSchema, type TaskDep } from '../../../shared/models/taskDep';

export class TaskDependencyCycleError extends Error {
  constructor(taskId: string, dependsOnTaskId: string) {
    super(
      `Adding "${taskId} depends on ${dependsOnTaskId}" would create a ` +
        `cycle — ${dependsOnTaskId} already (transitively) depends on ${taskId}.`,
    );
    this.name = 'TaskDependencyCycleError';
  }
}

/**
 * `(task_id, depends_on_task_id)` composite PK — cycle rejection is
 * application logic (§5.1: "cycles rejected on insert" isn't something
 * SQLite can express declaratively). Checked with a recursive CTE walking
 * forward from `depends_on_task_id`: if `task_id` is already reachable
 * from it, this edge would close a loop.
 */
export function insertTaskDep(db: Database.Database, taskId: string, dependsOnTaskId: string): TaskDep {
  if (taskId === dependsOnTaskId) {
    throw new TaskDependencyCycleError(taskId, dependsOnTaskId);
  }

  const wouldCycle = db
    .prepare(
      `WITH RECURSIVE reachable(id) AS (
         SELECT depends_on_task_id FROM task_deps WHERE task_id = ?
         UNION
         SELECT td.depends_on_task_id FROM task_deps td JOIN reachable r ON td.task_id = r.id
       )
       SELECT 1 FROM reachable WHERE id = ? LIMIT 1`,
    )
    .get(dependsOnTaskId, taskId);

  if (wouldCycle) {
    throw new TaskDependencyCycleError(taskId, dependsOnTaskId);
  }

  db.prepare('INSERT INTO task_deps (task_id, depends_on_task_id) VALUES (?, ?)').run(taskId, dependsOnTaskId);
  return TaskDepSchema.parse({ task_id: taskId, depends_on_task_id: dependsOnTaskId });
}

export function listDependenciesOf(db: Database.Database, taskId: string): string[] {
  const rows = db.prepare('SELECT depends_on_task_id FROM task_deps WHERE task_id = ?').all(taskId) as {
    depends_on_task_id: string;
  }[];
  return rows.map((row) => row.depends_on_task_id);
}
