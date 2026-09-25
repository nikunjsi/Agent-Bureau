import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { reconcile } from '../../../src/main/db/reconcile';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import type { Project } from '../../../src/shared/models/project';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TRIVIAL_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
];

/**
 * P-5 / chaos scenario #6: "a worktree is deleted externally while leased".
 *
 * What N-12's test covers: deletion before a restart. `reconcile()` prunes
 * git's record (`reconcilePrunesDeletedWorktree.test.ts`).
 *
 * The remainder, named:
 *  1. **"While leased" cannot be tested as written**, because no lease is ever
 *     taken (N-11: the lease is reserved). The live equivalent is an employee
 *     with a task assigned to that worktree, which is what this test uses.
 *  2. **Nothing notices mid-session.** There is no file watcher, and
 *     `reconcile()` runs at startup only. A deletion is discovered at the next
 *     git operation on that worktree, which is the commit. That is the gap,
 *     and it is stated here rather than closed: a watcher is not in any row's
 *     scope.
 *
 * So the test pins the behaviour at the point of discovery: the commit fails
 * without committing anything, without a security event blaming the
 * employee, and without leaving a pending-commit marker behind; the task is
 * not moved to done; and the next `reconcile()` converges the database (the
 * phantom worktree row is deleted and the employee's reference cleared).
 */
describe('a worktree deleted mid-task (P-5, chaos #6)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-wtgone-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-wtgone-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-wtgone-home-'));
    const dbPath = path.join(dbDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(dbDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(dbDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    for (const dir of [dbDir, repoPath, companyHomePath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the commit fails safe, and reconcile converges the database', async () => {
    const seeded = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, seeded);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(
      await getCheckedOutBranch(repoPath),
      seeded.id,
    );
    const project = getProjectById(db, seeded.id) as Project;
    const employee = seedEmployee(db, { name: 'Quinn' });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: 'Doomed', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });
    writeFileSync(path.join(worktree.path, 'work.txt'), 'work that is about to vanish\n');

    // Deleted from outside Bureau, mid-task.
    rmSync(worktree.path, { recursive: true, force: true });

    await expect(
      commitTaskWork({
        db,
        activityLog,
        project,
        employee: getEmployeeById(db, employee.id)!,
        worktree,
        task: getTaskById(db, task.id)!,
        validators: TRIVIAL_VALIDATORS,
      }),
    ).rejects.toThrow();

    const count = (type: string) =>
      (db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n;
    expect(count('git.committed')).toBe(0);
    expect(count('git.unexpected_commit_detected')).toBe(0);
    expect(getWorktreeById(db, worktree.id)?.pending_commit_task_id).toBeNull();
    expect(getTaskById(db, task.id)?.status).not.toBe('done');

    await reconcile(db, activityLog, dbDir);

    expect(getWorktreeById(db, worktree.id)).toBeNull();
    expect(getEmployeeById(db, employee.id)?.worktree_id).toBeNull();
    const released = db
      .prepare("SELECT payload FROM events WHERE type = 'git.worktree_released'")
      .all() as Array<{ payload: string }>;
    expect(released.map((row) => JSON.parse(row.payload).reason)).toContain(
      'reconcile_phantom_row',
    );
  });
});
