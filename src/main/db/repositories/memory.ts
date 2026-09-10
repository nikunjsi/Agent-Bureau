import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  MemorySchema,
  NewMemoryInputSchema,
  type Memory,
  type NewMemoryInput,
} from '../../../shared/models/memory';

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

/**
 * AUDIT M0–M2 #4 — the one designated writer for `memory.pinned`.
 *
 * `handlers/memory.ts` had **two different** `UPDATE memory SET pinned`
 * statements, in the same file: one keyed by `id`, one by `path`, and only
 * one of them touched `updated_at`. That divergence is the finding in
 * miniature — the same column, two owners, and no test of either half
 * could see that they disagreed.
 *
 * Addressed by id or by path because both callers are real: `memory.pin`
 * has the row in hand, while `memory.write` has only the relative path it
 * just wrote. Both now stamp `updated_at`, which is §5.0's blanket rule
 * for a mutable table and was previously true of only one of them.
 */
export function setMemoryPinned(
  db: Database.Database,
  target: { readonly id: string } | { readonly path: string },
  pinned: boolean,
): void {
  const now = nowIso();
  if ('id' in target) {
    db.prepare('UPDATE memory SET pinned = @pinned, updated_at = @now WHERE id = @id').run({
      pinned: pinned ? 1 : 0,
      now,
      id: target.id,
    });
    return;
  }
  db.prepare('UPDATE memory SET pinned = @pinned, updated_at = @now WHERE path = @path').run({
    pinned: pinned ? 1 : 0,
    now,
    path: target.path,
  });
}
