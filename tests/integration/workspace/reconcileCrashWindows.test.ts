import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection, checkIntegrity, checkForeignKeys } from '../../../src/main/db/connection';
import { reconcile } from '../../../src/main/db/reconcile';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const WORKER_SOURCE = path.resolve('tests/integration/fixtures/worktreeKillWorker.ts');

let bundledWorkerPath: string;

beforeAll(async () => {
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  bundledWorkerPath = path.join(outDir, 'worktreeKillWorker.js');
  await esbuild.build({
    entryPoints: [WORKER_SOURCE],
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
  stepsReached: number;
}

async function runToKillPoint(killAfterStep: number): Promise<KillOutcome> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), `bureau-wtkillpoint-${killAfterStep}-`));
  const dbPath = path.join(tmpDir, 'bureau.db');
  const activityLogPath = path.join(tmpDir, 'activity.jsonl');
  const backupsDir = path.join(tmpDir, 'backups');
  const repoPath = mkdtempSync(path.join(tmpdir(), `bureau-wtkillpoint-repo-${killAfterStep}-`));
  const homePath = mkdtempSync(path.join(tmpdir(), `bureau-wtkillpoint-home-${killAfterStep}-`));

  const child: ChildProcess = spawn(process.execPath, [bundledWorkerPath], {
    env: {
      ...process.env,
      BUREAU_WTKILLTEST_DB_PATH: dbPath,
      BUREAU_WTKILLTEST_ACTIVITY_LOG_PATH: activityLogPath,
      BUREAU_WTKILLTEST_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
      BUREAU_WTKILLTEST_BACKUPS_DIR: backupsDir,
      BUREAU_WTKILLTEST_REPO_PATH: repoPath,
      BUREAU_WTKILLTEST_HOME_PATH: homePath,
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

  return { tmpDir, dbPath, activityLogPath, repoPath, homePath, stepsReached: stepsSeen };
}

function assertBaseInvariants(db: Database.Database): void {
  const integrity = checkIntegrity(db);
  expect(integrity.ok, `integrity_check failed: ${integrity.issues.join('; ')}`).toBe(true);
  const fkViolations = checkForeignKeys(db);
  expect(
    fkViolations,
    `foreign_key_check found violations: ${JSON.stringify(fkViolations)}`,
  ).toEqual([]);
}

/**
 * Gate item 4: real process kill at each of the two crash windows this
 * session introduces (worker doc comment has the full rationale), restart,
 * `reconcile()` converges both times — mirroring `killPoints.test.ts`'s
 * own real-kill pattern, applied to the new git/worktree crash windows
 * instead of the M1 bootstrap ones.
 */
describe('reconcile() converges both new M5 worktree crash windows (gate item 4)', () => {
  const outcomes: KillOutcome[] = [];

  afterEach(() => {
    // Nothing per-test to clean here — outcomes are cleaned in bulk below,
    // since each test needs its own outcome directories to inspect the
    // pre-reconcile state before they're removed.
  });

  afterAll(() => {
    for (const outcome of outcomes) {
      rmSync(outcome.tmpDir, { recursive: true, force: true });
      rmSync(outcome.repoPath, { recursive: true, force: true });
      rmSync(outcome.homePath, { recursive: true, force: true });
    }
  });

  it('window 1 (DB-row-insert vs. `git worktree add`): a kill after the row is committed but before the real worktree exists reconciles to a clean phantom-row delete', async () => {
    const outcome = await runToKillPoint(1);
    outcomes.push(outcome);

    const db = openConnection(outcome.dbPath);
    const activityLog = ActivityLog.open(outcome.activityLogPath, db);
    try {
      const employeeId = (db.prepare('SELECT id FROM employees').get() as { id: string }).id;
      const worktreeRowBefore = db.prepare('SELECT * FROM worktrees').get() as
        { id: string; path: string; status: string } | undefined;
      expect(worktreeRowBefore, 'the row must have been committed before the kill').toBeDefined();
      expect(worktreeRowBefore?.status).toBe('free');
      expect(
        existsSync(worktreeRowBefore!.path),
        'the real git worktree must NOT exist yet — killed before addWorktree ran',
      ).toBe(false);

      const employeeBefore = getEmployeeById(db, employeeId);
      expect(employeeBefore?.worktree_id, 'the FK must already point at the phantom row').toBe(
        worktreeRowBefore!.id,
      );

      // Real command, real output.
      const porcelainRaw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: outcome.repoPath,
        encoding: 'utf8',
      });

      console.log(
        `--- window 1: git worktree list --porcelain (before reconcile) ---\n${porcelainRaw}`,
      );
      expect(porcelainRaw).not.toContain(worktreeRowBefore!.path.replace(/\\/g, '/'));

      const report = await reconcile(db, activityLog, outcome.tmpDir);

      console.log(`--- window 1: reconcile() report ---\n${JSON.stringify(report, null, 2)}`);

      expect(report.worktreePhantomsDeleted).toEqual([worktreeRowBefore!.id]);
      expect(getWorktreeById(db, worktreeRowBefore!.id), 'the phantom row must be gone').toBeNull();
      expect(getEmployeeById(db, employeeId)?.worktree_id, 'the FK must be nulled').toBeNull();

      const releasedEvent = db
        .prepare("SELECT payload FROM events WHERE type = 'git.worktree_released'")
        .get() as { payload: string } | undefined;
      expect(
        releasedEvent,
        'a git.worktree_released event must have been emitted for the cleanup',
      ).toBeDefined();
      expect(JSON.parse(releasedEvent!.payload).reason).toBe('reconcile_phantom_row');

      assertBaseInvariants(db);
    } finally {
      activityLog.close();
      db.close();
    }
  });

  it('window 2 (`git worktree remove` vs. row delete): a kill after the real worktree is gone but before the row is deleted reconciles to a clean phantom-row delete', async () => {
    const outcome = await runToKillPoint(2);
    outcomes.push(outcome);

    const db = openConnection(outcome.dbPath);
    const activityLog = ActivityLog.open(outcome.activityLogPath, db);
    try {
      const worktreeRowBefore = db.prepare('SELECT * FROM worktrees').get() as
        { id: string; path: string; status: string } | undefined;
      expect(
        worktreeRowBefore,
        'the row must still exist — killed before deleteWorktree ran',
      ).toBeDefined();
      expect(
        worktreeRowBefore?.status,
        "must be 'pruning' — set immediately before the real removal, per fix #7",
      ).toBe('pruning');
      expect(
        existsSync(worktreeRowBefore!.path),
        'the real git worktree must already be gone — killed after removeWorktree succeeded',
      ).toBe(false);

      const employeeId = (db.prepare('SELECT id FROM employees').get() as { id: string }).id;
      const employeeBefore = getEmployeeById(db, employeeId);
      expect(
        employeeBefore?.worktree_id,
        "the FK was already nulled before removeWorktree ran, per the fire flow's own ordering",
      ).toBeNull();

      const porcelainRaw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
        cwd: outcome.repoPath,
        encoding: 'utf8',
      });

      console.log(
        `--- window 2: git worktree list --porcelain (before reconcile) ---\n${porcelainRaw}`,
      );
      expect(porcelainRaw).not.toContain(worktreeRowBefore!.path.replace(/\\/g, '/'));

      const report = await reconcile(db, activityLog, outcome.tmpDir);

      console.log(`--- window 2: reconcile() report ---\n${JSON.stringify(report, null, 2)}`);

      expect(report.worktreePhantomsDeleted).toEqual([worktreeRowBefore!.id]);
      expect(getWorktreeById(db, worktreeRowBefore!.id), 'the row must finally be gone').toBeNull();

      const releasedEvents = db
        .prepare("SELECT payload FROM events WHERE type = 'git.worktree_released'")
        .all() as Array<{
        payload: string;
      }>;
      expect(
        releasedEvents,
        'reconcile() must have retroactively completed the interrupted fire with its own git.worktree_released',
      ).toHaveLength(1);
      expect(JSON.parse(releasedEvents[0]!.payload).reason).toBe('reconcile_phantom_row');

      assertBaseInvariants(db);
    } finally {
      activityLog.close();
      db.close();
    }
  });
});
