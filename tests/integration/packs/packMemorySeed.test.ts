import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { installPack } from '../../../src/main/packs/installPack';
import { getMemoryDir } from '../../../src/main/db/paths';
import { searchMemory } from '../../../src/main/memory/searchMemory';
import { writePack, APP_VERSION_FOR_TESTS } from '../../helpers/packFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * §6.2's `memory-seed/`, and the reason the memory store had to exist
 * before install could be called real: installing a pack has to put its
 * seed notes SOMEWHERE.
 */
describe('pack memory seeding (§6.2 → §12.1)', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-seed-'));
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

  function makePackWithSeed(name: string, seeds: Record<string, string>): string {
    const source = writePack(path.join(tmpDir, name));
    for (const [relPath, content] of Object.entries(seeds)) {
      const absolute = path.join(source, 'memory-seed', relPath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
    return source;
  }

  function install(sourceDir: string) {
    return installPack({
      db,
      activityLog,
      baseDir,
      sourceDir,
      origin: 'user',
      appVersion: APP_VERSION_FOR_TESTS,
    });
  }

  it('seeds a bare memory-seed file into company scope, per §6.2’s own example', () => {
    const source = makePackWithSeed('p1', {
      'engineering-conventions.md': '# Engineering conventions\n\nSmall commits, always.\n',
    });

    const result = install(source);

    expect(result.installed).toBe(true);
    expect(result.memorySeeded).toBe(1);
    const target = path.join(getMemoryDir(baseDir), 'company', 'engineering-conventions.md');
    expect(readFileSync(target, 'utf8')).toContain('Small commits');
    expect(searchMemory(db, 'commits')).toHaveLength(1);
  });

  it('seeds a scoped note into the scope its directory names', () => {
    const source = makePackWithSeed('p2', {
      'role/engineering/developer/playbook.md': '# Playbook\n\nRead the tests first.\n',
    });

    install(source);

    const hits = searchMemory(db, 'tests', { scopes: ['role'] });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.scope_ref).toBe('engineering/developer');
  });

  it('never overwrites a note the user has since edited', () => {
    // Layer 1 is human-editable by design, so the pack loses this race on
    // purpose. A reinstall silently reverting someone's notes would make
    // "human-editable" untrue in the way that matters.
    const source = makePackWithSeed('p3', {
      'engineering-conventions.md': '# Engineering conventions\n\nOriginal.\n',
    });
    install(source);

    const target = path.join(getMemoryDir(baseDir), 'company', 'engineering-conventions.md');
    writeFileSync(target, '# Engineering conventions\n\nMy own version.\n', 'utf8');

    const second = install(source);

    expect(readFileSync(target, 'utf8')).toContain('My own version');
    expect(second.memorySeeded).toBe(0);
    expect(second.memorySkippedUserEdited).toEqual([target]);
  });

  it('refreshes an untouched note on reinstall rather than treating it as edited', () => {
    const source = makePackWithSeed('p4', { 'conventions.md': '# Conventions\n\nOne.\n' });
    install(source);

    const second = install(source);

    expect(second.memorySkippedUserEdited).toEqual([]);
    expect(second.memorySeeded).toBe(1);
  });

  it('ignores a seed directory that is not one of §12.1’s scopes', () => {
    const source = makePackWithSeed('p5', {
      'nonsense/thing.md': '# Thing\n',
      'conventions.md': '# Conventions\n\nReal.\n',
    });

    expect(install(source).memorySeeded).toBe(1);
  });

  it('installs cleanly when the pack ships no memory-seed at all', () => {
    const result = install(writePack(path.join(tmpDir, 'p6')));
    expect(result.installed).toBe(true);
    expect(result.memorySeeded).toBe(0);
  });
});
