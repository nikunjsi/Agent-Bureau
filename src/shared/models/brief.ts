import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { VersionedDocStatusSchema } from './enums';

// §8.3 owns the real brief content schema (M11); M1 only needs "JSON
// object" to model the column correctly.
const BriefContentSchema = z.record(z.unknown());

export const BriefSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  version: z.number().int(),
  content: jsonColumnSchema(BriefContentSchema),
  markdown: z.string(),
  status: VersionedDocStatusSchema,
  approved_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  // Not in §5.1's own listing; §5.0's blanket rule applies (status is
  // mutable: draft → awaiting_approval → approved/superseded).
  updated_at: IsoTimestampSchema,
});
export type Brief = z.infer<typeof BriefSchema>;

export const NewBriefInputSchema = z.object({
  project_id: IdSchema,
  version: z.number().int(),
  content: BriefContentSchema,
  markdown: z.string(),
  status: VersionedDocStatusSchema.default('draft'),
  approved_at: IsoTimestampSchema.nullable().default(null),
});
export type NewBriefInput = z.infer<typeof NewBriefInputSchema>;
