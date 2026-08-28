import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
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
import { commitTaskWork, UnexpectedCommitDetectedError } from '../../../src/main/workspace/employeeCommit';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import type { Project } from '../../../src/shared/models/project';
import type { Validator } from '../../../src/main/workspace/validators';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

// A hand-built, dependency-free validator list — just the mandatory
// secret scan — so these tests exercise the real commit path without
// needing a real package.json/node_modules (D5's flagged gap).
const TRIVIAL_VALIDATORS: Validator[] = [
  { name: 'secret-scan', run: async () => ({ name: 'secret-scan', passed: true, output: 'no secrets detected' }) },
];

/**
 * §10.3.1 / §28 M5 item 8, S6: layer 4 (commit-time HEAD reconciliation)
 * is the one layer that ships regardless of whether layer 1 (the
 * restricted token) lands. Written first, per the M5 part 2 kickoff's
 * own explicit ask, before commitPath.test.ts's happy-path coverage.
 */
describe('§10.3.1 layer 4 — HEAD reconciliation (gate item 8, S6)', () => {
  let dbDir: string;
  let repoPath: string;
  let companyHomePath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-layer4-db-'));
    repoPath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-layer4-repo-'));
    companyHomePath = mkdtempSync(path.join(tmpdir(), 'bureau-m5p2-layer4-home-'));
    const dbPath = path.join(dbDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(dbDir, 'backups') });
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

  it('S6: a real child_process bypass commit is detected — task blocked, security event, not a regex match', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Ravi' });
    let worktree = await hireEmployeeWorktree({ db, activityLog, project, employee, companyHomePath });
    const task = seedTask(db, { project_id: project.id, title: 'Bypass test', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });

    // The exact bypass §10.3.1 names: `node -e "require('child_process')
    // .execSync('git commit -m x')"` — not a `git commit` string alone,
    // which a naive pattern-match test would trivially catch. A real,
    // separate process, spawned via execFileSync (argv array, no
    // shell), that itself spawns git via a nested child_process call.
    writeFileSync(path.join(worktree.path, 'sneaky.txt'), 'an employee wrote this directly', 'utf8');
    const bypassScript = `require('child_process').execSync('git -c user.name=Employee -c user.email=e@bypass.local add -A && git -c user.name=Employee -c user.email=e@bypass.local commit -m bypass', { cwd: ${JSON.stringify(worktree.path)} });`;
    execFileSync(process.execPath, ['-e', bypassScript]);

    await expect(
      commitTaskWork({ db, activityLog, project, employee, worktree, task, validators: TRIVIAL_VALIDATORS }),
    ).rejects.toThrow(UnexpectedCommitDetectedError);

    const updatedTask = getTaskById(db, task.id);
    expect(updatedTask?.status, 'the bypass must be detected, not silently accepted').toBe('blocked');

    const events = db.prepare("SELECT * FROM events WHERE type = 'git.unexpected_commit_detected'").all() as Array<{
      severity: string;
      employee_id: string | null;
      task_id: string | null;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe('security');
    expect(events[0]?.employee_id).toBe(employee.id);
    expect(events[0]?.task_id).toBe(task.id);

    // base_commit must be untouched — refused, not partially applied.
    const row = getWorktreeById(db, worktree.id);
    expect(row?.base_commit).toBe(worktree.base_commit);
    expect(row?.pending_commit_task_id).toBeNull();
  });

  it('a normal, undisturbed worktree commits cleanly through the same HEAD check (negative control)', async () => {
    const project = await setUpRegisteredProject();
    const employee = seedEmployee(db, { name: 'Priya' });
    let worktree = await hireEmployeeWorktree({ db, activityLog, project, employee, companyHomePath });
    const task = seedTask(db, { project_id: project.id, title: 'Clean commit', status: 'review' });
    worktree = await assignTaskToWorktree({
      db,
      activityLog,
      project,
      employee,
      worktree,
      task,
      integrationRef: resolveDefaultIntegrationRef(project),
    });

    writeFileSync(path.join(worktree.path, 'work.txt'), 'real employee work\n', 'utf8');

    const result = await commitTaskWork({ db, activityLog, project, employee, worktree, task, validators: TRIVIAL_VALIDATORS });
    expect(result.outcome).toBe('committed');

    const events = db.prepare("SELECT * FROM events WHERE type = 'git.unexpected_commit_detected'").all();
    expect(events).toEqual([]);
  });
});

/**
 * D4's false-positive proof: real process kills pinned at the two new
 * commit-path crash windows, mirroring `reconcileCrashWindows.test.ts`'s
 * own real-kill pattern (M5 part 1) — both must converge with NO
 * security event raised against Bureau's own interrupted work, which is
 * the entire point of the durable intent marker.
 */
describe('commitTaskWork crash windows converge without false-positiving as a bypass (D4)', () => {
  let bundledWorkerPath: string;

  beforeAll(async () => {
    const outDir = path.resolve('dist', 'test-bundles');
    mkdirSync(outDir, { recursive: true });
    bundledWorkerPath = path.join(outDir, 'commitKillWorker.js');
    await esbuild.build({
      entryPoints: [path.resolve('tests/integration/fixtures/commitKillWorker.ts')],
      outfile: bundledWorkerPath,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      external: ['better-sqlite3'],
    });
  }, 30_000);

  afterAll(() => {
    rmSync(path.dirname(bundledWorkerPath), { recursive: true, force: true });
  });

  interface KillOutcome {
    tmpDir: string;
    dbPath: string;
    activityLogPath: string;
    repoPath: string;
    homePath: string;
  }
  const outcomes: KillOutcome[] = [];

  afterAll(() => {
    for (const outcome of outcomes) {
      rmSync(outcome.tmpDir, { recursive: true, force: true });
      rmSync(outcome.repoPath, { recursive: true, force: true });
      rmSync(outcome.homePath, { recursive: true, force: true });
    }
  });

  async function runToKillPoint(killAfterStep: number): Promise<KillOutcome> {
    const tmpDir = mkdtempSync(path.join(tmpdir(), `bureau-commitkill-${killAfterStep}-`));
    const dbPath = path.join(tmpDir, 'bureau.db');
    const activityLogPath = path.join(tmpDir, 'activity.jsonl');
    const backupsDir = path.join(tmpDir, 'backups');
    const repoPath = mkdtempSync(path.join(tmpdir(), `bureau-commitkill-repo-${killAfterStep}-`));
    const homePath = mkdtempSync(path.join(tmpdir(), `bureau-commitkill-home-${killAfterStep}-`));

    const child: ChildProcess = spawn(process.execPath, [bundledWorkerPath], {
      env: {
        ...process.env,
        BUREAU_COMMITKILLTEST_DB_PATH: dbPath,
        BUREAU_COMMITKILLTEST_ACTIVITY_LOG_PATH: activityLogPath,
        BUREAU_COMMITKILLTEST_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
        BUREAU_COMMITKILLTEST_BACKUPS_DIR: backupsDir,
        BUREAU_COMMITKILLTEST_REPO_PATH: repoPath,
        BUREAU_COMMITKILLTEST_HOME_PATH: homePath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrBuf = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderrBuf += d.toString();
    });

    let stepsSeen = 0;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker never reached step ${killAfterStep}. stderr: ${stderrBuf}`));
      }, 20_000);

      let buffered = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        buffered += chunk.toString();
        let newlineIndex = buffered.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffered.slice(0, newlineIndex);
          buffered = buffered.slice(newlineIndex + 1);
          const match = /^STEP_DONE (\d+)$/.exec(line);
          if (match?.[1]) {
            stepsSeen = Number.parseInt(match[1], 10);
            if (stepsSeen >= killAfterStep) {
              clearTimeout(timeout);
              resolve();
              return;
            }
            child.stdin?.write('.');
          }
          newlineIndex = buffered.indexOf('\n');
        }
      });
      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on('exit', (code, signal) => {
        if (stepsSeen < killAfterStep) {
          clearTimeout(timeout);
          reject(
            new Error(
              `Worker exited early (code=${String(code)}, signal=${String(signal)}) after ${stepsSeen} steps, wanted ${killAfterStep}. stderr: ${stderrBuf}`,
            ),
          );
        }
      });
    });

    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));

    return { tmpDir, dbPath, activityLogPath, repoPath, homePath };
  }

  it('window 1 (marker written, before `git commit`): converges to "nothing to converge," no security event', async () => {
    const outcome = await runToKillPoint(1);
    outcomes.push(outcome);

    const db = openConnection(outcome.dbPath);
    const activityLog = ActivityLog.open(outcome.activityLogPath, db);
    try {
      const worktreeRowBefore = db.prepare('SELECT * FROM worktrees').get() as {
        id: string;
        base_commit: string;
        pending_commit_task_id: string | null;
      };
      expect(worktreeRowBefore.pending_commit_task_id, 'the marker must be set — killed right after writing it').not.toBeNull();

      const report = await reconcile(db, activityLog, outcome.tmpDir);
       
      console.log(`--- window 1: reconcile() report ---\n${JSON.stringify(report, null, 2)}`);
      expect(report.pendingCommitsResolved).toBe(1);

      const worktreeRowAfter = db.prepare('SELECT * FROM worktrees').get() as { pending_commit_task_id: string | null; base_commit: string };
      expect(worktreeRowAfter.pending_commit_task_id, 'the stale marker must be cleared').toBeNull();
      expect(worktreeRowAfter.base_commit, 'no commit ever landed — base_commit must be unchanged').toBe(worktreeRowBefore.base_commit);

      const securityEvents = db.prepare("SELECT * FROM events WHERE type = 'git.unexpected_commit_detected'").all();
      expect(securityEvents, "Bureau's own interrupted work must never be flagged as a bypass").toEqual([]);
    } finally {
      activityLog.close();
      db.close();
    }
  });

  it('window 2 (`git commit` landed, before the atomic update): converges via HEAD, no security event', async () => {
    const outcome = await runToKillPoint(2);
    outcomes.push(outcome);

    const db = openConnection(outcome.dbPath);
    const activityLog = ActivityLog.open(outcome.activityLogPath, db);
    try {
      const worktreeRowBefore = db.prepare('SELECT * FROM worktrees').get() as {
        id: string;
        path: string;
        base_commit: string;
        pending_commit_task_id: string | null;
      };
      expect(worktreeRowBefore.pending_commit_task_id, 'the marker must still be set — killed before it was cleared').not.toBeNull();

      const headRaw = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktreeRowBefore.path, encoding: 'utf8' }).trim();
      expect(headRaw, 'the real git commit must have landed before the kill').not.toBe(worktreeRowBefore.base_commit);

      const report = await reconcile(db, activityLog, outcome.tmpDir);
       
      console.log(`--- window 2: reconcile() report ---\n${JSON.stringify(report, null, 2)}`);
      expect(report.pendingCommitsResolved).toBe(1);

      const worktreeRowAfter = db.prepare('SELECT * FROM worktrees').get() as { pending_commit_task_id: string | null; base_commit: string };
      expect(worktreeRowAfter.pending_commit_task_id).toBeNull();
      expect(worktreeRowAfter.base_commit, 'converged to the real commit that actually landed').toBe(headRaw);

      const securityEvents = db.prepare("SELECT * FROM events WHERE type = 'git.unexpected_commit_detected'").all();
      expect(securityEvents, "Bureau's own commit, recovered by reconcile(), must never be flagged as a bypass").toEqual([]);

      const committedEvents = db.prepare("SELECT payload FROM events WHERE type = 'git.committed'").all() as Array<{ payload: string }>;
      expect(committedEvents.some((e) => JSON.parse(e.payload).reason === 'reconcile_recovered')).toBe(true);
    } finally {
      activityLog.close();
      db.close();
    }
  });
});
