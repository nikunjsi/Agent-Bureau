import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '../../shared/models/ids';

interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * Numbered, forward-only SQL files (§5.3). Never edit an applied one —
 * checksums are verified at startup; a mismatch is a hard error.
 */
export class MigrationChecksumMismatchError extends Error {
  constructor(
    public readonly version: number,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(
      `Migration ${version} has been modified since it was applied ` +
        `(expected checksum ${expected}, found ${actual}). Never edit an ` +
        `applied migration — add a new one instead.`,
    );
    this.name = 'MigrationChecksumMismatchError';
  }
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

  return files.map((filename) => {
    const versionMatch = /^(\d{4})_/.exec(filename);
    if (!versionMatch?.[1]) {
      throw new Error(`Migration filename does not start with a 4-digit version: ${filename}`);
    }
    const filePath = path.join(migrationsDir, filename);
    const sql = readFileSync(filePath, 'utf8');
    return {
      version: Number.parseInt(versionMatch[1], 10),
      name: filename,
      path: filePath,
      sql,
      checksum: checksumOf(sql),
    };
  });
}

/** Bootstraps `schema_migrations` if it doesn't exist yet — the runner has
 * to query it to know what's applied, which is a chicken-and-egg problem
 * if only a migration file creates it (0001 also includes the same
 * statement; both are `IF NOT EXISTS`, so this is never a conflict). */
function ensureSchemaMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum   TEXT NOT NULL
    );
  `);
}

interface AppliedRow {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

function getAppliedMigrations(db: Database.Database): Map<number, AppliedRow> {
  const rows = db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations').all() as AppliedRow[];
  return new Map(rows.map((row) => [row.version, row]));
}

/** Backs up `bureau.db` to `bureau.db.pre-NNNN.bak` before applying
 * migration NNNN, using better-sqlite3's online backup API (safe under WAL
 * — a raw file copy is not, since -wal frames may not be checkpointed). */
async function backupBeforeMigration(
  db: Database.Database,
  dbPath: string,
  backupsDir: string,
  version: number,
): Promise<void> {
  if (dbPath === ':memory:') return; // nothing to back up for an in-memory DB (tests)
  mkdirSync(backupsDir, { recursive: true });
  const paddedVersion = String(version).padStart(4, '0');
  const backupPath = path.join(backupsDir, `bureau.db.pre-${paddedVersion}.bak`);
  await db.backup(backupPath);
}

export interface MigrateOptions {
  readonly db: Database.Database;
  readonly dbPath: string;
  readonly migrationsDir: string;
  readonly backupsDir: string;
}

export interface MigrateResult {
  readonly applied: readonly number[];
}

/** Applies every not-yet-applied migration, in order, each in its own
 * transaction, backed up first. Verifies checksums of already-applied
 * migrations along the way — a mismatch is a hard error (§5.3 rule 1). */
export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const { db, dbPath, migrationsDir, backupsDir } = options;

  ensureSchemaMigrationsTable(db);

  const files = loadMigrationFiles(migrationsDir);
  const applied = getAppliedMigrations(db);
  const newlyApplied: number[] = [];

  for (const file of files) {
    const existing = applied.get(file.version);
    if (existing) {
      if (existing.checksum !== file.checksum) {
        throw new MigrationChecksumMismatchError(file.version, existing.checksum, file.checksum);
      }
      continue; // already applied, checksum matches — nothing to do
    }

    await backupBeforeMigration(db, dbPath, backupsDir, file.version);

    const applyTxn = db.transaction(() => {
      db.exec(file.sql);
      db.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
      ).run(file.version, file.name, nowIso(), file.checksum);
    });
    applyTxn();
    newlyApplied.push(file.version);
  }

  return { applied: newlyApplied };
}

/** Re-exported for the "apply to a fixture DB from the previous version"
 * migration tests (§5.3 rule 4) — lets a test assert on the file list
 * without duplicating the filename-parsing regex. */
export function listMigrationFiles(migrationsDir: string): readonly { version: number; name: string }[] {
  if (!existsSync(migrationsDir)) return [];
  return loadMigrationFiles(migrationsDir).map(({ version, name }) => ({ version, name }));
}
