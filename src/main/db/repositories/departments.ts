import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  DepartmentSchema,
  NewDepartmentInputSchema,
  type Department,
  type NewDepartmentInput,
} from '../../../shared/models/department';

export function insertDepartment(db: Database.Database, input: NewDepartmentInput): Department {
  const parsed = NewDepartmentInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO departments (id, key, name, pack_id, room_rect, preferred_w, preferred_h, theme, enabled, created_at, updated_at)
     VALUES (@id, @key, @name, @pack_id, @room_rect, @preferred_w, @preferred_h, @theme, @enabled, @created_at, @updated_at)`,
  ).run({
    id,
    key: parsed.key,
    name: parsed.name,
    pack_id: parsed.pack_id,
    room_rect: toJsonColumn(parsed.room_rect),
    preferred_w: parsed.preferred_w,
    preferred_h: parsed.preferred_h,
    theme: parsed.theme === null ? null : toJsonColumn(parsed.theme),
    enabled: parsed.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return getDepartmentById(db, id) as Department;
}

export function getDepartmentById(db: Database.Database, id: string): Department | null {
  const row = db.prepare('SELECT * FROM departments WHERE id = ?').get(id);
  return row ? DepartmentSchema.parse(row) : null;
}

export function getDepartmentByKey(db: Database.Database, key: string): Department | null {
  const row = db.prepare('SELECT * FROM departments WHERE key = ?').get(key);
  return row ? DepartmentSchema.parse(row) : null;
}

/** Ordered by key so the floor generator's input is stable — its whole
 * determinism claim rests on the input order being decided here, not by
 * SQLite's default row order (§13.3). */
export function listDepartments(
  db: Database.Database,
  options: { enabledOnly?: boolean } = {},
): Department[] {
  const where = options.enabledOnly === true ? 'WHERE enabled = 1' : '';
  const rows = db.prepare(`SELECT * FROM departments ${where} ORDER BY key`).all();
  return rows.map((row) => DepartmentSchema.parse(row));
}

/** §13.3 step 8's denormalised half — the whole layout lives in
 * `companies.floor_layout`; this is the per-department view §5.1 also
 * specifies. Written in the same transaction as the layout. */
export function setDepartmentRoomRect(
  db: Database.Database,
  key: string,
  rect: { x: number; y: number; w: number; h: number },
): void {
  db.prepare('UPDATE departments SET room_rect = @rect WHERE key = @key').run({
    key,
    rect: toJsonColumn(rect),
  });
}
