import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openConnection, checkIntegrity, checkForeignKeys } from '../../src/main/db/connection';
import { reconcile } from '../../src/main/db/reconcile';
import { ActivityLog } from '../../src/main/db/activityLog';
import { rebuildMemoryIndex } from '../../src/main/memory/rebuildMemoryIndex';
import { searchMemory } from '../../src/main/memory/searchMemory';

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
  // **This file only, not the directory.** It used to be
  // `rmSync(path.dirname(...))`, which deletes the whole shared
  // `dist/test-bundles/` — including a concurrently running suite's copy.
  // That is the recorded parallel-suite collision (Known Issues,
  // 2026-09-09): `chatAborted.spec.ts` bundles into the same directory and
  // hung rather than failed when this ran alongside it. `chatAborted`
  // already removes only its own file; this now matches, which closes the
  // collision from both sides rather than one.
  rmSync(bundledWorkerPath, { force: true });
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
      // M10 steps 21-22: where §12.1 layer 1 lives for this run.
      BUREAU_KILLTEST_BASE_DIR: tmpDir,
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

/** The project the worker created. Read back rather than remembered,
 *  because the id is minted inside the killed child. */
function projectIdOf(db: Database.Database): string {
  return (db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: string }).id;
}

/**
 * AUDIT M0–M2 #9 — what "no lost committed state" has to mean.
 *
 * §28 M1's gate reads: *"kill the process at 20 scripted points; every one
 * reconciles cleanly with no lost committed state."* For 12 of the 22
 * points, nothing checked the second half. `assertBaseInvariants` runs
 * `integrity_check` and `foreign_key_check` and confirms `reconcile()` did
 * not throw — none of which looks at whether the step's own committed row
 * survived. A kill at step 19 asserted nothing about
 * `general.notifications`; a kill at 20 asserted nothing about the `usage`
 * row. **A repository that silently failed to commit would have passed
 * this gate at every one of those points.**
 *
 * This is the cumulative check: after a kill at step *k*, every row that
 * steps 1..*k* committed must still be there. It runs at every point, so
 * step 6's project is re-checked at all of 6..22 rather than only at 6.
 *
 * ## What it deliberately does NOT assert
 *
 * Identity and presence, not mutable status — because `reconcile()` runs
 * between the kill and these assertions and is *supposed* to change
 * things: a `running` task becomes `blocked`, a streaming message becomes
 * `aborted`, an expired lease is reclaimed. Those transitions are the
 * point-specific assertions' job and they stay where they are. Conflating
 * the two would make this helper fail on correct behaviour.
 *
 * Steps 3 and 4 are inside the §5.1.1 bootstrap transaction, so "committed
 * through 3" is *nothing* — the atomicity assertion below is the inverse
 * of the others and is the reason this takes `k` rather than just
 * replaying a list.
 */
function assertCommittedStateThrough(db: Database.Database, k: number): void {
  const count = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  // Step 1 — the department.
  if (k >= 1) {
    expect(count(`SELECT COUNT(*) AS n FROM departments WHERE key = 'engineering'`), 'step 1').toBe(
      1,
    );
  }

  // Step 2 — the role.
  if (k >= 2) {
    expect(count(`SELECT COUNT(*) AS n FROM roles WHERE key = 'director'`), 'step 2').toBe(1);
  }

  // Steps 3-4 — INSIDE the bootstrap transaction. Nothing may be
  // committed; this is atomicity, the inverse of every other clause here.
  if (k < 5) {
    expect(count(`SELECT COUNT(*) AS n FROM companies`), 'steps 3-4 are mid-transaction').toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM employees`), 'steps 3-4 are mid-transaction').toBe(0);
  }

  // Step 5 — the transaction committed: company and director, linked.
  if (k >= 5) {
    expect(count(`SELECT COUNT(*) AS n FROM companies`), 'step 5').toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM employees`), 'step 5').toBe(1);
    const company = db.prepare('SELECT director_employee_id FROM companies').get() as {
      director_employee_id: string | null;
    };
    expect(company.director_employee_id, 'step 5: company links its director').not.toBeNull();
  }

  // Step 6 — the project.
  if (k >= 6) {
    expect(
      count(`SELECT COUNT(*) AS n FROM projects WHERE name = 'Kill Point Project'`),
      'step 6',
    ).toBe(1);
  }

  // Step 7 — the brief.
  if (k >= 7) {
    expect(count(`SELECT COUNT(*) AS n FROM briefs WHERE version = 1`), 'step 7').toBe(1);
  }

  // Step 8 — the approval, which IS the committed state of that step
  // rather than a mutable status reconcile() might move.
  if (k >= 8) {
    const brief = db.prepare('SELECT status, approved_at FROM briefs').get() as {
      status: string;
      approved_at: string | null;
    };
    expect(brief.status, 'step 8: the approval survived').toBe('approved');
    expect(brief.approved_at, 'step 8: with its timestamp').not.toBeNull();
  }

  // Step 9 — the plan.
  if (k >= 9) {
    expect(count(`SELECT COUNT(*) AS n FROM plans WHERE version = 1`), 'step 9').toBe(1);
  }

  // Step 10 — the phase.
  if (k >= 10) {
    expect(count(`SELECT COUNT(*) AS n FROM phases WHERE name = 'Phase 1'`), 'step 10').toBe(1);
  }

  // Step 11 — the first task.
  if (k >= 11) {
    expect(count(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Do the thing'`), 'step 11').toBe(
      1,
    );
  }

  // Step 12 — the second task AND its dependency edge. The edge is the
  // half a silent commit failure would most plausibly drop, since it is a
  // second statement in the same step.
  if (k >= 12) {
    expect(
      count(`SELECT COUNT(*) AS n FROM tasks WHERE title = 'Do the other thing'`),
      'step 12: the task',
    ).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM task_deps`), 'step 12: the dependency edge').toBe(1);
  }

  // Step 13 — the worktree.
  if (k >= 13) {
    expect(count(`SELECT COUNT(*) AS n FROM worktrees`), 'step 13').toBe(1);
  }

  // Step 14 — the lease. Presence of the worktree row only; whether the
  // lease is still HELD after reconcile() is point 14's own assertion,
  // because lease reclamation is a legitimate reconcile transition.
  if (k >= 14) {
    expect(count(`SELECT COUNT(*) AS n FROM worktrees`), 'step 14').toBe(1);
  }

  // Step 16 — the mirror row for the real logEvent() call. Step 15 is the
  // gap between file and mirror BY DESIGN, so the mirror is only owed from
  // 16 onward; point 15 asserts the gap and its repair itself.
  if (k >= 16) {
    expect(
      count(`SELECT COUNT(*) AS n FROM events WHERE type = 'git.lease_acquired'`),
      'step 16: the mirror row',
    ).toBe(1);
  }

  // Step 17 — the conversation and its message row. Status is reconcile's
  // to change (streaming → aborted); the ROW must exist either way.
  if (k >= 17) {
    expect(count(`SELECT COUNT(*) AS n FROM conversations`), 'step 17: the conversation').toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM conversation_messages`), 'step 17: the message').toBe(
      1,
    );
  }

  // Step 19 — the setting. Not merely present: the VALUE the step wrote.
  // This is one of the twelve points that asserted nothing at all.
  if (k >= 19) {
    const row = db
      .prepare(`SELECT value_json FROM settings WHERE key = 'general.notifications'`)
      .get() as { value_json: string } | undefined;
    expect(row, 'step 19: the setting row exists').toBeDefined();
    expect(JSON.parse(row?.value_json ?? 'null'), 'step 19: with the value that was set').toBe(
      false,
    );
  }

  // Step 20 — the usage row, with its cost. The other point that asserted
  // nothing. Money is the state where a silent commit failure is worst.
  if (k >= 20) {
    const usage = db.prepare('SELECT cost_usd_micros FROM usage').get() as
      { cost_usd_micros: number } | undefined;
    expect(usage, 'step 20: the usage row exists').toBeDefined();
    expect(usage?.cost_usd_micros, 'step 20: with its integer micro-dollar cost').toBe(15_000);
  }

  // Step 22 — the memory index row. 21 is the deliberate file-without-row
  // gap and has its own assertion; 22 is both halves done.
  if (k >= 22) {
    expect(count(`SELECT COUNT(*) AS n FROM memory`), 'step 22: the index row').toBe(1);
  }
}

/** Invariants that must hold after *every* kill point, no matter how far
 * the script got. */
function assertBaseInvariants(db: Database.Database): void {
  const integrity = checkIntegrity(db);
  expect(integrity.ok, `integrity_check failed: ${integrity.issues.join('; ')}`).toBe(true);

  const fkViolations = checkForeignKeys(db);
  expect(
    fkViolations,
    `foreign_key_check found violations: ${JSON.stringify(fkViolations)}`,
  ).toEqual([]);
}

describe('kill-point durability gate (§28 M1: 20 points; M10 adds 21-22)', () => {
  const outcomes: Record<number, KillOutcome> = {};

  afterAll(() => {
    for (const outcome of Object.values(outcomes)) {
      rmSync(outcome.tmpDir, { recursive: true, force: true });
    }
  });

  it.each(Array.from({ length: 22 }, (_, i) => i + 1))(
    'kill point %i: reconciles cleanly, no lost committed state',
    async (killAfterStep) => {
      const outcome = await runToKillPoint(killAfterStep);
      outcomes[killAfterStep] = outcome;

      const db = openConnection(outcome.dbPath);
      const activityLog = ActivityLog.open(outcome.activityLogPath, db);
      try {
        assertBaseInvariants(db);

        // AUDIT #9. Every row steps 1..k committed must still be here — the
        // half of this gate's own wording ("no lost committed state") that
        // nothing checked at 12 of the 22 points. Asserted BEFORE reconcile()
        // so it is about what the kill left behind, not what repair restored.
        assertCommittedStateThrough(db, killAfterStep);

        // Points 3 and 4 are *inside* the §5.1.1 bootstrap transaction —
        // a kill there must leave nothing committed at all (atomicity).
        if (killAfterStep === 3 || killAfterStep === 4) {
          const companies = db.prepare('SELECT COUNT(*) as n FROM companies').get() as {
            n: number;
          };
          expect(companies.n, 'transaction must not have partially committed').toBe(0);
        }

        // Point 5: the transaction committed — company and director both
        // durably exist, correctly linked.
        if (killAfterStep === 5) {
          const company = db.prepare('SELECT director_employee_id FROM companies').get() as {
            director_employee_id: string | null;
          };
          expect(company.director_employee_id).not.toBeNull();
          const employees = db.prepare('SELECT COUNT(*) as n FROM employees').get() as {
            n: number;
          };
          expect(employees.n).toBe(1);
        }

        // Point 14: the worktree lease was acquired.
        if (killAfterStep === 14) {
          const wt = db.prepare('SELECT lease_holder FROM worktrees').get() as {
            lease_holder: string | null;
          };
          expect(wt.lease_holder).not.toBeNull();
        }

        // Point 15: the crux of the whole gate. The file has the entry —
        // the mirror does not yet, until reconcile() repairs it.
        if (killAfterStep === 15) {
          expect(existsSync(outcome.activityLogPath)).toBe(true);
          const fileContent = readFileSync(outcome.activityLogPath, 'utf8').trim();
          expect(
            fileContent.length,
            'activity.jsonl must have the entry — file is written first',
          ).toBeGreaterThan(0);

          const beforeRepair = db.prepare('SELECT COUNT(*) as n FROM events').get() as {
            n: number;
          };
          expect(
            beforeRepair.n,
            'mirror must NOT have it yet — that is the whole point of this kill point',
          ).toBe(0);

          const report = await reconcile(db, activityLog, outcome.tmpDir);
          expect(report.mirrorRepaired).toBe(1);

          // reconcile() also emits its own app.reconciled summary event
          // (AUDIT finding #2) — the repaired row plus that one, not just
          // the repaired row alone, is now the correct total.
          const afterRepair = db.prepare('SELECT COUNT(*) as n FROM events').get() as { n: number };
          expect(
            afterRepair.n,
            'reconcile() must have repaired the mirror from the file tail, plus its own summary event',
          ).toBe(2);
          const repairedRow = db.prepare('SELECT seq FROM events WHERE seq = 1').get();
          expect(repairedRow, 'the specific repaired entry (seq=1) must be present').toBeDefined();
          // AUDIT #9: and reconcile() must not have lost anything on the way.
          assertCommittedStateThrough(db, killAfterStep);
          assertBaseInvariants(db);
          return; // already ran reconcile() for this point
        }

        // Point 17: a streaming conversation message must be aborted by reconcile().
        //
        // M9: the row is now begun by the real `ChatStream` and killed with
        // an unflushed tail still in the dead process's memory — a genuine
        // mid-stream crash, not a hand-written `status: 'streaming'`.
        if (killAfterStep === 17) {
          const before = db.prepare('SELECT status, body FROM conversation_messages').get() as
            { status: string; body: string } | undefined;
          expect(before?.status).toBe('streaming');
          // The words appended within the throttle window died with the
          // process. That is the loss a reader has to be told about, and
          // it is why the marker — not the text — is what makes an aborted
          // message honest.
          expect(before?.body).toBe('');
        }

        // Point 18+: the task was marked running — reconcile() must block it.
        if (killAfterStep >= 18) {
          const task = db
            .prepare('SELECT status FROM tasks WHERE title = ?')
            .get('Do the thing') as { status: string } | undefined;
          expect(task?.status).toBe('running');
        }

        // Run reconcile() for every point that didn't already run it above
        // (15 returned early), and check its after-effects where relevant.
        const report = await reconcile(db, activityLog, outcome.tmpDir);

        if (killAfterStep === 17) {
          const after = db.prepare('SELECT status FROM conversation_messages').get() as {
            status: string;
          };
          expect(after.status).toBe('aborted');
          expect(report.streamingMessagesAborted).toBe(1);
          // §5.2's own event for it, in the real activity log — the row
          // changing state silently would leave the one durable record of
          // "this reply was cut off" nowhere at all.
          const events = db
            .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'chat.stream_aborted'")
            .get() as { n: number };
          expect(events.n).toBe(1);
        }

        if (killAfterStep >= 18) {
          const task = db
            .prepare('SELECT status, status_reason FROM tasks WHERE title = ?')
            .get('Do the thing') as {
            status: string;
            status_reason: string;
          };
          expect(task.status).toBe('blocked');
          expect(task.status_reason).toBe('app_restart');
        }

        // Points 21 and 22 — §12.1's memory write ordering (M10).
        //
        // 21 is the crux: the kill lands INSIDE `writeMemory`, between the
        // markdown file and the index row, pinned there by that function's
        // own `afterFileWrite` hook. §12.1 says this direction is the safe
        // one precisely because it is recoverable, and this is what proves
        // the claim rather than restating it — the file has the knowledge,
        // the index does not, and a rebuild restores the index from the file.
        if (killAfterStep === 21 || killAfterStep === 22) {
          const notePath = path.join(
            outcome.tmpDir,
            'memory',
            'project',
            projectIdOf(db),
            'context.md',
          );
          expect(existsSync(notePath), 'the markdown file is written first, always').toBe(true);
          expect(readFileSync(notePath, 'utf8')).toContain('SQLite');

          const indexed = db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number };
          if (killAfterStep === 21) {
            expect(indexed.n, 'the index row must NOT exist yet — that is this kill point').toBe(0);

            // The recovery §12.1 promises. Note it rebuilds from the FILE,
            // through the real walker — nothing here re-supplies the content.
            const rebuilt = rebuildMemoryIndex(db, outcome.tmpDir, activityLog);
            expect(rebuilt.indexed).toBe(1);
            const row = db.prepare('SELECT body FROM memory').get() as { body: string };
            expect(row.body).toContain('SQLite');

            // And it is searchable again, which is the thing the index is
            // for — a restored row nothing can find would be a half-repair.
            expect(searchMemory(db, 'SQLite')).toHaveLength(1);
          } else {
            expect(indexed.n, 'both halves completed').toBe(1);
          }
        }

        // Whatever reconcile() did, it must never itself leave the DB
        // inconsistent — nor lose anything that was committed before the
        // kill. Repair may legitimately CHANGE state (a running task
        // becomes blocked, a streaming message becomes aborted); it may
        // never make a committed row disappear.
        assertBaseInvariants(db);
        assertCommittedStateThrough(db, killAfterStep);
        void report;
      } finally {
        activityLog.close();
        db.close();
      }
    },
    20_000,
  );
});
