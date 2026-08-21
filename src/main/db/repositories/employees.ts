import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { EmployeeSchema, NewEmployeeInputSchema, type Employee, type NewEmployeeInput } from '../../../shared/models/employee';

export function insertEmployee(db: Database.Database, input: NewEmployeeInput): Employee {
  const parsed = NewEmployeeInputSchema.parse(input);
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
    name: parsed.name,
    role_key: parsed.role_key,
    is_director: parsed.is_director ? 1 : 0,
    desk_x: parsed.desk_x,
    desk_y: parsed.desk_y,
    sprite_variant: parsed.sprite_variant,
    status: parsed.status,
    status_detail: parsed.status_detail,
    engine: parsed.engine,
    engine_mode: parsed.engine_mode,
    engine_version: parsed.engine_version,
    model: parsed.model,
    session_id: parsed.session_id,
    pid: parsed.pid,
    process_start_time: parsed.process_start_time,
    worktree_id: parsed.worktree_id,
    current_task_id: parsed.current_task_id,
    autonomy: parsed.autonomy,
    daily_budget_usd_micros: parsed.daily_budget_usd_micros,
    resume_at: parsed.resume_at,
    heartbeat_at: parsed.heartbeat_at,
    consecutive_failures: parsed.consecutive_failures,
    lifetime_spend_usd_micros: parsed.lifetime_spend_usd_micros,
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
