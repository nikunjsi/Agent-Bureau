import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations, MigrationChecksumMismatchError, listMigrationFiles } from '../../src/main/db/migrate';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('migration runner (§5.3)', () => {
  let tmpDir: string;
  let dbPath: string;
  let backupsDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-migrate-'));
    dbPath = path.join(tmpDir, 'bureau.db');
    backupsDir = path.join(tmpDir, 'backups');
    db = openConnection(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies 0001_initial.sql to an empty fixture DB and records it', async () => {
    const result = await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    expect(result.applied).toEqual([1]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    for (const expected of [
      'companies', 'departments', 'roles', 'employees', 'projects', 'briefs', 'plans', 'phases',
      'tasks', 'task_deps', 'worktrees', 'conversations', 'conversation_messages', 'messages',
      'checkpoints', 'deliverables', 'artifacts', 'memory', 'events', 'counters', 'usage',
      'prereqs', 'secrets_meta', 'settings', 'schema_migrations',
    ]) {
      expect(tableNames, `missing table ${expected}`).toContain(expected);
    }

    const migrations = db.prepare('SELECT * FROM schema_migrations').all() as { version: number; checksum: string }[];
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[0]?.checksum).toHaveLength(64); // sha256 hex
  });

  it('re-running is a no-op — same checksum, nothing re-applied', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    const second = await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    expect(second.applied).toEqual([]);
  });

  it('a checksum mismatch on an already-applied migration is a hard error', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });

    // Simulate someone editing an applied migration file: point the runner
    // at a copy with the same filename but different content.
    const tamperedDir = mkdtempSync(path.join(tmpdir(), 'bureau-migrate-tampered-'));
    const original = readFileSync(path.join(REAL_MIGRATIONS_DIR, '0001_initial.sql'), 'utf8');
    writeFileSync(path.join(tamperedDir, '0001_initial.sql'), `${original}\n-- tampered\n`);

    try {
      await expect(
        runMigrations({ db, dbPath, migrationsDir: tamperedDir, backupsDir }),
      ).rejects.toThrow(MigrationChecksumMismatchError);
    } finally {
      rmSync(tamperedDir, { recursive: true, force: true });
    }
  });

  it('backs up the db before applying a migration', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    const backupPath = path.join(backupsDir, 'bureau.db.pre-0001.bak');
    const { existsSync } = await import('node:fs');
    expect(existsSync(backupPath)).toBe(true);
  });

  it('listMigrationFiles finds 0001_initial.sql in the real migrations dir', () => {
    const files = listMigrationFiles(REAL_MIGRATIONS_DIR);
    expect(files).toEqual([{ version: 1, name: '0001_initial.sql' }]);
  });
});
