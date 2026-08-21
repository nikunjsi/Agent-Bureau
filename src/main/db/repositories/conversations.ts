import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { ConversationSchema, type Conversation, type NewConversationInput } from '../../../shared/models/conversation';

export function insertConversation(db: Database.Database, input: NewConversationInput): Conversation {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversations (id, company_id, project_id, title, director_session_id, summary, director_state, director_state_data, status, created_at, updated_at)
     VALUES (@id, @company_id, @project_id, @title, @director_session_id, @summary, @director_state, @director_state_data, @status, @created_at, @updated_at)`,
  ).run({
    id,
    company_id: input.company_id,
    project_id: input.project_id,
    title: input.title,
    director_session_id: input.director_session_id,
    summary: input.summary,
    director_state: input.director_state,
    director_state_data: input.director_state_data === null ? null : toJsonColumn(input.director_state_data),
    status: input.status,
    created_at: now,
    updated_at: now,
  });
  return getConversationById(db, id) as Conversation;
}

export function getConversationById(db: Database.Database, id: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  return row ? ConversationSchema.parse(row) : null;
}
