import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { ProbeCache } from '../../../src/main/engine/probeCache';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { seedEmployee } from '../../helpers/dbFixtures';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * P-2 / chaos scenario #9: "the engine CLI is uninstalled while running".
 *
 * The real `ClaudeCodeAdapter`, spawning for real. Only binary RESOLUTION is
 * injected, with the same meaning the §15.4 resolver has ("is there a file at
 * the path?"), pointed at a real file in a temp directory so the test can
 * uninstall it. The version check is injected too, because the stand-in file
 * is never executed until it has already been renamed away. Nothing here
 * spends money: the only spawn is the one that fails.
 *
 * Three things must hold:
 *  1. The running Supervisor fails CLOSED: `failed`, one `employee.crashed`,
 *     no retry that silently succeeds.
 *  2. What reaches the event a person reads is TRANSLATED: plain language
 *     naming the engine and the action, never `spawn ... ENOENT` (the raw
 *     text is kept separately, for diagnosis).
 *  3. The next probe does not serve the cached "installed" answer for another
 *     minute: it looks again, and reports the engine determined-absent.
 */
describe('the engine CLI uninstalled mid-session (P-2, chaos #9)', () => {
  let tmpDir: string;
  let installDir: string;
  let binaryPath: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-uninstalled-'));
    installDir = mkdtempSync(path.join(tmpdir(), 'bureau-fake-install-'));
    binaryPath = path.join(installDir, 'claude.exe');
    writeFileSync(binaryPath, 'stand-in: never executed while present\n');
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
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  });

  it('the running Supervisor fails closed with a translated message, and the next probe reports it absent', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({
        resolvedPathString: installDir,
        binaryPath: existsSync(binaryPath) ? binaryPath : null,
      }),
      runVersionCheck: async () => '2.1.0 (Claude Code)',
      resolveBureauHookScriptPath: () => path.join(installDir, 'bureau-hook.js'),
    });
    const probeCache = new ProbeCache();
    const employee = seedEmployee(db, { name: 'Ravi' });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      probeCache,
      heartbeatCheckIntervalMs: 999_999_999,
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
    expect(supervisor.currentState).not.toBe('failed');

    // Uninstalled while the employee is running.
    renameSync(binaryPath, `${binaryPath}.uninstalled`);

    await supervisor.deliverOutboxMessage({
      id: 'm1',
      from_addr: 'director',
      to_addr: `employee:${employee.id}`,
      kind: 'status',
      subject: null,
      body: 'Carry on.',
    } as never);
    const deadline = Date.now() + 10_000;
    while (supervisor.currentState !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 1. Fail closed.
    expect(supervisor.currentState).toBe('failed');
    expect(getEmployeeById(db, employee.id)?.status).toBe('failed');
    const crashes = db
      .prepare("SELECT payload FROM events WHERE type = 'employee.crashed' AND employee_id = ?")
      .all(employee.id) as Array<{ payload: string }>;
    expect(crashes).toHaveLength(1);

    // 2. Translated, with the raw text kept apart from it.
    const payload = JSON.parse(crashes[0]!.payload) as { message: string; detail: string | null };
    expect(payload.message).toContain('claude-code');
    expect(payload.message).toMatch(/no longer (installed|on this computer)/i);
    expect(payload.message).not.toMatch(/ENOENT|spawn|reason=/);
    expect(payload.detail).toMatch(/ENOENT/);

    // 3. The next probe looks again instead of serving the cached answer.
    const next = await probeCache.probe(adapter, { budgetMs: 5_000 });
    expect(next.determination).toBe('determined');
    expect(next.installed).toBe(false);
  });
});
