import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { DepartmentSchema, type Department, type NewDepartmentInput } from '../../../shared/models/department';

export function insertDepartment(db: Database.Database, input: NewDepartmentInput): Department {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO departments (id, key, name, pack_id, room_rect, theme, enabled, created_at, updated_at)
     VALUES (@id, @key, @name, @pack_id, @room_rect, @theme, @enabled, @created_at, @updated_at)`,
  ).run({
    id,
    key: input.key,
    name: input.name,
    pack_id: input.pack_id,
    room_rect: toJsonColumn(input.room_rect),
    theme: input.theme === null ? null : toJsonColumn(input.theme),
    enabled: input.enabled ? 1 : 0,
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
