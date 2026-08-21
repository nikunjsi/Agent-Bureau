import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Opens the **one** write connection with the §5.0 pragmas. Every other
 * module in the app shares this single `Database` instance — better-
 * sqlite3 is synchronous, so a single connection with WAL mode is simpler
 * and avoids async interleaving bugs (§4.3).
 */
export function openConnection(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export interface IntegrityCheckResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** `PRAGMA integrity_check` — structural corruption (§28 M1 step 8). */
export function checkIntegrity(db: Database.Database): IntegrityCheckResult {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const messages = rows.map((row) => row.integrity_check);
  const ok = messages.length === 1 && messages[0] === 'ok';
  return { ok, issues: ok ? [] : messages };
}

export interface ForeignKeyViolation {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
}

/** `PRAGMA foreign_key_check` — referential integrity. Empty array = clean. */
export function checkForeignKeys(db: Database.Database): ForeignKeyViolation[] {
  const rows = db.pragma('foreign_key_check') as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  return rows.map((row) => ({
    table: row.table,
    rowid: row.rowid,
    parent: row.parent,
    fkid: row.fkid,
  }));
}
