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

/**
 * M4 — the first thing that needs a real, discoverable per-employee state
 * directory convention (§7.10's `control.json` lives at `<stateDir>/
 * control.json`; `reconcile()` needs to find every employee's one to clean
 * up stale ones at startup). Nothing before M4 needed this to be a real,
 * derivable path — M3's tests all passed an arbitrary test-provided
 * string. `baseDir` is the same Electron userData root `getDbPaths` takes,
 * for the same testability reason.
 */
export function getEmployeeStateDir(baseDir: string, employeeId: string): string {
  return path.join(baseDir, 'employees', employeeId);
}
