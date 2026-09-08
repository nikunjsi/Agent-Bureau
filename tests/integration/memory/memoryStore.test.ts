import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import {
  writeMemory,
  discoverMemoryFiles,
  titleFromMarkdown,
  memoryScopeRefForRole,
} from '../../../src/main/memory/memoryStore';
import { rebuildMemoryIndex } from '../../../src/main/memory/rebuildMemoryIndex';
import { searchMemory, toFtsQuery, listPinnedMemory } from '../../../src/main/memory/searchMemory';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §12.1's three claims about the memory store, each tested as a claim
 * rather than as an implementation detail:
 *
 * 1. The markdown files are the source of truth.
 * 2. The SQLite index is rebuildable from them at any time.
 * 3. Retrieval can filter by scope, because a role reads only the scopes
 *    its `memory_scopes` names.
 */
describe('§12.1 memory store', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-memory-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSomeNotes(): void {
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body: '# Coding standards\n\nPrefer explicit types over inference at module boundaries.\n',
      source: 'user_stated',
      pinned: true,
    });
    writeMemory(db, {
      baseDir,
      scope: 'project',
      scopeRef: 'proj-1',
      fileName: 'decisions.md',
      title: 'Decisions',
      body: '# Decisions\n\nDatabase: SQLite, because this runs on one machine.\n',
      source: 'observed',
    });
    writeMemory(db, {
      baseDir,
      scope: 'role',
      scopeRef: memoryScopeRefForRole('engineering:developer'),
      fileName: 'playbook.md',
      title: 'Developer playbook',
      body: '# Developer playbook\n\nRun the tests before claiming a task is done.\n',
      source: 'imported',
    });
  }

  it('writes a real markdown file at §12.1’s own path, then indexes it', () => {
    const result = writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body: '# Coding standards\n\nText.\n',
      source: 'user_stated',
    });

    expect(result.absolutePath).toBe(path.join(getMemoryDir(baseDir), 'company', 'standards.md'));
    expect(readFileSync(result.absolutePath, 'utf8')).toContain('Coding standards');
    // `memory.path` is UNIQUE, so it must be one canonical, POSIX,
    // relative-to-the-root string regardless of platform.
    expect(result.relativePath).toBe('company/standards.md');

    const row = db.prepare('SELECT * FROM memory WHERE path = ?').get('company/standards.md') as
      { title: string; scope: string } | undefined;
    expect(row?.title).toBe('Coding standards');
    expect(row?.scope).toBe('company');
  });

  it('nests scoped memory under its ref, as §12.1’s tree lays it out', () => {
    const result = writeMemory(db, {
      baseDir,
      scope: 'project',
      scopeRef: 'proj-1',
      fileName: 'decisions.md',
      title: 'Decisions',
      body: '# Decisions\n',
      source: 'observed',
    });
    expect(result.relativePath).toBe('project/proj-1/decisions.md');
    expect(existsSync(path.join(getMemoryDir(baseDir), 'project', 'proj-1', 'decisions.md'))).toBe(
      true,
    );
  });

  it('updates the row in place when the same file is rewritten', () => {
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body: '# Coding standards\n\nFirst.\n',
      source: 'user_stated',
    });
    const second = writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body: '# Coding standards\n\nSecond.\n',
      source: 'user_stated',
    });

    expect(second.changed).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory').get()).toEqual({ n: 1 });
    expect(readFileSync(second.absolutePath, 'utf8')).toContain('Second.');
  });

  it('reports an unchanged write honestly rather than rewriting the file', () => {
    const body = '# Coding standards\n\nSame.\n';
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body,
      source: 'user_stated',
    });
    const second = writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body,
      source: 'user_stated',
    });
    expect(second.changed).toBe(false);
  });

  // --- the disposability claim -----------------------------------------

  it('rebuilds the entire index from the files after every row is deleted', () => {
    // §12.1's actual claim: "rebuildable from Layer 1 at any time". The
    // only honest test of it is to destroy layer 2 completely and prove
    // search still works — not to check that a rebuild function runs.
    seedSomeNotes();
    expect(searchMemory(db, 'SQLite')).toHaveLength(1);

    db.prepare('DELETE FROM memory').run();
    expect(searchMemory(db, 'SQLite')).toEqual([]);

    const result = rebuildMemoryIndex(db, baseDir, activityLog);

    expect(result.indexed).toBe(3);
    expect(searchMemory(db, 'SQLite')).toHaveLength(1);
    expect(searchMemory(db, 'playbook')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory').get()).toEqual({ n: 3 });
  });

  it('picks up a file the user created by hand, outside Bureau entirely', () => {
    // Layer 1 is "human-editable, greppable, and survives the app". A note
    // written with a text editor has to become searchable, or that
    // sentence is decoration.
    mkdirSync(path.join(getMemoryDir(baseDir), 'user'), { recursive: true });
    writeFileSync(
      path.join(getMemoryDir(baseDir), 'user', 'about.md'),
      '# About me\n\nI prefer terse commit messages.\n',
      'utf8',
    );

    rebuildMemoryIndex(db, baseDir);

    const hits = searchMemory(db, 'terse');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe('About me');
    expect(hits[0]!.scope).toBe('user');
  });

  it('picks up an EDIT the user made to a Bureau-written file', () => {
    seedSomeNotes();
    const file = path.join(getMemoryDir(baseDir), 'company', 'standards.md');
    writeFileSync(file, '# Coding standards\n\nActually, prefer inference.\n', 'utf8');

    rebuildMemoryIndex(db, baseDir);

    expect(searchMemory(db, 'inference')).toHaveLength(1);
    expect(searchMemory(db, 'explicit')).toEqual([]);
  });

  it('drops rows for files that no longer exist', () => {
    seedSomeNotes();
    rmSync(path.join(getMemoryDir(baseDir), 'project'), { recursive: true, force: true });

    const result = rebuildMemoryIndex(db, baseDir);

    expect(result.indexed).toBe(2);
    expect(searchMemory(db, 'SQLite')).toEqual([]);
  });

  it('emits exactly one memory.indexed event for a rebuild', () => {
    seedSomeNotes();
    rebuildMemoryIndex(db, baseDir, activityLog);
    const rows = db.prepare("SELECT type FROM events WHERE type LIKE 'memory.%'").all();
    expect(rows).toEqual([{ type: 'memory.indexed' }]);
  });

  it('ignores a directory that is not one of §12.1’s five scopes', () => {
    seedSomeNotes();
    mkdirSync(path.join(getMemoryDir(baseDir), 'scratch'), { recursive: true });
    writeFileSync(path.join(getMemoryDir(baseDir), 'scratch', 'junk.md'), '# Junk\n', 'utf8');

    expect(discoverMemoryFiles(baseDir).map((f) => f.relativePath)).not.toContain(
      'scratch/junk.md',
    );
    expect(rebuildMemoryIndex(db, baseDir).indexed).toBe(3);
  });

  // --- retrieval --------------------------------------------------------

  it('filters by scope, because a role reads only what memory_scopes names', () => {
    seedSomeNotes();
    // A body word present in all three, so only the filter can separate them.
    expect(
      searchMemory(db, 'the', { scopes: ['project'] }).every((m) => m.scope === 'project'),
    ).toBe(true);
    expect(searchMemory(db, 'tests', { scopes: ['company'] })).toEqual([]);
    expect(searchMemory(db, 'tests', { scopes: ['role'] })).toHaveLength(1);
  });

  it('filters by scope_ref, so one project cannot read another’s decisions', () => {
    seedSomeNotes();
    writeMemory(db, {
      baseDir,
      scope: 'project',
      scopeRef: 'proj-2',
      fileName: 'decisions.md',
      title: 'Decisions',
      body: '# Decisions\n\nDatabase: Postgres.\n',
      source: 'observed',
    });

    const hits = searchMemory(db, 'Database', { scopes: ['project'], scopeRef: 'proj-1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.body).toContain('SQLite');
  });

  it('returns pinned notes first when asked', () => {
    seedSomeNotes();
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'preferences.md',
      title: 'Preferences',
      body: '# Preferences\n\nStandards matter.\n',
      source: 'user_stated',
    });
    const hits = searchMemory(db, 'standards', { scopes: ['company'], pinnedFirst: true });
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0]!.pinned).toBe(true);
  });

  it('lists pinned notes for §12.3’s memory pack', () => {
    seedSomeNotes();
    const pinned = listPinnedMemory(db, 'company', null);
    expect(pinned).toHaveLength(1);
    expect(pinned[0]!.path).toBe('company/standards.md');
  });

  it('does not unpin a note when re-indexing it after an edit', () => {
    seedSomeNotes();
    writeMemory(db, {
      baseDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Coding standards',
      body: '# Coding standards\n\nEdited.\n',
      source: 'user_stated',
    });
    expect(listPinnedMemory(db, 'company', null)).toHaveLength(1);
  });
});

describe('toFtsQuery — task text is not an FTS5 query', () => {
  // §12.3 searches on the task's own text, which is user- and
  // Director-written prose. FTS5's MATCH argument is a query LANGUAGE:
  // unescaped, a hyphen means NOT, a quote is a syntax error, and `NEAR`
  // is an operator. Every one of those is a plausible thing to find in a
  // task title.
  it('quotes each token so operators and punctuation are literal', () => {
    expect(toFtsQuery('fix the auth-token bug')).toBe(
      '"fix" OR "the" OR "auth" OR "token" OR "bug"',
    );
  });

  it('survives text that would otherwise be a syntax error', () => {
    expect(() => toFtsQuery('"unterminated AND (')).not.toThrow();
    expect(toFtsQuery('NEAR OR AND')).toBe('"NEAR" OR "OR" OR "AND"');
  });

  it('returns null for text with nothing searchable in it', () => {
    expect(toFtsQuery('   ---   ')).toBeNull();
  });
});

describe('titleFromMarkdown', () => {
  it('takes the first heading', () => {
    expect(titleFromMarkdown('\n\n## Decisions made\n\nbody', 'decisions.md')).toBe(
      'Decisions made',
    );
  });

  it('falls back to the filename without its extension', () => {
    expect(titleFromMarkdown('no heading here', 'open-questions.md')).toBe('open-questions');
  });
});
