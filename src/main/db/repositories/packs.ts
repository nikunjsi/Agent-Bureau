import type Database from 'better-sqlite3';
import { nowIso } from '../../../shared/models/ids';
import {
  PackRowSchema,
  NewPackInputSchema,
  type PackRow,
  type NewPackInput,
  type PackValidationStatus,
} from '../../../shared/models/pack';

/**
 * The `packs` table (migration 0006). Keyed by the pack's own `key` rather
 * than a generated id: a pack key is already globally unique by
 * construction (it is the directory name, and `roles.pack_id` /
 * `departments.pack_id` have always been that string), so a surrogate id
 * would create a second way to name the same thing.
 */

export function upsertPack(db: Database.Database, input: NewPackInput): PackRow {
  const parsed = NewPackInputSchema.parse(input);
  const now = nowIso();
  db.prepare(
    `INSERT INTO packs (
       key, name, version, origin, source_path, installed_at, enabled,
       last_validation_status, last_validation_error, last_validated_at,
       created_at, updated_at
     ) VALUES (
       @key, @name, @version, @origin, @source_path, @installed_at, @enabled,
       @last_validation_status, @last_validation_error, @last_validated_at,
       @created_at, @updated_at
     )
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name,
       version = excluded.version,
       origin = excluded.origin,
       source_path = excluded.source_path,
       last_validation_status = excluded.last_validation_status,
       last_validation_error = excluded.last_validation_error,
       last_validated_at = excluded.last_validated_at,
       updated_at = excluded.updated_at`,
    // Deliberately NOT in the update list: `enabled` and `installed_at`.
    // `enabled` is the user's intent and is only ever changed by an
    // explicit setEnabled(); reinstalling a pack the user had switched off
    // must not switch it back on behind their back.
  ).run({
    key: parsed.key,
    name: parsed.name,
    version: parsed.version,
    origin: parsed.origin,
    source_path: parsed.source_path,
    installed_at: now,
    enabled: parsed.enabled ? 1 : 0,
    last_validation_status: parsed.last_validation_status,
    last_validation_error: parsed.last_validation_error,
    last_validated_at: now,
    created_at: now,
    updated_at: now,
  });
  return getPackByKey(db, parsed.key) as PackRow;
}

export function getPackByKey(db: Database.Database, key: string): PackRow | null {
  const row = db.prepare('SELECT * FROM packs WHERE key = ?').get(key);
  return row ? PackRowSchema.parse(row) : null;
}

export function listPacks(db: Database.Database): PackRow[] {
  const rows = db.prepare('SELECT * FROM packs ORDER BY key').all();
  return rows.map((row) => PackRowSchema.parse(row));
}

/**
 * §6.7 — records the outcome of a validation run WITHOUT touching
 * `enabled`. A pack that fails at boot keeps the user's intent intact and
 * simply has its roles withheld; the readable error lives here so
 * `packs.list` can say why.
 */
export function recordPackValidation(
  db: Database.Database,
  key: string,
  status: PackValidationStatus,
  error: string | null,
): void {
  db.prepare(
    `UPDATE packs
        SET last_validation_status = @status,
            last_validation_error = @error,
            last_validated_at = @now,
            updated_at = @now
      WHERE key = @key`,
  ).run({ key, status, error, now: nowIso() });
}

/** The only thing that may write `enabled` — an explicit user action. */
export function setPackEnabled(db: Database.Database, key: string, enabled: boolean): void {
  const now = nowIso();
  db.prepare('UPDATE packs SET enabled = @enabled, updated_at = @now WHERE key = @key').run({
    key,
    enabled: enabled ? 1 : 0,
    now,
  });
}

/**
 * Removes everything a pack instantiated, keeping the `packs` row itself
 * (and therefore the user's `enabled` intent). This is the upgrade path:
 * `installPack` clears the old content and writes the new inside ONE
 * transaction, so a pack is never half-upgraded.
 *
 * Roles before departments: `roles.department_key` references
 * `departments(key)`, so the reverse order trips the FK.
 *
 * There is deliberately no `deletePackCascade` alongside this. Nothing
 * uninstalls a pack yet — `packs.uninstall` is not in the IPC surface —
 * and shipping an untriggered delete path is exactly the unexercised-code
 * shape the M3-M6 audit found rotting elsewhere.
 */
export function deletePackContent(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM roles WHERE pack_id = ?').run(key);
  db.prepare('DELETE FROM departments WHERE pack_id = ?').run(key);
}
