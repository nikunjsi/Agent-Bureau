import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nowIso } from '../../shared/models/ids';
import { upsertPrereq } from '../db/repositories/prereqs';
import { readRegistryPathValue } from './registry';

/**
 * Expands `%VAR%` tokens against a given environment map — needed because
 * the machine-level registry PATH is typically REG_EXPAND_SZ, full of
 * literal tokens like `%SystemRoot%\system32`. An unresolvable token is
 * left as-is, never silently dropped, so a broken value is visible rather
 * than hidden.
 */
export function expandEnvTokens(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
}

/** Splits a Windows PATH-style string on `;`, trims, drops empties. */
export function splitPathEntries(value: string): string[] {
  return value
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * §15.4 step 2's "known install locations" — fixed logical roots, expanded
 * against a real env at call time. These change only on reinstall/relogin,
 * unlike PATH itself (which changes on every `npm i -g`), so reading their
 * roots from the live environment does not reintroduce the staleness
 * problem this whole service exists to route around.
 */
export function knownInstallLocations(env: NodeJS.ProcessEnv): string[] {
  const locations = [
    env.APPDATA ? path.join(env.APPDATA, 'npm') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'nodejs') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Git', 'cmd') : null,
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null,
  ];
  return locations.filter((entry): entry is string => entry !== null);
}

/**
 * Unions path entries from multiple sources, de-duplicated case-
 * insensitively (Windows paths are case-insensitive) while preserving
 * first-seen order and each entry's original casing.
 */
export function unionPathEntries(...sources: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const entry of source) {
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/**
 * §15.4: the resolved-PATH service. Union of the registry `Path` (HKCU user
 * override + the machine key) and the known install locations —
 * deliberately excludes the live `process.env.PATH`, which is exactly the
 * stale value this service exists to stop relying on (CLAUDE.md: "Do not
 * rely on `process.env.PATH` after installing a tool", §15.4: Electron's
 * `process.env.PATH` was captured at launch and never updates).
 */
export async function buildResolvedPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const [hkcuRaw, hklmRaw] = await Promise.all([
    readRegistryPathValue('HKCU'),
    readRegistryPathValue('HKLM'),
  ]);
  const hkcuEntries = hkcuRaw ? splitPathEntries(expandEnvTokens(hkcuRaw, env)) : [];
  const hklmEntries = hklmRaw ? splitPathEntries(expandEnvTokens(hklmRaw, env)) : [];
  const known = knownInstallLocations(env);
  return unionPathEntries(hkcuEntries, hklmEntries, known).join(';');
}

const DEFAULT_PATHEXT = ['.EXE', '.CMD', '.BAT'];

/**
 * §15.4 step 3: resolves a bare binary name to an **absolute path** by
 * walking `resolvedPath`'s directories, trying each PATHEXT extension in
 * order — the same resolution order Windows itself uses for a bare command
 * name. The caller then spawns by this absolute path rather than relying on
 * lookup at spawn time, which is the actual, robust fix §15.4 asks for.
 * `existsFn` is injectable so this stays unit-testable without touching the
 * real filesystem.
 */
export function resolveBinaryAbsolutePath(
  name: string,
  resolvedPath: string,
  options: { pathext?: string[]; existsFn?: (candidate: string) => boolean } = {},
): string | null {
  const pathext = options.pathext ?? DEFAULT_PATHEXT;
  const existsFn = options.existsFn ?? fs.existsSync;
  const dirs = splitPathEntries(resolvedPath);
  const alreadyHasExt = pathext.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const suffixesToTry = alreadyHasExt ? [''] : pathext;
  for (const dir of dirs) {
    for (const suffix of suffixesToTry) {
      const candidate = path.join(dir, name + suffix);
      if (existsFn(candidate)) return candidate;
    }
  }
  return null;
}

export interface DetectAndCacheResult {
  found: boolean;
  path: string | null;
}

/**
 * Resolves `binaryName` against `resolvedPath` and caches the result in
 * `prereqs` (M1's repository — §5.1/§15.3) so later reads don't have to
 * re-walk the filesystem. Status vocabulary matches §15.2's wizard table
 * (`ok`/`missing`) — deliberately not attempting `outdated` (needs
 * version-range knowledge this service does not have; that is an adapter's
 * `probe()` job) or inventing a new status string for the wizard to
 * translate later. `version` is left null for the same reason.
 */
export function detectAndCacheBinary(
  db: Database.Database,
  key: string,
  binaryName: string,
  resolvedPath: string,
  options: { pathext?: string[]; existsFn?: (candidate: string) => boolean } = {},
): DetectAndCacheResult {
  const absolutePath = resolveBinaryAbsolutePath(binaryName, resolvedPath, options);
  upsertPrereq(db, {
    key,
    status: absolutePath ? 'ok' : 'missing',
    path: absolutePath,
    detected_at: nowIso(),
  });
  return { found: absolutePath !== null, path: absolutePath };
}
