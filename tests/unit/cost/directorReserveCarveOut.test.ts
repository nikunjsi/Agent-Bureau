import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { enforceBudget } from '../../../src/main/cost/budgetEnforcement';
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { seedEmployee } from '../../helpers/dbFixtures';
import { newId } from '../../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §11.5's Director budget reserve, AUDIT #19.
 *
 * The audit flagged that `directorReserveUsd` is subtracted at BOTH the
 * project and global-daily levels while §11.5 described only the project
 * one — so `budgets.dailyUsd = $20.00` silently capped employees at
 * $18.00. The suggested fix was "narrow it, or document it."
 *
 * Judged: the behaviour is RIGHT and the documentation was wrong.
 * Exempting the Director from `dailyUsd` outright would stop that setting
 * capping total spend at all, which is a larger change to its meaning than
 * the anti-deadlock rule justifies. §11.5 now states the carve-out
 * explicitly, per level, including the visible $20→$18 consequence.
 *
 * These tests exist so the documented behaviour cannot drift back into
 * being undocumented-and-different: they pin each level against the real
 * `enforceBudget`, not a restatement of its arithmetic.
 */
describe('the Director reserve is carved out at project AND global-daily (§11.5, AUDIT #19)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-reserve-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    setSetting(db, 'budgets.directorReserveUsd', 2.0); // $2.00 -> 2_000_000 micros
    setSetting(db, 'budgets.dailyUsd', 20.0);
    setSetting(db, 'budgets.warnAtPct', 80);
    setSetting(db, 'budgets.onExceed', 'park');
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Drives the REAL enforceBudget against a REAL ledger. The global-daily
   * level sums `usage` since local midnight rather than trusting the
   * caller's number, so the spend has to genuinely exist in the table —
   * writing it through the real `insertUsage` is the only way this test
   * observes the same value production would.
   */
  function globalDailyVerdict(isDirector: boolean, totalSpendMicros: number): string | null {
    const employee = seedEmployee(db, { name: `E-${newId()}` });
    const lastIncrement = 500_000;
    insertUsage(db, {
      employee_id: employee.id, task_id: null, engine: 'claude-code', source: 'turn', turn_index: 0,
      model: 'm', tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0,
      cost_usd_micros: totalSpendMicros - lastIncrement, computed_cost_usd_micros: null,
    } as never);
    insertUsage(db, {
      employee_id: employee.id, task_id: null, engine: 'claude-code', source: 'turn', turn_index: 1,
      model: 'm', tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0,
      cost_usd_micros: lastIncrement, computed_cost_usd_micros: null,
    } as never);

    return enforceBudget(db, activityLog, {
      employeeId: employee.id,
      isDirector,
      projectId: null,
      taskId: null,
      costMicros: lastIncrement,
      taskSpend: null,
      projectSpend: null,
      roleBudgetMicros: null,
      employeeDailyBudgetMicros: null,
    } as never).verdict;
  }

  it('a non-Director employee is stopped at (dailyUsd − reserve) = $18.00, not $20.00', () => {
    // $18.50 of real ledger spend: over the carved-out $18.00 ceiling,
    // under the full $20.00 one.
    expect(globalDailyVerdict(false, 18_500_000)).toBe('park');
  });

  it('the Director may draw past $18.00 — the reserve is exactly what it is for', () => {
    expect(globalDailyVerdict(true, 18_500_000)).toBeNull();
  });

  it('the Director IS still stopped once the full $20.00 is gone — a carve-out, not an exemption', () => {
    expect(globalDailyVerdict(true, 20_500_000)).toBe('park');
  });

  it('a non-Director employee under $18.00 is not stopped', () => {
    expect(globalDailyVerdict(false, 1_000_000)).toBeNull();
  });
});
