import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { TokenRegistry } from '../controlChannel/tokens';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { SupervisorOptions } from '../engine/supervisor';
import type { ContainProcess } from '../engine/containEngineChild';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { SecretBroker } from '../../shared/engine/seams';
import type { Employee } from '../../shared/models/employee';
import type { Project } from '../../shared/models/project';
import type { Role } from '../../shared/models/role';
import type { Task } from '../../shared/models/task';
import type { Worktree } from '../../shared/models/worktree';
import { getSetting } from '../db/repositories/settings';
import { getSoleCompany } from '../db/repositories/companies';
import {
  getEmployeeById,
  releaseEmployeeTask,
  setEmployeeWorktree,
} from '../db/repositories/employees';
import { getProjectById } from '../db/repositories/projects';
import { getPhaseById, setPhaseStatus } from '../db/repositories/phases';
import { getRoleByFullKey } from '../db/repositories/roles';
import { blockTaskUnassigned, getTaskById } from '../db/repositories/tasks';
import { deleteWorktree, getWorktreeById } from '../db/repositories/worktrees';
import { createEmployeeAdapter } from '../engine/employeeAdapter';
import { spawnSupervisedEmployee } from '../engine/spawnSupervisedEmployee';
import { composeEmployeeContext } from '../company/composeEmployeeContext';
import { ensureProjectWorkspace } from '../workspace/projectWorkspace';
import {
  assignTaskToWorktree,
  fireEmployeeWorktree,
  hireEmployeeWorktree,
} from '../workspace/employeeWorktree';
import { createBranch, pruneWorktrees, resolveRef } from '../workspace/gitWorktree';
import { GitCommandError } from '../workspace/gitProcess';
import { readyTasks } from './readyTasks';
import { AssignmentRefusedError, claimTask, eligibleEmployees } from './assignment';

/**
 * §26.2, the autonomous assignment loop (M11 S3-2b). **Plain code, no
 * model**: the Director sets what the tasks are; this decides who, by a rule
 * the user can read, and costs no Director turn per assignment.
 *
 * One pass:
 * 1. Claims already made but not started (a restart, or `bureau_assign_task`)
 *    are started first.
 * 2. For each ready task (`readyTasks`: an approved, current plan's current
 *    phase, dependencies done), while fewer than
 *    `orchestrator.maxConcurrentEmployees` tasks are running: the first
 *    eligible employee by §8.5's key (`eligibleEmployees`) is claimed for it
 *    (`claimTask`, one transaction). Nobody eligible leaves the task waiting;
 *    S3-3 tells the Director.
 * 3. Each claimed task is started: the project's folder is made ready
 *    (`ensureProjectWorkspace`); a `pending` phase starts on
 *    `bureau/phase/<n>` cut from `base_ref` (§10.6 rule 1); the employee's
 *    worktree is checked to exist — made again when it was lost, moved when it
 *    belongs to another project — and pointed at a task branch cut from the
 *    phase branch (rule 2); then the employee is spawned through the
 *    production chain (`createEmployeeAdapter`, `spawnSupervisedEmployee`,
 *    `composeEmployeeContext`, `Supervisor.assign()`), which starts an `off`
 *    employee. A running employee is stopped first, so each task starts in a
 *    fresh process with its own context.
 *
 * Anything that stops a claimed task from starting blocks it with the reason
 * in plain words and frees the employee — never a blind retry.
 *
 * What wakes it: the events that change what could be assigned (a plan
 * approved, a task finishing or freed, a phase done, an employee stopping or
 * going idle), and `kick()`. One pass at a time; a kick during a pass runs one
 * more after it. Never a timer.
 */
export interface AssignmentLoopDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly supervisorRegistry: SupervisorRegistry;
  readonly tokenRegistry: TokenRegistry;
  readonly controlChannelPort: number;
  readonly baseDir: string;
  readonly bundledPacksDir: string;
  readonly secretBroker: SecretBroker;
  readonly containProcess: ContainProcess;
  readonly resolveToolsScriptPath?: () => string;
  readonly supervisorOptions?: Partial<
    Omit<
      SupervisorOptions,
      'db' | 'activityLog' | 'adapter' | 'tokenRegistry' | 'supervisorRegistry'
    >
  >;
  /** Test seam: the employee's adapter. Production uses `createEmployeeAdapter`. */
  readonly createAdapter?: (db: Database.Database, employee: Employee, role: Role) => EngineAdapter;
}

export interface AssignmentLoop {
  /** Run a pass now, or one more after the pass in progress. */
  kick(): void;
  /** Resolves when no pass is running (tests, and shutdown). */
  settled(): Promise<void>;
  stop(): void;
}

/** What may have made new work assignable. */
const WAKE_ON = new Set([
  'project.plan_approved',
  'task.assigned',
  'task.completed',
  'task.cancelled',
  'task.unblocked',
  'task.reassigned',
  'phase.accepted',
  'phase.completed',
  'phase.skipped',
  'employee.idle',
  'employee.off',
  'employee.stopped',
]);

export function createAssignmentLoop(deps: AssignmentLoopDeps): AssignmentLoop {
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;

  const kick = (): void => {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await pass(deps);
      } while (again && !stopped);
    })()
      .catch((err: unknown) => console.error('[assignment loop]', err))
      .finally(() => {
        running = null;
      });
  };

  const unsubscribe = deps.activityLog.onEvent((entry) => {
    if (WAKE_ON.has(entry.type)) kick();
  });

  return {
    kick,
    settled: async () => {
      while (running !== null) await running;
    },
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

async function pass(deps: AssignmentLoopDeps): Promise<void> {
  const { db } = deps;

  // 1. Claims made but never started: a restart, or the Director's tool.
  const unstarted = (
    db
      .prepare(
        `SELECT id FROM tasks WHERE status = 'assigned' AND assignee_employee_id IS NOT NULL
          ORDER BY rowid`,
      )
      .all() as { id: string }[]
  ).filter((row) => {
    const task = getTaskById(db, row.id);
    return task !== null && deps.supervisorRegistry.get(task.assignee_employee_id!) === undefined;
  });
  for (const row of unstarted) await startClaimedTask(deps, row.id);

  // 2. New claims, up to the cap.
  const cap = getSetting(db, 'orchestrator.maxConcurrentEmployees');
  for (const task of readyTasks(db)) {
    if (runningTaskCount(db) >= cap) return;
    const best = eligibleEmployees(db, task.id).eligible[0];
    if (best === undefined) continue;
    try {
      claimTask({ db, activityLog: deps.activityLog }, { taskId: task.id, employeeId: best.id });
    } catch (err) {
      if (err instanceof AssignmentRefusedError) continue;
      throw err;
    }
    await startClaimedTask(deps, task.id);
  }
}

/** Tasks someone is working on now. */
function runningTaskCount(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('assigned', 'running') AND assignee_employee_id IS NOT NULL",
      )
      .get() as { n: number }
  ).n;
}

async function startClaimedTask(deps: AssignmentLoopDeps, taskId: string): Promise<void> {
  const { db, activityLog } = deps;
  const task = getTaskById(db, taskId);
  if (task === null || task.assignee_employee_id === null) return;
  const employee = getEmployeeById(db, task.assignee_employee_id);
  if (employee === null) return;

  const fail = (reason: string): void => blockAndFree(deps, task, employee, reason);

  const workspace = await ensureProjectWorkspace({ db, activityLog }, task.project_id);
  if (!workspace.ok) return fail(workspace.reason);
  const project = getProjectById(db, task.project_id)!;

  const phaseBranch = await startPhase(deps, project, task);
  if (typeof phaseBranch !== 'string' || phaseBranch.startsWith('!')) {
    return fail(String(phaseBranch).slice(1));
  }

  const worktree = await worktreeFor(deps, project, employee);
  if (typeof worktree === 'string') return fail(worktree);

  try {
    await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee: getEmployeeById(db, employee.id)!,
      worktree,
      task,
      integrationRef: phaseBranch,
    });
  } catch (err) {
    return fail(`its worktree could not be pointed at the task: ${messageOf(err)}`);
  }

  const role = getRoleByFullKey(db, employee.role_key);
  if (role === null) return fail(`${employee.name}'s role ${employee.role_key} is not installed.`);

  // A fresh process per task: a running one (idle after its last task) stops
  // first, so the new task starts with its own context.
  await deps.supervisorRegistry.get(employee.id)?.stop();
  const adapter = (deps.createAdapter ?? defaultAdapter(deps))(db, employee, role);
  const spawned = await spawnSupervisedEmployee({
    db,
    activityLog,
    tokenRegistry: deps.tokenRegistry,
    supervisorRegistry: deps.supervisorRegistry,
    controlChannelPort: deps.controlChannelPort,
    employeeId: employee.id,
    adapter,
    baseDir: deps.baseDir,
    ...(deps.supervisorOptions === undefined ? {} : { supervisorOptions: deps.supervisorOptions }),
  });
  try {
    const ctx = composeEmployeeContext(
      {
        db,
        baseDir: deps.baseDir,
        bundledPacksDir: deps.bundledPacksDir,
        broker: deps.secretBroker,
        ...(deps.resolveToolsScriptPath === undefined
          ? {}
          : { resolveToolsScriptPath: deps.resolveToolsScriptPath }),
      },
      spawned,
      employee.id,
      task.id,
    );
    await spawned.supervisor.assign(ctx);
  } catch (err) {
    await spawned.supervisor.stop();
    return fail(`${employee.name} could not be started: ${messageOf(err)}`);
  }
}

function defaultAdapter(
  deps: AssignmentLoopDeps,
): (db: Database.Database, employee: Employee, role: Role) => EngineAdapter {
  return (db, employee, role) =>
    createEmployeeAdapter(db, employee, role, { containProcess: deps.containProcess });
}

/**
 * §10.6 rule 1: a phase starts on its own integration branch, cut from
 * `base_ref`, the first time one of its tasks is started. Returns the branch,
 * or `!reason` when git refused.
 */
async function startPhase(deps: AssignmentLoopDeps, project: Project, task: Task): Promise<string> {
  const phase = task.phase_id === null ? null : getPhaseById(deps.db, task.phase_id);
  if (phase === null) return '!the task belongs to no phase.';
  const branch = `bureau/phase/${phase.ordinal}`;
  try {
    let baseCommit: string;
    try {
      baseCommit = await resolveRef(project.path, `refs/heads/${branch}`);
    } catch (err) {
      if (!(err instanceof GitCommandError)) throw err;
      baseCommit = await resolveRef(project.path, project.base_ref);
      await createBranch(project.path, branch, baseCommit);
    }
    if (phase.status === 'pending') {
      setPhaseStatus(deps.db, phase.id, 'active');
      deps.activityLog.logEvent({
        actor: 'system',
        type: 'phase.started',
        severity: 'info',
        project_id: project.id,
        task_id: null,
        employee_id: null,
        checkpoint_id: null,
        payload: { phaseId: phase.id, ordinal: phase.ordinal, branch, baseCommit },
      });
    }
    return branch;
  } catch (err) {
    return `!the phase branch ${branch} could not be made: ${messageOf(err)}`;
  }
}

/**
 * The employee's worktree for this project, checked before each task: made
 * when there is none, made again when its folder was lost, and moved when it
 * belongs to another project. Returns the worktree, or the reason it could
 * not be had.
 */
async function worktreeFor(
  deps: AssignmentLoopDeps,
  project: Project,
  employee: Employee,
): Promise<Worktree | string> {
  const { db, activityLog } = deps;
  const company = getSoleCompany(db);
  if (company === null) return 'there is no company to put a worktree under.';
  let worktree = employee.worktree_id === null ? null : getWorktreeById(db, employee.worktree_id);
  try {
    if (worktree !== null && worktree.project_id !== project.id) {
      const other = getProjectById(db, worktree.project_id);
      if (other !== null) {
        await fireEmployeeWorktree({ db, activityLog, project: other, employee, worktree });
      }
      worktree = null;
    }
    if (worktree !== null && !existsSync(worktree.path)) {
      // Lost: the record goes, git forgets it, and a new one is made below.
      setEmployeeWorktree(db, employee.id, null);
      deleteWorktree(db, worktree.id);
      await pruneWorktrees(project.path);
      activityLog.logEvent({
        actor: 'system',
        type: 'git.worktree_released',
        severity: 'warn',
        project_id: project.id,
        task_id: null,
        employee_id: employee.id,
        checkpoint_id: null,
        payload: { worktreeId: worktree.id, path: worktree.path, reason: 'missing_on_disk' },
      });
      worktree = null;
    }
    if (worktree === null) {
      worktree = await hireEmployeeWorktree({
        db,
        activityLog,
        project,
        employee: getEmployeeById(db, employee.id)!,
        companyHomePath: company.home_path,
      });
    }
    return worktree;
  } catch (err) {
    return `${employee.name}'s worktree could not be made ready: ${messageOf(err)}`;
  }
}

/** The task goes back to nobody, blocked with the reason; the employee is free. */
function blockAndFree(
  deps: AssignmentLoopDeps,
  task: Task,
  employee: Employee,
  reason: string,
): void {
  deps.db.transaction(() => {
    blockTaskUnassigned(deps.db, task.id, reason);
    releaseEmployeeTask(deps.db, employee.id, task.id);
  })();
  deps.activityLog.logEvent({
    actor: 'system',
    type: 'task.blocked',
    severity: 'warn',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: employee.id,
    checkpoint_id: null,
    payload: { reason },
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
