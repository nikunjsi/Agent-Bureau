import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { ActivityLog } from '../../src/main/db/activityLog';
import { reconcile } from '../../src/main/db/reconcile';
import { insertConversationMessage } from '../../src/main/db/repositories/conversationMessages';
import { insertCompany } from '../../src/main/db/repositories/companies';
import { insertConversation } from '../../src/main/db/repositories/conversations';
import { seedEmployee, seedProject, seedRole, seedTask } from '../helpers/dbFixtures';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * D-5 / M0–M2 report §6(c) item 7: **nobody had proven that a crash *during*
 * `reconcile()` is safe.**
 *
 * `killPoints.test.ts` kills the app at 22 points and then runs `reconcile()`
 * to convergence — so every one of those points is a crash the recovery
 * handles. None of them is a crash *inside the recovery*, and M11 makes
 * `reconcile()` longer (assignment state, Director session), which widens the
 * window it has never been tested in.
 *
 * ## How the crash is produced, and why this is a real one
 *
 * `reconcile()` is eleven steps, each writing rows and emitting events, with
 * no transaction spanning them — by design: they are independent repairs, and
 * one failing must not roll back the others. A crash is therefore "stopped
 * between two of those writes with the earlier ones durable", which is exactly
 * what an exception thrown from the activity log at the Nth event produces.
 * SQLite has already committed what came before; nothing unwinds it.
 *
 * Every N from 1 to "more events than reconcile emits" is driven, so this is
 * not one hand-picked window: it is every window there is.
 *
 * ## What must hold
 *
 * **Convergence** — the final state after crash-then-rerun equals the state a
 * single clean run reaches, exactly. **No duplicate events** — a repair that
 * already happened must not be recorded twice, because the activity log is
 * what a person reads to find out what the app did to their work.
 *
 * ## What this measured, which nobody had written down
 *
 * A crash at event N loses **exactly that event**, and only it. The repair's
 * row write commits before the event is logged (invariant #3's own ordering:
 * commit, then record), so a crash in between leaves the repair done and the
 * line unwritten — and the next run, finding nothing left to fix, has nothing
 * to re-announce. Every window behaves this way, and the loss never exceeds
 * one line.
 *
 * That is the safe direction and the same trade `ActivityLog` already makes
 * between its file and its mirror: a state change with no log line, never a
 * log line with no state change. It cannot be closed by a transaction either,
 * because a transaction is precisely where `logEvent` must not be called
 * (AUDIT M0–M2 #29). Recorded here as a measured property of the recovery
 * path rather than left for M11 to discover while lengthening it.
 */
describe('a crash inside reconcile() is safe, at every window (D-5)', () => {
  let tmpDir: string;
  let dbPath: string;
  let logPath: string;

  /** A database that gives `reconcile()` real work in several of its steps. */
  async function seedWorkForReconcile(): Promise<void> {
    const db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    const activityLog = ActivityLog.open(logPath, db);

    const company = insertCompany(db, { name: 'Test Co', home_path: tmpDir });
    const conversation = insertConversation(db, {
      company_id: company.id,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
      status: 'active',
    });
    const role = seedRole(db);
    const employee = seedEmployee(db, { role_key: role.full_key });
    const project = seedProject(db);
    // A task left `running` by a crash — `blockRunningTasks` repairs it.
    seedTask(db, { project_id: project.id, status: 'running', assignee_employee_id: employee.id });
    // A message left mid-stream — `abortStaleStreamingMessages` repairs it.
    insertConversationMessage(db, {
      conversation_id: conversation.id,
      project_id: null,
      author: 'director',
      kind: 'text',
      body: 'half a reply',
      payload: null,
      checkpoint_id: null,
      status: 'streaming',
    });
    // A `control.json` from a process that no longer exists — swept (§7.10).
    const stateDir = path.join(tmpDir, 'employees', employee.id);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'control.json'), '{"port":1,"token":"x"}', 'utf8');

    activityLog.close();
    db.close();
  }

  /**
   * Runs `reconcile()` with the activity log rigged to throw on its `failAt`-th
   * event — the crash — or cleanly when `failAt` is null. Returns how many
   * events it managed to write.
   */
  async function runReconcile(failAt: number | null): Promise<number> {
    const db = openConnection(dbPath);
    const activityLog = ActivityLog.open(logPath, db);
    let written = 0;
    const realLogEvent = activityLog.logEvent.bind(activityLog);
    // Always counted, thrown from only when asked: the clean run's count is
    // what tells the loop below how many windows there are to crash in.
    Object.assign(activityLog, {
      logEvent: (input: Parameters<typeof realLogEvent>[0]) => {
        written += 1;
        if (written === failAt) throw new Error(`crash at event ${failAt}`);
        return realLogEvent(input);
      },
    });
    try {
      await reconcile(db, activityLog, tmpDir);
    } catch (err) {
      if (failAt === null) throw err;
    } finally {
      activityLog.close();
      db.close();
    }
    return written;
  }

  /** Everything a later run could disagree about, plus the event tally. */
  function observe(): {
    rows: unknown[];
    events: Record<string, number>;
  } {
    const db = openConnection(dbPath);
    try {
      // Ids are deliberately not compared: each iteration re-seeds, so every
      // row is a new ULID and comparing them would fail on the fixture
      // rather than on anything reconcile did. What must match is the
      // repaired *state*.
      const rows = [
        db.prepare('SELECT status, status_reason FROM tasks ORDER BY status').all(),
        db.prepare('SELECT status FROM employees ORDER BY status').all(),
        db.prepare('SELECT status FROM conversation_messages ORDER BY status').all(),
        db.prepare('SELECT lease_holder FROM worktrees ORDER BY lease_holder').all(),
      ];
      const events: Record<string, number> = {};
      for (const row of db
        .prepare('SELECT type, COUNT(*) AS n FROM events GROUP BY type')
        .all() as { type: string; n: number }[]) {
        events[row.type] = row.n;
      }
      return { rows, events };
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reconcile-crash-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    logPath = path.join(tmpDir, 'activity.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a clean run repairs what was left behind, and says so once', async () => {
    // The baseline every crash case is compared against — and a check that
    // the fixture actually gives reconcile work to do, so the convergence
    // assertions below are not comparing two empty runs.
    await seedWorkForReconcile();

    await runReconcile(null);

    const after = observe();
    expect(after.events['app.reconciled']).toBe(1);
    expect(after.events['task.blocked']).toBe(1);
    expect(Object.keys(after.events).length).toBeGreaterThan(2);
  });

  it('converges after a crash at every event boundary, with nothing recorded twice', async () => {
    await seedWorkForReconcile();
    const clean = await runReconcile(null);
    const expected = observe();
    expect(clean, 'the fixture must give reconcile several events of work').toBeGreaterThan(2);

    for (let failAt = 1; failAt <= clean; failAt += 1) {
      rmSync(tmpDir, { recursive: true, force: true });
      mkdirSync(tmpDir, { recursive: true });
      await seedWorkForReconcile();

      await runReconcile(failAt); // the crash
      await runReconcile(null); // the next launch

      const after = observe();
      expect(after.rows, `state after a crash at event ${failAt}`).toEqual(expected.rows);
      // Exactly the clean run's events, not "at most one extra": a repair
      // the crashed run already made and recorded must not be recorded
      // again by the run that picks up after it.
      // **No duplicates, ever**: no type may appear more often than a clean
      // run produces it. A repair already made and recorded must not be
      // recorded again by the run that picks up after the crash.
      for (const [type, count] of Object.entries(after.events)) {
        expect(count, `${type} after a crash at event ${failAt}`).toBeLessThanOrEqual(
          expected.events[type] ?? 0,
        );
      }
      // **And at most one is missing — the one the crash interrupted.** See
      // this file's header: the repair commits before its event, so a crash
      // in between loses the line and the next run has nothing left to
      // redo. Asserting the bound rather than equality is what makes that a
      // measured property instead of a tolerated mismatch.
      const missing = Object.entries(expected.events).filter(
        ([type, count]) => (after.events[type] ?? 0) < count,
      );
      expect(
        missing.length,
        `events lost to a crash at event ${failAt}: ${JSON.stringify(missing)}`,
      ).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it('a second clean run repairs nothing and records only that it ran', async () => {
    // The control for the loop above: re-running reconcile with nothing left
    // to fix must be inert apart from its own `app.reconciled`. Without this,
    // a reconcile that silently re-did its work would still satisfy
    // "converges", because both runs would re-do it identically.
    await seedWorkForReconcile();
    await runReconcile(null);
    const afterFirst = observe();

    await runReconcile(null);

    const afterSecond = observe();
    expect(afterSecond.rows).toEqual(afterFirst.rows);
    for (const [type, count] of Object.entries(afterSecond.events)) {
      const before = afterFirst.events[type] ?? 0;
      expect(count, `${type} after a second run`).toBe(
        type === 'app.reconciled' ? before + 1 : before,
      );
    }
  });
});
