import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { ArtifactSchema, type Artifact, type NewArtifactInput } from '../../../shared/models/artifact';

export function insertArtifact(db: Database.Database, input: NewArtifactInput): Artifact {
  const id = newId();
  db.prepare(
    `INSERT INTO artifacts (id, task_id, employee_id, kind, title, path, content, content_sha256, bytes, mime, pinned, created_at)
     VALUES (@id, @task_id, @employee_id, @kind, @title, @path, @content, @content_sha256, @bytes, @mime, @pinned, @created_at)`,
  ).run({
    id,
    task_id: input.task_id,
    employee_id: input.employee_id,
    kind: input.kind,
    title: input.title,
    path: input.path,
    content: input.content,
    content_sha256: input.content_sha256,
    bytes: input.bytes,
    mime: input.mime,
    pinned: input.pinned ? 1 : 0,
    created_at: nowIso(),
  });
  return getArtifactById(db, id) as Artifact;
}

export function getArtifactById(db: Database.Database, id: string): Artifact | null {
  const row = db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id);
  return row ? ArtifactSchema.parse(row) : null;
}
