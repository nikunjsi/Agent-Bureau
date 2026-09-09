import { getConversationMessageById } from '../../db/repositories/conversationMessages';
import { getConversationById } from '../../db/repositories/conversations';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Chat as ChatSchemas } from '../../../shared/ipc/schemas/chat';
import { stub, type Handler, type HandlerContext } from './types';

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
  // M9 session 2, not M11 (see `stop` above for why the M11 tags were
  // wrong). `send` persists the user's message and addresses an outbox row
  // to `director`, which the M8 router already holds until a Director
  // exists; `markRead` is a `read_at` write behind item 7's unread badges.
  // Neither needs the Director to be built, and neither is built yet.
  send: stub('M9'),
  markRead: stub('M9'),
};
