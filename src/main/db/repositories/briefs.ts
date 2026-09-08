import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  BriefSchema,
  NewBriefInputSchema,
  type Brief,
  type NewBriefInput,
} from '../../../shared/models/brief';

export function insertBrief(db: Database.Database, input: NewBriefInput): Brief {
  const parsed = NewBriefInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO briefs (id, project_id, version, content, markdown, status, approved_at, created_at, updated_at)
     VALUES (@id, @project_id, @version, @content, @markdown, @status, @approved_at, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: parsed.project_id,
    version: parsed.version,
    content: toJsonColumn(parsed.content),
    markdown: parsed.markdown,
    status: parsed.status,
    approved_at: parsed.approved_at,
    created_at: now,
    updated_at: now,
  });
  return getBriefById(db, id) as Brief;
}

export function getBriefById(db: Database.Database, id: string): Brief | null {
  const row = db.prepare('SELECT * FROM briefs WHERE id = ?').get(id);
  return row ? BriefSchema.parse(row) : null;
}

export function approveBrief(db: Database.Database, id: string): void {
  db.prepare("UPDATE briefs SET status = 'approved', approved_at = ? WHERE id = ?").run(
    nowIso(),
    id,
  );
}
