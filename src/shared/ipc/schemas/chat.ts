import { z } from 'zod';
import { ConversationSchema } from '../../models/conversation';
import { ConversationMessageSchema } from '../../models/conversationMessage';
import { IdSchema } from '../../models/ids';
import { OkOutputSchema, listOutputSchema } from './common';

export const Chat = {
  listMessages: {
    input: z.object({ conversationId: IdSchema }),
    output: listOutputSchema(ConversationMessageSchema),
  },
  /** Stubbed until M9 session 2 (the composer). The Director generating a
   * *reply* is M11; persisting what the user typed is not. */
  send: {
    input: z.object({ conversationId: IdSchema, body: z.string().min(1) }),
    output: z.object({ item: ConversationMessageSchema }),
  },
  /** `stopped: false` is a real outcome, not a failure: the stream had
   * already ended, or a second window got there first. A bare `ok` would
   * make "I interrupted the reply" and "there was nothing to interrupt"
   * indistinguishable to a user who is about to wonder why it kept
   * talking. */
  stop: {
    input: z.object({ conversationId: IdSchema }),
    output: z.object({ ok: z.literal(true), stopped: z.boolean() }),
  },
  markRead: {
    input: z.object({ conversationId: IdSchema, messageId: IdSchema }),
    output: OkOutputSchema,
  },
  listConversations: {
    input: z.object({ projectId: IdSchema.nullable().default(null) }),
    output: listOutputSchema(ConversationSchema),
  },
};
