import type Database from 'better-sqlite3';
import { getSecretsMeta } from '../db/repositories/secretsMeta';
import { ANTHROPIC_API_KEY_SETTING } from './secretBroker';

/**
 * Is an Anthropic API key stored? (M11 S1-7.)
 *
 * **Metadata, never the value.** `secrets_meta` records that a key exists
 * and where its ciphertext lives; the plaintext is the broker's alone to
 * resolve, and only into a child process (§11.4). A caller that needed to
 * decrypt a secret in order to find out whether there is one would be a
 * second reader of it, which is exactly what that rule forbids.
 *
 * One function, one answer (standing rule 6): `Supervisor.assign()` asks
 * it before a real claude-code spawn, and Settings shows the same fact
 * through `getSecretsStatus`.
 */
export function isAnthropicApiKeyStored(db: Database.Database): boolean {
  return getSecretsMeta(db, ANTHROPIC_API_KEY_SETTING) !== null;
}
