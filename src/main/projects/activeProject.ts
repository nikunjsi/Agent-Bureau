import type Database from 'better-sqlite3';

/**
 * The project the window's Board shows (M11 S2-5, `NEXT-VERSION` §N.5).
 *
 * **The project whose conversation last had a message**, else the newest
 * project, else none. That is the conversation switcher's own default
 * (`chooseConversation`: "where something was said last"), computed here so
 * the Core does not need to know what the renderer has open (invariant #11).
 * A conversation the user picks in the switcher without speaking in it does
 * not move it; the Board following the switcher is M14's (the Board's own
 * milestone, §F).
 *
 * One decision, one place: the `tasks` slice of the snapshot and of the live
 * push both ask this.
 */
export function activeProjectId(db: Database.Database): string | null {
  const spoken = db
    .prepare(
      `SELECT c.project_id AS id
         FROM conversation_messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.project_id IS NOT NULL
        ORDER BY m.created_at DESC, m.rowid DESC
        LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  if (spoken !== undefined) return spoken.id;
  const newest = db
    .prepare('SELECT id FROM projects ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { id: string } | undefined;
  return newest?.id ?? null;
}
