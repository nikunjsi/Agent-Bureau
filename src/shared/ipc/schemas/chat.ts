import { z } from 'zod';
import { ConversationSchema } from '../../models/conversation';
import { ConversationMessageSchema } from '../../models/conversationMessage';
import { IdSchema } from '../../models/ids';
import { OkOutputSchema, listOutputSchema } from './common';

export const Chat = {
  listMessages: { input: z.object({ conversationId: IdSchema }), output: listOutputSchema(ConversationMessageSchema) },
  /** Stubbed until M11 (Director core); the router still validates and
   * shapes the response correctly so M11 doesn't need to touch this file. */
  send: {
    input: z.object({ conversationId: IdSchema, body: z.string().min(1) }),
    output: z.object({ item: ConversationMessageSchema }),
  },
  stop: { input: z.object({ conversationId: IdSchema }), output: OkOutputSchema },
  markRead: { input: z.object({ conversationId: IdSchema, messageId: IdSchema }), output: OkOutputSchema },
  listConversations: {
    input: z.object({ projectId: IdSchema.nullable().default(null) }),
    output: listOutputSchema(ConversationSchema),
  },
};
