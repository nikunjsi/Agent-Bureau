import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';
import { ConversationStatusSchema } from './enums';

/** Appendix A.3 state machine (M11); M1 only needs "some string state". */
const DirectorStateSchema = z.string();

/** Pending intake answers, in-progress draft ids, the §26.1 coalescing
 * queue — owned by M11/M8; M1 only needs "JSON object". */
const DirectorStateDataSchema = z.record(z.unknown());

export const ConversationSchema = z.object({
  id: IdSchema,
  company_id: IdSchema,
  project_id: IdSchema.nullable(),
  title: z.string().min(1),
  director_session_id: z.string().nullable(),
  summary: z.string().nullable(),
  director_state: DirectorStateSchema.nullable(),
  director_state_data: nullableJsonColumnSchema(DirectorStateDataSchema),
  status: ConversationStatusSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const NewConversationInputSchema = z.object({
  company_id: IdSchema,
  project_id: IdSchema.nullable().default(null),
  title: z.string().min(1),
  director_session_id: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  director_state: DirectorStateSchema.nullable().default(null),
  director_state_data: DirectorStateDataSchema.nullable().default(null),
  status: ConversationStatusSchema.default('active'),
});
export type NewConversationInput = z.infer<typeof NewConversationInputSchema>;
