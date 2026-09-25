import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import type { Employee } from '../../../src/shared/models/employee';
import type { Project } from '../../../src/shared/models/project';
import type { Task } from '../../../src/shared/models/task';
import type { Worktree } from '../../../src/shared/models/worktree';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TRIVIAL_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
];

function diskFull(): Error {
  return Object.assign(new Error('ENOSPC: no space left on device, write'), {
    code: 'ENOSPC',
    errno: -4055,
  });
}

/**
 * P-1 / chaos scenario #4: "fill the disk during a commit".
 *
 * `ENOSPC` is injected at the two boundaries of `commitTaskWork`'s write
 * step, through its existing test seam: after the durable intent marker (the
 * disk fills before `git add`/`git commit` land) and after `git commit` (the
 * disk fills before the atomic DB update). A real full disk cannot be
 * produced portably in a test. These are the two places a write failure can
 * leave different durable state behind, and any other failure inside the
 * step leaves one of these two states.
 *
 * Fail-safe means: the error reaches the caller (nothing swallowed), there is
 * never a half commit (HEAD is the old base or a complete commit), the
 * pending-commit marker is kept for recovery rather than lost, no security
 * event is raised against Bureau's own interrupted work, and `reconcile()`
 * converges so the next attempt works.
 */
describe('a full disk during a commit fails safe and converges (P-1, chaos #4)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-enospc-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-enospc-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-enospc-home-'));
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

  async function setUp(): Promise<{
    project: Project;
    employee: Employee;
    worktree: Worktree;
    task: Task;
  }> {
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
    const task = seedTask(db, { project_id: project.id, title: 'Disk full', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });
    writeFileSync(path.join(worktree.path, 'work.txt'), 'real work\n', 'utf8');
    return { project, employee, worktree, task };
  }

  function head(worktreePath: string): string {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
    }).trim();
  }

  function eventCount(type: string): number {
    return (
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(type) as { n: number }
    ).n;
  }

  it('disk fills before the commit lands: no commit, marker kept, reconcile clears it, the retry commits', async () => {
    const { project, employee, worktree, task } = await setUp();
    const base = worktree.base_commit;

    await expect(
      commitTaskWork({
        db,
        activityLog,
        project,
        employee,
        worktree,
        task,
        validators: TRIVIAL_VALIDATORS,
        testHooks: {
          afterIntentMarker: () => {
            throw diskFull();
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(head(worktree.path), 'no half commit: HEAD is still the base').toBe(base);
    expect(getWorktreeById(db, worktree.id)?.pending_commit_task_id).toBe(task.id);
    expect(eventCount('git.committed')).toBe(0);

    await reconcile(db, activityLog, dbDir);
    const afterReconcile = getWorktreeById(db, worktree.id)!;
    expect(afterReconcile.pending_commit_task_id).toBeNull();
    expect(afterReconcile.base_commit).toBe(base);
    expect(eventCount('git.unexpected_commit_detected')).toBe(0);

    // Space is back: the same work commits normally.
    const retry = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree: afterReconcile,
      task: getTaskById(db, task.id)!,
      validators: TRIVIAL_VALIDATORS,
    });
    expect(retry.outcome).toBe('committed');
    expect(eventCount('git.unexpected_commit_detected')).toBe(0);
  });

  it('disk fills after the commit lands: marker kept, reconcile adopts the complete commit, no security event', async () => {
    const { project, employee, worktree, task } = await setUp();
    const base = worktree.base_commit;

    await expect(
      commitTaskWork({
        db,
        activityLog,
        project,
        employee,
        worktree,
        task,
        validators: TRIVIAL_VALIDATORS,
        testHooks: {
          afterGitCommit: () => {
            throw diskFull();
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'ENOSPC' });

    const landed = head(worktree.path);
    expect(landed).not.toBe(base);
    // A complete commit, not a half one: git can read it and it holds the work.
    expect(
      execFileSync('git', ['show', '--stat', '--format=%s', landed], {
        cwd: worktree.path,
        encoding: 'utf8',
      }),
    ).toContain('work.txt');
    expect(getWorktreeById(db, worktree.id)?.pending_commit_task_id).toBe(task.id);
    expect(getWorktreeById(db, worktree.id)?.base_commit).toBe(base);

    await reconcile(db, activityLog, dbDir);
    const afterReconcile = getWorktreeById(db, worktree.id)!;
    expect(afterReconcile.pending_commit_task_id).toBeNull();
    expect(afterReconcile.base_commit).toBe(landed);
    expect(eventCount('git.committed')).toBe(1);
    expect(eventCount('git.unexpected_commit_detected')).toBe(0);
  });
});
