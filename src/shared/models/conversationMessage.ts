import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';
import { ConversationMessageKindSchema, ConversationMessageStatusSchema, MessageAuthorSchema } from './enums';

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
export type NewConversationMessageInput = z.infer<typeof NewConversationMessageInputSchema>;
