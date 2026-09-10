import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import {
  getEmployeeById,
  archiveEmployee,
  unarchiveEmployee,
  setEmployeeStatus,
  setEmployeeCurrentTask,
} from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { getWorktreeById } from '../db/repositories/worktrees';
import { getProjectById } from '../db/repositories/projects';
import { fireEmployeeWorktree } from '../workspace/employeeWorktree';
import { isPackAvailable } from '../packs/revalidateInstalledPacks';
import type { Employee } from '../../shared/models/employee';
import { applyFloorLayout, collectLayoutInputs } from './persistFloorLayout';
import { generateFloorLayout } from './generateFloorLayout';
import { RoleNotAvailableError } from './hireEmployee';
import { UserFacingError } from '../../shared/errors/userFacing';

/**
 * §6.8 — "Firing an employee archives their memory rather than deleting
 * it — if rehired into the same role, they resume with what they learned."
 *
 * The archiving is the row surviving with `archived_at` set (migration
 * 0007). Employee memory is markdown keyed by employee id, so nothing has
 * to move: the notes stay exactly where they were, and a rehire that keeps
 * the id walks straight back into them.
 */

/**
 * The Director cannot be fired.
 *
 * This is the **third instance of one pattern**, and naming it here rather
 * than treating it as a special case is the point: §8.0's budget reserve
 * holds money back so a budget limit can never silence the Director, and
 * §11.5's circuit breaker exempts the Director from its stop step for the
 * same reason. Firing is the most complete version of the same failure —
 * it archives the only agent the user can talk to, and unlike a budget
 * limit or a breaker trip there is no path back, because raising a budget
 * or answering a checkpoint both require somebody to raise them.
 *
 * The rule, stated once: **any operation that could remove the user's only
 * way back must refuse; operations the user can undo need not.** That is
 * why `pause` deliberately does NOT refuse the Director — a paused
 * Director resumes from a button that needs no model call, which is the
 * same escape hatch §8.0 describes for an exhausted budget.
 */
export class CannotFireDirectorError extends UserFacingError {
  constructor() {
    super(
      'the Director cannot be fired — it is the only agent the user can talk to, and there would be ' +
        'no way to hire a replacement or raise a budget without it (§8.0).',
    );
    this.name = 'CannotFireDirectorError';
  }
}

export interface FireEmployeeOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly companyId: string;
  readonly employeeId: string;
}

export async function fireEmployee(options: FireEmployeeOptions): Promise<Employee> {
  const { db, activityLog, companyId, employeeId } = options;

  const employee = getEmployeeById(db, employeeId);
  if (employee === null) throw new RoleNotAvailableError(employeeId, 'no such employee');
  if (employee.is_director) throw new CannotFireDirectorError();
  if (employee.archived_at !== null) return employee; // already archived — idempotent

  // The worktree half is M5's, reused rather than reimplemented: `git
  // worktree remove --force` then `prune`, with the branch deliberately
  // retained (their work is not deleted either).
  if (employee.worktree_id !== null) {
    const worktree = getWorktreeById(db, employee.worktree_id);
    if (worktree !== null) {
      const project = getProjectById(db, worktree.project_id);
      if (project !== null) {
        await fireEmployeeWorktree({ db, activityLog, project, employee, worktree });
      }
    }
  }

  const archive = db.transaction(() => {
    setEmployeeCurrentTask(db, employeeId, null);
    setEmployeeStatus(db, employeeId, 'off');
    archiveEmployee(db, employeeId);
  });
  archive();

  // Their desk is now free, and the department's room may shrink (§13.3
  // step 3 sizes by employee count). Suppressed event — a fire is ONE
  // user-visible action and emits `company.employee_fired` below.
  applyFloorLayout({ db, activityLog, companyId, emitEvent: false, reason: 'fire' });

  activityLog.logEvent({
    actor: 'user',
    type: 'company.employee_fired',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: {
      companyId,
      name: employee.name,
      roleKey: employee.role_key,
      // §6.8's actual promise, recorded where someone reading the log can
      // see it: the memory is kept, not deleted.
      memoryArchived: true,
      memoryScopeRef: employeeId,
    },
  });

  return getEmployeeById(db, employeeId)!;
}

/**
 * §6.8's other half — "if rehired into the same role, they resume with
 * what they learned."
 *
 * Keeps the id (and therefore every note under
 * `memory/employee/<id>/`), keeps the name, and allocates a fresh desk.
 * A rehire into a DIFFERENT role is deliberately not supported here: §6.8
 * scopes the promise to the same role, and the memory that makes a rehire
 * worth doing is role-shaped.
 */
export function rehireEmployee(options: {
  db: Database.Database;
  activityLog: ActivityLog;
  companyId: string;
  employeeId: string;
}): Employee {
  const { db, activityLog, companyId, employeeId } = options;

  const employee = getEmployeeById(db, employeeId);
  if (employee === null) throw new RoleNotAvailableError(employeeId, 'no such employee');
  if (employee.archived_at === null) return employee; // already employed — idempotent

  const role = getRoleByFullKey(db, employee.role_key);
  if (role === null) {
    throw new RoleNotAvailableError(employee.role_key, 'the role they held no longer exists');
  }
  const packKey = employee.role_key.split(':')[0]!;
  if (!isPackAvailable(db, packKey)) {
    throw new RoleNotAvailableError(employee.role_key, `its pack "${packKey}" is not available`);
  }

  // Confirm there is somewhere for them to sit before un-archiving, so a
  // failure leaves them archived rather than employed-with-no-desk.
  const inputs = collectLayoutInputs(db, companyId);
  const prospective = generateFloorLayout({
    companyId,
    departments: inputs.departments,
    employees: [
      ...inputs.employees,
      { id: employeeId, departmentKey: role.department_key, isDirector: false },
    ],
    previousLayout: inputs.previousLayout,
  });
  const hasDesk = prospective.layout.rooms.some((room) =>
    room.desks.some((d) => d.employeeId === employeeId),
  );
  if (!hasDesk) {
    throw new RoleNotAvailableError(
      employee.role_key,
      `department "${role.department_key}" has no free desk`,
    );
  }

  unarchiveEmployee(db, employeeId);
  applyFloorLayout({ db, activityLog, companyId, emitEvent: false, reason: 'rehire' });

  const rehired = getEmployeeById(db, employeeId)!;
  activityLog.logEvent({
    actor: 'user',
    type: 'company.employee_hired',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: {
      companyId,
      name: rehired.name,
      roleKey: rehired.role_key,
      department: role.department_key,
      desk: { x: rehired.desk_x, y: rehired.desk_y },
      // Distinguishes this from a fresh hire in the log without needing a
      // second event type: same action, different provenance.
      rehired: true,
      memoryScopeRef: employeeId,
    },
  });

  return rehired;
}
