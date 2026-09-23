import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { reconcile } from '../../../src/main/db/reconcile';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { startTimeOfLiveProcess, processIsConfirmedGone } from '../../helpers/processStartTime';
import { seedEmployee, seedProject } from '../../helpers/dbFixtures';
import { insertWorktree, getWorktreeById } from '../../../src/main/db/repositories/worktrees';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * Gate item 3, strengthened per the M5 plan review: not "reconcile ran and
 * didn't throw", but the actual safety proof — a lease held by an employee
 * whose recorded `pid`/`process_start_time` belong to a **real, live
 * process** (spawned here, provably alive via the same
 * `getProcessStartTime` check `reconcile.test.ts`'s own orphan-sweep tests
 * use), reclaimed only *after* that process is dead. `reconcile()`
 * (`db/reconcile.ts`) sequences `sweepOrphans()` before
 * `reclaimExpiredLeases()`; this test proves that ordering held for this
 * specific worktree via the `events` table's own monotonic `seq` — the
 * actual mechanism, not the plan's prose about it.
 */
describe('lease reclaim safety (§4.4 Q7 — gate item 3)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let dummyChild: ChildProcess | undefined;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m5-reclaim-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    dummyChild?.kill();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gate 3: an expired lease held by a provably-live process — the process is killed BEFORE the lease is reclaimed, never while a live holder still has it', async () => {
    const project = seedProject(db);

    dummyChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    const pid = dummyChild.pid;
    expect(pid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it fully start
    // Throws unless the read says 'alive' — never merely "not null".
    const startTime = startTimeOfLiveProcess(pid as number);

    const employee = seedEmployee(db, { name: 'Ravi', pid, process_start_time: startTime });
    const worktree = insertWorktree(db, {
      project_id: project.id,
      path: 'C:\\wt\\ravi',
      branch: 'bureau/ravi/unassigned',
      base_commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      status: 'leased',
    });
    // acquireWorktreeLease (the repo function acquireLease wraps) always
    // sets a future expiry, so an already-expired lease has to be written
    // directly — same as this codebase's other reconcile tests do.
    db.prepare(
      "UPDATE worktrees SET lease_holder = ?, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(employee.id, worktree.id);

    const report = await reconcile(db, activityLog, tmpDir);

    expect(report.orphansKilled, 'the orphan sweep must have caught this employee').toEqual([
      employee.id,
    ]);
    expect(report.leasesReclaimed).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(
      processIsConfirmedGone(pid as number),
      'the process must actually be dead now, not merely marked so',
    ).toBe(true);

    const afterWorktree = getWorktreeById(db, worktree.id);
    expect(afterWorktree?.status).toBe('free');
    expect(afterWorktree?.lease_holder).toBeNull();

    // The actual safety proof: employee.orphan_killed's seq strictly
    // precedes git.lease_reclaimed's seq — the kill provably happened
    // before the lease was handed back, not concurrently with or after a
    // live holder still had it.
    const orphanEvent = db
      .prepare("SELECT seq FROM events WHERE type = 'employee.orphan_killed' AND employee_id = ?")
      .get(employee.id) as { seq: number } | undefined;
    const reclaimEvent = db
      .prepare("SELECT seq FROM events WHERE type = 'git.lease_reclaimed'")
      .get() as { seq: number } | undefined;
    expect(orphanEvent, 'expected an employee.orphan_killed event').toBeDefined();
    expect(reclaimEvent, 'expected a git.lease_reclaimed event').toBeDefined();
    expect(
      orphanEvent!.seq,
      `employee.orphan_killed (seq=${orphanEvent?.seq}) must precede git.lease_reclaimed (seq=${reclaimEvent?.seq}) — this ordering IS the safety proof`,
    ).toBeLessThan(reclaimEvent!.seq);
  });

  it('a lease held by an employee with no recorded pid (never ran a real process) is reclaimed with no orphan-kill step — nothing to prove alive or dead, not a safety gap', async () => {
    const project = seedProject(db);
    const employee = seedEmployee(db, { name: 'Priya' }); // pid defaults to null
    const worktree = insertWorktree(db, {
      project_id: project.id,
      path: 'C:\\wt\\priya',
      branch: 'b',
      base_commit: 'cafecafecafecafecafecafecafecafecafecafe',
      status: 'leased',
    });
    db.prepare(
      "UPDATE worktrees SET lease_holder = ?, lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
    ).run(employee.id, worktree.id);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.orphansKilled).toEqual([]);
    expect(report.leasesReclaimed).toBe(1);
  });
});
