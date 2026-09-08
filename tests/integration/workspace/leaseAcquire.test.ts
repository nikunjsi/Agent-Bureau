import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';
import { insertWorktree, getWorktreeById } from '../../../src/main/db/repositories/worktrees';
import { acquireLease } from '../../../src/main/workspace/employeeWorktree';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * Gate item 2. `acquireLease` wraps the real §5.1 `BEGIN IMMEDIATE`
 * guard (`acquireWorktreeLease`, `worktrees.ts`, unmodified since M1;
 * `BEGIN IMMEDIATE`-ness itself is already proven by
 * `singleWriterAndLocking.test.ts`). That guard's atomicity is not a
 * theoretical property here to begin with: better-sqlite3 is fully
 * synchronous and this process holds the *only* write connection
 * (enforced and tested separately), so no two `UPDATE`s against the same
 * row can ever physically interleave — what this test actually proves is
 * that the guard's own SQL predicate and this wrapper's plumbing around
 * it are logically correct (exactly one row-changed per free worktree, no
 * off-by-one letting a second acquirer also see `changes > 0`), the same
 * way `twoEmployeeConcurrency.test.ts` tests same-process concurrency
 * elsewhere in this codebase. `Promise.all` over many independently-
 * scheduled acquirers, repeated across many fresh worktrees, is what
 * "run enough times a race would surface" means for a mechanism whose
 * true concurrency guarantee comes from single-threaded JS + SQLite
 * transaction atomicity, not from this test's own scheduling.
 */
describe('acquireLease concurrency (§5.1 transactional guard — gate item 2)', () => {
  let dbDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    dbDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5-lease-'));
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
  });

  it('gate 2: N concurrent acquirers racing for one free worktree — exactly one ever wins, across many independent runs', async () => {
    const project = seedProject(db);
    const CONCURRENT_ACQUIRERS = 25;
    const ITERATIONS = 30;

    for (let iter = 0; iter < ITERATIONS; iter += 1) {
      const worktree = insertWorktree(db, {
        project_id: project.id,
        path: `C:\\wt\\${iter}`,
        branch: 'b',
        base_commit: 'c',
        status: 'free',
      });
      const employees = Array.from({ length: CONCURRENT_ACQUIRERS }, (_, i) =>
        seedEmployee(db, { name: `racer-${iter}-${i}` }),
      );

      // Every call is scheduled on its own microtask/macrotask boundary
      // (setImmediate, not a bare Promise.resolve) so calls genuinely
      // interleave at the JS event-loop level rather than all running in
      // strict array order inside one synchronous Promise.all pass.
      const results = await Promise.all(
        employees.map(
          (employee) =>
            new Promise<boolean>((resolve) => {
              setImmediate(() => resolve(acquireLease(db, activityLog, worktree, employee, 2700)));
            }),
        ),
      );

      const winners = results.filter(Boolean);
      expect(
        winners,
        `iteration ${iter}: exactly one of ${CONCURRENT_ACQUIRERS} concurrent acquirers must win`,
      ).toHaveLength(1);

      const row = getWorktreeById(db, worktree.id);
      expect(row?.status).toBe('leased');
      expect(row?.lease_holder).not.toBeNull();
    }

    // One git.lease_acquired event per iteration — never more, never fewer.
    const events = db
      .prepare("SELECT COUNT(*) as n FROM events WHERE type = 'git.lease_acquired'")
      .get() as { n: number };
    expect(events.n).toBe(ITERATIONS);
  });

  it("a second acquirer is refused while the first holder's lease is still live (not expired)", async () => {
    const project = seedProject(db);
    const worktree = insertWorktree(db, {
      project_id: project.id,
      path: 'C:\\wt\\single',
      branch: 'b',
      base_commit: 'c',
      status: 'free',
    });
    const first = seedEmployee(db, { name: 'first' });
    const second = seedEmployee(db, { name: 'second' });

    expect(acquireLease(db, activityLog, worktree, first, 2700)).toBe(true);
    expect(acquireLease(db, activityLog, worktree, second, 2700)).toBe(false);

    const row = getWorktreeById(db, worktree.id);
    expect(row?.lease_holder).toBe(first.id);
  });
});
