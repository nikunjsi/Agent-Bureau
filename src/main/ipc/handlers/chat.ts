import {
  getConversationMessageById,
  markConversationMessageRead,
} from '../../db/repositories/conversationMessages';
import { getConversationById } from '../../db/repositories/conversations';
import { insertOutboxMessage } from '../../db/repositories/messages';
import { appendChatMessage, broadcast } from '../../chat/appendMessage';
import { describeRefusal, resolveAttachments } from '../../chat/attachments';
import { parseSlashCommand, runSlashCommand } from '../../chat/slashCommands';
import { nowIso } from '../../../shared/models/ids';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Chat as ChatSchemas, type ConversationListItem } from '../../../shared/ipc/schemas/chat';
import { getProjectById } from '../../db/repositories/projects';
import { type Handler, type HandlerContext } from './types';
import { UNREAD_FOR_USER_SQL } from '../../../shared/models/conversationMessage';

// Applying the same "pure read against an existing M1 repository, zero
// orchestration" rule used for projects/tasks/employees (see the M2 plan)
// to listMessages/listConversations too — Chat is §14.1's *default* tab,
// so it needs a real (likely empty) list to render its designed empty
// state rather than an error, the first thing any user sees.
/**
 * P-4 / chaos #12: one page, walking backwards from `beforeMessageId`.
 * Ordered by `(created_at, id)`, the same order the renderer's store sorts
 * by, so a cursor never skips or repeats a message that shares a millisecond
 * with another. A cursor that names no message in this conversation returns
 * an empty page rather than guessing.
 */
function listMessagePage(
  ctx: HandlerContext,
  conversationId: string,
  beforeMessageId: string | null,
  limit: number,
) {
  let bound = '';
  const params: unknown[] = [conversationId];
  if (beforeMessageId !== null) {
    const cursor = ctx.db
      .prepare(
        'SELECT created_at, id FROM conversation_messages WHERE id = ? AND conversation_id = ?',
      )
      .get(beforeMessageId, conversationId) as { created_at: string; id: string } | undefined;
    if (cursor === undefined) return { items: [], hasOlder: false, unreadOlderCount: 0 };
    bound = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
    params.push(cursor.created_at, cursor.created_at, cursor.id);
  }
  const rows = ctx.db
    .prepare(
      `SELECT id, created_at FROM conversation_messages WHERE conversation_id = ?${bound} ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as { id: string; created_at: string }[];
  const hasOlder = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const oldest = page[0];
  const unreadOlderCount =
    !hasOlder || oldest === undefined
      ? 0
      : (
          ctx.db
            .prepare(
              `SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND ${UNREAD_FOR_USER_SQL} AND (created_at < ? OR (created_at = ? AND id < ?))`,
            )
            .get(conversationId, oldest.created_at, oldest.created_at, oldest.id) as { n: number }
        ).n;
  const items = page
    .map((row) => getConversationMessageById(ctx.db, row.id))
    .filter((m) => m !== null);
  return { items, hasOlder, unreadOlderCount };
}

/**
 * The Director's A.3 states in which the user is the one being waited on:
 * an approval, a phase review, or an answer to an escalation.
 */
const WAITING_ON_USER_STATES = new Set([
  'AWAITING_BRIEF_APPROVAL',
  'AWAITING_PLAN_APPROVAL',
  'PHASE_REVIEW',
  'ESCALATING',
]);

/**
 * M11 S2-1c: the switcher's list. The company conversation first (§5.1's one
 * company-level conversation), then projects' in the order they began —
 * stable, so an entry does not jump when someone speaks in it.
 */
function listAllConversations(ctx: HandlerContext, projectId: string | null) {
  const rows = (
    projectId === null
      ? ctx.db
          .prepare(
            'SELECT id FROM conversations ORDER BY (project_id IS NOT NULL), created_at, rowid',
          )
          .all()
      : ctx.db
          .prepare('SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at, rowid')
          .all(projectId)
  ) as { id: string }[];
  const unread = ctx.db.prepare(
    `SELECT COUNT(*) AS n FROM conversation_messages WHERE conversation_id = ? AND ${UNREAD_FOR_USER_SQL}`,
  );
  const lastMessage = ctx.db.prepare(
    'SELECT MAX(created_at) AS last FROM conversation_messages WHERE conversation_id = ?',
  );
  const pendingCheckpoints = ctx.db.prepare(
    "SELECT COUNT(*) AS n FROM checkpoints WHERE project_id = ? AND status = 'pending'",
  );
  const items: ConversationListItem[] = [];
  for (const row of rows) {
    const conversation = getConversationById(ctx.db, row.id);
    if (conversation === null) continue;
    const project =
      conversation.project_id === null ? null : getProjectById(ctx.db, conversation.project_id);
    const waitingOnCheckpoint =
      project !== null && (pendingCheckpoints.get(project.id) as { n: number }).n > 0;
    items.push({
      ...conversation,
      project:
        project === null
          ? null
          : {
              id: project.id,
              displayKey: project.display_key,
              name: project.name,
              stage: project.stage,
            },
      unreadCount: (unread.get(conversation.id) as { n: number }).n,
      waiting:
        waitingOnCheckpoint || WAITING_ON_USER_STATES.has(conversation.director_state ?? 'IDLE'),
      lastMessageAt: (lastMessage.get(conversation.id) as { last: string | null }).last,
    });
  }
  return items;
}

function chatDeps(ctx: HandlerContext) {
  return {
    db: ctx.db,
    activityLog: ctx.activityLog,
    ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
  };
}

/**
 * §14.2's composer, main-process half. This is the first thing in Bureau
 * that a *person* can cause to happen — §1 invariant 1's "the conversation
 * is the product", from the user's end.
 *
 * ## The order, and why it is this one (invariant #3)
 *
 * 1. The conversation is resolved. A send into one that does not exist is
 *    `NOT_FOUND`, not a row in nowhere.
 * 2. Attachments are resolved and confined. **A refusal writes nothing at
 *    all** — no message, no outbox row. Fail closed (#6): a half-sent
 *    message with the attachment silently dropped is worse than a refusal,
 *    because the user would believe the Director had the file.
 * 3. Slash commands are parsed **before** anything is addressed to the
 *    Director (§17.2). A command never becomes an outbox row, which is the
 *    whole point: it works when the Director cannot.
 * 4. Otherwise: the user's message is committed and emits
 *    `chat.message_persisted`, and only then is the outbox row written and
 *    `message.sent` emitted. Two state changes, two events.
 *
 * ## `user.message_sent` is deliberately not emitted
 *
 * §5.2 lists it, and `chat.message_persisted` with `actor: 'user'` already
 * carries everything it would. Emitting both would give one state change
 * two events, which invariant #3 forbids — the identical call
 * `answerCheckpoint.ts` made about `user.checkpoint_answered`, and made
 * for the same reason. Flagged in PROGRESS.md rather than silently decided.
 *
 * ## Sending while the Director is mid-generation
 *
 * CLAUDE.md: *do not inject a message into an agent mid-generation; wait
 * for `idle`.* Nothing here needs to check that, and that is not luck —
 * this writes a durable outbox row and M8's router is the only thing that
 * delivers it, and it holds (`target_mid_turn`) until the Director is
 * genuinely idle. Correct by construction, said here so it is not
 * rediscovered as a gap.
 */
const send: Handler = async (input, ctx) => {
  const { conversationId, body, attachments } = ChatSchemas.send.input.parse(input);

  const conversation = getConversationById(ctx.db, conversationId);
  if (conversation === null) {
    return ipcError('NOT_FOUND', `No conversation with id "${conversationId}".`, { type: 'retry' });
  }

  const resolved = resolveAttachments(ctx.db, attachments);
  if (!resolved.ok) {
    // §14.6: plain language, and the refusal is total.
    return ipcError('VALIDATION_FAILED', describeRefusal(resolved.refusal));
  }

  const command = parseSlashCommand(body);
  if (command !== null) {
    if (resolved.paths.length > 0) {
      return ipcError(
        'VALIDATION_FAILED',
        'A command cannot carry an attachment. Send the file on its own, or remove the command.',
      );
    }
    const outcome = await runSlashCommand(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.supervisorRegistry ? { supervisorRegistry: ctx.supervisorRegistry } : {}),
      },
      command,
    );
    // One `system` message, per §17.2. Nothing is addressed to the
    // Director: a command that reached it would be a command that stops
    // working exactly when it is needed.
    const echoed = appendChatMessage(chatDeps(ctx), {
      conversationId,
      projectId: conversation.project_id,
      author: 'system',
      kind: 'text',
      body: outcome.body,
    });
    return ipcOk(ChatSchemas.send.output.parse({ item: echoed }));
  }

  const message = appendChatMessage(chatDeps(ctx), {
    conversationId,
    projectId: conversation.project_id,
    author: 'user',
    kind: 'text',
    body,
    // Structured, never formatted into `body`: how an attached path reads
    // is the renderer's decision. See chatPayloads.ts, including the note
    // M11's prompt composer has to act on.
    payload: resolved.paths.length === 0 ? null : { attachments: resolved.paths },
  });

  // The second state change, after the first has committed and emitted.
  // `insertOutboxMessage` + `message.sent` is the same pair
  // `bureau_ask_director` writes — one outbox, one door.
  const outbox = insertOutboxMessage(ctx.db, {
    idempotency_key: `chat:${message.id}`,
    from_addr: 'user',
    to_addr: 'director',
    kind: 'question',
    subject: body.slice(0, 120),
    body,
    // M11 S2-1a: the conversation this was said in, so the Director's turn
    // for it runs, and answers, there (`conversationOfOutboxMessage`).
    thread_id: conversationId,
  });
  ctx.activityLog.logEvent({
    actor: 'user',
    type: 'message.sent',
    severity: 'info',
    project_id: conversation.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      messageId: outbox.id,
      to: 'director',
      kind: 'question',
      conversationMessageId: message.id,
    },
  });

  return ipcOk(ChatSchemas.send.output.parse({ item: message }));
};

/**
 * §28 M9 item 7's unread badges, durable half. `conversation_messages
 * .read_at` has existed since M1 and nothing has ever written it.
 *
 * ## No activity event, argued rather than assumed
 *
 * Invariant #3 gives every state change exactly one event, and this
 * deliberately emits none. `read_at` is the one column in the schema that
 * records something about the **viewer** rather than about the company's
 * work: nothing downstream reads it, there is no side effect to order
 * against, and §5.2's taxonomy — closed in M9 session 1 — has no type for
 * it. Adding one would put a row in the activity stream for every message
 * a person's eyes passed over, in the same stream §14.5 requires to stay
 * "genuinely readable".
 *
 * The push is not an event: other windows must stop showing the message as
 * unread, and they learn that the same way they learn everything else.
 */
const markRead: Handler = (input, ctx) => {
  const { conversationId, messageId } = ChatSchemas.markRead.input.parse(input);
  const message = getConversationMessageById(ctx.db, messageId);
  if (message === null || message.conversation_id !== conversationId) {
    return ipcError('NOT_FOUND', `No message with id "${messageId}" in that conversation.`, {
      type: 'retry',
    });
  }
  const updated = markConversationMessageRead(ctx.db, messageId, nowIso());
  // `null` means it was already read, or the user wrote it. Neither is a
  // failure and neither needs a push.
  if (updated !== null) broadcast(chatDeps(ctx), updated);
  return ipcOk(ChatSchemas.markRead.output.parse({ ok: true }));
};

export const chatHandlers: Record<string, Handler> = {
  listMessages: (input, ctx) => {
    const { conversationId, beforeMessageId, limit } = ChatSchemas.listMessages.input.parse(input);
    return ipcOk(listMessagePage(ctx, conversationId, beforeMessageId, limit));
  },
  listConversations: (input, ctx) => {
    const { projectId } = ChatSchemas.listConversations.input.parse(input);
    return ipcOk({ items: listAllConversations(ctx, projectId) });
  },
  /**
   * §28 M9 item 3. Stops whatever is streaming into this conversation.
   *
   * It needs no Director — it needs a stream, and `ChatStreamRegistry` is
   * what produces one. (These three were tagged `stub('M11')`, which was
   * wrong: M11 owns the *producer* of the Director's replies, not the
   * methods for reading and interrupting them.)
   *
   * `stopped` is reported honestly rather than a bare `ok`. Two windows can
   * both press stop; the second press stopped nothing, and saying so is the
   * same reasoning that gave `checkpoints.answerPermission` its
   * `holdReleased`.
   */
  stop: (input, ctx) => {
    const { conversationId } = ChatSchemas.stop.input.parse(input);
    if (ctx.chatStreams === undefined) {
      return ipcError(
        'INTERNAL_ERROR',
        'The chat stream registry is not running, so there is nothing to stop.',
      );
    }
    return ipcOk({ ok: true as const, stopped: ctx.chatStreams.stop(conversationId) });
  },
  send,
  markRead,
};
