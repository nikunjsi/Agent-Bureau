import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  ConversationSchema,
  NewConversationInputSchema,
  type Conversation,
  type NewConversationInput,
} from '../../../shared/models/conversation';

export function insertConversation(
  db: Database.Database,
  input: NewConversationInput,
): Conversation {
  const parsed = NewConversationInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversations (id, company_id, project_id, title, director_session_id, summary, director_state, director_state_data, status, created_at, updated_at)
     VALUES (@id, @company_id, @project_id, @title, @director_session_id, @summary, @director_state, @director_state_data, @status, @created_at, @updated_at)`,
  ).run({
    id,
    company_id: parsed.company_id,
    project_id: parsed.project_id,
    title: parsed.title,
    director_session_id: parsed.director_session_id,
    summary: parsed.summary,
    director_state: parsed.director_state,
    director_state_data:
      parsed.director_state_data === null ? null : toJsonColumn(parsed.director_state_data),
    status: parsed.status,
    created_at: now,
    updated_at: now,
  });
  return getConversationById(db, id) as Conversation;
}

export function getConversationById(db: Database.Database, id: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return row ? ConversationSchema.parse(row) : null;
}

/**
 * **Which conversation a `user`-addressed message lands in** (§9.7/§J.4).
 *
 * The rule, stated because §9.7 does not: the conversation belonging to
 * the message's project, and failing that the most recently created one.
 * `null` means this company has no conversation at all, which is a real
 * data state (nothing creates one before M11's project intake or M13's
 * wizard) and is why the router still has a hold reason for it — not a
 * missing mechanism.
 *
 * `ChatView` independently shows "the most recently created conversation",
 * because nothing creates a second one yet (docs/NEXT-VERSION.md §K.2).
 * The two rules agree today and would only diverge once projects exist —
 * at which point the view gains the switcher §K.2 describes and this
 * function is the routing half, not the display half.
 */
export function resolveConversationForDelivery(
  db: Database.Database,
  projectId: string | null,
): Conversation | null {
  const byProject =
    projectId === null
      ? undefined
      : (db
          .prepare(
            'SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(projectId) as { id: string } | undefined);
  const row =
    byProject ??
    (db.prepare('SELECT id FROM conversations ORDER BY created_at DESC LIMIT 1').get() as
      { id: string } | undefined);
  return row ? getConversationById(db, row.id) : null;
}

/**
 * M11 row S1-14: writes the Director's state and its data together. Only
 * `transitionDirectorState` calls this: it is the one place a transition is
 * validated against Appendix A.3 and its event emitted.
 */
export function setConversationDirectorState(
  db: Database.Database,
  conversationId: string,
  state: string,
  data: Record<string, unknown>,
): void {
  db.prepare(
    'UPDATE conversations SET director_state = ?, director_state_data = ?, updated_at = ? WHERE id = ?',
  ).run(state, toJsonColumn(data), nowIso(), conversationId);
}
