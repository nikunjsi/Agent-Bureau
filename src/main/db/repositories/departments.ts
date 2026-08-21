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
    `INSERT INTO departments (id, key, name, pack_id, room_rect, theme, enabled, created_at, updated_at)
     VALUES (@id, @key, @name, @pack_id, @room_rect, @theme, @enabled, @created_at, @updated_at)`,
  ).run({
    id,
    key: parsed.key,
    name: parsed.name,
    pack_id: parsed.pack_id,
    room_rect: toJsonColumn(parsed.room_rect),
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
