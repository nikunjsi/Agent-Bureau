import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { Employee } from '../../shared/models/employee';
import type { Project } from '../../shared/models/project';
import type { Task } from '../../shared/models/task';
import type { Worktree } from '../../shared/models/worktree';
import {
  insertWorktree,
  getWorktreeById,
  listAllWorktreePaths,
  setWorktreeStatus,
  setWorktreeBranchAndBaseCommit,
  deleteWorktree,
  acquireWorktreeLease,
} from '../db/repositories/worktrees';
import { setEmployeeWorktree } from '../db/repositories/employees';
import { setProjectRepoInitialised } from '../db/repositories/projects';
import { computeWorktreePath, assertNoWorktreePathCollision, sanitizeEmployeeDirName } from './pathSanitize';
import { addWorktree, removeWorktree, checkoutBranch, isWorktreeDirty, createBranch, deleteBranch, resolveRef } from './gitWorktree';
import { ensureRepoInitialised, ensureNonUnbornHead } from './gitInit';

function placeholderBranchName(employeeName: string): string {
  return `bureau/${sanitizeEmployeeDirName(employeeName)}/unassigned`;
}

function taskBranchName(employeeName: string, task: Task): string {
  return `bureau/${sanitizeEmployeeDirName(employeeName)}/${task.display_key}`;
}

/**
 * §28 M5 item 1: `git init` if needed, repo-level config, the initial
 * commit if `HEAD` is unborn (Q2/Q3) — idempotent, safe to call again on
 * an already-registered project. No event emitted: the user's explicit
 * git.* taxonomy for this session is exactly four names
 * (created/released/lease_acquired/lease_reclaimed); workspace
 * registration isn't one of them.
 */
export async function registerProjectWorkspace(db: Database.Database, project: Project): Promise<void> {
  await ensureRepoInitialised(project.path);
  await ensureNonUnbornHead(project.path);
  if (!project.repo_initialised) {
    setProjectRepoInitialised(db, project.id, true);
  }
}

export interface HireEmployeeWorktreeOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  project: Project;
  employee: Employee;
  companyHomePath: string;
}

/**
 * §10.3: one worktree per employee, created at hire. `branch`/
 * `base_commit` are real from the first row (Q1) — a throwaway
 * placeholder branch from the project's current `base_ref` HEAD, deleted
 * the moment a real task assignment re-points the worktree. The DB row
 * is inserted as `status='free'` directly, **before** the real
 * `git worktree add` runs (CLAUDE.md #3: commit before side effect — the
 * row IS the intent record, written first, not after; a crash between
 * the two leaves a phantom row, not an untracked orphan directory with
 * zero durable trace it was ever supposed to exist). M5 plan review fix
 * #5: `'pruning'` is not a creation marker — both crash windows are
 * resolved by the bidirectional reconciler from disk state alone, not a
 * status flag, so this ordering is what the reconciler's "phantom row →
 * delete" branch (as opposed to "orphan directory → remove") is actually
 * for.
 */
export async function hireEmployeeWorktree(options: HireEmployeeWorktreeOptions): Promise<Worktree> {
  const { db, activityLog, project, employee, companyHomePath } = options;

  const worktreePath = computeWorktreePath(companyHomePath, employee.name);
  assertNoWorktreePathCollision(worktreePath, listAllWorktreePaths(db));

  const baseCommit = await resolveRef(project.path, project.base_ref);
  const branch = placeholderBranchName(employee.name);

  const worktree = insertWorktree(db, {
    project_id: project.id,
    path: worktreePath,
    branch,
    base_commit: baseCommit,
    status: 'free',
  });
  setEmployeeWorktree(db, employee.id, worktree.id);

  await addWorktree(project.path, worktreePath, branch, baseCommit);

  activityLog.logEvent({
    actor: 'system',
    type: 'git.worktree_created',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: employee.id,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, path: worktreePath, branch, baseCommit },
  });

  return worktree;
}

export interface FireEmployeeWorktreeOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  project: Project;
  employee: Employee;
  worktree: Worktree;
}

/**
 * §28 M5 item 7 / §10.3: `git worktree remove --force` then `prune`
 * (trap b), branch retention (never deleted here — only the removal-
 * crash-window marker and the row itself are Bureau's to clean up).
 * M5 plan review fix #7: `employees.worktree_id` is an enforced FK, and
 * firing archives the employee row rather than deleting it (§6.7) — it
 * is nulled *before* the worktree row is deleted, or the delete fails on
 * the FK.
 */
export async function fireEmployeeWorktree(options: FireEmployeeWorktreeOptions): Promise<void> {
  const { db, activityLog, project, employee, worktree } = options;

  setWorktreeStatus(db, worktree.id, 'pruning');
  setEmployeeWorktree(db, employee.id, null);
  await removeWorktree(project.path, worktree.path);
  deleteWorktree(db, worktree.id);

  activityLog.logEvent({
    actor: 'system',
    type: 'git.worktree_released',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: employee.id,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, path: worktree.path, branch: worktree.branch },
  });
}

export interface AssignTaskToWorktreeOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  project: Project;
  employee: Employee;
  worktree: Worktree;
  task: Task;
  /** Q8 seam: this session's only caller passes `resolveDefaultIntegrationRef(project)`;
   * M11's Director passes a real phase branch — no other change needed. */
  integrationRef: string;
}

/**
 * §10.3/§28 M5 item 3: re-points the worktree to `bureau/<employee>/
 * <task>`, cut from the integration head at assignment time, and
 * records `base_commit`. Q4, corrected after review: a dirty worktree is
 * refused (never carried/stashed/hard-reset) *and* emits a `security`
 * event (§10.3.1 layer 4's own precedent — "an unexpected git state
 * means something wrote to the repository outside the expected flow"),
 * not just a thrown error invisible in the activity log.
 */
export async function assignTaskToWorktree(options: AssignTaskToWorktreeOptions): Promise<Worktree> {
  const { db, activityLog, project, employee, worktree, task, integrationRef } = options;

  const dirty = await isWorktreeDirty(project.path, worktree.path);
  if (dirty) {
    // M5 part 2 (D7): the `worktrees.status = 'dirty'` value finally
    // gets a real writer — part 1 shipped the enum value with nothing
    // that ever set it. This is a record for observability only, not a
    // gate anything reads: nothing checks `status === 'dirty'` to block
    // or permit an operation, and nothing recovers a worktree *out* of
    // this state automatically (there's no spec guidance on what
    // "cleaning" one even means, and guessing here would be exactly the
    // kind of auto-resolution §10.6 forbids for merges). The throw
    // below is what actually stops the reassignment — stated explicitly
    // so a future session doesn't assume this column is load-bearing
    // somewhere it isn't.
    setWorktreeStatus(db, worktree.id, 'dirty');
    activityLog.logEvent({
      actor: 'system',
      type: 'git.worktree_dirty_refused',
      severity: 'security',
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { worktreeId: worktree.id, path: worktree.path },
    });
    throw new Error(
      `worktree ${worktree.path} has uncommitted changes ahead of assigning task ${task.display_key} — refusing to re-point it. §10.3: the employee never runs git write commands, so this means the previous task's commit step never ran, or something wrote outside the expected flow.`,
    );
  }

  const baseCommit = await resolveRef(project.path, integrationRef);
  const newBranch = taskBranchName(employee.name, task);
  const previousBranch = worktree.branch;

  await checkoutBranch(project.path, worktree.path, newBranch, baseCommit);
  setWorktreeBranchAndBaseCommit(db, worktree.id, newBranch, baseCommit);

  // Only the throwaway hire-time placeholder is cleaned up here — a real
  // previous task's branch is retained (it holds real work pending
  // merge, §10.6), never deleted by a later assignment.
  if (previousBranch === placeholderBranchName(employee.name)) {
    await deleteBranch(project.path, previousBranch);
  }

  return getWorktreeById(db, worktree.id) as Worktree;
}

/** Q6: wraps the existing §5.1 transactional lease-acquire repo function
 * with the one thing it can't do itself — emit the event (repositories
 * are activityLog-agnostic throughout this codebase). Returns whether
 * the lease was acquired; `false` means someone else holds a live one. */
export function acquireLease(
  db: Database.Database,
  activityLog: ActivityLog,
  worktree: Worktree,
  employee: Employee,
  ttlSeconds: number,
): boolean {
  const leaseExpiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const acquired = acquireWorktreeLease(db, worktree.id, employee.id, leaseExpiresAt);
  if (acquired) {
    activityLog.logEvent({
      actor: 'system',
      type: 'git.lease_acquired',
      severity: 'info',
      project_id: worktree.project_id,
      task_id: null,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { worktreeId: worktree.id, leaseExpiresAt },
    });
  }
  return acquired;
}

/** Q8: this session's only implementation of "what is the integration
 * head" — the project's own base branch. The Director (M11) computes a
 * real integration ref (a phase branch) and passes that to
 * `assignTaskToWorktree` instead — no change to this function or that one. */
export function resolveDefaultIntegrationRef(project: Project): string {
  return project.base_ref;
}

/**
 * §10.6/Q8: creates `bureau/phase/<n>` as a **standalone git operation**
 * with no `phases`/`plans` dependency — proves "creating the branch is
 * in scope" (merging into it is not) without needing a real `phases` row
 * to exist. Ref-only (Q5): never checks the branch out anywhere.
 */
export async function createPhaseIntegrationBranch(
  repoPath: string,
  phaseNumber: number,
  baseRef: string,
): Promise<{ branch: string; baseCommit: string }> {
  const branch = `bureau/phase/${phaseNumber}`;
  const baseCommit = await resolveRef(repoPath, baseRef);
  await createBranch(repoPath, branch, baseCommit);
  return { branch, baseCommit };
}
