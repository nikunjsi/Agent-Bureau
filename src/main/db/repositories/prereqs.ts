import type Database from 'better-sqlite3';
import { PrereqSchema, UpsertPrereqInputSchema, type Prereq, type UpsertPrereqInput } from '../../../shared/models/prereq';

export function upsertPrereq(db: Database.Database, input: UpsertPrereqInput): Prereq {
  const parsed = UpsertPrereqInputSchema.parse(input);
  db.prepare(
    `INSERT INTO prereqs (key, status, version, path, detected_at, notes)
     VALUES (@key, @status, @version, @path, @detected_at, @notes)
     ON CONFLICT(key) DO UPDATE SET
       status = excluded.status, version = excluded.version, path = excluded.path,
       detected_at = excluded.detected_at, notes = excluded.notes`,
  ).run(parsed);
  return getPrereq(db, parsed.key) as Prereq;
}

export function getPrereq(db: Database.Database, key: string): Prereq | null {
  const row = db.prepare('SELECT * FROM prereqs WHERE key = ?').get(key);
  return row ? PrereqSchema.parse(row) : null;
}
