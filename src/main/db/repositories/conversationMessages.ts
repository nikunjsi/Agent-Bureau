import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import {
  ConversationMessageSchema,
  type ConversationMessage,
  type NewConversationMessageInput,
} from '../../../shared/models/conversationMessage';

export function insertConversationMessage(
  db: Database.Database,
  input: NewConversationMessageInput,
): ConversationMessage {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, project_id, author, kind, body, payload, checkpoint_id, status, seq, read_at, created_at, updated_at)
     VALUES (@id, @conversation_id, @project_id, @author, @kind, @body, @payload, @checkpoint_id, @status, @seq, @read_at, @created_at, @updated_at)`,
  ).run({
    id,
    conversation_id: input.conversation_id,
    project_id: input.project_id,
    author: input.author,
    kind: input.kind,
    body: input.body,
    payload: input.payload === null ? null : toJsonColumn(input.payload),
    checkpoint_id: input.checkpoint_id,
    status: input.status,
    seq: input.seq,
    read_at: input.read_at,
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
