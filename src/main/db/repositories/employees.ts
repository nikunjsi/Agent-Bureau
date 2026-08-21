import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { EmployeeSchema, type Employee, type NewEmployeeInput } from '../../../shared/models/employee';

export function insertEmployee(db: Database.Database, input: NewEmployeeInput): Employee {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO employees (
       id, name, role_key, is_director, desk_x, desk_y, sprite_variant, status, status_detail,
       engine, engine_mode, engine_version, model, session_id, pid, process_start_time,
       worktree_id, current_task_id, autonomy, daily_budget_usd_micros, resume_at,
       heartbeat_at, consecutive_failures, lifetime_spend_usd_micros, hired_at, created_at, updated_at
     ) VALUES (
       @id, @name, @role_key, @is_director, @desk_x, @desk_y, @sprite_variant, @status, @status_detail,
       @engine, @engine_mode, @engine_version, @model, @session_id, @pid, @process_start_time,
       @worktree_id, @current_task_id, @autonomy, @daily_budget_usd_micros, @resume_at,
       @heartbeat_at, @consecutive_failures, @lifetime_spend_usd_micros, @hired_at, @created_at, @updated_at
     )`,
  ).run({
    id,
    name: input.name,
    role_key: input.role_key,
    is_director: input.is_director ? 1 : 0,
    desk_x: input.desk_x,
    desk_y: input.desk_y,
    sprite_variant: input.sprite_variant,
    status: input.status,
    status_detail: input.status_detail,
    engine: input.engine,
    engine_mode: input.engine_mode,
    engine_version: input.engine_version,
    model: input.model,
    session_id: input.session_id,
    pid: input.pid,
    process_start_time: input.process_start_time,
    worktree_id: input.worktree_id,
    current_task_id: input.current_task_id,
    autonomy: input.autonomy,
    daily_budget_usd_micros: input.daily_budget_usd_micros,
    resume_at: input.resume_at,
    heartbeat_at: input.heartbeat_at,
    consecutive_failures: input.consecutive_failures,
    lifetime_spend_usd_micros: input.lifetime_spend_usd_micros,
    hired_at: now,
    created_at: now,
    updated_at: now,
  });
  return getEmployeeById(db, id) as Employee;
}

export function getEmployeeById(db: Database.Database, id: string): Employee | null {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  return row ? EmployeeSchema.parse(row) : null;
}

export function setEmployeeCurrentTask(db: Database.Database, employeeId: string, taskId: string | null): void {
  db.prepare('UPDATE employees SET current_task_id = ? WHERE id = ?').run(taskId, employeeId);
}

export function setEmployeeStatus(db: Database.Database, employeeId: string, status: string): void {
  db.prepare('UPDATE employees SET status = ? WHERE id = ?').run(status, employeeId);
}

/** Rows with a recorded `pid` — what `reconcile()`'s orphan sweep scans. */
export function listEmployeesWithPid(
  db: Database.Database,
): Array<{ id: string; pid: number; process_start_time: string | null }> {
  return db
    .prepare('SELECT id, pid, process_start_time FROM employees WHERE pid IS NOT NULL')
    .all() as Array<{ id: string; pid: number; process_start_time: string | null }>;
}
