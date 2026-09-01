import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { storeSecret, type SafeStorageLike } from '../../../src/main/secrets/secretStore';
import { createRealSecretBroker } from '../../../src/main/secrets/secretBroker';
import { SecretRegistry } from '../../../src/main/secrets/redactor';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

function fakeSafeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) => Buffer.from(`FAKE-ENCRYPTED:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').replace(/^FAKE-ENCRYPTED:/, ''),
  };
}

describe('createRealSecretBroker (§11.4/§7.6)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-secretbroker-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves {env:{}, secretValues:[]} when nothing is stored — the real, current default (§7.6: subscription auth, no injected key)', async () => {
    const registry = new SecretRegistry();
    const broker = createRealSecretBroker(db, registry);
    const result = await broker.resolveForSpawn({ employeeId: 'emp1', engineKey: 'claude-code' });
    expect(result).toEqual({ env: {}, secretValues: [] });
    expect(registry.values()).toEqual([]);
  });

  it('resolves an explicitly-stored key as ANTHROPIC_API_KEY and registers it for redaction', async () => {
    // storeSecret uses the real safeStorage lazy-import by default; inject
    // the fake directly since this test isn't exercising secretStore.ts
    // itself, only the broker's own read side.
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-real-stored-value', 'anthropic', fakeSafeStorage());
    const registry = new SecretRegistry();
    const broker = createRealSecretBroker(db, registry, fakeSafeStorage());

    const result = await broker.resolveForSpawn({ employeeId: 'emp1', engineKey: 'claude-code' });
    expect(result.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-real-stored-value' });
    expect(result.secretValues).toEqual(['sk-ant-real-stored-value']);
    // The real point of routing through the broker at all — this value
    // is now redactable everywhere, the moment it was ever resolved once.
    expect(registry.values()).toContain('sk-ant-real-stored-value');
  });

  it('never resolves anything for an engine other than claude-code — no other real adapter exists', async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-real-stored-value', 'anthropic', fakeSafeStorage());
    const broker = createRealSecretBroker(db, new SecretRegistry());
    const result = await broker.resolveForSpawn({ employeeId: 'emp1', engineKey: 'generic-pty' });
    expect(result).toEqual({ env: {}, secretValues: [] });
  });

  it('revokeForEmployee is a real, callable no-op — never throws, matches the honest §11.4 reasoning', async () => {
    const broker = createRealSecretBroker(db, new SecretRegistry());
    await expect(broker.revokeForEmployee('emp1')).resolves.toBeUndefined();
  });
});
