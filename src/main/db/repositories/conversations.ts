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
 * §5.1: "there is always one company-level conversation": the one with no
 * project. The newest, should more than one ever exist. `null` only before
 * any conversation does (M11 S2-1a).
 */
export function getCompanyConversation(db: Database.Database): Conversation | null {
  const row = db
    .prepare(
      'SELECT id FROM conversations WHERE project_id IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1',
    )
    .get() as { id: string } | undefined;
  return row ? getConversationById(db, row.id) : null;
}

/**
 * **Which conversation something about a project lands in** (§9.7/§J.4):
 * the project's own conversation, and failing that (no project, or one
 * without a conversation) the company conversation.
 *
 * **Changed at M11 S2-1a.** The fallback was "the most recently created
 * conversation", which meant the same thing while only one existed. Once a
 * project has a conversation of its own, "most recent" would post company
 * business into whichever project was started last. `null` means this
 * company has no conversation at all, which is a real data state and why
 * the router still has a hold reason for it.
 */
export function resolveConversationForDelivery(
  db: Database.Database,
  projectId: string | null,
): Conversation | null {
  if (projectId !== null) {
    const row = db
      .prepare(
        'SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get(projectId) as { id: string } | undefined;
    if (row) return getConversationById(db, row.id);
  }
  return getCompanyConversation(db);
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

/** M11 row S1-18: compaction's summary. */
export function setConversationSummary(
  db: Database.Database,
  conversationId: string,
  summary: string,
): void {
  db.prepare('UPDATE conversations SET summary = ?, updated_at = ? WHERE id = ?').run(
    summary,
    nowIso(),
    conversationId,
  );
}

/**
 * M11 row S1-18: the engine session a compaction started. Written when the
 * fresh session reports its id, which is the change it records (S1-11 keeps
 * the live id on `employees.session_id`; this is the conversation's record).
 */
export function setConversationDirectorSessionId(
  db: Database.Database,
  conversationId: string,
  sessionId: string,
): void {
  db.prepare('UPDATE conversations SET director_session_id = ?, updated_at = ? WHERE id = ?').run(
    sessionId,
    nowIso(),
    conversationId,
  );
}
