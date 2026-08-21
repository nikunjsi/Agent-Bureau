import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

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
 */
export function restoreFromBackup(backupPath: string, dbPath: string): void {
  copyFileSync(backupPath, dbPath);
}
