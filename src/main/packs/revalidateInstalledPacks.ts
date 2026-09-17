import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { listPacks, recordPackValidation, getPackByKey } from '../db/repositories/packs';
import { getPackDir } from '../db/paths';
import type { PackRow } from '../../shared/models/pack';
import { loadPack } from './loadPack';
import { validatePack } from './validatePack';
import type { ProbeResult } from '../../shared/engine/types';

/**
 * §6.7: "**On startup** and on install, every pack is validated. A pack
 * that fails validation is disabled with a readable error, never partially
 * loaded."
 *
 * This is the startup half, and the only thing that ever writes
 * `packs.last_validation_status`. Its counterpart `installPack` never
 * annotates a row on failure: what fails there is a SOURCE being offered,
 * not the installed pack.
 *
 * **What "disabled" means here, precisely.** `enabled` is the user's
 * intent and is never rewritten (see migration 0006). A pack that fails
 * validation at startup keeps `enabled = 1`, records the readable error,
 * and is reported as unavailable-with-a-reason by `packs.list`. Fixing the
 * pack and restarting makes it available again with no second user action,
 * which a silent flip to `enabled = 0` would not.
 *
 * **What this deliberately does NOT do:** it does not delete a failing
 * pack's roles or departments. Employees already hired into those roles
 * exist, and quietly removing the row an `employees.role_key` points at
 * would break a running company to punish a YAML typo. Withholding is a
 * read-time decision (`availablePacks`), not a destructive one.
 */

export interface RevalidateResult {
  readonly checked: number;
  readonly failed: readonly { key: string; errors: string[] }[];
}

export interface RevalidateOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly baseDir: string;
  readonly appVersion: string;
  /** Where bundled packs live; `origin: 'bundled'` rows are read from here. */
  readonly bundledPacksDir: string;
}

function directoryFor(pack: PackRow, options: RevalidateOptions): string {
  return pack.origin === 'bundled'
    ? `${options.bundledPacksDir}/${pack.key}`
    : getPackDir(options.baseDir, pack.key);
}

export function revalidateInstalledPacks(options: RevalidateOptions): RevalidateResult {
  const failed: { key: string; errors: string[] }[] = [];
  const packs = listPacks(options.db);

  for (const pack of packs) {
    const dir = directoryFor(pack, options);
    const loaded = loadPack(dir);
    const errors =
      loaded.pack === null
        ? loaded.errors
        : validatePack(loaded.pack, { appVersion: options.appVersion }).errors;

    const status = errors.length === 0 ? 'ok' : 'failed';
    const error = errors.length === 0 ? null : errors.join('\n');

    // Only write when something actually changed. A boot that finds every
    // pack healthy is not a state change and must not emit an event —
    // otherwise every launch appends noise to the activity log, and
    // "exactly one event per state change" degrades into "an event
    // whenever we looked".
    const unchanged =
      pack.last_validation_status === status && pack.last_validation_error === error;
    if (unchanged) {
      if (status === 'failed') failed.push({ key: pack.key, errors });
      continue;
    }

    recordPackValidation(options.db, pack.key, status, error);
    options.activityLog.logEvent({
      actor: 'system',
      type: status === 'failed' ? 'company.pack_validation_failed' : 'company.pack_validated',
      severity: status === 'failed' ? 'warn' : 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: {
        key: pack.key,
        path: dir,
        // The readable error §6.7 requires, in the durable record as well
        // as the row — the row holds only the latest, the log holds when.
        errors,
      },
    });

    if (status === 'failed') failed.push({ key: pack.key, errors });
  }

  return { checked: packs.length, failed };
}

/**
 * The read-time half of "disabled with a readable error": a pack whose
 * last validation failed is withheld, and a pack the user switched off is
 * withheld. Callers that need to know WHY ask `getPackByKey`.
 */
/** Probes one engine by key. `null` means Bureau has no adapter for that key. */
export type PackEngineProbe = (engineKey: string) => Promise<ProbeResult | null>;

/**
 * X-2 / §6.3: `requires.engines` — "at least one must be available". Runs
 * after `revalidateInstalledPacks` (the probes are async and can take
 * seconds, so they are kept off the synchronous pass). A pack that passed
 * validation but none of whose engines is installed is recorded as `failed`
 * with a readable reason, which `isPackAvailable` then withholds from hiring,
 * and emits `company.pack_validation_failed`. The next startup revalidates
 * from scratch, so installing the engine is enough to bring the pack back.
 *
 * An `indeterminate` probe (it did not finish, §7.8) is not proof of absence
 * and never makes a pack unavailable on its own; an engine key with no adapter
 * counts as not installed.
 */
export async function revalidatePackEngines(
  options: RevalidateOptions & { readonly probeEngine: PackEngineProbe },
): Promise<RevalidateResult> {
  const failed: { key: string; errors: string[] }[] = [];
  const packs = listPacks(options.db);
  for (const pack of packs) {
    if (!pack.enabled || pack.last_validation_status !== 'ok') continue;
    const dir = directoryFor(pack, options);
    const engines = loadPack(dir).pack?.manifest.requires.engines ?? [];
    if (engines.length === 0) continue;

    let satisfied = false;
    for (const engineKey of engines) {
      const result = await options.probeEngine(engineKey);
      if (result !== null && (result.installed || result.determination === 'indeterminate')) {
        satisfied = true;
        break;
      }
    }
    if (satisfied) continue;

    const error = `This pack needs one of these engines, and none of them is installed: ${engines.join(', ')}. Install one, then restart Bureau.`;
    recordPackValidation(options.db, pack.key, 'failed', error);
    options.activityLog.logEvent({
      actor: 'system',
      type: 'company.pack_validation_failed',
      severity: 'warn',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { key: pack.key, path: dir, errors: [error], reason: 'engines_unavailable' },
    });
    failed.push({ key: pack.key, errors: [error] });
  }
  return { checked: packs.length, failed };
}

export function isPackAvailable(db: Database.Database, key: string): boolean {
  const pack = getPackByKey(db, key);
  if (!pack) return false;
  return pack.enabled && pack.last_validation_status === 'ok';
}
