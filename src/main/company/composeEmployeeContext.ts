import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { getEmployeeById } from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { getTaskById } from '../db/repositories/tasks';
import { getWorktreeById } from '../db/repositories/worktrees';
import {
  buildControlChannelAndToolServerContext,
  type SpawnSupervisedEmployeeResult,
} from '../engine/spawnSupervisedEmployee';
import { packFilePath } from '../packs/packFilePath';
import type { EmployeeContext } from '../../shared/engine/types';
import type { SecretBroker } from '../../shared/engine/seams';
import type { Role } from '../../shared/models/role';

export interface ComposeEmployeeContextDeps {
  readonly db: Database.Database;
  /** Electron's userData root: memory, packs and state live under it. */
  readonly baseDir: string;
  /** The app's bundled `packs/`, where a bundled role's prompt is read. */
  readonly bundledPacksDir: string;
  readonly broker: SecretBroker;
  /** Injectable for plain-Node tests (see `buildControlChannelAndToolServerContext`). */
  readonly resolveToolsScriptPath?: () => string;
}

/**
 * An `EmployeeContext` for a hired employee and a task (M11 S3-1,
 * `NEXT-VERSION` §H.6). The Director's is composed by `startDirector`; this
 * is the employees', and the assignment loop (S3-2) is its caller.
 *
 * Everything comes from rows: the employee, its role, the task, the
 * employee's worktree, and the role's prompt from its pack. **It decides no
 * model**: `modelId` is `null` here and `Supervisor.assign()` resolves the
 * tier, the one place a model is decided (§7.5, standing rule 6). The memory
 * pack is not composed here either — the Supervisor composes it when it
 * sends the task (§12.3), and renders Appendix B around it.
 *
 * Throws when a row it needs is missing: the loop checks the worktree before
 * each task (S3-2), so a missing one here is a programming error, not a
 * state to paper over.
 */
export function composeEmployeeContext(
  deps: ComposeEmployeeContextDeps,
  spawned: Pick<
    SpawnSupervisedEmployeeResult,
    'stateDir' | 'controlChannelPort' | 'token' | 'controlJsonPath'
  >,
  employeeId: string,
  taskId: string,
): EmployeeContext {
  const { db } = deps;
  const employee = getEmployeeById(db, employeeId);
  if (employee === null) throw new Error(`employee ${employeeId} does not exist`);
  const role = getRoleByFullKey(db, employee.role_key);
  if (role === null) throw new Error(`the role ${employee.role_key} is not installed`);
  const task = getTaskById(db, taskId);
  if (task === null) throw new Error(`task ${taskId} does not exist`);
  const worktree = employee.worktree_id === null ? null : getWorktreeById(db, employee.worktree_id);
  if (worktree === null) throw new Error(`${employee.name} has no worktree to work in`);

  return {
    employee,
    role,
    task,
    worktreePath: worktree.path,
    stateDir: spawned.stateDir,
    baseDir: deps.baseDir,
    broker: deps.broker,
    // Decided by Supervisor.assign(), never here (§7.5).
    modelId: null,
    turnBudgetCapUsdMicros: null,
    rolePrompt: readRolePrompt(deps, role),
    ...buildControlChannelAndToolServerContext(
      spawned,
      ...(deps.resolveToolsScriptPath === undefined ? [] : [deps.resolveToolsScriptPath]),
    ),
  };
}

/** The role's prompt, then each shared prompt it names, in order. A file
 *  that is not there is left out rather than guessed at. */
function readRolePrompt(deps: ComposeEmployeeContextDeps, role: Role): string {
  return [role.system_prompt_path, ...role.shared_prompts]
    .map((relative) => packFilePath(deps, role.pack_id, relative))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, 'utf8').trim())
    .join('\n\n');
}
