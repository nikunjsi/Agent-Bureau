import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getSecretsMeta } from '../../../src/main/db/repositories/secretsMeta';
import { restrictFileToCurrentUser } from '../../../src/main/controlChannel/tokens';
import { SecretRegistry } from '../../../src/main/secrets/redactor';
import { provisionTestAnthropicKey, TestKeyRefusedError } from '../../helpers/realEngineKey';

const execFileAsync = promisify(execFile);

/**
 * The opt-in real-engine tests' key path (M11 row S1-6, decision E-2),
 * proven for free: the key file is checked, the key goes through the real
 * secret store and broker, and nothing a refusal says contains it.
 */
describe('real-engine tests get their key from a protected file, through the store and broker', () => {
  // Built at run time, so no token-shaped literal is committed (pre-M11 §F).
  const KEY = ['sk', 'ant', 'test', 'key-file-value-0123456789abcdef'].join('-');
  let dir: string;
  let db: Database.Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-test-key-'));
    const dbPath = path.join(dir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(dir, 'backups'),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A key file readable by the current user only, as E-2 requires — narrowed
   * by production's own function (M11 S1-21). This used to run its own
   * `icacls /inheritance:r` with no `/reset`, so on the elevated CI runner
   * an explicit Administrators entry survived and the fixture was refused.
   */
  async function restrictedKeyFile(): Promise<string> {
    const file = path.join(dir, 'anthropic.key');
    writeFileSync(file, `${KEY}\n`, 'utf8');
    await restrictFileToCurrentUser(file);
    return file;
  }

  async function refusal(promise: Promise<unknown>): Promise<TestKeyRefusedError> {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TestKeyRefusedError);
    const message = (err as Error).message;
    expect(message).not.toContain(KEY);
    return err as TestKeyRefusedError;
  }

  it('a file only the user can read: the key is stored encrypted and the real broker injects it', async () => {
    const keyFile = await restrictedKeyFile();
    const registry = new SecretRegistry();

    const broker = await provisionTestAnthropicKey(db, { keyFile, env: {}, registry });
    const spawn = await broker.resolveForSpawn({ employeeId: 'e1', engineKey: 'claude-code' });

    expect(spawn.env).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect(registry.values()).toContain(KEY);
    const meta = getSecretsMeta(db, 'anthropic_api_key');
    expect(meta?.storage_ref).not.toBeNull();
    expect(meta?.storage_ref).not.toContain(KEY);
  });

  it('refuses a key file that also grants Everyone, and does not echo the key', async () => {
    const keyFile = await restrictedKeyFile();
    await execFileAsync('icacls', [keyFile, '/grant', '*S-1-1-0:(R)']);

    const err = await refusal(provisionTestAnthropicKey(db, { keyFile, env: {} }));

    expect(err.message).toMatch(/readable by more than you/);
    expect(getSecretsMeta(db, 'anthropic_api_key')).toBeNull();
  });

  it("refuses a key file left with its folder's inherited access (Administrators)", async () => {
    const keyFile = path.join(dir, 'inherited.key');
    writeFileSync(keyFile, KEY, 'utf8');

    const err = await refusal(provisionTestAnthropicKey(db, { keyFile, env: {} }));

    expect(err.message).toMatch(/icacls/);
  });

  it('refuses to run while ANTHROPIC_API_KEY is set in the parent environment', async () => {
    const keyFile = await restrictedKeyFile();

    const err = await refusal(
      provisionTestAnthropicKey(db, { keyFile, env: { ANTHROPIC_API_KEY: 'anything' } }),
    );

    expect(err.message).toMatch(/Unset it/);
    expect(getSecretsMeta(db, 'anthropic_api_key')).toBeNull();
  });

  it('says where the file should be when there is none', async () => {
    const err = await refusal(
      provisionTestAnthropicKey(db, { keyFile: path.join(dir, 'missing.key'), env: {} }),
    );

    expect(err.message).toMatch(/E-2/);
  });
});
