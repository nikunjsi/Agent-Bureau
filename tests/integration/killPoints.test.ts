import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection, checkIntegrity, checkForeignKeys } from '../../src/main/db/connection';
import { reconcile } from '../../src/main/db/reconcile';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const WORKER_SOURCE = path.resolve('tests/integration/fixtures/dbKillWorker.ts');

// Bundled *inside* the project tree (dist/ is already gitignored), not
// under the OS temp dir — os.tmpdir() is typically on a different drive
// entirely (C: vs. this project's D:), and require('better-sqlite3')
// resolves by walking up from the bundle's own location looking for
// node_modules, which never reaches this project's if the bundle lives
// somewhere that walk can't get to.
let bundledWorkerPath: string;

beforeAll(async () => {
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  bundledWorkerPath = path.join(outDir, 'dbKillWorker.js');
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
  stepsReached: number;
}

/** Spawns the worker, waits for exactly `killAfterStep` STEP_DONE markers,
 * then force-kills it. Returns the paths for the caller to inspect. */
async function runToKillPoint(killAfterStep: number): Promise<KillOutcome> {
  const tmpDir = mkdtempSync(path.join(tmpdir(), `bureau-killpoint-${killAfterStep}-`));
  const dbPath = path.join(tmpDir, 'bureau.db');
  const activityLogPath = path.join(tmpDir, 'activity.jsonl');
  const backupsDir = path.join(tmpDir, 'backups');

  const child: ChildProcess = spawn(process.execPath, [bundledWorkerPath], {
    env: {
      ...process.env,
      BUREAU_KILLTEST_DB_PATH: dbPath,
      BUREAU_KILLTEST_ACTIVITY_LOG_PATH: activityLogPath,
      BUREAU_KILLTEST_MIGRATIONS_DIR: REAL_MIGRATIONS_DIR,
      BUREAU_KILLTEST_BACKUPS_DIR: backupsDir,
    },
    // A real stdin pipe, not 'ignore' — the worker blocks after each step
    // waiting for one ack byte (see announceAndWaitForAck in the worker),
    // and this is how the parent supplies it. Withholding the ack for the
    // target step is what actually pins the kill point precisely, rather
    // than racing the child's (fast, synchronous) execution against the
    // marker's OS-pipe latency.
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
    }, 15_000);

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
          // Not the target step yet — ack it so the worker can proceed.
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
      // If it exits before reaching the target step, something is wrong
      // with the worker itself, not the kill-point mechanics.
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

  // The actual kill. child.kill() maps to TerminateProcess on Windows —
  // an immediate hard kill, no graceful shutdown, no chance for any
  // in-flight write to complete beyond what the OS already flushed.
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 150));

  return { tmpDir, dbPath, activityLogPath, stepsReached: stepsSeen };
}

/** Invariants that must hold after *every* kill point, no matter how far
 * the script got. */
function assertBaseInvariants(db: Database.Database): void {
  const integrity = checkIntegrity(db);
  expect(integrity.ok, `integrity_check failed: ${integrity.issues.join('; ')}`).toBe(true);

  const fkViolations = checkForeignKeys(db);
  expect(fkViolations, `foreign_key_check found violations: ${JSON.stringify(fkViolations)}`).toEqual([]);
}

describe('kill-point durability gate (§28 M1: kill at 20 scripted points)', () => {
  const outcomes: Record<number, KillOutcome> = {};

  afterAll(() => {
    for (const outcome of Object.values(outcomes)) {
      rmSync(outcome.tmpDir, { recursive: true, force: true });
    }
  });

  it.each(Array.from({ length: 20 }, (_, i) => i + 1))(
    'kill point %i: reconciles cleanly, no lost committed state',
    async (killAfterStep) => {
      const outcome = await runToKillPoint(killAfterStep);
      outcomes[killAfterStep] = outcome;

      const db = openConnection(outcome.dbPath);
      try {
        assertBaseInvariants(db);

        // Points 3 and 4 are *inside* the §5.1.1 bootstrap transaction —
        // a kill there must leave nothing committed at all (atomicity).
        if (killAfterStep === 3 || killAfterStep === 4) {
          const companies = db.prepare('SELECT COUNT(*) as n FROM companies').get() as { n: number };
          expect(companies.n, 'transaction must not have partially committed').toBe(0);
        }

        // Point 5: the transaction committed — company and director both
        // durably exist, correctly linked.
        if (killAfterStep === 5) {
          const company = db.prepare('SELECT director_employee_id FROM companies').get() as {
            director_employee_id: string | null;
          };
          expect(company.director_employee_id).not.toBeNull();
          const employees = db.prepare('SELECT COUNT(*) as n FROM employees').get() as { n: number };
          expect(employees.n).toBe(1);
        }

        // Point 14: the worktree lease was acquired.
        if (killAfterStep === 14) {
          const wt = db.prepare('SELECT lease_holder FROM worktrees').get() as { lease_holder: string | null };
          expect(wt.lease_holder).not.toBeNull();
        }

        // Point 15: the crux of the whole gate. The file has the entry —
        // the mirror does not yet, until reconcile() repairs it.
        if (killAfterStep === 15) {
          expect(existsSync(outcome.activityLogPath)).toBe(true);
          const fileContent = readFileSync(outcome.activityLogPath, 'utf8').trim();
          expect(fileContent.length, 'activity.jsonl must have the entry — file is written first').toBeGreaterThan(0);

          const beforeRepair = db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
          expect(beforeRepair.n, 'mirror must NOT have it yet — that is the whole point of this kill point').toBe(0);

          const report = reconcile(db, outcome.activityLogPath);
          expect(report.mirrorRepaired).toBe(1);

          const afterRepair = db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
          expect(afterRepair.n, 'reconcile() must have repaired the mirror from the file tail').toBe(1);
          return; // already ran reconcile() for this point
        }

        // Point 17: a streaming conversation message must be aborted by reconcile().
        if (killAfterStep === 17) {
          const before = db.prepare("SELECT status FROM conversation_messages").get() as
            | { status: string }
            | undefined;
          expect(before?.status).toBe('streaming');
        }

        // Point 18+: the task was marked running — reconcile() must block it.
        if (killAfterStep >= 18) {
          const task = db.prepare('SELECT status FROM tasks WHERE title = ?').get('Do the thing') as
            | { status: string }
            | undefined;
          expect(task?.status).toBe('running');
        }

        // Run reconcile() for every point that didn't already run it above
        // (15 returned early), and check its after-effects where relevant.
        const report = reconcile(db, outcome.activityLogPath);

        if (killAfterStep === 17) {
          const after = db.prepare('SELECT status FROM conversation_messages').get() as { status: string };
          expect(after.status).toBe('aborted');
        }

        if (killAfterStep >= 18) {
          const task = db.prepare('SELECT status, status_reason FROM tasks WHERE title = ?').get('Do the thing') as {
            status: string;
            status_reason: string;
          };
          expect(task.status).toBe('blocked');
          expect(task.status_reason).toBe('app_restart');
        }

        // Whatever reconcile() did, it must never itself leave the DB
        // inconsistent.
        assertBaseInvariants(db);
        void report;
      } finally {
        db.close();
      }
    },
    20_000,
  );
});
