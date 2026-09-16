import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { nowIso } from '../../src/shared/models/ids';
import { ActivityLog } from '../../src/main/db/activityLog';
import { getDbPaths } from '../../src/main/db/paths';
import { loadPricingYaml } from '../../src/main/cost/pricingYaml';
import { systemHandlers } from '../../src/main/ipc/handlers/system';
import type { HandlerContext } from '../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

describe('memory_fts (§5.1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let now: string;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-fts-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    now = nowIso();
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMemory(id: string, title: string, body: string) {
    db.prepare(
      'INSERT INTO memory (id,scope,path,title,body,content_sha256,tags,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, 'project', `memory/${id}.md`, title, body, 'abc', '[]', 'observed', now, now);
  }

  function search(term: string): number {
    return (
      db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(term) as unknown[]
    ).length;
  }

  it('an insert is immediately searchable', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    expect(search('greenfield')).toBe(1);
  });

  it('an update is reflected — old term gone, new term found (sync trigger)', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    db.prepare('UPDATE memory SET body = ? WHERE id = ?').run(
      'Use the canary pipeline instead',
      'mem1',
    );
    expect(search('greenfield')).toBe(0);
    expect(search('canary')).toBe(1);
  });

  it('a delete removes it from the index', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    db.prepare('DELETE FROM memory WHERE id = ?').run('mem1');
    expect(search('greenfield')).toBe(0);
  });

  /**
   * AUDIT M0–M2 #6. This case used to run `VACUUM` and the rebuild inline
   * on its own connection:
   *
   *     db.exec('VACUUM');
   *     db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
   *
   * which is a fixture shaped exactly like the production path — so it
   * passed while `system.compactDb` ran the `VACUUM` and **not** the
   * rebuild, in violation of §5.1's MUST. The file never imported
   * `systemHandlers` at all. Standing rule 1: a test may not re-implement
   * the call it exists to verify.
   *
   * It now goes through the real handler, so removing the rebuild line
   * from `handlers/system.ts` fails this.
   */
  it('compactDb runs §5.1s mandatory FTS rebuild after its VACUUM — via the real handler', async () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    insertMemory('mem2', 'Onboarding', 'Read the greenfield handbook first');

    // Corrupt the index deliberately, so only a real rebuild can restore
    // it. Without this the assertion would pass on a VACUUM alone —
    // SQLite's VACUUM does not, on its own, damage a well-formed FTS5
    // index, which is why the inline version of this test proved nothing
    // about the rebuild.
    db.exec('DELETE FROM memory_fts');
    expect(search('greenfield')).toBe(0);

    const result = await systemHandlers['compactDb']!({}, ctx);
    expect(result).toEqual({ ok: true, data: { ok: true } });

    expect(search('greenfield')).toBe(2);
  });

  /**
   * The rowid half, kept separate because it asserts something different
   * and weaker than its old title claimed.
   *
   * **This does not demonstrate that `memory.rowid INTEGER PRIMARY KEY` is
   * what makes VACUUM safe** — audit M0–M2 **#21** measured that directly:
   * removing the explicit rowid declaration leaves this file 4/4 green,
   * and the mutation is caught only incidentally, by `MemorySchema`'s Zod
   * field. The old title said "explicit rowid means VACUUM cannot desync
   * it", which is a causal claim this build does not exhibit and this case
   * cannot show.
   *
   * What it does assert is real and worth keeping: after VACUUM + rebuild
   * the FTS rowids still join to the real table. Left titled for that, not
   * for the mechanism.
   *
   * #21 closed at fix 3b by correcting the claim, not by building a
   * desync demonstration: probe A2 was re-run and all four configurations
   * (explicit rowid or not, rebuild or not) preserve rowids on this build,
   * so there is no desync to demonstrate. §5.1 now says the declaration is
   * kept because SQLite does not *promise* rowid stability without one —
   * insurance against a documented permission, not a fix for an observed
   * failure. If a future SQLite starts renumbering, this case is where it
   * would show.
   */
  it('FTS rowids still join to memory after VACUUM + rebuild (see audit #21 re: the cause)', async () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    insertMemory('mem2', 'Onboarding', 'Read the greenfield handbook first');

    await systemHandlers['compactDb']!({}, ctx);

    expect(search('greenfield')).toBe(2);

    const joined = db
      .prepare(
        `SELECT m.id FROM memory m JOIN memory_fts ON memory_fts.rowid = m.rowid WHERE memory_fts MATCH 'handbook'`,
      )
      .all() as { id: string }[];
    expect(joined).toEqual([{ id: 'mem2' }]);
  });
});
