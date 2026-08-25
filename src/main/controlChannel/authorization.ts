import type Database from 'better-sqlite3';
import { getEmployeeById } from '../db/repositories/employees';
import { getTaskById } from '../db/repositories/tasks';
import type { Task } from '../../shared/models/task';

/**
 * M4 session 2 — "authorization, not just authentication." Session 1's
 * bearer token proves a request comes from a *live employee*; it says
 * nothing about whether that employee is entitled to the specific resource
 * a call names. Deliberately, most of the 8 employee tools never give the
 * agent a resource id to name at all (bureau_task_done/bureau_task_blocked
 * take no task_id argument, bureau_raise_checkpoint's task_id is the
 * caller's own current one, bureau_report_status only ever touches the
 * caller's own row) — closing the cross-employee vector at the design
 * level, not with a per-call check-then-reject against an
 * agent-suppliable id that doesn't exist to be crossed.
 *
 * What CAN still be wrong, and is exactly what "a deliberately crossed
 * task id" tests for real: the denormalised pointer `employees.
 * current_task_id` could, through a bug elsewhere or a corrupted row,
 * disagree with `tasks.assignee_employee_id` — the actual ownership FK.
 * This resolves ownership by walking token -> employee ->
 * current_task_id -> task, then verifying the task's *own* assignee
 * matches, rather than trusting either field in isolation.
 */
export type OwnedTaskResolution =
  | { ok: true; task: Task }
  | { ok: false; reason: 'NO_CURRENT_TASK' | 'EMPLOYEE_NOT_FOUND' | 'TASK_NOT_FOUND' }
  | { ok: false; reason: 'TASK_OWNERSHIP_MISMATCH'; task: Task };

export function resolveOwnedCurrentTask(db: Database.Database, employeeId: string): OwnedTaskResolution {
  const employee = getEmployeeById(db, employeeId);
  if (!employee) {
    // Should be impossible — the caller already authenticated this
    // employeeId against a live token — but never assumed away (CLAUDE.md
    // #6: fail closed on the ambiguous case too).
    return { ok: false, reason: 'EMPLOYEE_NOT_FOUND' };
  }
  if (!employee.current_task_id) {
    return { ok: false, reason: 'NO_CURRENT_TASK' };
  }
  const task = getTaskById(db, employee.current_task_id);
  if (!task) {
    // current_task_id points at a row that doesn't exist — a corrupted
    // pointer, not a live task belonging to someone else. Distinct from
    // TASK_OWNERSHIP_MISMATCH below so a caller logging this can tell
    // "dangling reference" apart from "pointed at someone else's task".
    return { ok: false, reason: 'TASK_NOT_FOUND' };
  }
  if (task.assignee_employee_id !== employeeId) {
    return { ok: false, reason: 'TASK_OWNERSHIP_MISMATCH', task };
  }
  return { ok: true, task };
}
