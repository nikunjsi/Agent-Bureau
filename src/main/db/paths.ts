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

/**
 * M7 — where USER-INSTALLED packs live (Appendix D:
 * `%APPDATA%/Bureau/packs/<key>/`). Distinct from the bundled pack root,
 * which is read-only inside the installer and resolved by
 * `resolveBundledPacksDirPath()` in `engine/resourceScripts.ts`. Neither is
 * the other: `packs.install` VALIDATES a source directory and then COPIES
 * it here, so the pack Bureau reads is always one it has validated in
 * place, never one the user may edit out from under it mid-run.
 */
export function getPacksDir(baseDir: string): string {
  return path.join(baseDir, 'packs');
}

export function getPackDir(baseDir: string, packKey: string): string {
  return path.join(getPacksDir(baseDir), packKey);
}

/**
 * M7 — §12.1 layer 1: the markdown files that ARE the memory. The SQLite
 * `memory` table is a disposable index over this tree, rebuildable from it
 * at any time (`rebuildMemoryIndex`).
 *
 * Worth knowing while reading this: `deny.system_paths` already denies
 * any path under `AppData/Roaming/Bureau/`, so this tree is unreachable to
 * an employee's own file tools BY DESIGN. Memory writes go through
 * Core-side code, never a raw `Write` — that is the intended arrangement,
 * not an oversight to work around.
 */
export function getMemoryDir(baseDir: string): string {
  return path.join(baseDir, 'memory');
}

// Deliberately no `getMemoryScopeDir(scope, scopeRef)` here. A scope ref
// is a relative SUB-PATH, not a single segment (a role's is two: see
// `memoryStore.ts`'s MemoryLocation), and a helper taking one segment
// would encode the wrong assumption in the one place everything else
// derives paths from. `memoryAbsolutePath` composes from the canonical
// relative path instead, so the layout has exactly one definition.
