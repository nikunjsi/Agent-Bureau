import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { ActivityLog } from '../../src/main/db/activityLog';
import { insertCheckpoint, getCheckpointById } from '../../src/main/db/repositories/checkpoints';
import {
  resolveExpiredCheckpoints,
  startCheckpointsTick,
} from '../../src/main/checkpoints/checkpointsTick';
import { CheckpointSurfacer } from '../../src/main/checkpoints/surfacing';
import { ProbeCache } from '../../src/main/engine/probeCache';
import { FakeAdapter } from '../../src/main/engine/fakeAdapter';
import { Supervisor } from '../../src/main/engine/supervisor';
import { insertUsage, getUsageSince } from '../../src/main/db/repositories/usage';
import { localMidnightIso } from '../../src/main/cost/budgetCheck';
import { setSetting } from '../../src/main/db/repositories/settings';
import { getRoleByFullKey } from '../../src/main/db/repositories/roles';
import { seedEmployee } from '../helpers/dbFixtures';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../src/shared/engine/seams';
import type { AgentEvent } from '../../src/shared/engine/events';
import type { AnswerDeps } from '../../src/main/checkpoints/answerCheckpoint';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * P-3 / chaos scenario #10: "the clock jumps backwards". Owner recorded as M10
 * hardening. The inventory, and what each one measures:
 *
 * | Mechanism                | Measures              | Clock                       |
 * |--------------------------|-----------------------|-----------------------------|
 * | checkpoint expiry        | an absolute deadline  | wall (must survive restart) |
 * | post-restart grace       | a duration            | MONOTONIC (switched here)   |
 * | worktree lease TTL       | reserved (N-11)       | none in force; M11          |
 * | probe cache TTL (60 s)   | a duration            | MONOTONIC (switched here)   |
 * | budget daily window      | a calendar day        | wall (local midnight)       |
 * | rate-limit backoff cap   | a duration            | MONOTONIC (switched here)   |
 *
 * Deadlines and calendar days are wall-clock by definition, so for those the
 * test is that a backward jump fails SAFE. Durations switched to a monotonic
 * clock, and the test is that a backward jump changes nothing.
 */
describe('the clock jumps backwards (P-3, chaos #10)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let deps: AnswerDeps;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-clock-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    deps = { db, activityLog, baseDir: tmpDir };
  });

  afterEach(() => {
    vi.useRealTimers();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function checkpointWithSafeDefault() {
    return insertCheckpoint(db, activityLog, {
      type: 'decision',
      urgency: 'blocking',
      title: 'Cache the report?',
      context: 'Caching is faster but can be stale.',
      options: [
        { id: 'cache', label: 'Cache', consequence: 'Faster, possibly minutes stale.' },
        { id: 'leave', label: 'Leave it', consequence: 'Nothing changes.', reversible: true },
      ],
      default_action: 'leave',
    });
  }

  it('checkpoint expiry (wall, a deadline): a backward jump never resolves a checkpoint early', () => {
    const cp = checkpointWithSafeDefault();
    expect(cp.expires_at).not.toBeNull();
    const jumped = Date.now() - DAY_MS;
    const report = resolveExpiredCheckpoints(deps, {
      appStartedAtMs: jumped - 60 * MINUTE_MS,
      nowMs: jumped,
      uptimeMs: 60 * MINUTE_MS,
    });
    expect(report.resolved).toEqual([]);
    expect(getCheckpointById(db, cp.id)?.status).toBe('pending');
  });

  it('post-restart grace (monotonic): a wall clock jumped back a day does not stretch the grace, and uptime alone ends it', () => {
    const cp = checkpointWithSafeDefault();
    const startedWall = Date.now();
    const jumped = startedWall - DAY_MS;
    // Expired against the jumped clock too, so only the grace decides.
    db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
      new Date(jumped - MINUTE_MS).toISOString(),
      cp.id,
    );
    const report = resolveExpiredCheckpoints(deps, {
      appStartedAtMs: startedWall,
      nowMs: jumped,
      uptimeMs: 11 * MINUTE_MS,
    });
    expect(report.graceRemainingMs).toBe(0);
    expect(report.resolved).toEqual([cp.id]);
  });

  it('post-restart grace (monotonic): the real tick measures uptime, not the wall clock', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedWall = Date.parse('2026-09-17T12:00:00.000Z');
    vi.setSystemTime(startedWall);
    let monotonic = 1_000;
    const cp = checkpointWithSafeDefault();
    const tick = startCheckpointsTick(
      deps,
      new CheckpointSurfacer(db, { activityLog }),
      { isAnyWindowFocused: () => true, notify: () => {} },
      startedWall,
      999_999_999,
      () => monotonic,
    );
    try {
      const jumped = startedWall - DAY_MS;
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
        new Date(jumped - MINUTE_MS).toISOString(),
        cp.id,
      );
      vi.setSystemTime(jumped);

      monotonic += 5 * MINUTE_MS; // inside the 10-minute grace
      tick.runNow();
      expect(getCheckpointById(db, cp.id)?.status).toBe('pending');

      monotonic += 6 * MINUTE_MS; // past it, though the wall clock says a day earlier
      tick.runNow();
      expect(getCheckpointById(db, cp.id)?.status).not.toBe('pending');
    } finally {
      tick.stop();
    }
  });

  it('probe cache TTL (monotonic): an elapsed time that comes out negative is stale, not fresh for a day', async () => {
    let clock = 10 * DAY_MS;
    const cache = new ProbeCache(60_000, () => clock);
    const adapter = new FakeAdapter();
    await cache.probe(adapter, { budgetMs: 1_000 });
    clock -= DAY_MS;
    await cache.probe(adapter, { budgetMs: 1_000 });
    expect(cache.underlyingProbeCount).toBe(2);
  });

  it('budget daily window (wall, a calendar day): a backward jump over-counts spend, the fail-closed direction', () => {
    const employee = seedEmployee(db);
    insertUsage(db, {
      employee_id: employee.id,
      task_id: null,
      engine: 'fake',
      model: 'm',
      tokens_in: 1,
      tokens_out: 1,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd_micros: 5_000_000,
      computed_cost_usd_micros: null,
      turn_index: 0,
      source: 'turn',
    });
    const jumpedMidnight = localMidnightIso(new Date(Date.now() - DAY_MS));
    // Today's real spend still counts against "today" as the jumped clock sees it.
    expect(getUsageSince(db, jumpedMidnight)).toBe(5_000_000);
  });

  it('rate-limit backoff cap (monotonic): a wall clock jumped back an hour does not keep a rate-limited employee waiting forever', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const startedWall = Date.parse('2026-09-17T12:00:00.000Z');
    vi.setSystemTime(startedWall);
    setSetting(db, 'engines.rateLimitMaxWaitMinutes', 10);
    let monotonic = 1_000;
    const employee = seedEmployee(db);
    const adapter = new FakeAdapter({
      keepOpen: true,
      events: [{ t: 'session.started', sessionId: 's1', engineVersion: 'x', model: 'm' }],
    });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      heartbeatCheckIntervalMs: 999_999_999,
      monotonicNow: () => monotonic,
    });
    await supervisor.assign({
      employee,
      role: getRoleByFullKey(db, employee.role_key)!,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    const rateLimited: AgentEvent = {
      t: 'rate_limited',
      classification: 'per_minute',
      retryAfterMs: 999_999_999,
    };
    try {
      adapter.pushEvent(rateLimited);
      await vi.waitFor(() => expect(supervisor.currentState).toBe('waiting'));

      vi.setSystemTime(startedWall - 60 * MINUTE_MS); // the jump
      monotonic += 11 * MINUTE_MS; // but eleven real minutes have passed
      adapter.pushEvent(rateLimited);
      await vi.waitFor(() => expect(supervisor.currentState).toBe('parked'));
    } finally {
      await supervisor.stop();
    }
  });
});
