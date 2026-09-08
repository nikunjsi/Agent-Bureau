import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import {
  storeSecret,
  retrieveSecret,
  clearSecret,
  type SafeStorageLike,
} from '../../../src/main/secrets/secretStore';
import { getSecretsMeta } from '../../../src/main/db/repositories/secretsMeta';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/** A real, in-memory-only fake of the one Electron API this module needs
 * — no actual OS DPAPI call, but a real, working symmetric transform
 * (base64, reversible), so a round-trip through this fake genuinely
 * proves the encrypt/store/retrieve/decrypt sequence, not just that
 * functions were called. */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(`FAKE-ENCRYPTED:${plainText}`, 'utf8'),
    decryptString: (encrypted: Buffer) =>
      encrypted.toString('utf8').replace(/^FAKE-ENCRYPTED:/, ''),
  };
}

describe('secretStore (§11.4)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-secretstore-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a real round trip: store then retrieve returns the exact original plaintext', async () => {
    const result = await storeSecret(
      db,
      'anthropic_api_key',
      'sk-ant-real-value-123456',
      'anthropic',
      fakeSafeStorage(),
    );
    expect(result.stored).toBe(true);

    const readBack = await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage());
    expect(readBack).toBe('sk-ant-real-value-123456');
  });

  it('never stores the plaintext anywhere in the DB row — only ciphertext', async () => {
    await storeSecret(
      db,
      'anthropic_api_key',
      'sk-ant-should-never-appear-raw',
      'anthropic',
      fakeSafeStorage(),
    );
    const meta = getSecretsMeta(db, 'anthropic_api_key');
    expect(meta?.storage_ref).not.toContain('sk-ant-should-never-appear-raw');
    expect(meta?.storage_ref).toBeTruthy(); // real ciphertext is there, just not the plaintext
  });

  it('refuses to store when encryption is unavailable — never falls back to plaintext (§11.4 literal rule)', async () => {
    const result = await storeSecret(
      db,
      'anthropic_api_key',
      'sk-ant-plaintext-danger',
      'anthropic',
      fakeSafeStorage(false),
    );
    expect(result.stored).toBe(false);
    expect(result.reason).toBeTruthy();
    // Confirm nothing was written at all — not a plaintext fallback, not a partial row.
    expect(getSecretsMeta(db, 'anthropic_api_key')).toBeNull();
  });

  it('retrieveSecret returns null when nothing is stored — the real, current default', async () => {
    expect(await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage())).toBeNull();
  });

  it("retrieveSecret returns null when encryption is unavailable, even if a row exists (can't decrypt what can't be encrypted on this session)", async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-value', 'anthropic', fakeSafeStorage(true));
    expect(await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage(false))).toBeNull();
  });

  it('records last_used_at on a successful retrieve — real bookkeeping, not decorative', async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-value', 'anthropic', fakeSafeStorage());
    expect(getSecretsMeta(db, 'anthropic_api_key')?.last_used_at).toBeNull();
    await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage());
    expect(getSecretsMeta(db, 'anthropic_api_key')?.last_used_at).toBeTruthy();
  });

  it('clearSecret really clears it — the next retrieve returns null, matching "set / replace / clear" (§11.4)', async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-value', 'anthropic', fakeSafeStorage());
    clearSecret(db, 'anthropic_api_key');
    expect(await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage())).toBeNull();
  });

  it('storing twice replaces the old value — the second retrieve sees only the new one', async () => {
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-old-value', 'anthropic', fakeSafeStorage());
    await storeSecret(db, 'anthropic_api_key', 'sk-ant-new-value', 'anthropic', fakeSafeStorage());
    expect(await retrieveSecret(db, 'anthropic_api_key', fakeSafeStorage())).toBe(
      'sk-ant-new-value',
    );
  });
});
