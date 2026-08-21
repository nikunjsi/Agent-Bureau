import path from 'node:path';

export interface DbPaths {
  readonly dbPath: string;
  readonly activityLogPath: string;
  readonly backupsDir: string;
  readonly migrationsDir: string;
}

/**
 * Everything the DB layer needs a filesystem location for, derived from one
 * base directory. Takes `baseDir` as a parameter rather than calling
 * `app.getPath('userData')` internally, so this (and everything built on
 * it) is usable from plain-Node tests and the kill-point worker without an
 * Electron `app` object — only `src/main/index.ts` passes a real Electron
 * path in.
 */
export function getDbPaths(baseDir: string, migrationsDir: string): DbPaths {
  return {
    dbPath: path.join(baseDir, 'bureau.db'),
    activityLogPath: path.join(baseDir, 'activity.jsonl'),
    backupsDir: path.join(baseDir, 'backups'),
    migrationsDir,
  };
}
