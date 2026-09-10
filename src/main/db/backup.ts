import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export interface BackupInfo {
  readonly path: string;
  readonly filename: string;
  readonly mtime: string;
}

/**
 * §28 M1 step 8's "offer the most recent backup" — the mechanism. No UI
 * exists yet to surface this from (that's M2+), so nothing calls
 * `restoreFromBackup` automatically; `checkIntegrity` (connection.ts) plus
 * this pair is what a future "corrupted DB, restore?" flow will be built
 * on.
 */
export function listBackups(backupsDir: string): BackupInfo[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.endsWith('.bak'))
    .map((filename) => {
      const fullPath = path.join(backupsDir, filename);
      const stat = statSync(fullPath);
      return { path: fullPath, filename, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime)); // newest first
}

/**
 * Restores `dbPath` from `backupPath`. Caller must ensure the live
 * connection is closed first — copying over an open WAL-mode database
 * would corrupt it.
 *
 * ## The `-wal`/`-shm` removal is the whole correctness of this function
 *
 * AUDIT M0–M2 #3. This used to be a bare `copyFileSync`, and it was wrong
 * in exactly the scenario it exists for.
 *
 * The database runs in WAL mode (§5.0), so committed data lives in
 * `<db>-wal` until a checkpoint folds it into the main file. Copying a
 * backup over `bureau.db` while a stale `bureau.db-wal` sits beside it
 * does **not** restore the backup — the next connection replays that WAL
 * on top of the file just copied in, and the user gets a mixture of the
 * backup and whatever the database was doing when it broke. Measured, not
 * theorised: `restoreFromBackup.test.ts` reproduces it and the pre-fix
 * function returns both the restored row and the one the restore was
 * supposed to discard.
 *
 * The old comment reasoned only about the destination being open. That is
 * a real hazard and it is still the caller's job — but it is not this one.
 * A restore is offered **after a crash**, which is precisely when an
 * uncheckpointed WAL is on disk, so the dangerous case was the normal one.
 *
 * Order matters: sidecars first, then the copy. The reverse leaves a
 * window where the file is the backup and the WAL is not, which is the
 * corrupt state this is preventing.
 */
export function restoreFromBackup(backupPath: string, dbPath: string): void {
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  copyFileSync(backupPath, dbPath);
}

/**
 * An on-demand backup — `system.backupDb` (§16 Advanced: "database
 * maintenance"), not tied to a migration version the way
 * `migrate.ts`'s pre-migration backups are. Same `db.backup()` API
 * (WAL-safe, unlike a raw file copy — see migrate.ts's own comment on
 * this), just a timestamped filename instead of a version number.
 */
export async function createBackup(db: Database.Database, backupsDir: string): Promise<string> {
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupsDir, `bureau.db.manual-${stamp}.bak`);
  await db.backup(backupPath);
  return backupPath;
}
