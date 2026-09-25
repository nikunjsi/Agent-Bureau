import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  createPhaseIntegrationBranch,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { mergeAcceptedTask } from '../../../src/main/workspace/integrationMerge';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import type { Project } from '../../../src/shared/models/project';
import type { Employee } from '../../../src/shared/models/employee';
import type { Worktree } from '../../../src/shared/models/worktree';
import type { Task } from '../../../src/shared/models/task';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

const TRIVIAL_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
];

describe('mergeAcceptedTask — clean merges, conflicts, and concurrent CAS retry (§28 M5 item 6, D1/D2/D6)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-merge-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-merge-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-merge-home-'));
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

  async function setUpRegisteredProject(): Promise<Project> {
    const project = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, project);
    const initialBranch = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
    return getProjectById(db, project.id) as Project;
  }

  /** Hires an employee, assigns it a task from `integrationRef`, writes
   * `fileName`, and commits — the full real pipeline up to (not
   * including) the merge, so each test starts from a real, committed
   * task branch. */
  async function hireAssignAndCommit(
    project: Project,
    employeeName: string,
    taskTitle: string,
    integrationRef: string,
    fileName: string,
    content: string,
  ): Promise<{ employee: Employee; worktree: Worktree; task: Task }> {
    const employee = seedEmployee(db, { name: employeeName });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: taskTitle, status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef,
    });
    writeFileSync(path.join(worktree.path, fileName), content, 'utf8');
    const result = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      validators: TRIVIAL_VALIDATORS,
    });
    if (result.outcome !== 'committed') throw new Error(`setup failed: ${JSON.stringify(result)}`);
    return { employee, worktree: getWorktreeById(db, worktree.id) as Worktree, task };
  }

  it('a clean merge lands a real two-parent merge commit, task -> done, git.merged emitted', async () => {
    const project = await setUpRegisteredProject();
    const { branch: integrationBranch } = await createPhaseIntegrationBranch(
      project.path,
      1,
      project.base_ref,
    );

    const { worktree, task } = await hireAssignAndCommit(
      project,
      'Quinn',
      'Add quinn.txt',
      integrationBranch,
      'quinn.txt',
      'quinn work\n',
    );

    const result = await mergeAcceptedTask({
      db,
      activityLog,
      project,
      task,
      worktree,
      integrationBranch,
    });
    expect(result.outcome).toBe('merged');
    if (result.outcome !== 'merged') throw new Error('unreachable');

    // Real command, real output — a genuine two-parent merge commit.
    const parentsRaw = execFileSync('git', ['log', '-1', '--format=%P', result.commitSha], {
      cwd: project.path,
      encoding: 'utf8',
    }).trim();

    console.log(`--- git log -1 --format=%P (merge commit parents) ---\n${parentsRaw}`);
    expect(parentsRaw.split(' ')).toHaveLength(2);

    const branchTip = execFileSync('git', ['rev-parse', integrationBranch], {
      cwd: project.path,
      encoding: 'utf8',
    }).trim();
    expect(branchTip).toBe(result.commitSha);

    const fileContent = execFileSync('git', ['show', `${integrationBranch}:quinn.txt`], {
      cwd: project.path,
      encoding: 'utf8',
    });
    expect(fileContent).toBe('quinn work\n');

    expect(getTaskById(db, task.id)?.status).toBe('done');

    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'git.merged'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).commitSha).toBe(result.commitSha);
  });

  it('a real conflict produces a real checkpoint row with both sides, task -> blocked, git.merge_conflict emitted, no auto-resolution', async () => {
    const project = await setUpRegisteredProject();
    const { branch: integrationBranch } = await createPhaseIntegrationBranch(
      project.path,
      1,
      project.base_ref,
    );

    // Quinn's edit lands on the integration branch first (a real, clean
    // merge) — Meera's task branch was cut before that, from the same
    // base, and edits the *same* file differently, so merging it next
    // produces a genuine conflict.
    const raviWork = await hireAssignAndCommit(
      project,
      'Quinn',
      'Edit shared.txt (Quinn)',
      integrationBranch,
      'shared.txt',
      'quinn version\n',
    );
    const meeraEmployee = seedEmployee(db, { name: 'Meera' });
    let meeraWorktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee: meeraEmployee,
      companyHomePath,
    });
    const meeraTask = seedTask(db, {
      project_id: project.id,
      title: 'Edit shared.txt (Meera)',
      status: 'review',
    });
    meeraWorktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee: meeraEmployee,
      worktree: meeraWorktree,
      task: meeraTask,
      integrationRef: integrationBranch, // same base as Quinn's — before Quinn's merge
    });
    writeFileSync(path.join(meeraWorktree.path, 'shared.txt'), 'meera version\n', 'utf8');
    const meeraCommitResult = await commitTaskWork({
      db,
      activityLog,
      project,
      employee: meeraEmployee,
      worktree: meeraWorktree,
      task: meeraTask,
      validators: TRIVIAL_VALIDATORS,
    });
    if (meeraCommitResult.outcome !== 'committed') throw new Error('setup failed');

    const raviMerge = await mergeAcceptedTask({
      db,
      activityLog,
      project,
      task: raviWork.task,
      worktree: raviWork.worktree,
      integrationBranch,
    });
    if (raviMerge.outcome !== 'merged')
      throw new Error(`setup failed: ${JSON.stringify(raviMerge)}`);

    const meeraWorktreeFresh = getWorktreeById(db, meeraWorktree.id) as Worktree;
    const conflictResult = await mergeAcceptedTask({
      db,
      activityLog,
      project,
      task: meeraTask,
      worktree: meeraWorktreeFresh,
      integrationBranch,
    });
    expect(conflictResult.outcome).toBe('conflict');
    if (conflictResult.outcome !== 'conflict') throw new Error('unreachable');
    expect(conflictResult.conflicts.map((c) => c.path)).toEqual(['shared.txt']);

    expect(getTaskById(db, meeraTask.id)?.status).toBe('blocked');

    const checkpoint = db
      .prepare('SELECT * FROM checkpoints WHERE id = ?')
      .get(conflictResult.checkpointId) as {
      type: string;
      urgency: string;
      default_action: string | null;
      expires_at: string | null;
      options: string;
      preview: string;
    };

    console.log(`--- checkpoint row ---\n${JSON.stringify(checkpoint, null, 2)}`);
    expect(checkpoint.type).toBe('blocker');
    expect(checkpoint.urgency).toBe('blocking');
    expect(checkpoint.default_action).toBeNull();
    expect(checkpoint.expires_at).toBeNull();

    const options = JSON.parse(checkpoint.options) as Array<{ id: string; consequence: string }>;
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(
      options.every((o) => typeof o.consequence === 'string' && o.consequence.length > 0),
    ).toBe(true);

    const preview = JSON.parse(checkpoint.preview) as Array<{
      path: string;
      ours: string | null;
      theirs: string | null;
    }>;
    expect(preview).toHaveLength(1);
    expect(preview[0]?.path).toBe('shared.txt');
    // "ours" is the integration branch's own side (Quinn's, already merged in); "theirs" is Meera's.
    expect(preview[0]?.ours).toBe('quinn version\n');
    expect(preview[0]?.theirs).toBe('meera version\n');

    const events = db
      .prepare("SELECT payload, severity FROM events WHERE type = 'git.merge_conflict'")
      .all() as Array<{
      payload: string;
      severity: string;
    }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).files).toEqual(['shared.txt']);

    // The integration branch itself must be untouched — no auto-resolution.
    const branchTipAfter = execFileSync('git', ['rev-parse', integrationBranch], {
      cwd: project.path,
      encoding: 'utf8',
    }).trim();
    expect(branchTipAfter).toBe(raviMerge.commitSha);
  });

  it('3 real concurrent merges into one integration branch all land — the bounded CAS retry actually recovers real races, not just Bureau-serialized ones', async () => {
    const project = await setUpRegisteredProject();
    const { branch: integrationBranch } = await createPhaseIntegrationBranch(
      project.path,
      1,
      project.base_ref,
    );

    const work = await Promise.all(
      ['Quinn', 'Meera', 'Dan'].map((name, i) =>
        hireAssignAndCommit(
          project,
          name,
          `Add ${name}.txt`,
          integrationBranch,
          `${name.toLowerCase()}.txt`,
          `${name} work ${i}\n`,
        ),
      ),
    );

    // All three merges fired at once, interleaved via setImmediate — a
    // real race against the same integration branch ref, not sequential
    // calls that never actually collide.
    const results = await Promise.all(
      work.map(
        ({ worktree, task }) =>
          new Promise<Awaited<ReturnType<typeof mergeAcceptedTask>>>((resolve, reject) => {
            setImmediate(() => {
              mergeAcceptedTask({
                db,
                activityLog,
                project,
                task,
                worktree,
                integrationBranch,
              }).then(resolve, reject);
            });
          }),
      ),
    );

    expect(
      results.every((r) => r.outcome === 'merged'),
      JSON.stringify(results),
    ).toBe(true);

    for (const { task } of work) {
      expect(getTaskById(db, task.id)?.status).toBe('done');
    }

    // Real command, real output — every file made it into the final tree.
    const lsTreeRaw = execFileSync('git', ['ls-tree', '-r', '--name-only', integrationBranch], {
      cwd: project.path,
      encoding: 'utf8',
    });

    console.log(`--- git ls-tree -r --name-only ${integrationBranch} ---\n${lsTreeRaw}`);
    for (const name of ['quinn', 'meera', 'dan']) {
      expect(lsTreeRaw).toContain(`${name}.txt`);
    }

    const mergedEvents = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'git.merged'")
      .get() as { n: number };
    expect(mergedEvents.n).toBe(3);
  });
});
