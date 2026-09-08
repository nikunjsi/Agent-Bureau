import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getPrereq } from '../../../src/main/db/repositories/prereqs';
import { readRegistryPathValue } from '../../../src/main/engine/registry';
import { buildResolvedPath, detectAndCacheBinary } from '../../../src/main/engine/resolvedPath';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §15.4: the parts of the resolved-PATH service that touch real I/O — the
 * actual Windows registry and the real `prereqs` table. The pure union/
 * resolution logic is covered, faster and platform-independently, by
 * tests/unit/engine/resolvedPath.test.ts.
 */
describe('resolved-PATH service — real registry + real DB (§15.4)', () => {
  it('readRegistryPathValue reads a real, non-empty machine PATH from HKLM', async () => {
    // Every Windows machine has a machine-level Path (Windows itself is
    // unusable without one) — this is the one registry read we can assert
    // on unconditionally, unlike HKCU's user override which may not exist.
    const value = await readRegistryPathValue('HKLM');
    expect(value).not.toBeNull();
    expect(value!.length).toBeGreaterThan(0);
    // The machine key is near-universally REG_EXPAND_SZ containing
    // %SystemRoot% — if this ever stops being true, expandEnvTokens'
    // presence in buildResolvedPath needs re-justifying, not just this
    // assertion updating.
    expect(value!.toLowerCase()).toContain('system32');
  });

  it('readRegistryPathValue returns null, not a throw, for a value that plausibly does not exist', async () => {
    // HKCU\Environment's Path is a per-user override many machines never
    // set — this just proves the "not found" path is null, not an
    // exception, without asserting which state this particular machine is
    // actually in.
    const value = await readRegistryPathValue('HKCU');
    expect(value === null || typeof value === 'string').toBe(true);
  });

  it('buildResolvedPath produces a real, non-empty, semicolon-joined PATH', async () => {
    const resolved = await buildResolvedPath();
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved).toContain(';');
  });

  describe('detectAndCacheBinary against a real prereqs table', () => {
    let tmpDir: string;
    let db: Database.Database;

    beforeEach(async () => {
      tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-resolvedpath-'));
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

    it('caches a found binary as status "ok" with its absolute path', () => {
      const result = detectAndCacheBinary(db, 'test-tool', 'test-tool', 'C:\\tools', {
        existsFn: (candidate) => candidate === 'C:\\tools\\test-tool.EXE',
      });
      expect(result).toEqual({ found: true, path: 'C:\\tools\\test-tool.EXE' });

      const cached = getPrereq(db, 'test-tool');
      expect(cached).toMatchObject({
        key: 'test-tool',
        status: 'ok',
        path: 'C:\\tools\\test-tool.EXE',
      });
      expect(cached!.detected_at).not.toBeNull();
    });

    it('caches a missing binary as status "missing" with a null path', () => {
      const result = detectAndCacheBinary(db, 'ghost-tool', 'ghost-tool', 'C:\\tools', {
        existsFn: () => false,
      });
      expect(result).toEqual({ found: false, path: null });

      const cached = getPrereq(db, 'ghost-tool');
      expect(cached).toMatchObject({ key: 'ghost-tool', status: 'missing', path: null });
    });

    it('re-detecting overwrites the previous cached result rather than accumulating rows', () => {
      detectAndCacheBinary(db, 'flip', 'flip', 'C:\\tools', { existsFn: () => false });
      expect(getPrereq(db, 'flip')?.status).toBe('missing');

      detectAndCacheBinary(db, 'flip', 'flip', 'C:\\tools', {
        existsFn: (candidate) => candidate === 'C:\\tools\\flip.EXE',
      });
      expect(getPrereq(db, 'flip')?.status).toBe('ok');

      const rowCount = db
        .prepare('SELECT COUNT(*) as n FROM prereqs WHERE key = ?')
        .get('flip') as { n: number };
      expect(rowCount.n).toBe(1);
    });
  });
});
