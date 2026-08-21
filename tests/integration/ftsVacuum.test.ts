import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { nowIso } from '../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('memory_fts (§5.1)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let now: string;

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
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertMemory(id: string, title: string, body: string) {
    db.prepare(
      'INSERT INTO memory (id,scope,path,title,body,content_sha256,tags,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(id, 'project', `memory/${id}.md`, title, body, 'abc', '[]', 'observed', now, now);
  }

  function search(term: string): number {
    return (db.prepare('SELECT rowid FROM memory_fts WHERE memory_fts MATCH ?').all(term) as unknown[]).length;
  }

  it('an insert is immediately searchable', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    expect(search('greenfield')).toBe(1);
  });

  it('an update is reflected — old term gone, new term found (sync trigger)', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    db.prepare('UPDATE memory SET body = ? WHERE id = ?').run('Use the canary pipeline instead', 'mem1');
    expect(search('greenfield')).toBe(0);
    expect(search('canary')).toBe(1);
  });

  it('a delete removes it from the index', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    db.prepare('DELETE FROM memory WHERE id = ?').run('mem1');
    expect(search('greenfield')).toBe(0);
  });

  it('survives VACUUM + the documented rebuild — explicit rowid means VACUUM cannot desync it (§5.1)', () => {
    insertMemory('mem1', 'Deploy notes', 'Use the greenfield pipeline');
    insertMemory('mem2', 'Onboarding', 'Read the greenfield handbook first');

    db.exec('VACUUM');
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");

    expect(search('greenfield')).toBe(2);

    // The FTS rowids must still line up with the real table after VACUUM +
    // rebuild — a desync would show up as a join miss here.
    const joined = db
      .prepare(
        `SELECT m.id FROM memory m JOIN memory_fts ON memory_fts.rowid = m.rowid WHERE memory_fts MATCH 'handbook'`,
      )
      .all() as { id: string }[];
    expect(joined).toEqual([{ id: 'mem2' }]);
  });
});
