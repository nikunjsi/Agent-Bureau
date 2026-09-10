import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import { writeMemory, getMemoryRowByPath } from '../../../src/main/memory/memoryStore';
import { rebuildMemoryIndex } from '../../../src/main/memory/rebuildMemoryIndex';
import {
  reconcileMemory,
  reconcileMemoryPath,
  syncMemoryIndexFromDisk,
} from '../../../src/main/memory/syncMemoryIndex';
import { searchMemory, listPinnedMemory } from '../../../src/main/memory/searchMemory';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §12.1's two claims about layer 2, each tested the way §12.1 itself names:
 *
 *  - *"'Rebuildable at any time' is tested by **deleting every row** and
 *    proving search still works, and by **indexing a file written with a
 *    text editor that Bureau never saw**."*
 *  - *"`pinned` is lost on a full rebuild… **Ordinary re-indexing of an
 *    edited file does not unpin** — only a wipe-and-rebuild does."* Two
 *    different paths, so two different tests.
 *
 * Standing rule 1 governs the shape of all of them: **nothing here seeds a
 * row.** A rebuild test that inserted rows and then rebuilt from them would
 * prove the inserter, not the walker. Every fixture below is a file on disk,
 * written either by `writeMemory` or by `fs.writeFileSync` standing in for
 * a text editor.
 */
describe('§12.1: the index is rebuildable, and pins survive the right things', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  const memoryFile = (...parts: string[]): string => path.join(getMemoryDir(tmpDir), ...parts);

  /** A file written by something that is not Bureau — the case §12.1 names
   *  explicitly. No row, no hash, no stamp: only bytes on disk. */
  function writeWithATextEditor(relativeParts: string[], body: string): void {
    const absolute = memoryFile(...relativeParts);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, 'utf8');
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-memsync-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- rebuildable at any time --------------------------------------

  it('survives every index row being deleted — search still works afterwards', () => {
    writeMemory(db, {
      baseDir: tmpDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Standards',
      body: '# Standards\n\nAlways migrate with a transaction.',
      source: 'user_stated',
    });
    expect(searchMemory(db, 'migrate')).toHaveLength(1);

    // The disposal §12.1 claims is safe. Not "clear the FTS table" — the
    // real thing, every row of the real table.
    db.prepare('DELETE FROM memory').run();
    expect(searchMemory(db, 'migrate')).toHaveLength(0);

    const result = rebuildMemoryIndex(db, tmpDir, activityLog);

    expect(result.indexed).toBe(1);
    expect(searchMemory(db, 'migrate')).toHaveLength(1);
  });

  it('indexes a file Bureau never wrote — the text-editor case', () => {
    // §12.1's own second test, and the reason layer 1 is markdown at all:
    // "human-readable, human-editable, greppable, and survives the app".
    writeWithATextEditor(
      ['company', 'preferences.md'],
      '# Preferences\n\nWe deploy on Fridays, deliberately.',
    );

    const result = syncMemoryIndexFromDisk(db, tmpDir, activityLog);

    expect(result.indexed).toBe(1);
    const hits = searchMemory(db, 'Fridays');
    expect(hits).toHaveLength(1);
    // The title comes from the file's own first heading, because nothing
    // else knows it — `titleFromMarkdown`, the same derivation the write
    // path uses.
    expect(hits[0]?.title).toBe('Preferences');
    expect(hits[0]?.path).toBe('company/preferences.md');
  });

  it('reconstructs a role’s two-segment scope ref from the path alone', () => {
    // §12.1: `pack:key` cannot be a Windows directory, so a role's memory
    // nests. The walker is recursive rather than fixed at one level so
    // nothing special-cases which scope is the two-segment one — and this
    // is what proves the round trip actually reverses.
    writeWithATextEditor(
      ['role', 'engineering', 'developer', 'playbook.md'],
      '# Playbook\n\nRun the linter before you push.',
    );

    syncMemoryIndexFromDisk(db, tmpDir, activityLog);

    const row = getMemoryRowByPath(db, 'role/engineering/developer/playbook.md');
    expect(row?.scope).toBe('role');
    expect(row?.scope_ref).toBe('engineering/developer');
  });

  it('drops the row for a file deleted outside Bureau', () => {
    writeMemory(db, {
      baseDir: tmpDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'gone.md',
      title: 'Gone',
      body: '# Gone\n\nSoon.',
      source: 'user_stated',
    });
    unlinkSync(memoryFile('company', 'gone.md'));

    const result = syncMemoryIndexFromDisk(db, tmpDir, activityLog);

    expect(result.removed).toBe(1);
    expect(getMemoryRowByPath(db, 'company/gone.md')).toBeNull();
  });

  // ---- pinning: two paths, two outcomes ------------------------------

  it('an ordinary re-index of an EDITED file does not unpin it', () => {
    writeMemory(db, {
      baseDir: tmpDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Standards',
      body: '# Standards\n\nFirst version.',
      source: 'user_stated',
      pinned: true,
    });

    // Edited outside Bureau, so the reconcile has real work to do — an
    // unchanged file would be skipped and would prove nothing about the
    // update path.
    writeWithATextEditor(['company', 'standards.md'], '# Standards\n\nSecond version, edited.');

    const result = syncMemoryIndexFromDisk(db, tmpDir, activityLog);

    expect(result.indexed).toBe(1);
    const row = getMemoryRowByPath(db, 'company/standards.md');
    expect(row?.body).toContain('Second version');
    // The whole point. §12.1: pinning is a user decision about a note, not
    // a property of its content.
    expect(row?.pinned).toBe(true);
    expect(listPinnedMemory(db, 'company', null)).toHaveLength(1);
  });

  it('a full wipe-and-rebuild DOES clear pins, and says how many', () => {
    for (const name of ['standards.md', 'preferences.md']) {
      writeMemory(db, {
        baseDir: tmpDir,
        scope: 'company',
        scopeRef: null,
        fileName: name,
        title: name,
        body: `# ${name}\n\nContent.`,
        source: 'user_stated',
        pinned: true,
      });
    }
    expect(listPinnedMemory(db, 'company', null)).toHaveLength(2);

    const result = rebuildMemoryIndex(db, tmpDir, activityLog);

    // §12.1: "stated rather than hidden". The count is the statement — a
    // rebuild that quietly cleared pins and reported only `indexed` would
    // leave the user to discover it.
    expect(result.pinsCleared).toBe(2);
    expect(listPinnedMemory(db, 'company', null)).toHaveLength(0);
    // The knowledge itself is intact; only the pin is gone.
    expect(searchMemory(db, 'Content')).toHaveLength(2);
  });

  // ---- stat-before-hash ---------------------------------------------

  it('skips a file whose stamp has not moved, and re-reads one whose has', () => {
    writeMemory(db, {
      baseDir: tmpDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Standards',
      body: '# Standards\n\nOne.',
      source: 'user_stated',
    });

    // Nothing changed: no read, no write, no event.
    const untouched = syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    expect(untouched.skipped).toBe(1);
    expect(untouched.indexed).toBe(0);
    expect(untouched.changed).toBe(false);

    writeWithATextEditor(['company', 'standards.md'], '# Standards\n\nTwo, with more words.');
    const edited = syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    expect(edited.indexed).toBe(1);
    expect(getMemoryRowByPath(db, 'company/standards.md')?.body).toContain('Two');
  });

  it('the forced pass re-hashes regardless of the stamp — the repair for a stamp that lied', () => {
    writeMemory(db, {
      baseDir: tmpDir,
      scope: 'company',
      scopeRef: null,
      fileName: 'standards.md',
      title: 'Standards',
      body: '# Standards\n\nOne.',
      source: 'user_stated',
    });

    // Simulates precisely the case a stat cannot see: the content on disk
    // has changed while the row's recorded stamp still MATCHES the file.
    // Constructed by rewriting the file and then copying the file's new
    // stamp onto the (still stale) row, because the alternative — hoping
    // the filesystem hands two different writes an identical mtime — is not
    // a test, it is a coin toss.
    writeWithATextEditor(['company', 'standards.md'], '# Standards\n\nOne.\n\nAnd a second line.');
    const onDisk = statSync(memoryFile('company', 'standards.md'));
    db.prepare('UPDATE memory SET file_mtime_ms = @m, file_size = @s WHERE path = @p').run({
      m: onDisk.mtimeMs,
      s: onDisk.size,
      p: 'company/standards.md',
    });

    // The ordinary pass is fooled, and that is the documented, bounded cost
    // of the optimisation rather than a bug hidden by this test.
    const lied = syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    expect(lied.skipped).toBe(1);
    expect(getMemoryRowByPath(db, 'company/standards.md')?.body).not.toContain('second line');

    // The repair `memory.reindex` runs.
    const forced = reconcileMemory(db, tmpDir, activityLog, { kind: 'force' });
    expect(forced.indexed).toBe(1);
    expect(getMemoryRowByPath(db, 'company/standards.md')?.body).toContain('second line');
  });

  // ---- one reconciler, two entry points ------------------------------

  it('the single-path entry point makes the same decisions as the whole-tree one', () => {
    // Standing rule 6: `memory.read` needed exactly this answer for one
    // file, and a second implementation of it would drift on the
    // interesting cases while agreeing on the boring one. Same body, so it
    // cannot.
    writeWithATextEditor(['company', 'one.md'], '# One\n\nAlpha.');
    writeWithATextEditor(['company', 'two.md'], '# Two\n\nBravo.');
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);

    writeWithATextEditor(['company', 'one.md'], '# One\n\nAlpha, revised.');
    unlinkSync(memoryFile('company', 'two.md'));

    // Scoped to one path: it updates that one and does NOT notice the other,
    // which is the correct behaviour for a scoped reconcile rather than an
    // oversight.
    const scoped = reconcileMemoryPath(db, tmpDir, 'company/one.md', activityLog);
    expect(scoped.indexed).toBe(1);
    expect(getMemoryRowByPath(db, 'company/one.md')?.body).toContain('revised');
    expect(getMemoryRowByPath(db, 'company/two.md')).not.toBeNull();

    // And the same body, given the whole tree, cleans up the deletion.
    const whole = syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    expect(whole.removed).toBe(1);
    expect(getMemoryRowByPath(db, 'company/two.md')).toBeNull();
  });

  it('emits memory.indexed only when something actually changed', () => {
    writeWithATextEditor(['company', 'one.md'], '# One\n\nAlpha.');
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    const after = countIndexedEvents();
    expect(after).toBe(1);

    // Looking is not a state change. Without this rule the activity log
    // becomes a log of when we ran, which is the failure invariant #3 is
    // written to prevent — the same discipline `company.pack_validated`
    // already follows.
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    syncMemoryIndexFromDisk(db, tmpDir, activityLog);
    expect(countIndexedEvents()).toBe(after);
  });

  function countIndexedEvents(): number {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'memory.indexed'").get() as {
        n: number;
      }
    ).n;
  }
});
