import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  fireEmployeeWorktree,
} from '../../../src/main/workspace/employeeWorktree';
import {
  listWorktreesPorcelain,
  getCheckedOutBranch,
} from '../../../src/main/workspace/gitWorktree';
import { WorktreeNameCollisionError } from '../../../src/main/workspace/pathSanitize';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import type { Project } from '../../../src/shared/models/project';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('hireEmployeeWorktree / fireEmployeeWorktree (§28 M5 items 1, 2, 7 — gate items 1 and 5)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-m5-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-m5-home-'));
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
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(repoPath, { recursive: true, force: true });
    rmSync(companyHomePath, { recursive: true, force: true });
  });

  /** `registerProjectWorkspace` runs a real `git init`, which honours
   * whatever `init.defaultBranch` the machine running this test has
   * configured (git's own default has changed across versions/OS
   * installs) — never assumed to be "main". The project's `base_ref` is
   * corrected to match the real branch git actually created, so the rest
   * of the test exercises real, resolvable refs throughout. */
  async function setUpRegisteredProject(): Promise<Project> {
    const project = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, project);
    const initialBranch = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
    return getProjectById(db, project.id) as Project;
  }

  it('gate 1: hires 3 employees — worktrees on disk match `git worktree list --porcelain` AND the `worktrees` table; main tree checkout unchanged', async () => {
    const project = await setUpRegisteredProject();
    const branchBefore = await getCheckedOutBranch(repoPath);

    const employees = [
      seedEmployee(db, { name: 'Quinn' }),
      seedEmployee(db, { name: 'Wren' }),
      seedEmployee(db, { name: 'Wei' }),
    ];
    const worktrees = [];
    for (const employee of employees) {
      worktrees.push(
        await hireEmployeeWorktree({ db, activityLog, project, employee, companyHomePath }),
      );
    }

    // Real command, real output — exactly what the gate item asks for.
    const porcelainRaw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    console.log('--- git worktree list --porcelain (3 hires) ---\n' + porcelainRaw);

    const diskEntries = await listWorktreesPorcelain(repoPath); // already excludes the main tree
    expect(
      diskEntries,
      'exactly 3 worktree entries — the main tree must not appear as a 4th',
    ).toHaveLength(3);

    // Path-identity comparisons use fs.realpathSync.native throughout this
    // codebase (§11.3), never string normalization — Windows can report the
    // *same* directory via a short (8.3) name in one context (e.g. a
    // %TEMP%-derived path) and the long name in another (git's own
    // canonicalized porcelain output), which a naive normalize/lowercase
    // compare treats as different paths even though they're identical on
    // disk.
    const mainRepoReal = fs.realpathSync.native(repoPath);
    expect(diskEntries.some((e) => fs.realpathSync.native(e.path) === mainRepoReal)).toBe(false);

    const diskPathsReal = new Set(diskEntries.map((e) => fs.realpathSync.native(e.path)));
    for (const wt of worktrees) {
      expect(existsSync(wt.path), `${wt.path} must actually exist on disk`).toBe(true);
      expect(
        diskPathsReal.has(fs.realpathSync.native(wt.path)),
        `worktree ${wt.path} must be a real entry on disk`,
      ).toBe(true);

      const row = getWorktreeById(db, wt.id);
      expect(row, 'the DB row must exist').not.toBeNull();
      expect(row!.status).toBe('free');
      expect(row!.path).toBe(wt.path);
      // Q1: base_commit is a real, resolvable SHA — the repo's own initial commit.
      const resolvedInMainRepo = execFileSync('git', ['rev-parse', project.base_ref], {
        cwd: repoPath,
        encoding: 'utf8',
      }).trim();
      expect(row!.base_commit).toBe(resolvedInMainRepo);
    }

    const branchAfter = await getCheckedOutBranch(repoPath);
    expect(
      branchAfter,
      "hiring employees must never change what's checked out in the main tree",
    ).toBe(branchBefore);
  });

  it('listWorktreesPorcelain excludes the main working tree itself (M5 plan review fix #3) — a repo with zero created worktrees reports zero, not one', async () => {
    await setUpRegisteredProject();
    const entries = await listWorktreesPorcelain(repoPath);
    expect(entries).toEqual([]);
  });

  it('trap e: hiring "Quinn" then "quinn" collides loudly (WorktreeNameCollisionError), not silently sharing a directory', async () => {
    const project = await setUpRegisteredProject();

    const quinn = seedEmployee(db, { name: 'Quinn' });
    await hireEmployeeWorktree({ db, activityLog, project, employee: quinn, companyHomePath });

    const raviLower = seedEmployee(db, { name: 'quinn' });
    await expect(
      hireEmployeeWorktree({ db, activityLog, project, employee: raviLower, companyHomePath }),
    ).rejects.toThrow(WorktreeNameCollisionError);

    // The collision is caught before any git side effect — no orphaned
    // second worktree, no second row.
    const rows = db.prepare('SELECT COUNT(*) as n FROM worktrees').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('gate 5: fires an employee — worktree removed & pruned, row deleted, worktree_id nulled, git.worktree_released emitted, branch retained', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Quinn' });
    const worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const branchName = worktree.branch;

    await fireEmployeeWorktree({ db, activityLog, project, employee, worktree });

    // Real command, real output.
    const porcelainRaw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    console.log('--- git worktree list --porcelain (after fire) ---\n' + porcelainRaw);
    expect(porcelainRaw.replace(/\\/g, '/')).not.toContain(worktree.path.replace(/\\/g, '/'));

    expect(existsSync(worktree.path), 'the worktree directory itself must be gone').toBe(false);
    expect(getWorktreeById(db, worktree.id), 'the worktrees row must be deleted').toBeNull();
    expect(
      getEmployeeById(db, employee.id)?.worktree_id,
      'employees.worktree_id must be nulled',
    ).toBeNull();

    const branchListRaw = execFileSync('git', ['branch', '--list', branchName], {
      cwd: repoPath,
      encoding: 'utf8',
    });

    console.log('--- git branch --list (retained) ---\n' + branchListRaw);
    expect(
      branchListRaw.trim().length,
      `branch ${branchName} must be retained per §10.3/§10.6, not deleted by the fire flow`,
    ).toBeGreaterThan(0);

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'git.worktree_released'")
      .all() as Array<{ employee_id: string | null }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.employee_id).toBe(employee.id);
  });
});
