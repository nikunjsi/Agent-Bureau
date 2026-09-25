import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getSetting } from '../db/repositories/settings';
import { getUsageSince } from '../db/repositories/usage';
import { claimTaskRow, getTaskById, releaseTaskClaim } from '../db/repositories/tasks';
import { claimEmployeeForTask, releaseEmployeeTask } from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { localMidnightIso } from '../cost/budgetCheck';
import { taskNotReadyReason } from './readyTasks';
import { EmployeeSchema, type Employee } from '../../shared/models/employee';
import type { Task } from '../../shared/models/task';

/**
 * Who may take a task, and taking it (M11 S3-2a; §8.5, §26.2, §10.3's
 * guarantee).
 *
 * **One eligibility function** (standing rule 6): the assignment loop and
 * `bureau_assign_task` both ask `eligibleEmployees`, so a person the loop
 * would never pick cannot be handed work by the tool either, and the tool's
 * refusal says why in the same words.
 *
 * **One claim**: `claimTask` decides "this task is this employee's" in one
 * `BEGIN IMMEDIATE` transaction, with a compare-and-set on both rows, before
 * any worktree is touched (§10.3: a task goes to at most one employee; an
 * employee holds at most one task; a second attempt is refused with a typed
 * error, never queued; the claim is in the database, so it survives a
 * restart, and `reconcile()` releases one whose employee is gone).
 */

export type AssignmentRefusalCode =
  'task_not_ready' | 'task_taken' | 'employee_busy' | 'employee_ineligible' | 'no_such_employee';

export class AssignmentRefusedError extends Error {
  constructor(
    readonly code: AssignmentRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AssignmentRefusedError';
  }
}

export interface Eligibility {
  /** Eligible employees, best first by §8.5's key. */
  readonly eligible: readonly Employee[];
  /** Everyone else, each with the reason in plain words. */
  readonly rejected: readonly { employeeId: string; name: string; reason: string }[];
}

/** Task states that still hold an employee. */
const HOLDING = new Set(['assigned', 'running', 'blocked', 'review']);

/**
 * §8.5's filter, in plain code, over every hired employee:
 * the Director never takes a task; `idle` or `off` (an idle-stopped employee
 * is still eligible — assignment starts it); holding no task; its role has
 * every required skill and, when the task names one, the deliverable type;
 * not excluded from the task; and its budget for today has more left than the
 * task is estimated to cost. Ordered by `[activeTaskCount, -role.priority,
 * hiredAt]`.
 */
export function eligibleEmployees(db: Database.Database, taskId: string): Eligibility {
  const task = getTaskById(db, taskId);
  if (task === null) return { eligible: [], rejected: [] };
  const employees = (
    db
      .prepare('SELECT * FROM employees WHERE archived_at IS NULL ORDER BY rowid')
      .all() as unknown[]
  ).map((row) => EmployeeSchema.parse(row));

  const eligible: { employee: Employee; key: [number, number, string] }[] = [];
  const rejected: { employeeId: string; name: string; reason: string }[] = [];
  const reject = (employee: Employee, reason: string) =>
    rejected.push({ employeeId: employee.id, name: employee.name, reason });

  for (const employee of employees) {
    if (employee.is_director) {
      reject(employee, 'the Director plans and reviews; it does not take tasks.');
      continue;
    }
    const role = getRoleByFullKey(db, employee.role_key);
    if (role === null) {
      reject(employee, `${employee.name}'s role ${employee.role_key} is not installed.`);
      continue;
    }
    if (employee.status !== 'idle' && employee.status !== 'off') {
      reject(employee, `${employee.name} is ${employee.status}, not free.`);
      continue;
    }
    const held = heldTask(db, employee);
    if (held !== null) {
      reject(employee, `${employee.name} already holds ${held}.`);
      continue;
    }
    const missing = task.required_skills.filter((skill) => !role.skills.includes(skill));
    if (missing.length > 0) {
      reject(employee, `${employee.name} (${role.title}) lacks the skill ${missing.join(', ')}.`);
      continue;
    }
    if (
      task.deliverable_type !== null &&
      !(role.deliverable_types as readonly string[]).includes(task.deliverable_type)
    ) {
      reject(
        employee,
        `${employee.name} (${role.title}) does not produce ${task.deliverable_type}.`,
      );
      continue;
    }
    if (task.excluded_employees.includes(employee.id)) {
      reject(employee, `${employee.name} is excluded from this task.`);
      continue;
    }
    const remaining = budgetRemainingToday(db, employee);
    const estimate = task.estimated_cost_usd_micros ?? 0;
    if (remaining <= estimate) {
      reject(employee, `${employee.name} has not enough budget left today for this task.`);
      continue;
    }
    const activeTasks = activeTaskCount(db, employee.id);
    eligible.push({ employee, key: [activeTasks, -role.priority, employee.hired_at] });
  }

  eligible.sort(
    (a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2].localeCompare(b.key[2]),
  );
  return { eligible: eligible.map((e) => e.employee), rejected };
}

/**
 * Claims `taskId` for `employeeId` — one `BEGIN IMMEDIATE` transaction, both
 * rows compare-and-set, one `task.assigned` after the commit (invariant #3).
 * Throws `AssignmentRefusedError` and writes nothing when the task is not
 * ready, is already someone's, or the employee is not eligible or already
 * holds a task.
 */
export function claimTask(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: { readonly taskId: string; readonly employeeId: string },
): Task {
  const { db, activityLog } = deps;
  const claimed = db
    .transaction((): Task => {
      const notReady = taskNotReadyReason(db, input.taskId);
      if (notReady !== null) {
        const task = getTaskById(db, input.taskId);
        const taken = task !== null && task.assignee_employee_id !== null;
        throw new AssignmentRefusedError(
          taken ? 'task_taken' : 'task_not_ready',
          taken ? 'someone already holds the task.' : notReady,
        );
      }
      const employeeRow = db.prepare('SELECT * FROM employees WHERE id = ?').get(input.employeeId);
      if (employeeRow === undefined) {
        throw new AssignmentRefusedError('no_such_employee', 'there is no such employee.');
      }
      const employee = EmployeeSchema.parse(employeeRow);
      if (heldTask(db, employee) !== null) {
        throw new AssignmentRefusedError('employee_busy', `${employee.name} already holds a task.`);
      }
      const { eligible, rejected } = eligibleEmployees(db, input.taskId);
      if (!eligible.some((e) => e.id === employee.id)) {
        const why = rejected.find((r) => r.employeeId === employee.id)?.reason;
        throw new AssignmentRefusedError(
          'employee_ineligible',
          why ?? `${employee.name} cannot take this task.`,
        );
      }
      const taskMoved = claimTaskRow(db, input.taskId, employee.id);
      const employeeTook = claimEmployeeForTask(db, employee.id, input.taskId);
      if (!taskMoved || !employeeTook) {
        // Unreachable while one connection writes, kept as the backstop:
        // throwing rolls the half that did change back.
        throw new AssignmentRefusedError('task_taken', 'the task or the employee was just taken.');
      }
      return getTaskById(db, input.taskId)!;
    })
    .immediate();

  activityLog.logEvent({
    actor: 'system',
    type: 'task.assigned',
    severity: 'info',
    project_id: claimed.project_id,
    task_id: claimed.id,
    employee_id: input.employeeId,
    checkpoint_id: null,
    payload: { taskId: claimed.id, employeeId: input.employeeId },
  });
  return claimed;
}

/**
 * `reconcile()`'s half of the guarantee: a claim whose employee is gone
 * (fired, or the row missing) goes back to the queue, one `task.reassigned`
 * each (`to: null`, `reason: 'employee_gone'`), and the archived employee
 * no longer points at it. A claim whose employee is still hired stays: it
 * survives the restart and the loop drives it (S3-2b).
 */
export function releaseOrphanedClaims(db: Database.Database, activityLog: ActivityLog): string[] {
  const orphaned = db
    .prepare(
      `SELECT t.id, t.project_id, t.assignee_employee_id AS employee_id FROM tasks t
         LEFT JOIN employees e ON e.id = t.assignee_employee_id
        WHERE t.status = 'assigned' AND t.assignee_employee_id IS NOT NULL
          AND (e.id IS NULL OR e.archived_at IS NOT NULL)`,
    )
    .all() as { id: string; project_id: string; employee_id: string }[];
  if (orphaned.length === 0) return [];
  db.transaction(() => {
    for (const row of orphaned) {
      releaseTaskClaim(db, row.id);
      releaseEmployeeTask(db, row.employee_id, row.id);
    }
  })();
  for (const row of orphaned) {
    activityLog.logEvent({
      actor: 'system',
      type: 'task.reassigned',
      severity: 'info',
      project_id: row.project_id,
      task_id: row.id,
      employee_id: null,
      checkpoint_id: null,
      payload: { from: row.employee_id, to: null, reason: 'employee_gone' },
    });
  }
  return orphaned.map((row) => row.id);
}

/** The display key of the task an employee holds, or `null`. */
function heldTask(db: Database.Database, employee: Employee): string | null {
  if (employee.current_task_id === null) return null;
  const task = getTaskById(db, employee.current_task_id);
  return task !== null && HOLDING.has(task.status) ? task.display_key : null;
}

function activeTaskCount(db: Database.Database, employeeId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks
          WHERE assignee_employee_id = ? AND status IN ('assigned', 'running', 'blocked', 'review')`,
      )
      .get(employeeId) as { n: number }
  ).n;
}

/** Today's budget left: the employee's own daily cap, or the setting's. */
function budgetRemainingToday(db: Database.Database, employee: Employee): number {
  const cap = employee.daily_budget_usd_micros ?? getSetting(db, 'budgets.perEmployeeDailyUsd');
  return cap - getUsageSince(db, localMidnightIso(), { employeeId: employee.id });
}
