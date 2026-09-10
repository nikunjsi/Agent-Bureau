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
import { Chat as ChatSchemas } from '../../../shared/ipc/schemas/chat';
import { type Handler, type HandlerContext } from './types';

// Applying the same "pure read against an existing M1 repository, zero
// orchestration" rule used for projects/tasks/employees (see the M2 plan)
// to listMessages/listConversations too — Chat is §14.1's *default* tab,
// so it needs a real (likely empty) list to render its designed empty
// state rather than an error, the first thing any user sees.
function listMessagesForConversation(ctx: HandlerContext, conversationId: string) {
  const rows = ctx.db
    .prepare('SELECT id FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at')
    .all(conversationId) as { id: string }[];
  return rows.map((row) => getConversationMessageById(ctx.db, row.id)).filter((m) => m !== null);
}

function listAllConversations(ctx: HandlerContext, projectId: string | null) {
  const rows = (
    projectId === null
      ? ctx.db.prepare('SELECT id FROM conversations ORDER BY created_at').all()
      : ctx.db
          .prepare('SELECT id FROM conversations WHERE project_id = ? ORDER BY created_at')
          .all(projectId)
  ) as { id: string }[];
  return rows.map((row) => getConversationById(ctx.db, row.id)).filter((c) => c !== null);
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
    const { conversationId } = ChatSchemas.listMessages.input.parse(input);
    return ipcOk({ items: listMessagesForConversation(ctx, conversationId) });
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
