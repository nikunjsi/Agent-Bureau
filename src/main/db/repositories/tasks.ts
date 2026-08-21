import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { TaskSchema, NewTaskInputSchema, type Task, type NewTaskInput } from '../../../shared/models/task';
import { nextCounterValue, formatDisplayKey } from './counters';

/** Input is validated **before** the transaction opens (AUDIT finding #1) —
 * an invalid input must never consume a display-key counter value or write
 * a row that a later read would then throw on forever. */
export function insertTask(db: Database.Database, input: NewTaskInput): Task {
  const parsed = NewTaskInputSchema.parse(input);

  const insertTxn = db.transaction(() => {
    const counterValue = nextCounterValue(db, 'task');
    const displayKey = formatDisplayKey('T', counterValue, 4);
    const id = newId();
    const now = nowIso();
    db.prepare(
      `INSERT INTO tasks (
         id, display_key, project_id, phase_id, parent_task_id, title, body, acceptance_criteria,
         required_skills, deliverable_type, assignee_employee_id, excluded_employees, status,
         status_reason, priority, attempts, reassignments, estimated_cost_usd_micros, spend_usd_micros,
         result_summary, started_at, finished_at, created_at, updated_at
       ) VALUES (
         @id, @display_key, @project_id, @phase_id, @parent_task_id, @title, @body, @acceptance_criteria,
         @required_skills, @deliverable_type, @assignee_employee_id, @excluded_employees, @status,
         @status_reason, @priority, 0, 0, @estimated_cost_usd_micros, NULL,
         NULL, NULL, NULL, @created_at, @updated_at
       )`,
    ).run({
      id,
      display_key: displayKey,
      project_id: parsed.project_id,
      phase_id: parsed.phase_id,
      parent_task_id: parsed.parent_task_id,
      title: parsed.title,
      body: parsed.body,
      acceptance_criteria: toJsonColumn(parsed.acceptance_criteria),
      required_skills: toJsonColumn(parsed.required_skills),
      deliverable_type: parsed.deliverable_type,
      assignee_employee_id: parsed.assignee_employee_id,
      excluded_employees: toJsonColumn(parsed.excluded_employees),
      status: parsed.status,
      status_reason: parsed.status_reason,
      priority: parsed.priority,
      estimated_cost_usd_micros: parsed.estimated_cost_usd_micros,
      created_at: now,
      updated_at: now,
    });
    return id;
  });

  const id = insertTxn.immediate();
  return getTaskById(db, id) as Task;
}

export function getTaskById(db: Database.Database, id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return row ? TaskSchema.parse(row) : null;
}

export function setTaskStatus(
  db: Database.Database,
  taskId: string,
  status: string,
  statusReason: string | null = null,
): void {
  db.prepare('UPDATE tasks SET status = ?, status_reason = ? WHERE id = ?').run(status, statusReason, taskId);
}
