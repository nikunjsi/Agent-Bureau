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
const FAKE_PRICING: PricingTable = { version: 1, verified_at: '2026-01-01', verified_against: 'test', engines: {} };

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
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = { db, activityLog, dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR), pricing: FAKE_PRICING, baseDir: tmpDir, bundledPacksDir: path.resolve('packs'), appVersion: '0.0.1' };
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
      insertUsage(db, {
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
      } as never, { projectId: project.id });
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
      insertUsage(db, {
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
      } as never, { projectId: project.id });
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
      insertUsage(db, {
        employee_id: employee.id, task_id: task.id, engine: 'claude-code', source: 'turn', turn_index: 0,
        model: 'm', tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0,
        cost_usd_micros: 0, // really, genuinely, zero
        computed_cost_usd_micros: null,
      } as never, { projectId: project.id });
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBe(0);
    });

    it('a mix of reported and unreported sums the reported part rather than reporting null', () => {
      seedUnreportedSpend();
      const project = seedProject(db);
      const employee = seedEmployee(db, { name: 'Metered' });
      const task = seedTask(db, { project_id: project.id });
      insertUsage(db, {
        employee_id: employee.id, task_id: task.id, engine: 'claude-code', source: 'turn', turn_index: 0,
        model: 'm', tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0,
        cost_usd_micros: 250_000, computed_cost_usd_micros: null,
      } as never, { projectId: project.id });
      expect(item(costsHandlers['summary']!({}, ctx))['totalUsdMicros']).toBe(250_000);
    });
  });
});
