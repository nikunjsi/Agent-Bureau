import type Database from 'better-sqlite3';
import { renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAllSettings } from '../db/repositories/settings';
import { redactDeep } from '../secrets/redactor';

/** The file's name, in one place. Deliberately exported for writing only —
 * see the header on why nothing may read it. */
export const SETTINGS_SNAPSHOT_FILE = 'settings.json';

/**
 * AUDIT M0–M2 #26 — §16.1: "`settings.json` in the data folder is an
 * **export/import** convenience only, written on change for user
 * inspection and **never read at runtime**." Appendix D lists it among the
 * files a user will find in their data folder. Until this, nothing wrote
 * it.
 *
 * **Never read.** The SQLite `settings` table is authoritative; a second
 * store the app also read would be two sources of truth for one value,
 * free to drift (§16.1's own reason). `settingsJsonSnapshot.test.ts` scans
 * `src/` for a reader.
 *
 * **Redacted**, like every other outbound copy of state (§11.4): settings
 * are never meant to hold secrets, but a path or a free-text value can
 * carry one by accident, and this file exists to be opened and shared.
 *
 * **Atomic** — written to a sibling temp file and renamed over the old one,
 * so a crash mid-write leaves the previous snapshot rather than a torn one.
 *
 * Called after the setting is committed and its event logged (invariant
 * #3). It is a derived copy, not a state change, so it emits nothing.
 */
export function writeSettingsSnapshot(db: Database.Database, dataDir: string): void {
  const target = path.join(dataDir, SETTINGS_SNAPSHOT_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(redactDeep(getAllSettings(db)), null, 2)}\n`, 'utf8');
  renameSync(temp, target);
}
