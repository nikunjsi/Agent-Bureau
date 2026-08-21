import type Database from 'better-sqlite3';
import { SecretsMetaSchema, UpsertSecretsMetaInputSchema, type SecretsMeta, type UpsertSecretsMetaInput } from '../../../shared/models/secretsMeta';

export function upsertSecretsMeta(db: Database.Database, input: UpsertSecretsMetaInput): SecretsMeta {
  const parsed = UpsertSecretsMetaInputSchema.parse(input);
  db.prepare(
    `INSERT INTO secrets_meta (key, provider, storage_ref, last_set_at, last_used_at)
     VALUES (@key, @provider, @storage_ref, @last_set_at, @last_used_at)
     ON CONFLICT(key) DO UPDATE SET
       provider = excluded.provider, storage_ref = excluded.storage_ref,
       last_set_at = excluded.last_set_at, last_used_at = excluded.last_used_at`,
  ).run(parsed);
  return getSecretsMeta(db, parsed.key) as SecretsMeta;
}

export function getSecretsMeta(db: Database.Database, key: string): SecretsMeta | null {
  const row = db.prepare('SELECT * FROM secrets_meta WHERE key = ?').get(key);
  return row ? SecretsMetaSchema.parse(row) : null;
}
