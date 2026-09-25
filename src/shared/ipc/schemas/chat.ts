import { z } from 'zod';
import { ConversationSchema } from '../../models/conversation';
import { CHAT_PAGE_SIZE, ConversationMessageSchema } from '../../models/conversationMessage';
import { IdSchema, IsoTimestampSchema } from '../../models/ids';
import { ProjectStageSchema } from '../../models/enums';
import { OkOutputSchema, listOutputSchema } from './common';

/**
 * M11 S2-1c: one entry in the conversation switcher. The conversation row,
 * plus what the list shows beside it — decided in the Core, never derived in
 * the renderer (invariant #11):
 *
 * - `project`: the project it is about, with its §8 stage; `null` for the
 *   company conversation.
 * - `unreadCount`: messages the user has not seen (`UNREAD_FOR_USER_SQL`).
 * - `waiting`: the user is being waited on here — a pending checkpoint on
 *   the project, or the Director waiting for an approval or an answer.
 * - `lastMessageAt`: when anything was last said, `null` if nothing was.
 */
export const ConversationListItemSchema = ConversationSchema.extend({
  project: z
    .object({
      id: IdSchema,
      displayKey: z.string(),
      name: z.string(),
      stage: ProjectStageSchema,
    })
    .nullable(),
  unreadCount: z.number().int().min(0),
  waiting: z.boolean(),
  lastMessageAt: IsoTimestampSchema.nullable(),
});
export type ConversationListItem = z.infer<typeof ConversationListItemSchema>;

export const Chat = {
  /**
   * P-4 / chaos #12: paginated. Returns the page of messages just before
   * `beforeMessageId` (the newest page when null), oldest first. `hasOlder`
   * says whether an earlier page exists; `unreadOlderCount` counts the unread
   * messages older than this page, which the unread badge cannot see.
   */
  listMessages: {
    input: z.object({
      conversationId: IdSchema,
      beforeMessageId: IdSchema.nullable().default(null),
      limit: z.number().int().min(1).max(500).default(CHAT_PAGE_SIZE),
    }),
    output: z.object({
      items: z.array(ConversationMessageSchema),
      hasOlder: z.boolean(),
      unreadOlderCount: z.number().int().min(0),
    }),
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
  /** M11 S2-1c: the company conversation first, then projects' in the
   *  order they began, each with its markers. */
  listConversations: {
    input: z.object({ projectId: IdSchema.nullable().default(null) }),
    output: listOutputSchema(ConversationListItemSchema),
  },
};
