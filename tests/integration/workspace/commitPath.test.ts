import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject, seedTask, seedRole } from '../../helpers/dbFixtures';
import {
  registerProjectWorkspace,
  hireEmployeeWorktree,
  assignTaskToWorktree,
  resolveDefaultIntegrationRef,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch } from '../../../src/main/workspace/gitWorktree';
import { commitTaskWork } from '../../../src/main/workspace/employeeCommit';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import type { Project } from '../../../src/shared/models/project';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

const PASSING_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
  { name: 'lint', run: async () => ({ name: 'lint', passed: true, output: 'ok' }) },
];

const FAILING_LINT_VALIDATORS: Validator[] = [
  {
    name: 'secret-scan',
    run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }),
  },
  { name: 'lint', run: async () => ({ name: 'lint', passed: false, output: '3 errors' }) },
];

describe('commitTaskWork — the successful path and validator-blocks-commit (§28 M5 item 4)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-commit-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-commit-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-commit-home-'));
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

  it('commits real work with the employee as author and Bureau as committer, updates base_commit, emits git.committed', async () => {
    const project = await setUpRegisteredProject();
    const role = seedRole(db, { key: 'developer' });
    const employee = seedEmployee(db, { name: 'Quinn', role_key: role.full_key });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const seededTask = seedTask(db, {
      project_id: project.id,
      title: 'Add the thing',
      status: 'review',
    });
    db.prepare('UPDATE tasks SET result_summary = ? WHERE id = ?').run(
      'added the thing',
      seededTask.id,
    );
    const task = getTaskById(db, seededTask.id)!;
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });

    writeFileSync(path.join(worktree.path, 'feature.ts'), 'export const thing = 1;\n', 'utf8');

    const result = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      validators: PASSING_VALIDATORS,
    });
    expect(result.outcome).toBe('committed');
    if (result.outcome !== 'committed') throw new Error('unreachable');

    // Real command, real output — author vs. committer identity.
    const identityRaw = execFileSync('git', ['log', '-1', '--format=%an <%ae> / %cn <%ce> / %s'], {
      cwd: worktree.path,
      encoding: 'utf8',
    }).trim();

    console.log(`--- git log -1 --format (author / committer / subject) ---\n${identityRaw}`);
    expect(identityRaw).toContain('Quinn (Bureau) <quinn@bureau.local>');
    expect(identityRaw).toContain('Bureau <bureau@bureau.local>');
    expect(identityRaw).toContain('bureau(quinn): added the thing');

    const trailerRaw = execFileSync('git', ['log', '-1', '--format=%b'], {
      cwd: worktree.path,
      encoding: 'utf8',
    });

    console.log(`--- git log -1 --format=%b (structured trailer) ---\n${trailerRaw}`);
    expect(trailerRaw).toContain(`Task:    ${task.display_key}`);
    expect(trailerRaw).toContain('Role:    developer');
    expect(trailerRaw).toContain('Engine:  claude-code');

    const row = getWorktreeById(db, worktree.id);
    expect(row?.base_commit).toBe(result.commitSha);
    expect(row?.pending_commit_task_id).toBeNull();

    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'git.committed'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload).commitSha).toBe(result.commitSha);
  });

  it('a validator failure blocks the commit — no marker ever written, task blocked, attempts incremented, no git commit made', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Meera' });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: 'Broken lint', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });

    writeFileSync(path.join(worktree.path, 'broken.ts'), 'const x = 1\n', 'utf8');
    const headBefore = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.path,
      encoding: 'utf8',
    }).trim();

    const result = await commitTaskWork({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      validators: FAILING_LINT_VALIDATORS,
    });
    expect(result.outcome).toBe('validator_failed');
    if (result.outcome !== 'validator_failed') throw new Error('unreachable');
    expect(result.results.find((r) => r.name === 'lint')?.passed).toBe(false);

    const updatedTask = getTaskById(db, task.id);
    expect(updatedTask?.status).toBe('blocked');
    expect(updatedTask?.attempts).toBe(1);

    const row = getWorktreeById(db, worktree.id);
    expect(
      row?.pending_commit_task_id,
      'no marker is ever written on a validator failure',
    ).toBeNull();
    expect(row?.base_commit).toBe(worktree.base_commit);

    // Real command, real output — no commit was actually made.
    const headAfter = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: worktree.path,
      encoding: 'utf8',
    }).trim();
    expect(headAfter).toBe(headBefore);

    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'git.validator_failed'")
      .all() as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(
      JSON.parse(events[0]!.payload).results.some((r: { name: string }) => r.name === 'lint'),
    ).toBe(true);
  });

  it('an empty diff (nothing to commit) still runs validators but does not fabricate a commit', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Dan' });
    let worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, {
      project_id: project.id,
      title: 'Nothing changed',
      status: 'review',
    });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });

    // Deliberately no file write — the employee reported done with no
    // actual diff.
    await expect(
      commitTaskWork({
        db,
        activityLog,
        project,
        employee,
        worktree,
        task,
        validators: PASSING_VALIDATORS,
      }),
    ).rejects.toThrow();
  });
});
