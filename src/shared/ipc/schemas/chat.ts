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
  /**
   * §14.2's composer. The Director generating a *reply* is M11; persisting
   * what the user typed is not.
   *
   * `attachments` is §14.2's "file attach (path reference into the
   * conversation)" — absolute paths, **validated in the main process**
   * against the company home before anything is written
   * (`src/main/chat/attachments.ts`). A field on an existing method rather
   * than a new one: §17.1's namespace/method surface is fixed and
   * `check:ipc-surface` diffs it against the spec.
   *
   * `body` still has `.min(1)`: an attachment with nothing said is not a
   * message, and letting one through would put an empty bubble in the
   * transcript.
   */
  send: {
    input: z.object({
      conversationId: IdSchema,
      body: z.string().min(1),
      attachments: z.array(z.string().min(1)).max(10).default([]),
    }),
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
