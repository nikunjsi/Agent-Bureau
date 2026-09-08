import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getDbPaths } from '../../../src/main/db/paths';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { settingsHandlers } from '../../../src/main/ipc/handlers/settings';
import { getSetting } from '../../../src/main/db/repositories/settings';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { PricingTable } from '../../../src/shared/models/pricing';
import type { IpcResult } from '../../../src/shared/ipc/envelope';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
// This suite never reads ctx.pricing — a minimal, schema-valid stand-in,
// not resources/pricing.yaml itself (unrelated to what §24.5's gate does).
const FAKE_PRICING: PricingTable = {
  version: 1,
  verified_at: '2026-01-01',
  verified_against: 'test',
  engines: {},
};

/**
 * §24.5's own enable-check (`canEnableZeroCostMode`), wired into the real
 * `settingsHandlers.set` IPC handler — not a bare unit test of the check
 * function in isolation, but the actual path a future Settings UI (M9)
 * will call through.
 */
describe('settingsHandlers.set — the costs.zeroCostMode enable-check (§24.5)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-settings-zerocost-'));
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

  it('turning zeroCostMode OFF is never gated — always succeeds regardless of engine state', async () => {
    const result = (await settingsHandlers.set!(
      { key: 'costs.zeroCostMode', value: false },
      ctx,
    )) as IpcResult<unknown>;
    expect(result.ok).toBe(true);
    expect(getSetting(db, 'costs.zeroCostMode')).toBe(false);
  });

  it('every other setting key bypasses the gate entirely, unaffected by engine probing', async () => {
    const result = (await settingsHandlers.set!(
      { key: 'budgets.dailyUsd', value: 15.0 },
      ctx,
    )) as IpcResult<unknown>;
    expect(result.ok).toBe(true);
    expect(getSetting(db, 'budgets.dailyUsd')).toBe(15_000_000);
  });

  it('turning zeroCostMode ON runs the real canEnableZeroCostMode check against engines.default (falling back to claude-code) and reflects its real verdict', async () => {
    const result = (await settingsHandlers.set!(
      { key: 'costs.zeroCostMode', value: true },
      ctx,
    )) as IpcResult<unknown>;

    const { canEnableZeroCostMode } = await import('../../../src/main/cost/zeroCostMode');
    const groundTruth = await canEnableZeroCostMode('claude-code');

    if (groundTruth.allowed) {
      expect(result.ok).toBe(true);
      expect(getSetting(db, 'costs.zeroCostMode')).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('VALIDATION_FAILED');
        expect(result.error.message).toContain("Can't enable zero-cost mode");
      }
      // The refused write never landed — the setting stays at its default.
      expect(getSetting(db, 'costs.zeroCostMode')).toBe(false);
    }
  });
});
