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
  resolveDefaultIntegrationRef,
  createPhaseIntegrationBranch,
} from '../../../src/main/workspace/employeeWorktree';
import { getCheckedOutBranch, resolveRef } from '../../../src/main/workspace/gitWorktree';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import type { Project } from '../../../src/shared/models/project';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TEST_IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@test.local'];

describe('assignTaskToWorktree (§10.3/§28 M5 item 3 — gate item 6, and Q4/fix #8 dirty refusal)', () => {
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

  async function setUpRegisteredProject(): Promise<Project> {
    const project = seedProject(db, { path: repoPath });
    await registerProjectWorkspace(db, project);
    const initialBranch = await getCheckedOutBranch(repoPath);
    db.prepare('UPDATE projects SET base_ref = ? WHERE id = ?').run(initialBranch, project.id);
    return getProjectById(db, project.id) as Project;
  }

  /** A real commit directly on the checked-out branch in the main tree —
   * this is test-fixture authoring (simulating what a real user's own
   * repo history looks like before Bureau ever gets involved), not a
   * Bureau code path, so it's exempt from Q5's "Bureau never touches the
   * main tree's checkout" rule, which governs Bureau's own runGit calls. */
  function commitFileOnCheckedOutBranch(fileName: string, content: string): void {
    writeFileSync(path.join(repoPath, fileName), content, 'utf8');
    execFileSync('git', [...TEST_IDENTITY, 'add', fileName], { cwd: repoPath });
    execFileSync('git', [...TEST_IDENTITY, 'commit', '-m', `add ${fileName}`], { cwd: repoPath });
  }

  it("gate 6: re-points to bureau/<employee>/<task> from a real integration ref deliberately distinct from base_ref's CURRENT value", async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Ravi' });
    const worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    }); // cut from C0

    commitFileOnCheckedOutBranch('phase.md', 'phase 1 work\n'); // base_ref now resolves to C1

    // The phase branch is cut from base_ref's value *right now* (C1) —
    // standalone, no phases/plans row needed (Q8).
    const { branch: phaseBranch, baseCommit: phaseBaseCommit } = await createPhaseIntegrationBranch(
      repoPath,
      1,
      project.base_ref,
    );

    commitFileOnCheckedOutBranch('phase2.md', 'phase 2 work\n'); // base_ref now resolves to C2 — phaseBranch stays at C1

    const baseRefNow = await resolveRef(repoPath, project.base_ref);
    expect(baseRefNow, 'setup sanity: base_ref must have moved on past the phase branch').not.toBe(
      phaseBaseCommit,
    );

    const task = seedTask(db, { project_id: project.id, title: 'Build the thing' });

    const updated = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: phaseBranch,
    });

    const newBranchSha = execFileSync('git', ['rev-parse', updated.branch], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();
    const phaseBranchSha = execFileSync('git', ['rev-parse', phaseBranch], {
      cwd: repoPath,
      encoding: 'utf8',
    }).trim();

    console.log(
      `--- git rev-parse ${updated.branch} => ${newBranchSha}\n--- git rev-parse ${phaseBranch} => ${phaseBranchSha}\n--- git rev-parse ${project.base_ref} (current) => ${baseRefNow}`,
    );

    expect(newBranchSha).toBe(phaseBranchSha);
    expect(newBranchSha).toBe(phaseBaseCommit);
    expect(updated.base_commit).toBe(phaseBaseCommit);
    expect(
      updated.base_commit,
      "must come from the given integrationRef, not from a fallback to base_ref's current value",
    ).not.toBe(baseRefNow);
    expect(updated.branch).toBe(`bureau/ravi/${task.display_key}`);

    // The hire-time placeholder branch must be gone (superseded); the main
    // tree's own checkout must be untouched by any of this (Q5).
    const placeholderList = execFileSync('git', ['branch', '--list', 'bureau/ravi/unassigned'], {
      cwd: repoPath,
      encoding: 'utf8',
    });
    expect(placeholderList.trim()).toBe('');
    expect(await getCheckedOutBranch(repoPath)).toBe(project.base_ref);
  });

  it('Q4/fix #8: refuses to re-point a dirty worktree — throws AND emits a security-severity git.worktree_dirty_refused event', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Ravi' });
    const worktree = await hireEmployeeWorktree({
      db,
      activityLog,
      project,
      employee,
      companyHomePath,
    });
    const task = seedTask(db, { project_id: project.id, title: 'Do a thing' });

    // Something wrote to this worktree outside the expected flow — §10.3:
    // the employee never runs git write commands, so this is exactly the
    // anomaly Q4 guards against.
    writeFileSync(path.join(worktree.path, 'stray.txt'), 'oops', 'utf8');

    await expect(
      assignTaskToWorktree({
        db,
        activityLog,
        project,
        employee,
        worktree,
        task,
        integrationRef: resolveDefaultIntegrationRef(project),
      }),
    ).rejects.toThrow(/uncommitted changes/);

    const events = db
      .prepare("SELECT * FROM events WHERE type = 'git.worktree_dirty_refused'")
      .all() as Array<{
      severity: string;
      employee_id: string | null;
      task_id: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('security');
    expect(events[0]?.employee_id).toBe(employee.id);
    expect(events[0]?.task_id).toBe(task.id);

    // Refused, not partially applied — branch/base_commit are untouched,
    // but status IS updated (D7, M5 part 2): 'dirty' finally gets a real
    // writer, a record for observability, not a gate anything reads.
    const row = getWorktreeById(db, worktree.id);
    expect(row?.branch).toBe(worktree.branch);
    expect(row?.base_commit).toBe(worktree.base_commit);
    expect(row?.status).toBe('dirty');
  });
});
