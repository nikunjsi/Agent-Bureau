import type Database from 'better-sqlite3';
import { newId } from '../../src/shared/models/ids';
import { insertDepartment } from '../../src/main/db/repositories/departments';
import { insertRole } from '../../src/main/db/repositories/roles';
import { insertEmployee } from '../../src/main/db/repositories/employees';
import { insertProject } from '../../src/main/db/repositories/projects';
import { insertWorktree } from '../../src/main/db/repositories/worktrees';
import { setEmployeeWorktree } from '../../src/main/db/repositories/employees';
import { insertBrief } from '../../src/main/db/repositories/briefs';
import { insertPlan } from '../../src/main/db/repositories/plans';
import { insertPhase } from '../../src/main/db/repositories/phases';
import { insertTask } from '../../src/main/db/repositories/tasks';
import type { Department, NewDepartmentInput } from '../../src/shared/models/department';
import type { Role, NewRoleInput } from '../../src/shared/models/role';
import type { Employee, NewEmployeeInput } from '../../src/shared/models/employee';
import type { Project, NewProjectInput } from '../../src/shared/models/project';
import type { Worktree, NewWorktreeInput } from '../../src/shared/models/worktree';
import type { Brief, NewBriefInput } from '../../src/shared/models/brief';
import type { Plan, NewPlanInput } from '../../src/shared/models/plan';
import type { Phase, NewPhaseInput } from '../../src/shared/models/phase';
import type { Task, NewTaskInput } from '../../src/shared/models/task';

/**
 * §5.1's one real FK chain (department → role → employee, and separately
 * project → brief → plan → phase, plus project → task), as a set of thin
 * `seedX` wrappers around the real repository `insertX` functions — never a
 * second, parallel way of writing these rows. Every M5 test (and every
 * future test that needs a valid row somewhere in this chain) imports this
 * instead of hand-rolling another `db.prepare('INSERT INTO ...')` (trap f —
 * four slightly-different ad-hoc copies had already accumulated across
 * M3/M4 test files before this existed; see PROGRESS.md's M5 part 1 entry
 * for the migration decision).
 *
 * Every function takes `db` plus a partial-overrides object matching that
 * table's own `NewXInput` (z.input) type — pass only what the test actually
 * cares about; everything else gets a real, valid default. A parent id
 * (e.g. `seedRole`'s `department_key`) is auto-created via the matching
 * `seedParent` call when not supplied, so `seedTask(db)` alone walks the
 * *entire* chain down to a fresh project with no setup required — and two
 * calls never collide, since every default name/key is suffixed with a
 * fresh ULID.
 */

function suffix(): string {
  return newId().toLowerCase();
}

export function seedDepartment(
  db: Database.Database,
  overrides: Partial<NewDepartmentInput> = {},
): Department {
  const s = suffix();
  return insertDepartment(db, {
    key: `dept-${s}`,
    name: `Department ${s}`,
    room_rect: { x: 0, y: 0, w: 4, h: 4 },
    ...overrides,
  });
}

export function seedRole(db: Database.Database, overrides: Partial<NewRoleInput> = {}): Role {
  const s = suffix();
  const departmentKey = overrides.department_key ?? seedDepartment(db).key;
  return insertRole(db, {
    key: `role-${s}`,
    version: '1.0.0',
    pack_id: 'core',
    title: 'Developer',
    description: 'Writes code.',
    system_prompt_path: 'prompts/developer.md',
    skills: ['code'],
    deliverable_types: ['code'],
    engine_preference: ['claude-code'],
    tools_allow: [],
    tools_deny: [],
    memory_scopes: ['role'],
    autonomy_default: 'guided',
    sprite_key: 'dev',
    ...overrides,
    department_key: departmentKey,
  });
}

export function seedEmployee(
  db: Database.Database,
  overrides: Partial<NewEmployeeInput> = {},
): Employee {
  const s = suffix();
  const roleKey = overrides.role_key ?? seedRole(db).full_key;
  return insertEmployee(db, {
    name: `Employee-${s}`,
    desk_x: 0,
    desk_y: 0,
    sprite_variant: 'a',
    status: 'off',
    engine: 'claude-code',
    autonomy: 'guided',
    ...overrides,
    role_key: roleKey,
  });
}

export function seedProject(
  db: Database.Database,
  overrides: Partial<NewProjectInput> = {},
): Project {
  const s = suffix();
  return insertProject(db, {
    name: `Project-${s}`,
    path: `C:\\bureau-test\\${s}`,
    kind: 'software',
    ...overrides,
  });
}

/**
 * §11.3's evaluator needs a real `worktrees` row + a real `employees.
 * worktree_id` reference to resolve `${worktree}`/`${project}` at all —
 * neither existed as a seed helper before M6 session 1, which is the
 * first thing to need "an employee with a real worktree" outside of
 * workspace/'s own tests. Does NOT create the worktree directory on disk
 * — callers that need real files there (tests/integration/controlChannel/
 * policy/policyRealEvaluator.test.ts) create them explicitly, since
 * "does this path exist on disk" is exactly the thing under test there.
 */
export function seedWorktree(
  db: Database.Database,
  overrides: Partial<NewWorktreeInput> = {},
): Worktree {
  const s = suffix();
  const projectId = overrides.project_id ?? seedProject(db).id;
  return insertWorktree(db, {
    path: `C:\\bureau-test\\worktrees\\${s}`,
    branch: `bureau/emp-${s}`,
    base_commit: '0'.repeat(40),
    ...overrides,
    project_id: projectId,
  });
}

/** Wires `seedEmployee`'s employee to a real worktree row via the real
 * repository function (`setEmployeeWorktree`) — never a raw UPDATE. */
export function seedEmployeeWithWorktree(
  db: Database.Database,
  employeeOverrides: Partial<NewEmployeeInput> = {},
  worktreeOverrides: Partial<NewWorktreeInput> = {},
): { employee: Employee; worktree: Worktree } {
  const employee = seedEmployee(db, employeeOverrides);
  const worktree = seedWorktree(db, worktreeOverrides);
  setEmployeeWorktree(db, employee.id, worktree.id);
  return { employee: { ...employee, worktree_id: worktree.id }, worktree };
}

export function seedBrief(db: Database.Database, overrides: Partial<NewBriefInput> = {}): Brief {
  const projectId = overrides.project_id ?? seedProject(db).id;
  return insertBrief(db, {
    version: 1,
    content: {},
    markdown: '# Brief',
    ...overrides,
    project_id: projectId,
  });
}

export function seedPlan(db: Database.Database, overrides: Partial<NewPlanInput> = {}): Plan {
  const projectId = overrides.project_id ?? seedProject(db).id;
  const briefId = overrides.brief_id ?? seedBrief(db, { project_id: projectId }).id;
  return insertPlan(db, {
    version: 1,
    content: {},
    ...overrides,
    project_id: projectId,
    brief_id: briefId,
  });
}

export function seedPhase(db: Database.Database, overrides: Partial<NewPhaseInput> = {}): Phase {
  const planId = overrides.plan_id ?? seedPlan(db).id;
  return insertPhase(db, {
    ordinal: 1,
    name: 'Phase 1',
    goal: 'Ship it.',
    ...overrides,
    plan_id: planId,
  });
}

export function seedTask(db: Database.Database, overrides: Partial<NewTaskInput> = {}): Task {
  const projectId = overrides.project_id ?? seedProject(db).id;
  return insertTask(db, {
    title: 'A task',
    body: 'Do the thing.',
    acceptance_criteria: ['done'],
    ...overrides,
    project_id: projectId,
  });
}
