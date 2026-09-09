import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { insertConversationMessage } from '../db/repositories/conversationMessages';
import type { ConversationMessage } from '../../shared/models/conversationMessage';
import type { ConversationMessageKind, MessageAuthor } from '../../shared/models/enums';
import { parseChatPayload } from '../../shared/models/chatPayloads';
import type { ChatBroadcaster } from './chatBroadcaster';
import { noopChatBroadcaster } from './chatBroadcaster';

export interface ChatDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly broadcaster?: ChatBroadcaster;
}

export interface AppendChatMessageInput {
  readonly conversationId: string;
  readonly projectId?: string | null;
  readonly author: MessageAuthor;
  readonly kind: ConversationMessageKind;
  readonly body: string;
  readonly payload?: unknown;
  readonly checkpointId?: string | null;
}

/**
 * The one door into `conversation_messages` (§5.1) for anything that is not
 * a live stream — `chatStream.ts` owns those, and goes through the same two
 * helpers below so there is one insert path and one push path.
 *
 * Ordering, per CLAUDE.md invariant #3: the row is committed, then the
 * event is written, then the push goes out. A window that receives a
 * message the database does not have is a bug that would look like a UI
 * glitch and be a data-loss bug.
 *
 * **Who calls this.** As of M9 session 2: `chat.send` (the user's own
 * messages and the `system` echo of a slash command) and the message
 * router (a message addressed to `user`, §J.4). The Director's own
 * messages are still M11's — that is the producer, not this door.
 *
 * ## `alsoCommit`, and the rule it must obey
 *
 * The router needs the conversation row and `messages.status = 'delivered'`
 * to land together: a crash between them would either duplicate the
 * message in the transcript on redelivery, or (inverted) lose it silently.
 * Both writes are on this same connection, so there is no process boundary
 * to make at-least-once necessary here — one transaction is simply
 * available, and taking it is better than documenting a duplicate.
 *
 * **What may go in it: a synchronous DB write on `deps.db`. Nothing else.**
 * No I/O, no `await`, no event, no push. It runs *inside* an open write
 * transaction, so anything slow in there holds SQLite's single writer
 * (§19) and anything that throws rolls the message insert back with it.
 * `ActivityLog.onEvent` defers its listeners to `setImmediate` precisely so
 * they never run inside an emitter's transaction; this callback runs inside
 * one deliberately, which is the opposite bargain and only pays for a
 * plain UPDATE.
 *
 * The event and the push stay outside the transaction, after the commit —
 * invariant #3's ordering is unchanged by this.
 */
export function appendChatMessage(
  deps: ChatDeps,
  input: AppendChatMessageInput,
  alsoCommit?: (message: ConversationMessage) => void,
): ConversationMessage {
  const payload = validatePayload(input.kind, input.payload ?? null);
  const write = deps.db.transaction(() => {
    const inserted = insertConversationMessage(deps.db, {
      conversation_id: input.conversationId,
      project_id: input.projectId ?? null,
      author: input.author,
      kind: input.kind,
      body: input.body,
      payload,
      checkpoint_id: input.checkpointId ?? null,
      status: 'complete',
    });
    alsoCommit?.(inserted);
    return inserted;
  });
  const message = write();
  logPersisted(deps, message);
  broadcast(deps, message);
  return message;
}

/**
 * A payload that does not match its kind is a programming error in the
 * producer, and it throws here rather than being stored — a card cannot
 * render what it cannot parse, and a row that reaches the renderer
 * unparseable becomes a rendering problem days later, at the point
 * furthest from the cause. The renderer's own parse is a `safeParse` for
 * exactly the opposite reason: by then, refusing is not an option.
 */
export function validatePayload(
  kind: ConversationMessageKind,
  payload: unknown,
): Record<string, unknown> | null {
  const parsed = parseChatPayload(kind, payload);
  if (!parsed.success) {
    throw new Error(
      `chat payload for kind '${kind}' is not valid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }
  return (parsed.data ?? null) as Record<string, unknown> | null;
}

/** §5.2 `chat.message_persisted` — one event per row, whatever wrote it. */
export function logPersisted(deps: ChatDeps, message: ConversationMessage): void {
  deps.activityLog.logEvent({
    actor: message.author === 'user' ? 'user' : 'system',
    type: 'chat.message_persisted',
    severity: 'info',
    project_id: message.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: message.checkpoint_id,
    payload: {
      messageId: message.id,
      conversationId: message.conversation_id,
      kind: message.kind,
      status: message.status,
    },
  });
}

export function broadcast(deps: ChatDeps, message: ConversationMessage): void {
  (deps.broadcaster ?? noopChatBroadcaster).messageChanged(message);
}
