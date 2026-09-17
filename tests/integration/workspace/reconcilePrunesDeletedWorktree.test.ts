import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { reconcile } from '../../../src/main/db/reconcile';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import type { Project } from '../../../src/shared/models/project';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * N-12 / §4.4 ("git worktree prune run") and §10.5 ("`prune` alone only
 * cleans records for directories that are already gone"). A worktree
 * directory deleted from outside Bureau leaves git's own record behind in
 * `.git/worktrees/`. The DB-row loop and the orphan-directory loop in
 * `reconcileProjectWorktrees` both skip a directory that no longer exists, so
 * only the standalone `pruneWorktrees` call removes that record. Before this
 * test, deleting that call left the whole suite green.
 */
describe('reconcile() prunes git’s record of an externally deleted worktree (N-12)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-prune-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-prune-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-prune-home-'));
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

  function listedWorktreePaths(): string[] {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.normalize(line.slice('worktree '.length)).toLowerCase());
  }

  it('the deleted worktree is gone from `git worktree list --porcelain` after reconcile()', async () => {
    const seeded = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, seeded);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(
      await getCheckedOutBranch(repoPath),
      seeded.id,
    );
    const project = getProjectById(db, seeded.id) as Project;
    const worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee: seedEmployee(db, { name: 'Ravi' }),
      companyHomePath,
    });
    const worktreePath = path.normalize(realpathSync.native(worktree.path)).toLowerCase();
    expect(listedWorktreePaths()).toContain(worktreePath);

    // Deleted from outside Bureau: the directory only, git's record stays.
    rmSync(worktree.path, { recursive: true, force: true });
    expect(listedWorktreePaths()).toContain(worktreePath);

    await reconcile(db, activityLog, dbDir);

    expect(listedWorktreePaths()).not.toContain(worktreePath);
  });
});
