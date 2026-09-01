import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations, MigrationChecksumMismatchError, MissingMigrationFileError, listMigrationFiles } from '../../src/main/db/migrate';

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

  it('applies every real migration to an empty fixture DB and records it', async () => {
    const result = await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    // M5 part 2: migration 0003 (worktrees.pending_commit_task_id). M6
    // session 1: migration 0004 (employees.autonomous_confirmed_at). M6
    // session 2: migration 0005 (usage.project_id/computed_cost_usd_micros)
    // — same mechanical pinned-count update M4's own §16.1 settings-key
    // precedent established.
    expect(result.applied).toEqual([1, 2, 3, 4, 5]);

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

    const migrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[];
    expect(migrations).toHaveLength(5);
    expect(migrations[0]?.version).toBe(1);
    expect(migrations[1]?.version).toBe(2);
    expect(migrations[2]?.version).toBe(3);
    expect(migrations[3]?.version).toBe(4);
    expect(migrations[4]?.version).toBe(5);
    for (const m of migrations) expect(m.checksum).toHaveLength(64); // sha256 hex
  });

  it('re-running is a no-op — same checksum, nothing re-applied', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    const second = await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    expect(second.applied).toEqual([]);
  });

  it('a checksum mismatch on an already-applied migration is a hard error', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });

    // Simulate someone editing an applied migration file: point the runner
    // at a copy of the *whole* real migrations dir, with only 0001's
    // content changed — every other applied migration must still be
    // present and untouched, or a MissingMigrationFileError would mask the
    // checksum-mismatch behaviour this test actually targets.
    const tamperedDir = mkdtempSync(path.join(tmpdir(), 'bureau-migrate-tampered-'));
    for (const file of listMigrationFiles(REAL_MIGRATIONS_DIR)) {
      const original = readFileSync(path.join(REAL_MIGRATIONS_DIR, file.name), 'utf8');
      const content = file.name === '0001_initial.sql' ? `${original}\n-- tampered\n` : original;
      writeFileSync(path.join(tamperedDir, file.name), content);
    }

    try {
      await expect(
        runMigrations({ db, dbPath, migrationsDir: tamperedDir, backupsDir }),
      ).rejects.toThrow(MigrationChecksumMismatchError);
    } finally {
      rmSync(tamperedDir, { recursive: true, force: true });
    }
  });

  it('AUDIT finding #7: a migration recorded as applied whose file has since been deleted is a hard error, not silently accepted', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });

    // Simulate 0001_initial.sql being deleted from disk after having been
    // applied: point the runner at an otherwise-empty migrations dir.
    const emptyDir = mkdtempSync(path.join(tmpdir(), 'bureau-migrate-missing-'));
    mkdirSync(emptyDir, { recursive: true });

    try {
      await expect(
        runMigrations({ db, dbPath, migrationsDir: emptyDir, backupsDir }),
      ).rejects.toThrow(MissingMigrationFileError);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('backs up the db before applying a migration', async () => {
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir });
    const backupPath = path.join(backupsDir, 'bureau.db.pre-0001.bak');
    const { existsSync } = await import('node:fs');
    expect(existsSync(backupPath)).toBe(true);
  });

  it('listMigrationFiles finds every real migration, in version order', () => {
    const files = listMigrationFiles(REAL_MIGRATIONS_DIR);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]).toEqual({ version: 1, name: '0001_initial.sql' });
    expect(files[1]).toEqual({ version: 2, name: '0002_add_engine_options.sql' });
    // Version order, not just presence — a later migration must never sort
    // before an earlier one regardless of directory listing order.
    for (let i = 1; i < files.length; i++) {
      expect(files[i]!.version).toBeGreaterThan(files[i - 1]!.version);
    }
  });
});
