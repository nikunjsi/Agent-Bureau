import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  ConversationMessageSchema,
  NewConversationMessageInputSchema,
  type ConversationMessage,
  type NewConversationMessageInput,
} from '../../../shared/models/conversationMessage';

export function insertConversationMessage(
  db: Database.Database,
  input: NewConversationMessageInput,
): ConversationMessage {
  const parsed = NewConversationMessageInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, project_id, author, kind, body, payload, checkpoint_id, status, seq, read_at, created_at, updated_at)
     VALUES (@id, @conversation_id, @project_id, @author, @kind, @body, @payload, @checkpoint_id, @status, @seq, @read_at, @created_at, @updated_at)`,
  ).run({
    id,
    conversation_id: parsed.conversation_id,
    project_id: parsed.project_id,
    author: parsed.author,
    kind: parsed.kind,
    body: parsed.body,
    payload: parsed.payload === null ? null : toJsonColumn(parsed.payload),
    checkpoint_id: parsed.checkpoint_id,
    status: parsed.status,
    seq: parsed.seq,
    read_at: parsed.read_at,
    created_at: now,
    updated_at: now,
  });
  return getConversationMessageById(db, id) as ConversationMessage;
}

export function getConversationMessageById(db: Database.Database, id: string): ConversationMessage | null {
  const row = db.prepare('SELECT * FROM conversation_messages WHERE id = ?').get(id);
  return row ? ConversationMessageSchema.parse(row) : null;
}

/** §5.1 "Streaming (MUST)": on reconcile, any row still `streaming` from
 * before the app started becomes `aborted`. */
export function abortStaleStreamingMessages(db: Database.Database): number {
  const result = db
    .prepare("UPDATE conversation_messages SET status = 'aborted' WHERE status = 'streaming'")
    .run();
  return result.changes;
}
