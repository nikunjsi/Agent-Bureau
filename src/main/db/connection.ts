import Database from 'better-sqlite3';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Enforces the **one** write connection invariant (§5.0) — previously just
 * a doc comment (AUDIT finding #3: two `openConnection()` calls to the
 * same file both silently succeeded, with writes from each cross-visible
 * to the other). Keyed by the real, resolved path so two different-looking
 * paths to the same file (e.g. via a symlink or `.`/`..` segments) can't
 * slip past it. Cleared when the returned `Database` is closed.
 */
const openPaths = new Set<string>();

export class ConnectionAlreadyOpenError extends Error {
  constructor(public readonly dbPath: string) {
    super(
      `A connection to "${dbPath}" is already open — Bureau allows exactly one write connection at a time (§5.0).`,
    );
    this.name = 'ConnectionAlreadyOpenError';
  }
}

/**
 * Opens the **one** write connection with the §5.0 pragmas. Every other
 * module in the app shares this single `Database` instance — better-
 * sqlite3 is synchronous, so a single connection with WAL mode is simpler
 * and avoids async interleaving bugs (§4.3).
 */
export function openConnection(dbPath: string): Database.Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  // realpathSync needs the file to exist; resolve against the (now
  // guaranteed to exist) parent directory instead for a file that may not
  // have been created yet, so a brand-new db path is still normalised.
  const resolvedKey = path.join(realpathSync(path.dirname(dbPath)), path.basename(dbPath));
  if (openPaths.has(resolvedKey)) {
    throw new ConnectionAlreadyOpenError(dbPath);
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  openPaths.add(resolvedKey);
  const originalClose = db.close.bind(db);
  db.close = () => {
    openPaths.delete(resolvedKey);
    return originalClose();
  };

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
