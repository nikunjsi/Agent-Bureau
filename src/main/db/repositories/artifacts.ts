import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { ArtifactSchema, NewArtifactInputSchema, type Artifact, type NewArtifactInput } from '../../../shared/models/artifact';

export function insertArtifact(db: Database.Database, input: NewArtifactInput): Artifact {
  const parsed = NewArtifactInputSchema.parse(input);
  const id = newId();
  db.prepare(
    `INSERT INTO artifacts (id, task_id, employee_id, kind, title, path, content, content_sha256, bytes, mime, pinned, created_at)
     VALUES (@id, @task_id, @employee_id, @kind, @title, @path, @content, @content_sha256, @bytes, @mime, @pinned, @created_at)`,
  ).run({
    id,
    task_id: parsed.task_id,
    employee_id: parsed.employee_id,
    kind: parsed.kind,
    title: parsed.title,
    path: parsed.path,
    content: parsed.content,
    content_sha256: parsed.content_sha256,
    bytes: parsed.bytes,
    mime: parsed.mime,
    pinned: parsed.pinned ? 1 : 0,
    created_at: nowIso(),
  });
  return getArtifactById(db, id) as Artifact;
}

export function getArtifactById(db: Database.Database, id: string): Artifact | null {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  return row ? ArtifactSchema.parse(row) : null;
}
