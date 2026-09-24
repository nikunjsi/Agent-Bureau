import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readControlJsonAcl } from '../../src/main/controlChannel/tokens';
import { storeSecret, type SafeStorageLike } from '../../src/main/secrets/secretStore';
import {
  ANTHROPIC_API_KEY_SETTING,
  createRealSecretBroker,
} from '../../src/main/secrets/secretBroker';
import { SecretRegistry } from '../../src/main/secrets/redactor';
import type { SecretBroker } from '../../src/shared/engine/seams';

/**
 * How the opt-in real-engine tests get an Anthropic API key (M11 S1-6,
 * decision E-2). Dev-only, never shipped: this file lives under `tests/`.
 *
 * **The key reaches the engine the way production's does**: stored with
 * `storeSecret` into the test's own database, then injected into the child
 * process only, by the real `createRealSecretBroker`. The one difference is
 * the encryption: Electron's safeStorage (DPAPI) cannot run in a plain-Node
 * test, and its key lives in Bureau's own profile, so a reversible stand-in
 * is used here.
 *
 * **Never a global `ANTHROPIC_API_KEY`.** The engine CLI prefers an
 * environment key over a subscription sign-in, so a key exported in the
 * shell would quietly move Nikunj's own Claude Code sessions onto the
 * prepaid key. The helper refuses to run while one is set, and a free test
 * checks that nothing else under `tests/` reads or sets it.
 *
 * **The key file is protected, and that is checked, not hoped.** It must
 * grant nobody but the current user (and SYSTEM), by the same SID-based
 * verification `control.json` uses. A key is never logged or echoed.
 */

export const TEST_KEY_FILE_ENV = 'BUREAU_TEST_ANTHROPIC_KEY_FILE';

export function testKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env[TEST_KEY_FILE_ENV] ?? path.join(homedir(), '.bureau-test', 'anthropic.key');
}

/** Why a real run cannot get a key, or null when the file is there to try. */
export function testKeyUnavailableReason(file: string = testKeyFilePath()): string | null {
  if (!existsSync(file)) {
    return `no Anthropic API key file at ${file} (set ${TEST_KEY_FILE_ENV}, or create it; decision E-2)`;
  }
  return null;
}

/** A reversible stand-in for DPAPI, for plain-Node tests only. */
const testSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
};

export class TestKeyRefusedError extends Error {}

/**
 * Stores the test key into `db`'s secret store and returns the real broker
 * that injects it. Throws `TestKeyRefusedError` (whose message never
 * contains the key) when the parent has a global key, the file is
 * missing, empty, or readable by anyone else.
 */
export async function provisionTestAnthropicKey(
  db: Database.Database,
  options: {
    registry?: SecretRegistry;
    /** Injectable so a test can show the refusal without setting a real one. */
    env?: NodeJS.ProcessEnv;
    keyFile?: string;
  } = {},
): Promise<SecretBroker> {
  const env = options.env ?? process.env;
  if (env['ANTHROPIC_API_KEY'] !== undefined) {
    throw new TestKeyRefusedError(
      'ANTHROPIC_API_KEY is set in this process. Unset it: a global key would also move your own ' +
        'Claude Code sessions onto it. Real-engine tests read the key from the key file (E-2).',
    );
  }
  const file = options.keyFile ?? testKeyFilePath(env);
  const unavailable = testKeyUnavailableReason(file);
  if (unavailable !== null) throw new TestKeyRefusedError(unavailable);

  const acl = await readControlJsonAcl(file);
  if (!acl.ok) {
    throw new TestKeyRefusedError(
      // `/reset` first: `/inheritance:r` alone leaves an explicit entry in
      // place (M11 S1-21), and an elevated shell gives a new file one.
      `the key file ${file} is readable by more than you (${acl.reason}). Restrict it with: ` +
        `icacls "${file}" /reset && icacls "${file}" /inheritance:r /grant:r "%USERNAME%:(R)"`,
    );
  }

  const key = readFileSync(file, 'utf8').trim();
  if (key === '') throw new TestKeyRefusedError(`the key file ${file} is empty`);

  const stored = await storeSecret(
    db,
    ANTHROPIC_API_KEY_SETTING,
    key,
    'anthropic',
    testSafeStorage,
  );
  if (!stored.stored) throw new TestKeyRefusedError(stored.reason ?? 'the key was not stored');
  return createRealSecretBroker(db, options.registry ?? new SecretRegistry(), testSafeStorage);
}
