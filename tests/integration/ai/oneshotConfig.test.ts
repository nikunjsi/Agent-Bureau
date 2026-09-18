import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { resolveOneShotConfig } from '../../../src/main/ai/oneshotConfig';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * X-19 / §22.4: the one-shot client's `model` is *"resolved from
 * `engines.modelTiers['fast']`"*.
 *
 * It was resolved for the **main engine** whatever the provider, so a user who
 * pointed `engines.oneshotProvider` at OpenAI got an Anthropic model id sent
 * to OpenAI — a call that can only fail, after a key had been stored and a
 * request made. The tier map is keyed by engine, and the one-shot provider is
 * not necessarily the engine.
 *
 * It now resolves **for the one-shot provider**, and a provider with no
 * resolvable fast model is `none` — which every caller already handles,
 * because §22.4 requires a working fallback for all of them. Bureau ships
 * tiers for `claude-code` only, so anything else needs the user to say which
 * model, and saying nothing is not a licence to guess.
 */
describe('the one-shot config resolves a model for its own provider (X-19)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-oneshot-cfg-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    // The realistic configured state: a main engine that resolves. Without
    // it every provider would be `none` for an unrelated reason and this
    // file would pass while proving nothing (the tier map is keyed by
    // engine, and the seeded `engines.default` is '').
    setSetting(db, 'engines.default', 'claude-code');
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is none out of the box — the seeded provider is unset', () => {
    expect(resolveOneShotConfig(db)).toMatchObject({ provider: 'none', model: '' });
  });

  it('anthropic gets the shipped claude fast model', () => {
    setSetting(db, 'engines.oneshotProvider', 'anthropic');

    const config = resolveOneShotConfig(db);

    expect(config.provider).toBe('anthropic');
    expect(config.model).toMatch(/^claude-/);
  });

  it.each(['openai', 'google', 'openai-compatible'] as const)(
    '%s with no configured fast model resolves to none rather than sending a Claude id',
    (provider) => {
      setSetting(db, 'engines.oneshotProvider', provider);

      expect(resolveOneShotConfig(db)).toMatchObject({ provider: 'none', model: '' });
    },
  );

  it.each([
    ['openai', 'gpt-4.1-mini'],
    ['google', 'gemini-2.5-flash'],
  ])('%s uses the fast model the user configured for it', (provider, modelId) => {
    setSetting(db, 'engines.oneshotProvider', provider);
    setSetting(db, 'engines.modelTiers', { [provider]: { fast: modelId } });

    expect(resolveOneShotConfig(db)).toMatchObject({ provider, model: modelId });
  });

  it('does not take the main engine’s model for another provider', () => {
    // The bug, stated as its own case: `engines.default` is claude-code and
    // its fast tier resolves, which is exactly why the old code looked
    // resolvable for every provider.
    setSetting(db, 'engines.oneshotProvider', 'openai');
    setSetting(db, 'engines.modelTiers', { 'claude-code': { fast: 'claude-haiku-4-5-20251001' } });

    expect(resolveOneShotConfig(db).model).not.toMatch(/^claude-/);
  });
});
