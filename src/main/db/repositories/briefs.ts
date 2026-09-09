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

/**
 * Invariant #2's producer: *nothing is built before the brief is
 * approved*, and this is the only thing that can make that sentence true.
 *
 * A compare-and-set, not a blind UPDATE, for the reason
 * `answerCheckpoint`'s own CAS exists: two windows can both press Approve,
 * and a version that has been superseded by an edit must not be approvable
 * at all — approving a brief the user has since replaced would authorise
 * work against text nobody agreed to. `false` means this call changed
 * nothing, and the caller says which of the two it was by reading the row.
 */
export function approveBrief(db: Database.Database, id: string): boolean {
  const at = nowIso();
  const result = db
    .prepare(
      `UPDATE briefs SET status = 'approved', approved_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('draft','awaiting_approval')`,
    )
    .run(at, at, id);
  return result.changes === 1;
}

/** §28 M9 item 4: "Edit opens the markdown in an editor and saves a new
 * version." The old row becomes `superseded` rather than being rewritten —
 * `version` is an int and `superseded` is a real status precisely so the
 * history survives. */
export function supersedeBrief(db: Database.Database, id: string): void {
  const at = nowIso();
  db.prepare("UPDATE briefs SET status = 'superseded', updated_at = ? WHERE id = ?").run(at, id);
}

/** The highest `version` this project's briefs have reached, or 0. Used to
 * number a new version — `MAX(...)+1` inside the same transaction as the
 * insert, which is §5.1.2's own rule for a gapless counter. */
export function latestBriefVersion(db: Database.Database, projectId: string): number {
  const row = db
    .prepare('SELECT MAX(version) AS v FROM briefs WHERE project_id = ?')
    .get(projectId) as { v: number | null };
  return row.v ?? 0;
}
