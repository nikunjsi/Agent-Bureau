import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ProbeCache } from '../../../src/main/engine/probeCache';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { seedEmployee, seedProject, seedTask, seedRole } from '../../helpers/dbFixtures';
import type { ProbeOptions, ProbeResult } from '../../../src/shared/engine/types';
import {
  PROBE_LIVENESS_CEILING_MS,
  PROBE_RESPONSIVENESS_BUDGET_MS,
} from '../../../src/shared/engine/types';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * `probe()` caching (§7.8's bounds, and the 5064ms flake).
 *
 * **These drive the real `ProbeCache` and, for the load test, the real
 * `Supervisor.assign()` path** — not a re-implementation of the caching
 * rule. The load test is the one that matters: the flake only ever
 * appeared under concurrency, and testing in isolation is exactly what let
 * the M5 soak be misdiagnosed three sessions running.
 */

/**
 * Counts real probe calls and can be made slow, so the single-flight
 * window is a real window rather than an instantaneous one.
 *
 * A SUBCLASS rather than a hand-assembled object literal: the literal
 * would have to restate every method of `EngineAdapter`, and would then
 * silently stop matching the interface the moment one changed. Only
 * `probe()` is overridden, which is the only thing this test is about.
 */
class CountingProbeAdapter extends FakeAdapter {
  probeCalls = 0;
  /** Mutable between calls, so a test can make the SECOND probe answer
   * differently from the first — which is the only way to tell "served from
   * cache" apart from "asked again and got the same thing". */
  nextResult: Partial<ProbeResult> = {};
  /** Every budget this adapter was actually handed, in order. */
  readonly budgetsSeen: Array<number | undefined> = [];

  constructor(private readonly delayMs = 0) {
    super();
  }

  override async probe(options?: ProbeOptions): Promise<ProbeResult> {
    this.probeCalls += 1;
    this.budgetsSeen.push(options?.budgetMs);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { ...(await super.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS })), ...this.nextResult };
  }
}

describe('ProbeCache', () => {
  it('asks the adapter once and serves the rest from cache', async () => {
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter();

    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });

    expect(adapter.probeCalls).toBe(1);
    expect(cache.underlyingProbeCount).toBe(1);
  });

  it('NEVER caches an indeterminate result — a 60s TTL on "I could not find out" is worse than no cache', async () => {
    // The TTL is 60s. Storing a non-answer would serve it for a full
    // minute — and because this cache is in-memory, the first probe after
    // every restart is both the coldest and the most likely to come back
    // indeterminate, so caching it would take the single worst case and
    // make it the answer for the whole minute after every start. That is
    // strictly worse than the bug this session fixed.
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter();
    adapter.nextResult = {
      determination: 'indeterminate',
      installed: false,
      metered: true,
      error: 'probe() did not finish within its 30000ms budget (§7.8)',
    };

    const first = await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    expect(first.determination).toBe('indeterminate');

    // The retry is the cheap path, not the expensive one: by now the page
    // cache is warm (measured warm p50 1785ms against a cold 3875ms+).
    adapter.nextResult = { determination: 'determined', installed: true, metered: false };
    const second = await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });

    expect(adapter.probeCalls, 'an indeterminate result must not have been cached').toBe(2);
    expect(second.determination).toBe('determined');
    expect(second.installed).toBe(true);

    // ...and the real answer, once it arrives, IS cached.
    const third = await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    expect(adapter.probeCalls).toBe(2);
    expect(third.installed).toBe(true);
  });

  it('single-flights only callers asking for the SAME budget (§7.8 defines two)', async () => {
    // Sharing one in-flight probe between the two budgets is dishonest in
    // both directions: a 2.5s caller joining a 30s probe waits far past its
    // own budget, and a 30s caller joining a 2.5s probe is handed an
    // indeterminate answer it had the patience to avoid.
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter(50);

    const [responsive, ceiling] = await Promise.all([
      cache.probe(adapter, { budgetMs: PROBE_RESPONSIVENESS_BUDGET_MS }),
      cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS }),
    ]);

    expect(adapter.probeCalls, 'different budgets are different questions').toBe(2);
    expect(responsive.determination).toBe('determined');
    expect(ceiling.determination).toBe('determined');
  });

  it('passes the caller budget through to the adapter rather than inventing one', async () => {
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter();

    await cache.probe(adapter, { budgetMs: PROBE_RESPONSIVENESS_BUDGET_MS });

    expect(adapter.budgetsSeen).toEqual([PROBE_RESPONSIVENESS_BUDGET_MS]);
  });

  it('a caller that names no budget gets the liveness ceiling, not an adapter default', async () => {
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter();

    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });

    expect(adapter.budgetsSeen).toEqual([PROBE_LIVENESS_CEILING_MS]);
  });

  it('SINGLE-FLIGHTS concurrent callers — the case a plain memo would miss', async () => {
    // Ten callers arriving before the first probe resolves all miss an
    // empty cache. A memoise-on-resolve would spawn ten processes here and
    // still look correct in the sequential test above — which is exactly
    // the shape of the original flake.
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter(50);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS }),
      ),
    );

    expect(adapter.probeCalls).toBe(1);
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.installed === results[0]!.installed)).toBe(true);
  });

  it('re-probes once the TTL has passed', async () => {
    let now = 1_000;
    const cache = new ProbeCache(60_000, () => now);
    const adapter = new CountingProbeAdapter();

    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    now += 59_000;
    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    expect(adapter.probeCalls).toBe(1);

    now += 2_000;
    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    expect(adapter.probeCalls).toBe(2);
  });

  it('invalidate() discards a stale answer without waiting out the TTL', async () => {
    // Installing a CLI mid-session makes a cached "not installed" actively
    // wrong; §15.4's setup flow (M13) is the real caller.
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter();

    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    cache.invalidate(adapter);
    await cache.probe(adapter, { budgetMs: PROBE_LIVENESS_CEILING_MS });

    expect(adapter.probeCalls).toBe(2);
  });

  it('keys by adapter INSTANCE, so two adapters never serve each other stale answers', async () => {
    // Not by `adapter.key`. claude-code's probe honours CLAUDE_CONFIG_DIR,
    // so two adapters with the same key can genuinely have different auth
    // answers — and a string key would hand one adapter's result to the
    // other. Caught by five unrelated suites failing impossibly when the
    // first version of this cache keyed by the string.
    const cache = new ProbeCache();
    const a = new CountingProbeAdapter();
    const b = new CountingProbeAdapter();
    expect(a.key).toBe(b.key); // same engine...

    await cache.probe(a, { budgetMs: PROBE_LIVENESS_CEILING_MS });
    await cache.probe(b, { budgetMs: PROBE_LIVENESS_CEILING_MS });

    expect(a.probeCalls, 'each adapter is probed on its own').toBe(1);
    expect(b.probeCalls).toBe(1);
  });
});

describe('the load case that produced the 5064ms flake', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-probe-load-'));
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
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('N concurrent assign()s produce exactly ONE underlying probe', async () => {
    // The assertion the plan called for, driven through the real
    // `Supervisor.assign()` rather than by calling the cache directly:
    // this is the production path, and a cache the supervisor forgot to
    // use would still pass every test above. (Session 1's own lesson: a
    // guard is not a guard until something on the real path calls it.)
    const cache = new ProbeCache();
    const adapter = new CountingProbeAdapter(30);
    const project = seedProject(db);

    const role = seedRole(db);
    const supervisors: Supervisor[] = [];
    const contexts: {
      employee: ReturnType<typeof seedEmployee>;
      task: ReturnType<typeof seedTask>;
    }[] = [];
    for (let i = 0; i < 6; i += 1) {
      const employee = seedEmployee(db, { name: `Probe${i}`, role_key: role.full_key });
      const task = seedTask(db, { project_id: project.id });
      supervisors.push(
        new Supervisor(employee.id, { db, activityLog, adapter, probeCache: cache }),
      );
      contexts.push({ employee, task });
    }

    await Promise.all(
      supervisors.map((supervisor, i) =>
        supervisor.assign({
          employee: contexts[i]!.employee,
          role,
          task: contexts[i]!.task,
          worktreePath: path.join(tmpDir, 'wt', String(i)),
          stateDir: path.join(tmpDir, 'state', String(i)),
          baseDir: path.join(tmpDir, 'state', String(i)),
          toolServer: placeholderToolServer,
          controlChannel: placeholderControlChannel,
          broker: noopSecretBroker,
          effectiveAutonomy: 'guided',
          modelId: null,
          turnBudgetCapUsdMicros: null,
        }),
      ),
    );

    expect(adapter.probeCalls, 'six concurrent assigns should share one probe').toBe(1);
    expect(cache.underlyingProbeCount).toBe(1);

    await Promise.all(supervisors.map((s) => s.stop(0)));
  });
});
