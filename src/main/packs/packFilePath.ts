import path from 'node:path';
import type Database from 'better-sqlite3';
import { getPacksDir } from '../db/paths';

/**
 * Where a file of an installed pack lives on disk: a bundled pack is read
 * from the app's own `packs/`, any other from the user's packs directory.
 * One answer for every reader — the Director's prompt (§8.0.1) and an
 * employee's role prompt (Appendix B, M11 S3-1).
 */
export function packFilePath(
  deps: {
    readonly db: Database.Database;
    readonly baseDir: string;
    readonly bundledPacksDir: string;
  },
  packKey: string,
  relativePath: string,
): string {
  const origin = (
    deps.db.prepare('SELECT origin FROM packs WHERE key = ?').get(packKey) as
      { origin: string } | undefined
  )?.origin;
  const packDir =
    origin === 'bundled'
      ? path.join(deps.bundledPacksDir, packKey)
      : path.join(getPacksDir(deps.baseDir), packKey);
  return path.join(packDir, relativePath);
}
