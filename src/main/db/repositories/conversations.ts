import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  ConversationSchema,
  NewConversationInputSchema,
  type Conversation,
  type NewConversationInput,
} from '../../../shared/models/conversation';

export function insertConversation(db: Database.Database, input: NewConversationInput): Conversation {
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
    director_state_data: parsed.director_state_data === null ? null : toJsonColumn(parsed.director_state_data),
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
