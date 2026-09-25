/**
 * The worker driven by tests/integration/workspace/reconcileCrashWindows.test.ts
 * (gate item 4: "real process kill at each of the two crash windows this
 * session introduces, restart, reconcile() converges both times"). Mirrors
 * dbKillWorker.ts's own technique exactly (STEP_DONE markers + a blocking
 * stdin ack read, so the parent can force-kill at a precisely pinned point
 * rather than racing the child's fast synchronous execution) — applied to
 * the two windows M5 part 1 actually introduces:
 *
 *   1. Between the `worktrees` row (+ `employees.worktree_id` FK) being
 *      durably written and the real `git worktree add` running —
 *      CLAUDE.md #3's "commit before side effect", applied to worktree
 *      creation for the first time this session.
 *   2. Between the real `git worktree remove` succeeding and the
 *      `worktrees` row actually being deleted, on the fire path.
 *
 * Both use the real production functions
 * (`insertWorktree`/`setEmployeeWorktree`/`addWorktree`/`removeWorktree`/
 * `deleteWorktree`/`setWorktreeStatus`) in the exact order
 * `employeeWorktree.ts` itself uses — this script is a hand-instrumented
 * *sequence* of those same real calls, not a reimplementation of them,
 * for the same reason dbKillWorker.ts's own doc comment gives for its
 * steps 15-16.
 */
import { readSync } from 'node:fs';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { nowIso } from '../../../src/shared/models/ids';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertWorktree } from '../../../src/main/db/repositories/worktrees';
import { setEmployeeWorktree } from '../../../src/main/db/repositories/employees';
import { registerProjectWorkspace } from '../../../src/main/workspace/employeeWorktree';
import {
  computeWorktreePath,
  assertNoWorktreePathCollision,
} from '../../../src/main/workspace/pathSanitize';
import {
  resolveRef,
  addWorktree,
  removeWorktree,
  getCheckedOutBranch,
} from '../../../src/main/workspace/gitWorktree';
import {
  setWorktreeStatus,
  deleteWorktree,
  listAllWorktreePaths,
} from '../../../src/main/db/repositories/worktrees';

function announceAndWaitForAck(step: number): void {
  process.stdout.write(`STEP_DONE ${step}\n`);
  const buffer = Buffer.alloc(1);
  try {
    readSync(0, buffer, 0, 1, null);
  } catch {
    // stdin closed (the parent killed us mid-read) — nothing to do.
  }
}

async function main(): Promise<void> {
  const dbPath = process.env['BUREAU_WTKILLTEST_DB_PATH'];
  const activityLogPath = process.env['BUREAU_WTKILLTEST_ACTIVITY_LOG_PATH'];
  const migrationsDir = process.env['BUREAU_WTKILLTEST_MIGRATIONS_DIR'];
  const backupsDir = process.env['BUREAU_WTKILLTEST_BACKUPS_DIR'];
  const repoPath = process.env['BUREAU_WTKILLTEST_REPO_PATH'];
  const companyHomePath = process.env['BUREAU_WTKILLTEST_HOME_PATH'];
  if (
    !dbPath ||
    !activityLogPath ||
    !migrationsDir ||
    !backupsDir ||
    !repoPath ||
    !companyHomePath
  ) {
    throw new Error('worktreeKillWorker: missing required BUREAU_WTKILLTEST_* env vars');
  }

  const db = openConnection(dbPath);
  await runMigrations({ db, dbPath, migrationsDir, backupsDir });
  const activityLog = ActivityLog.open(activityLogPath, db);
  const now = nowIso();

  // §5.0: ids are 26-char ULIDs (IdSchema.length(26)) — every row this
  // worker later reads back through a real repository getter (e.g.
  // getEmployeeById) must satisfy that exactly, so literal short ids are
  // padded, same convention singleWriterAndLocking.test.ts already uses
  // for its own raw-SQL-seeded fixtures.
  const departmentId = 'dept1'.padEnd(26, '0');
  const roleId = 'role1'.padEnd(26, '0');
  const employeeId = 'emp1'.padEnd(26, '0');

  db.prepare(
    'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
  ).run(departmentId, 'engineering', 'Engineering', '{}', now, now);
  db.prepare(
    `INSERT INTO roles (id,key,department_key,pack_id,version,title,description,system_prompt_path,skills,deliverable_types,engine_preference,tools_allow,tools_deny,memory_scopes,autonomy_default,sprite_key,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    roleId,
    'developer',
    'engineering',
    'core',
    '1.0.0',
    'Dev',
    'd',
    'p.md',
    '[]',
    '[]',
    '[]',
    '[]',
    '[]',
    '[]',
    'guided',
    'dev',
    now,
    now,
  );
  db.prepare(
    'INSERT INTO employees (id,name,role_key,desk_x,desk_y,sprite_variant,status,engine,autonomy,hired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    employeeId,
    'Quinn',
    'core:developer',
    0,
    0,
    'a',
    'off',
    'claude-code',
    'guided',
    now,
    now,
    now,
  );

  let project = insertProject(db, {
    name: 'Kill Window Project',
    path: repoPath,
    kind: 'software',
  });
  await registerProjectWorkspace(db, project);
  const initialBranch = await getCheckedOutBranch(repoPath);
  db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
  project = { ...project, base_ref: initialBranch, repo_initialised: true };

  const employeeName = 'Quinn';

  // --- hire, hand-instrumented around window 1 ---
  const worktreePath = computeWorktreePath(companyHomePath, employeeName);
  assertNoWorktreePathCollision(worktreePath, listAllWorktreePaths(db));
  const baseCommit = await resolveRef(project.path, project.base_ref);
  const branch = `bureau/${employeeName.toLowerCase()}/unassigned`;

  const worktree = insertWorktree(db, {
    project_id: project.id,
    path: worktreePath,
    branch,
    base_commit: baseCommit,
    status: 'free',
  });
  setEmployeeWorktree(db, employeeId, worktree.id);

  // Window 1: the row (+ FK) is durably committed; git worktree add has
  // not run yet. A kill withheld here must reconcile to a phantom-row
  // cleanup.
  announceAndWaitForAck(1);

  await addWorktree(project.path, worktreePath, branch, baseCommit);

  activityLog.logEvent({
    actor: 'system',
    type: 'git.worktree_created',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, path: worktreePath, branch, baseCommit },
  });

  // --- fire, hand-instrumented around window 2 ---
  setWorktreeStatus(db, worktree.id, 'pruning');
  setEmployeeWorktree(db, employeeId, null);
  await removeWorktree(project.path, worktree.path);

  // Window 2: the directory is already gone on disk; the row has not
  // been deleted yet. A kill withheld here must reconcile to the same
  // phantom-row cleanup path.
  announceAndWaitForAck(2);

  deleteWorktree(db, worktree.id);

  activityLog.logEvent({
    actor: 'system',
    type: 'git.worktree_released',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, path: worktree.path, branch: worktree.branch },
  });

  // Stay alive — the parent controls exactly when this process dies.
  setInterval(() => {}, 60_000);
}

void main();
