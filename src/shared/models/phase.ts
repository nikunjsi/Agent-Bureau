import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { PhaseStatusSchema } from './enums';

export const PhaseSchema = z.object({
  id: IdSchema,
  plan_id: IdSchema,
  ordinal: z.number().int(),
  name: z.string().min(1),
  goal: z.string().min(1),
  review_required: z.coerce.boolean(),
  status: PhaseStatusSchema,
  // Not in §5.1's own listing; §5.0's blanket rule applies (status is
  // mutable).
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Phase = z.infer<typeof PhaseSchema>;

export const NewPhaseInputSchema = z.object({
  plan_id: IdSchema,
  ordinal: z.number().int(),
  name: z.string().min(1),
  goal: z.string().min(1),
  review_required: z.boolean().default(true),
  status: PhaseStatusSchema.default('pending'),
});
export type NewPhaseInput = z.infer<typeof NewPhaseInputSchema>;
