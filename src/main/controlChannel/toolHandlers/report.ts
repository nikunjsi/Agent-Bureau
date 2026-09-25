import { appendChatMessage } from '../../chat/appendMessage';
import { resolveConversationForDelivery } from '../../db/repositories/conversations';
import { ReportPayloadSchema, SummaryPayloadSchema } from '../../../shared/models/chatPayloads';
import { ReportArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_report`: *"{ kind: 'report'|'summary', body, payload? } —
 * posts a chat message."* A Director tool (M11 row S1-12a).
 *
 * This is how the Director says something structured — a progress report,
 * a phase summary — as distinct from its own prose, which streams into the
 * conversation as it is generated (row S1-13). Both end up as messages the
 * user reads; only this one has a card behind it.
 *
 * The payload is validated against the same schema the renderer's card
 * reads, so a malformed report is refused at the tool with something the
 * agent can act on, rather than stored and rendered as a blank card.
 */

export const handleReport: ToolHandler = (ctx, rawArgs) => {
  const parsed = ReportArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_report: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    };
  }

  // The card the renderer draws is validated here, where the kind is known.
  const cardSchema = parsed.data.kind === 'report' ? ReportPayloadSchema : SummaryPayloadSchema;
  const card = cardSchema.safeParse(parsed.data.payload);
  if (!card.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_report: the ${parsed.data.kind} payload is not usable: ${card.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  // The Director posts into the conversation it is having. Before intake
  // creates one there is nowhere to post, and saying so is better than
  // inventing a conversation the user never opened.
  const conversation = resolveConversationForDelivery(ctx.db, null);
  if (!conversation) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'bureau_report: there is no conversation to post into yet.',
    };
  }

  // Pushed to the open window as it is written (M11 S2-0): a card the user
  // only sees after a re-hydrate is a card the conversation waits on.
  const message = appendChatMessage(
    {
      db: ctx.db,
      activityLog: ctx.activityLog,
      ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
    },
    {
      conversationId: conversation.id,
      ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
      author: 'director',
      kind: parsed.data.kind,
      body: parsed.data.body,
      payload: card.data,
    },
  );

  return { ok: true, data: { messageId: message.id } };
};
