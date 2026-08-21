import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { DeliverableSchema, NewDeliverableInputSchema, type Deliverable, type NewDeliverableInput } from '../../../shared/models/deliverable';

export function insertDeliverable(db: Database.Database, input: NewDeliverableInput): Deliverable {
  const parsed = NewDeliverableInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO deliverables (id, project_id, phase_id, type, title, path, summary, status, version, created_at, updated_at)
     VALUES (@id, @project_id, @phase_id, @type, @title, @path, @summary, @status, @version, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: parsed.project_id,
    phase_id: parsed.phase_id,
    type: parsed.type,
    title: parsed.title,
    path: parsed.path,
    summary: parsed.summary,
    status: parsed.status,
    version: parsed.version,
    created_at: now,
    updated_at: now,
  });
  return getDeliverableById(db, id) as Deliverable;
}

export function getDeliverableById(db: Database.Database, id: string): Deliverable | null {
  const row = db.prepare('SELECT * FROM deliverables WHERE id = ?').get(id);
  return row ? DeliverableSchema.parse(row) : null;
}
