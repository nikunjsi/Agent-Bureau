import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getDbPaths } from '../../../src/main/db/paths';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { seedProject, seedEmployee, seedTask } from '../../helpers/dbFixtures';
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { costsHandlers } from '../../../src/main/ipc/handlers/costs';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { PricingTable } from '../../../src/shared/models/pricing';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const FAKE_PRICING: PricingTable = {
  version: 1,
  verified_at: '2026-01-01',
  verified_against: 'test',
  engines: {},
};

/**
 * AUDIT #17 and #18 — the two cost-read defects, driven through the real
 * IPC handlers against a real DB.
 */
describe('costs handlers read the ledger correctly (AUDIT #17, #18)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-costs-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: FAKE_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Handlers return `ipcOk({ item })` / `ipcOk({ items })`. */
  function item(result: unknown): Record<string, unknown> {
    const r = result as { ok: boolean; data?: { item?: unknown }; error?: unknown };
    if (!r.ok) throw new Error(`handler failed: ${JSON.stringify(r.error)}`);
    return r.data!.item as Record<string, unknown>;
  }
  function items<T>(result: unknown): T[] {
    const r = result as { ok: boolean; data?: { items?: unknown }; error?: unknown };
    if (!r.ok) throw new Error(`handler failed: ${JSON.stringify(r.error)}`);
    return r.data!.items as T[];
  }

  /**
   * AUDIT #17: migration 0005 added `usage.project_id` specifically
   * because "a reconciliation query that only reaches
   * `projects.spend_usd_micros` through `tasks.project_id` would silently
   * miss Director-attributed spend". `reconcile.ts` honours that;
   * `costs.ts` joined `usage -> tasks -> projects` anyway, so spend with no
   * `task_id` — exactly the Director/one-shot case the column exists for —
   * was invisible in three of the views.
   */
  describe('AUDIT #17: Director-attributed spend (no task_id) is not silently dropped', () => {
    function seedDirectorSpend(): { projectId: string } {
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Director' });
      // The real shape: a project attribution with NO task.
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: null,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 100,
          tokens_out: 50,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: 750_000,
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
      return { projectId: project.id };
    }

    it('byProject includes it', () => {
      const { projectId } = seedDirectorSpend();
      const rows = items<{ id: string; usdMicros: number }>(costsHandlers['byProject']!({}, ctx));
      const row = rows.find((r) => r.id === projectId);
      expect(row, 'the project with only Director spend is missing entirely').toBeDefined();
      expect(row?.usdMicros).toBe(750_000);
    });

    it('summary(projectId) includes it', () => {
      const { projectId } = seedDirectorSpend();
      const data = item(costsHandlers['summary']!({ projectId }, ctx));
      expect(data['totalUsdMicros']).toBe(750_000);
    });

    it('summary(all) includes it too — and byEmployee already did', () => {
      seedDirectorSpend();
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBe(750_000);
      const byEmployee = items<{ usdMicros: number }>(costsHandlers['byEmployee']!({}, ctx));
      expect(byEmployee[0]?.usdMicros).toBe(750_000);
    });
  });

  /**
   * AUDIT #18 — CLAUDE.md names this exact anti-pattern: "Do not show
   * `$0.00` for an engine that does not report usage. Show 'cost not
   * reported'." The data layer is careful (`insertUsage` preserves NULL
   * deliberately, with its own tests); every cost READ then collapsed it
   * to 0 with `COALESCE(SUM(...), 0)`, so an unmetered employee rendered
   * as exactly free.
   */
  describe('AUDIT #18: unreported cost is null, never a fabricated $0.00', () => {
    function seedUnreportedSpend(): void {
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Unmetered' });
      const task = seedTask(db, { project_id: project.id });
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: task.id,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 100,
          tokens_out: 50,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: null, // the engine reported no cost at all
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
    }

    it('summary reports null, not 0, when nothing contributing has a cost', () => {
      seedUnreportedSpend();
      const data = item(costsHandlers['summary']!({}, ctx));
      expect(data['totalUsdMicros'], 'a fabricated $0.00 for unreported usage').toBeNull();
    });

    it('byEmployee reports null for an employee whose engine never reported cost', () => {
      seedUnreportedSpend();
      const rows = items<{ usdMicros: number | null }>(costsHandlers['byEmployee']!({}, ctx));
      expect(rows[0]?.usdMicros).toBeNull();
    });

    it('a genuine zero is still 0, not null — the distinction has to work in both directions', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Free' });
      const task = seedTask(db, { project_id: project.id });
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: task.id,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 1,
          tokens_out: 1,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: 0, // really, genuinely, zero
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBe(0);
    });

    it('a mix of reported and unreported sums the reported part rather than reporting null', () => {
      seedUnreportedSpend();
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Metered' });
      const task = seedTask(db, { project_id: project.id });
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: task.id,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 1,
          tokens_out: 1,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: 250_000,
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBe(250_000);
    });
  });

  /**
   * AUDIT M0–M2 #7 — the third state. `null` earned its meaning above
   * ("no engine reported a cost"), and the read path then used that same
   * value for a case that is not that at all: **no rows whatsoever**. A
   * bare `SUM()` over zero rows is SQL NULL, so a fresh install — the one
   * state every user is in on their first launch — reported "nobody knows"
   * for a ledger that is simply empty.
   *
   * Three facts, three values, and the query has to separate them:
   *   no rows at all         -> 0     a real, complete answer: nothing spent
   *   rows, none with a cost -> null  a real answer: nobody knows
   *   rows with costs        -> the sum of those
   */
  describe('AUDIT #7: an empty ledger is a real zero, not "not reported"', () => {
    it('summary over a database with no usage rows reports 0, not null', () => {
      const data = item(costsHandlers['summary']!({}, ctx));
      expect(
        data['totalUsdMicros'],
        'an empty ledger reported as "cost not reported" — a fresh install has spent $0.00 and knows it',
      ).toBe(0);
      expect(data['todayUsdMicros']).toBe(0);
    });

    it('a project with no usage of its own reports 0 too', () => {
      const project = seedProject(db);
      const data = item(costsHandlers['summary']!({ projectId: project.id }, ctx));
      expect(data['totalUsdMicros']).toBe(0);
      expect(data['todayUsdMicros']).toBe(0);
    });

    it('the empty case does not swallow the unreported one — rows with no cost are still null', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Unreported' });
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: null,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 1,
          tokens_out: 1,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: null,
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBeNull();
    });

    it('today is a real 0 even when older reported spend exists', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Yesterday' });
      insertUsage(
        db,
        {
          employee_id: employee.id,
          task_id: null,
          engine: 'claude-code',
          source: 'turn',
          turn_index: 0,
          model: 'm',
          tokens_in: 1,
          tokens_out: 1,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost_usd_micros: 900_000,
          computed_cost_usd_micros: null,
        } as never,
        { projectId: project.id },
      );
      // `insertUsage` stamps `nowIso()` itself and ignores any `ts` in its
      // input, so the row has to be backdated after the production writer
      // has written it. Hand-writing the row instead would test a fixture
      // rather than what the writer actually produces.
      db.prepare("UPDATE usage SET ts = '2020-01-01T00:00:00.000Z'").run();
      const data = item(costsHandlers['summary']!({}, ctx));
      expect(data['totalUsdMicros']).toBe(900_000);
      expect(data['todayUsdMicros'], 'no spend today is $0.00, not "not reported"').toBe(0);
    });
  });

  /**
   * AUDIT M0–M2 #7 / §14.1 — "The title bar's ⏱ meter totals only metered
   * spend. If any employee running today is unmetered (§11.5.1 —
   * `usageReporting: false`), the meter's tooltip/label MUST say so … the
   * header total silently omitting an employee's real (unknown) cost must
   * never look like a complete number."
   *
   * Before this the summary carried no field that could say so, so the
   * disclosure was not merely unbuilt — it was **inexpressible**.
   */
  describe('AUDIT #7 / §14.1: the summary can disclose unmetered employees', () => {
    it('is 0 on a company with no employees at all', () => {
      expect(item(costsHandlers['summary']!({}, ctx))['unmeteredEmployeeCount']).toBe(0);
    });

    it('is 0 for a structured-mode employee, which does report usage', () => {
      seedEmployee(db, { name: 'Metered', engine: 'claude-code', engine_mode: 'structured' });
      expect(item(costsHandlers['summary']!({}, ctx))['unmeteredEmployeeCount']).toBe(0);
    });

    it('counts a pty-mode employee — §7.7.1, unmeterable permanently', () => {
      seedEmployee(db, { name: 'Unmeterable', engine: 'generic-pty', engine_mode: 'pty' });
      expect(
        item(costsHandlers['summary']!({}, ctx))['unmeteredEmployeeCount'],
        'a pty employee contributes real, unknown cost and the total cannot say so',
      ).toBe(1);
    });

    it('counts each unmetered employee once, alongside metered ones', () => {
      seedEmployee(db, { name: 'Pty A', engine: 'generic-pty', engine_mode: 'pty' });
      seedEmployee(db, { name: 'Pty B', engine: 'generic-pty', engine_mode: 'pty' });
      seedEmployee(db, { name: 'Structured', engine: 'claude-code', engine_mode: 'structured' });
      expect(item(costsHandlers['summary']!({}, ctx))['unmeteredEmployeeCount']).toBe(2);
    });
  });
});
