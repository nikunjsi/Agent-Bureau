import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { TaskSchema, type Task, type NewTaskInput } from '../../../shared/models/task';
import { nextCounterValue, formatDisplayKey } from './counters';

export function insertTask(db: Database.Database, input: NewTaskInput): Task {
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
      project_id: input.project_id,
      phase_id: input.phase_id,
      parent_task_id: input.parent_task_id,
      title: input.title,
      body: input.body,
      acceptance_criteria: toJsonColumn(input.acceptance_criteria),
      required_skills: toJsonColumn(input.required_skills),
      deliverable_type: input.deliverable_type,
      assignee_employee_id: input.assignee_employee_id,
      excluded_employees: toJsonColumn(input.excluded_employees),
      status: input.status,
      status_reason: input.status_reason,
      priority: input.priority,
      estimated_cost_usd_micros: input.estimated_cost_usd_micros,
      created_at: now,
      updated_at: now,
    });
    return id;
  });

  const id = insertTxn();
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
