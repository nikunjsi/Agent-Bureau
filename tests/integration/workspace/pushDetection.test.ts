import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { unblockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { getProjectById } from '../../../src/main/db/repositories/projects';
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.local', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/**
 * N-9 / §10.6 rule 6. The `git_write` deny matches shell text, which can
 * never be complete (§10.3.1 names the bypasses). So pushes are also
 * DETECTED after the fact, the way layer 4 detects an unexpected commit:
 * at commit time, from the remote-tracking reflogs, for pushes made since
 * the task's branch was created. A detected push is rule 6's approval
 * checkpoint, graded by `projects.protected_refs`.
 */
describe('push detection (N-9, §10.6 rule 6)', () => {
  let dbDir: string;
  let repoPath: string;
  let remotePath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-push-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-push-repo-'));
    remotePath = mkdtempSync(path.join(tmpdir(), 'bureau-push-remote-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-push-home-'));
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
    for (const dir of [dbDir, repoPath, remotePath, companyHomePath]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A registered project with a real bare remote the USER pushed to before
   * any task existed. That push must never be reported. */
  async function setUp(): Promise<{
    project: Project;
    worktree: Worktree;
    employeeId: string;
    taskId: string;
    base: string;
  }> {
    const seeded = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, seeded);
    const base = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(base, seeded.id);
    const project = getProjectById(db, seeded.id) as Project;

    git(remotePath, 'init', '-q', '--bare');
    git(repoPath, 'remote', 'add', 'origin', remotePath);
    git(repoPath, 'push', '-q', 'origin', `${base}:${base}`);
    // Reflog timestamps are whole seconds: keep the user's push strictly
    // before the task branch's creation.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const employee = seedEmployee(db, { name: 'Quinn' });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: 'Push test', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });
    return { project, worktree, employeeId: employee.id, taskId: task.id, base };
  }

  function commit(project: Project, worktree: Worktree, employeeId: string, taskId: string) {
    return commitTaskWork({
      db,
      activityLog,
      project,
      employee: employeeById(employeeId),
      worktree,
      task: getTaskById(db, taskId)!,
      validators: TRIVIAL_VALIDATORS,
    });
  }

  function employeeById(id: string) {
    return db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as never;
  }

  function pushEvents(): Array<{ severity: string; task_id: string; payload: string }> {
    return db
      .prepare("SELECT * FROM events WHERE type = 'git.unexpected_push_detected' ORDER BY seq")
      .all() as Array<{ severity: string; task_id: string; payload: string }>;
  }

  it('an employee push to a protected ref, through a child process the deny never sees, raises an approval checkpoint and blocks the task — the user push before the task is not reported', async () => {
    const { project, worktree, employeeId, taskId, base } = await setUp();

    // The bypass shape: not a Bash tool call at all. A new commit object is
    // built with plumbing so the worktree's HEAD does not move (layer 4 would
    // otherwise fire first), then pushed as a real fast-forward. Pushing the
    // current HEAD would be a no-op that writes no reflog entry.
    const script = `const cp = require('child_process'); const o = { cwd: ${JSON.stringify(worktree.path)}, encoding: 'utf8' }; const sha = cp.execFileSync('git', ['-c', 'user.name=E', '-c', 'user.email=e@x.local', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'sneaky'], o).trim(); cp.execFileSync('git', ['push', '-q', 'origin', sha + ':refs/heads/${base}'], o);`;
    execFileSync(process.execPath, ['-e', script]);

    const result = await commit(project, worktree, employeeId, taskId);
    expect(result.outcome).toBe('push_detected');

    const task = getTaskById(db, taskId)!;
    expect(task.status).toBe('blocked');

    const events = pushEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('security');
    expect(JSON.parse(events[0]!.payload)).toMatchObject({
      ref: `refs/remotes/origin/${base}`,
      branch: base,
      protected: true,
    });

    const checkpoint = db.prepare('SELECT * FROM checkpoints WHERE task_id = ?').get(taskId) as {
      type: string;
      urgency: string;
      default_action: string | null;
    };
    expect(checkpoint.type).toBe('approval');
    expect(checkpoint.urgency).toBe('blocking');
    // Nothing about a push can be undone by a clock (§9.5, invariant #7).
    expect(checkpoint.default_action).toBeNull();
  });

  it('a push to an unprotected ref is still rule 6 (always an approval), at warn severity; once answered the same push is not reported again and the work commits', async () => {
    const { project, worktree, employeeId, taskId } = await setUp();
    git(worktree.path, 'push', '-q', 'origin', 'HEAD:refs/heads/scratch');

    const first = await commit(project, worktree, employeeId, taskId);
    expect(first.outcome).toBe('push_detected');
    expect(pushEvents()[0]?.severity).toBe('warn');
    expect(JSON.parse(pushEvents()[0]!.payload)).toMatchObject({ protected: false });

    // Answering unblocks the task (answerCheckpoint's step 3, called directly).
    const checkpointId = (
      db.prepare('SELECT id FROM checkpoints WHERE task_id = ?').get(taskId) as { id: string }
    ).id;
    expect(unblockTaskForCheckpoint(db, activityLog, { taskId, checkpointId })).toBe(true);
    db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId);

    writeFileSync(path.join(worktree.path, 'work.txt'), 'real work\n', 'utf8');
    const second = await commit(project, worktree, employeeId, taskId);
    expect(second.outcome).toBe('committed');
    expect(pushEvents()).toHaveLength(1);
  });

  it('a worktree nobody pushed from commits normally (negative control)', async () => {
    const { project, worktree, employeeId, taskId } = await setUp();
    writeFileSync(path.join(worktree.path, 'work.txt'), 'real work\n', 'utf8');
    const result = await commit(project, worktree, employeeId, taskId);
    expect(result.outcome).toBe('committed');
    expect(pushEvents()).toEqual([]);
  });
});
