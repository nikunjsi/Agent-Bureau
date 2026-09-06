import type Database from 'better-sqlite3';
import path from 'node:path';
import type { ActivityLog } from '../../src/main/db/activityLog';
import { insertCompany } from '../../src/main/db/repositories/companies';
import { installPack } from '../../src/main/packs/installPack';
import type { Company } from '../../src/shared/models/company';

export const APP_VERSION_FOR_TESTS = '0.0.1';
export const SHIPPED_PACKS_DIR = path.resolve('packs');

/**
 * Two seams this session states rather than closes, both flagged before
 * any code was written:
 *
 * **Nothing creates a company.** `insertCompany` has existed since M1 with
 * no production caller — the setup wizard that will call it is §14.1, M13.
 * Hiring needs a company row, so tests make one here. This is deliberately
 * a fixture and not a `createCompany()` in `src/main/`: inventing a
 * first-run flow ahead of the milestone that owns it is how speculative
 * code gets built, and M13 will want to make real decisions about naming,
 * the home path, and the Director's own creation.
 *
 * **Nothing installs a pack at first run.** M7 session 1 decided boot
 * VALIDATES installed packs but never installs one. Hiring needs installed
 * roles, so tests install explicitly. Same shape: a seam, not a gap.
 */

export function seedCompany(db: Database.Database, homePath: string, name = 'Test Co'): Company {
  return insertCompany(db, { name, home_path: homePath });
}

/** Installs a real shipped pack through the real installer. */
export function installShippedPack(options: {
  db: Database.Database;
  activityLog: ActivityLog;
  baseDir: string;
  packKey: string;
}): void {
  const result = installPack({
    db: options.db,
    activityLog: options.activityLog,
    baseDir: options.baseDir,
    sourceDir: path.join(SHIPPED_PACKS_DIR, options.packKey),
    origin: 'bundled',
    appVersion: APP_VERSION_FOR_TESTS,
  });
  if (!result.installed) {
    throw new Error(`fixture could not install "${options.packKey}": ${result.errors.join('; ')}`);
  }
}
