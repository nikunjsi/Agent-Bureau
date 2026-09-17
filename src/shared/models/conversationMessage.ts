import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';
import {
  ConversationMessageKindSchema,
  ConversationMessageStatusSchema,
  MessageAuthorSchema,
} from './enums';

/** Structured content for non-text kinds (options, diffs, brief id) — shape
 * varies by `kind`; owned by M9's chat UI. M1 only needs "JSON". */
const ConversationMessagePayloadSchema = z.record(z.unknown());

export const ConversationMessageSchema = z.object({
  id: IdSchema,
  conversation_id: IdSchema,
  project_id: IdSchema.nullable(),
  author: MessageAuthorSchema,
  kind: ConversationMessageKindSchema,
  body: z.string(),
  payload: nullableJsonColumnSchema(ConversationMessagePayloadSchema),
  checkpoint_id: IdSchema.nullable(),
  status: ConversationMessageStatusSchema,
  seq: z.number().int().nullable(),
  read_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/**
 * **The one definition of "unread"** (standing rule 6). §14 never states
 * one, so it is stated here: a message is unread when nothing has stamped
 * `read_at` and the user did not write it. Your own message is not
 * something you can have failed to read.
 *
 * Two callers, deliberately: `chat.markRead` uses it to refuse marking a
 * row that is not the user's to mark, and the renderer's Chat badge counts
 * with it. The alternative — the Core pushing a computed integer — would
 * be a second source for one number that the messages already on screen
 * could contradict, which is rule 6 pointing the other way.
 *
 * **Pagination (pre-M11 P-4).** `chat.listMessages` now returns a page, so
 * the badge cannot count from what is loaded alone. The Core counts the unread
 * messages OLDER than the page with `UNREAD_FOR_USER_SQL`, the same rule
 * written as SQL beside this function, and the badge adds that to this
 * predicate over the loaded messages. The two spellings are tested against
 * each other on 10,000 real rows (`chatTenThousandMessages.test.ts`).
 */
export function isUnreadForUser(message: ConversationMessage): boolean {
  return message.read_at === null && message.author !== 'user';
}

/** `isUnreadForUser` as a SQL condition over `conversation_messages`. Change
 *  both together. */
export const UNREAD_FOR_USER_SQL = "read_at IS NULL AND author != 'user'";

/**
 * P-4 / chaos #12: how many messages `chat.listMessages` returns per page.
 * Measured at 10,000 messages before paging: about 1.1 s of blocked main
 * process and a 4.5 MB response per load, then 8 s before the newest message
 * appeared in the packaged app, with the window unresponsive throughout.
 */
export const CHAT_PAGE_SIZE = 200;

export const NewConversationMessageInputSchema = z.object({
  conversation_id: IdSchema,
  project_id: IdSchema.nullable().default(null),
  author: MessageAuthorSchema,
  kind: ConversationMessageKindSchema,
  body: z.string(),
  payload: ConversationMessagePayloadSchema.nullable().default(null),
  checkpoint_id: IdSchema.nullable().default(null),
  status: ConversationMessageStatusSchema.default('complete'),
  seq: z.number().int().nullable().default(null),
  read_at: IsoTimestampSchema.nullable().default(null),
});
export type NewConversationMessageInput = z.input<typeof NewConversationMessageInputSchema>;
