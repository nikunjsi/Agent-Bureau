import type Database from 'better-sqlite3';
import { storeSecret, type SafeStorageLike } from '../../src/main/secrets/secretStore';
import { ANTHROPIC_API_KEY_SETTING } from '../../src/main/secrets/secretBroker';

/**
 * Puts a stored Anthropic API key in a test database (M11 S1-7a).
 *
 * `Supervisor.assign()` refuses a real claude-code launch when no key is
 * stored — risk #34's decision E-4a, since the CLI would otherwise fall
 * back to the user's own subscription login. Any test that drives a
 * supervisor whose adapter answers `claude-code` therefore has to satisfy
 * the same precondition production does, and this is that one line.
 *
 * The value never leaves the database: nothing here injects it into an
 * environment, and the encryption is a reversible stand-in because
 * Electron's safeStorage cannot run in a plain-Node test. A test that
 * needs a key the real engine will actually accept wants
 * `provisionTestAnthropicKey` (E-2's key file) instead.
 */
const reversibleStandInForDpapi: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
};

export async function storeTestAnthropicKey(
  db: Database.Database,
  value = 'sk-ant-not-a-real-key',
): Promise<void> {
  const stored = await storeSecret(
    db,
    ANTHROPIC_API_KEY_SETTING,
    value,
    'anthropic',
    reversibleStandInForDpapi,
  );
  if (!stored.stored) throw new Error(stored.reason ?? 'the test key was not stored');
}
