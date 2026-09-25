import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  createPhaseIntegrationBranch,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { mergeAcceptedTask } from '../../../src/main/workspace/integrationMerge';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import type { Project } from '../../../src/shared/models/project';
import type { Worktree } from '../../../src/shared/models/worktree';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TRIVIAL_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
];

/**
 * P-6 / risk #23: "the user edits files while an employee works on them".
 *
 * The behaviour, with evidence:
 *  1. **The user's own checkout and the employee's worktree never see each
 *     other.** The employee works in its own `git worktree`; merges are
 *     ref-only (`git merge-tree`/`commit-tree`/`update-ref`), so nothing Bureau
 *     does touches a file in the user's checkout, uncommitted edits included.
 *  2. **Committed user edits meet the employee's work only at a merge, and a
 *     conflict there reaches M5's conflict checkpoint.** Before phases exist
 *     (M11), a task's integration ref is `base_ref` itself
 *     (`resolveDefaultIntegrationRef`), so a user commit on that branch and an
 *     employee's edit to the same file conflict in `mergeAcceptedTask`: a
 *     `blocker` checkpoint with both sides, the task blocked, nothing
 *     auto-resolved, and the user's branch left where they put it.
 */
describe('the user edits files while an employee works on them (P-6, risk #23)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-useredit-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-useredit-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-useredit-home-'));
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

  function git(...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=User', '-c', 'user.email=u@u.local', ...args], {
      cwd: repoPath,
      encoding: 'utf8',
    });
  }

  async function projectAndEmployeeCommit(integrationRef: (p: Project) => Promise<string>) {
    const seeded = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, seeded);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(
      await getCheckedOutBranch(repoPath),
      seeded.id,
    );
    const project = getProjectById(db, seeded.id) as Project;
    const ref = await integrationRef(project);
    const employee = seedEmployee(db, { name: 'Quinn' });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: 'Edit notes', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: ref,
    });
    return { project, employee, worktree, task, ref };
  }

  it('uncommitted edits in the user checkout are never seen by the employee and never touched by the commit or the merge', async () => {
    const { project, employee, worktree, task, ref } = await projectAndEmployeeCommit(
      async (p) => (await createPhaseIntegrationBranch(p.path, 1, p.base_ref)).branch,
    );

    // The user, in their own checkout, mid-edit and not committed.
    writeFileSync(path.join(repoPath, 'notes.md'), 'the user is still typing\n');
    writeFileSync(path.join(worktree.path, 'notes.md'), 'the employee version\n');
    expect(readFileSync(path.join(worktree.path, 'notes.md'), 'utf8')).toBe(
      'the employee version\n',
    );

    const committed = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      validators: TRIVIAL_VALIDATORS,
    });
    expect(committed.outcome).toBe('committed');
    const merged = await mergeAcceptedTask({
      db,
      activityLog,
      project,
      task: getTaskById(db, task.id)!,
      worktree: getWorktreeById(db, worktree.id) as Worktree,
      integrationBranch: ref,
    });
    expect(merged.outcome).toBe('merged');

    expect(readFileSync(path.join(repoPath, 'notes.md'), 'utf8')).toBe(
      'the user is still typing\n',
    );
    expect(git('status', '--porcelain')).toContain('notes.md');
  });

  it("a committed user edit that conflicts with the employee's reaches the conflict checkpoint, and the user's branch is left alone", async () => {
    const { project, employee, worktree, task, ref } = await projectAndEmployeeCommit(async (p) =>
      resolveDefaultIntegrationRef(p),
    );

    writeFileSync(path.join(worktree.path, 'notes.md'), 'the employee version\n');
    const committed = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      validators: TRIVIAL_VALIDATORS,
    });
    expect(committed.outcome).toBe('committed');

    // Meanwhile the user commits a different version on their own branch.
    writeFileSync(path.join(repoPath, 'notes.md'), 'the user version\n');
    git('add', 'notes.md');
    git('commit', '-q', '-m', 'user edit');
    const userHead = git('rev-parse', 'HEAD').trim();

    const merged = await mergeAcceptedTask({
      db,
      activityLog,
      project,
      task: getTaskById(db, task.id)!,
      worktree: getWorktreeById(db, worktree.id) as Worktree,
      integrationBranch: ref,
    });
    expect(merged.outcome).toBe('conflict');
    expect(getTaskById(db, task.id)?.status).toBe('blocked');
    const checkpoint = db
      .prepare("SELECT type, context FROM checkpoints WHERE task_id = ? AND type = 'blocker'")
      .get(task.id) as { type: string; context: string } | undefined;
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.context).toContain('notes.md');

    expect(git('rev-parse', ref).trim()).toBe(userHead);
    expect(readFileSync(path.join(repoPath, 'notes.md'), 'utf8')).toBe('the user version\n');
  });
});
