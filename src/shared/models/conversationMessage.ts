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
 * **The badge's count assumes `chat.listMessages` returns the whole
 * conversation, which it does today** (no `LIMIT`, no cursor). If it ever
 * paginates, a count taken from the loaded page silently undercounts and
 * the Core must compute it instead.
 */
export function isUnreadForUser(message: ConversationMessage): boolean {
  return message.read_at === null && message.author !== 'user';
}

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
