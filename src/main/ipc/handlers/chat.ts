import { getConversationMessageById } from '../../db/repositories/conversationMessages';
import { getConversationById } from '../../db/repositories/conversations';
import { ipcOk } from '../../../shared/ipc/envelope';
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
  // Real send/stop/markRead need the Director (M11) actually generating
  // and streaming replies.
  send: stub('M11'),
  stop: stub('M11'),
  markRead: stub('M11'),
};
