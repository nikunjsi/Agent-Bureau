import type Database from 'better-sqlite3';
import type { Employee } from '../../../shared/models/employee';
import type { Role } from '../../../shared/models/role';
import type { Autonomy } from '../../../shared/models/enums';
import type { PolicyVariables } from '../../../shared/policy/types';
import { computeEffectiveAutonomy } from '../../../shared/policy/autonomy';
import { getEmployeeById } from '../../db/repositories/employees';
import { getRoleByFullKey } from '../../db/repositories/roles';
import { getWorktreeById } from '../../db/repositories/worktrees';
import { getProjectById } from '../../db/repositories/projects';
import { resolveConversationForDelivery } from '../../db/repositories/conversations';
import { getSetting } from '../../db/repositories/settings';
import { getEmployeeStateDir } from '../../db/paths';
import { canonicalizePath } from './pathCanonicalize';

export class UnknownEmployeeError extends Error {
  constructor(employeeId: string) {
    super(`no employee found for id "${employeeId}" — cannot build a policy context for it.`);
    this.name = 'UnknownEmployeeError';
  }
}

/**
 * The project `${project}` stands for, for THIS employee (M11 row S1-11b).
 *
 * An employee's project is its worktree's — the checkout it was assigned.
 * **The Director has no worktree** (§8.0), so before this it resolved to
 * null, which matches nothing: its own `Read(${project}/**)` grant would
 * have denied every read and left it safe but blind. Its project is the
 * one its conversation is about, and null again when it is between
 * projects — a read is then denied, which is the safe direction.
 *
 * One function, both cases: two resolutions of "which project is this" is
 * standing rule 6's shape.
 */
function resolvePolicyProject(
  db: Database.Database,
  employee: Employee,
  worktree: { project_id: string } | null,
): { path: string } | null {
  if (worktree) return getProjectById(db, worktree.project_id);
  if (!employee.is_director) return null;
  const conversation = resolveConversationForDelivery(db, null);
  if (!conversation?.project_id) return null;
  return getProjectById(db, conversation.project_id);
}

export interface EmployeePolicyContext {
  employee: Employee;
  role: Role | null;
  variables: PolicyVariables;
  effectiveAutonomy: Autonomy;
}

/**
 * Everything the real evaluator needs about the calling employee, built
 * fresh per policy check from real repositories — no new plumbing
 * required, all confirmed to already exist: `getEmployeeById`,
 * `getRoleByFullKey` (role.full_key === employee.role_key, §5.1),
 * `getWorktreeById`/`getProjectById` (via the worktree's own project_id),
 * `getSetting(db, 'general.homeFolder')` for `${home}`.
 *
 * `${worktree}`/`${project}` are `null` (unset — matches nothing, never
 * everything, §11.3) for the Director (no `worktree_id`, §8.0) and for
 * any employee between assignments. `${bureau_state}` is the employee's
 * own per-employee state directory (`getEmployeeStateDir`, M4) — always
 * set, since every employee, Director included, has one.
 *
 * Every set variable is run through `canonicalizePath` here, not left as
 * the raw DB-stored string — `conditions.ts`'s `path_outside` compares a
 * fully canonicalised candidate path against these roots, so comparing a
 * canonical candidate against a non-canonical root (a different case, a
 * trailing slash, an 8.3 component, a junction) would silently produce
 * wrong matches. Canonicalising both sides here, once, is simpler and
 * safer than trying to canonicalise "just enough" of each root at
 * condition-evaluation time.
 */
export function buildEmployeePolicyContext(
  db: Database.Database,
  baseDir: string,
  employeeId: string,
): EmployeePolicyContext {
  const employee = getEmployeeById(db, employeeId);
  if (!employee) throw new UnknownEmployeeError(employeeId);

  const role = getRoleByFullKey(db, employee.role_key);

  const worktree = employee.worktree_id ? getWorktreeById(db, employee.worktree_id) : null;
  const project = resolvePolicyProject(db, employee, worktree);
  const homeFolder = getSetting(db, 'general.homeFolder');

  return {
    employee,
    role,
    variables: {
      worktree: worktree ? canonicalizePath(worktree.path) : null,
      project: project ? canonicalizePath(project.path) : null,
      home: homeFolder ? canonicalizePath(homeFolder) : null,
      bureau_state: canonicalizePath(getEmployeeStateDir(baseDir, employeeId)),
    },
    effectiveAutonomy: computeEffectiveAutonomy(employee),
  };
}
