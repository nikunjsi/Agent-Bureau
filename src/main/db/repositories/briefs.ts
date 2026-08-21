import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { BriefSchema, type Brief, type NewBriefInput } from '../../../shared/models/brief';

export function insertBrief(db: Database.Database, input: NewBriefInput): Brief {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO briefs (id, project_id, version, content, markdown, status, approved_at, created_at, updated_at)
     VALUES (@id, @project_id, @version, @content, @markdown, @status, @approved_at, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: input.project_id,
    version: input.version,
    content: toJsonColumn(input.content),
    markdown: input.markdown,
    status: input.status,
    approved_at: input.approved_at,
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
  db.prepare("UPDATE briefs SET status = 'approved', approved_at = ? WHERE id = ?").run(nowIso(), id);
}
