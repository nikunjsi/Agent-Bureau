import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { setSetting } from '../../../src/main/db/repositories/settings';
import {
  HookTimingInvalidError,
  resolveHookTiming,
} from '../../../src/main/controlChannel/hookTiming';
import { createClaudeCodeAdapterFromSettings } from '../../../src/main/engine/claudeCodeAdapter';
import { UserFacingError } from '../../../src/shared/errors/userFacing';
import { seedEmployee } from '../../helpers/dbFixtures';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { noopSecretBroker, placeholderControlChannel } from '../../../src/shared/engine/seams';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { getSetting } from '../../../src/main/db/repositories/settings';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * S-1 / §7.10 item 3: `permissions.hookSelfDeadlineMs` was registered and
 * read by nothing. `bureau-hook` got a hardcoded 30 minutes, and §7.10's
 * "strictly less than the registered hook timeout, validated at startup" did
 * not exist. Now the real settings reach the hook's environment and the hook
 * registration through the one adapter factory, and a combination that would
 * let the engine's fail-OPEN hook timeout win is refused with a sentence a
 * person can act on, both at startup and at launch.
 */
describe('hook timing comes from settings and is validated (S-1, §7.10)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-hooktiming-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the defaults are valid: a 30-minute self-deadline under a 35-minute registered timeout', () => {
    expect(resolveHookTiming(db)).toEqual({
      maxHoldMinutes: 30,
      hookSelfDeadlineMs: 30 * 60_000,
      registeredHookTimeoutSeconds: 35 * 60,
    });
  });

  it.each([
    ['equal to the registered timeout', 10, 15 * 60_000],
    ['above the registered timeout', 10, 60 * 60_000],
    ['zero', 10, 0],
  ])('a self-deadline %s is refused, readably', (_label, hold, deadline) => {
    setSetting(db, 'permissions.maxHoldMinutes', hold);
    setSetting(db, 'permissions.hookSelfDeadlineMs', deadline);
    const error = (() => {
      try {
        resolveHookTiming(db);
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(HookTimingInvalidError);
    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toMatch(/permission/i);
    expect((error as Error).message).not.toMatch(/§|PreToolUse/);
  });

  it("the settings reach the hook's environment and the registered hook timeout at launch", async () => {
    setSetting(db, 'permissions.maxHoldMinutes', 10);
    setSetting(db, 'permissions.hookSelfDeadlineMs', 12 * 60_000);
    const adapter = createClaudeCodeAdapterFromSettings(db, {
      resolveBinary: async () => ({
        resolvedPathString: 'C:\\fake\\bin',
        binaryPath: 'C:\\fake\\bin\\claude.exe',
      }),
      resolveBureauHookScriptPath: () => 'C:\\fake\\bureau-hook.js',
    });
    const employee = seedEmployee(db);
    const spec = await adapter.buildLaunchSpec({
      employee,
      role: getRoleByFullKey(db, employee.role_key)!,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: { command: 'node', args: [], env: {} },
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    expect(spec.env.BUREAU_HOOK_SELF_DEADLINE_MS).toBe(String(12 * 60_000));
    const settingsFile = spec.configFiles.find((f) => f.path.endsWith('claude-settings.json'))!;
    const hook = (
      JSON.parse(settingsFile.content) as {
        hooks: { PreToolUse: Array<{ hooks: Array<{ timeout: number }> }> };
      }
    ).hooks.PreToolUse[0]!.hooks[0]!;
    expect(hook.timeout).toBe(15 * 60);
  });

  it('an invalid combination is refused before any adapter is built', () => {
    setSetting(db, 'permissions.maxHoldMinutes', 10);
    setSetting(db, 'permissions.hookSelfDeadlineMs', 20 * 60_000);
    expect(() => createClaudeCodeAdapterFromSettings(db)).toThrow(HookTimingInvalidError);
  });

  it('startup validates it: main() calls resolveHookTiming after migrations', () => {
    const source = readFileSync(path.resolve('src/main/index.ts'), 'utf8');
    const migrated = source.indexOf('await runMigrations(');
    const validated = source.indexOf('resolveHookTiming(db)');
    expect(validated, 'src/main/index.ts never validates hook timing').toBeGreaterThan(-1);
    expect(validated).toBeGreaterThan(migrated);
  });

  it('settings.set refuses to write an invalid pair, so startup can never be bricked from Settings', async () => {
    const ctx = { db, activityLog: { logEvent: () => undefined } } as unknown as HandlerContext;
    const result = await dispatchIpcCall(
      'settings:set',
      getMethodSchema('settings', 'set'),
      getHandler('settings', 'set'),
      ctx,
      true,
      { key: 'permissions.hookSelfDeadlineMs', value: 40 * 60_000 },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(getSetting(db, 'permissions.hookSelfDeadlineMs')).toBe(30 * 60_000);
  });
});
