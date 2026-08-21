import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { MemorySchema, NewMemoryInputSchema, type Memory, type NewMemoryInput } from '../../../shared/models/memory';

export function insertMemory(db: Database.Database, input: NewMemoryInput): Memory {
  const parsed = NewMemoryInputSchema.parse(input);
  const id = parsed.id ?? newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory (id, scope, scope_ref, path, title, body, content_sha256, tags, source, pinned, created_at, updated_at)
     VALUES (@id, @scope, @scope_ref, @path, @title, @body, @content_sha256, @tags, @source, @pinned, @created_at, @updated_at)`,
  ).run({
    id,
    scope: parsed.scope,
    scope_ref: parsed.scope_ref,
    path: parsed.path,
    title: parsed.title,
    body: parsed.body,
    content_sha256: parsed.content_sha256,
    tags: toJsonColumn(parsed.tags),
    source: parsed.source,
    pinned: parsed.pinned ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return getMemoryById(db, id) as Memory;
}

export function getMemoryById(db: Database.Database, id: string): Memory | null {
  const row = db.prepare('SELECT * FROM memory WHERE id = ?').get(id);
  return row ? MemorySchema.parse(row) : null;
}

export function searchMemory(db: Database.Database, query: string): Memory[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM memory m
       JOIN memory_fts ON memory_fts.rowid = m.rowid
       WHERE memory_fts MATCH ?
       ORDER BY rank`,
    )
    .all(query);
  return rows.map((row) => MemorySchema.parse(row));
}
