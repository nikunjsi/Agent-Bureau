import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { getSecretsMeta } from '../../../src/main/db/repositories/secretsMeta';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { settingsHandlers } from '../../../src/main/ipc/handlers/settings';
import {
  ANTHROPIC_API_KEY_SETTING,
  createRealSecretBroker,
} from '../../../src/main/secrets/secretBroker';
import { ONESHOT_SECRET_KEY_NAME } from '../../../src/main/ai/oneshotConfig';
import { STORABLE_SECRET_KEYS } from '../../../src/shared/ipc/schemas/settings';
import {
  ANTHROPIC_KEY_NAME,
  HELPER_KEY_NAME,
} from '../../../src/renderer/src/components/HelperKeyField';
import { SecretRegistry } from '../../../src/main/secrets/redactor';
import type { SafeStorageLike } from '../../../src/main/secrets/secretStore';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/** A reversible stand-in for DPAPI: plain-Node tests have no Electron. */
const workingSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${[...plain].reverse().join('')}`, 'utf8'),
  decryptString: (encrypted) => [...encrypted.toString('utf8').slice(4)].reverse().join(''),
};

const noEncryption: SafeStorageLike = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('must not be called');
  },
  decryptString: () => {
    throw new Error('must not be called');
  },
};

/**
 * M11 S1-5. `settings.setSecret` and `clearSecret` were `stub('M13')`
 * while pre-M11 X-20 shipped a Settings field that called them, so no key
 * could be saved through the app at all — including the Anthropic API key
 * E-4 makes Bureau's primary sign-in. Driven through the real
 * `dispatchIpcCall`, so validation, the handler and the success-payload
 * redaction are the ones that ship.
 */
describe('settings.setSecret / clearSecret store keys for real', () => {
  // Built at run time, so no token-shaped literal is committed (pre-M11 §F:
  // GitHub push protection matches real key shapes).
  const KEY_VALUE = ['sk', 'ant', 'test', 'a-stored-value-that-must-never-leak-0123456789'].join(
    '-',
  );
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-secrets-ipc-'));
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
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
      safeStorage: workingSafeStorage,
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function call(method: 'setSecret' | 'clearSecret' | 'getSecretsStatus', input: unknown) {
    return dispatchIpcCall(
      `settings:${method}`,
      getMethodSchema('settings', method),
      settingsHandlers[method]!,
      ctx,
      true,
      input,
    );
  }

  function eventsOfType(type: string): { payload: string }[] {
    return db.prepare('SELECT payload FROM events WHERE type = ?').all(type) as {
      payload: string;
    }[];
  }

  it('stores the Anthropic key encrypted, with one event naming the key and never the value', async () => {
    const result = await call('setSecret', { key: 'anthropic_api_key', value: KEY_VALUE });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const meta = getSecretsMeta(db, 'anthropic_api_key');
    expect(meta?.storage_ref).not.toBeNull();
    expect(meta?.storage_ref).not.toContain(KEY_VALUE);
    expect(meta?.provider).toBe('anthropic');

    const events = eventsOfType('app.setting_changed');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toEqual({ key: 'anthropic_api_key' });

    // The value is nowhere a person or a support bundle could read it.
    const allEvents = JSON.stringify(db.prepare('SELECT * FROM events').all());
    expect(allEvents).not.toContain(KEY_VALUE);
    expect(readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')).not.toContain(KEY_VALUE);
    expect(JSON.stringify(result)).not.toContain(KEY_VALUE);
  });

  it('the stored key is what the real broker hands a claude-code spawn, and it becomes redactable', async () => {
    await call('setSecret', { key: 'anthropic_api_key', value: KEY_VALUE });
    const registry = new SecretRegistry();
    const broker = createRealSecretBroker(db, registry, workingSafeStorage);

    const spawn = await broker.resolveForSpawn({ employeeId: 'e1', engineKey: 'claude-code' });

    expect(spawn.env).toEqual({ ANTHROPIC_API_KEY: KEY_VALUE });
    expect(registry.values()).toContain(KEY_VALUE);
  });

  it('stores the helper key too (X-20’s field), and status reports both without a value', async () => {
    await call('setSecret', { key: 'anthropic_api_key', value: KEY_VALUE });
    await call('setSecret', { key: 'oneshot.apiKey', value: `${KEY_VALUE}-helper` });

    const status = await call('getSecretsStatus', {});

    expect(status.ok).toBe(true);
    const keys = (status as { data: { items: { key: string }[] } }).data.items.map((i) => i.key);
    expect(keys.sort()).toEqual(['anthropic_api_key', 'oneshot.apiKey']);
    expect(JSON.stringify(status)).not.toContain(KEY_VALUE);
  });

  it('each allowlisted name is the one its reader looks up, and the Settings fields write those names', () => {
    // Two constants for one name is how a field ends up storing a key nothing reads.
    expect([...STORABLE_SECRET_KEYS].sort()).toEqual(
      [ANTHROPIC_API_KEY_SETTING, ONESHOT_SECRET_KEY_NAME].sort(),
    );
    expect(ANTHROPIC_KEY_NAME).toBe(ANTHROPIC_API_KEY_SETTING);
    expect(HELPER_KEY_NAME).toBe(ONESHOT_SECRET_KEY_NAME);
  });

  it('refuses a key name outside the allowlist, and stores nothing', async () => {
    const result = await call('setSecret', { key: 'github_token', value: KEY_VALUE });

    expect(result.ok).toBe(false);
    expect((result as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(getSecretsMeta(db, 'github_token')).toBeNull();
    expect(eventsOfType('app.setting_changed')).toHaveLength(0);
  });

  it('clearing removes the key: one event, no status row, and the broker injects nothing', async () => {
    await call('setSecret', { key: 'anthropic_api_key', value: KEY_VALUE });

    const cleared = await call('clearSecret', { key: 'anthropic_api_key' });

    expect(cleared.ok).toBe(true);
    expect(eventsOfType('app.setting_changed')).toHaveLength(2);
    const status = await call('getSecretsStatus', {});
    expect((status as { data: { items: unknown[] } }).data.items).toEqual([]);
    const spawn = await createRealSecretBroker(
      db,
      new SecretRegistry(),
      workingSafeStorage,
    ).resolveForSpawn({ employeeId: 'e1', engineKey: 'claude-code' });
    expect(spawn.env).toEqual({});
  });

  it('refuses to store in plaintext when the machine has no OS encryption, and says why', async () => {
    ctx = { ...ctx, safeStorage: noEncryption } as HandlerContext;

    const result = await call('setSecret', { key: 'anthropic_api_key', value: KEY_VALUE });

    expect(result.ok).toBe(false);
    expect((result as { error: { message: string } }).error.message).toMatch(/plaintext/);
    expect(getSecretsMeta(db, 'anthropic_api_key')).toBeNull();
    expect(eventsOfType('app.setting_changed')).toHaveLength(0);
  });
});
