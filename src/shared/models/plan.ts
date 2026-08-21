import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { VersionedDocStatusSchema } from './enums';
import { UsdMicrosSchema } from './money';

// Owned by M11 ("phases, tasks, deps, assignments, estimates"); M1 only
// needs "JSON object" to model the column correctly.
const PlanContentSchema = z.record(z.unknown());

export const PlanSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  brief_id: IdSchema,
  version: z.number().int(),
  content: jsonColumnSchema(PlanContentSchema),
  estimated_cost_usd_micros: UsdMicrosSchema.nullable(),
  status: VersionedDocStatusSchema,
  approved_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  // Not in §5.1's own listing; §5.0's blanket rule applies (status is
  // mutable).
  updated_at: IsoTimestampSchema,
});
export type Plan = z.infer<typeof PlanSchema>;

export const NewPlanInputSchema = z.object({
  project_id: IdSchema,
  brief_id: IdSchema,
  version: z.number().int(),
  content: PlanContentSchema,
  estimated_cost_usd_micros: UsdMicrosSchema.nullable().default(null),
  status: VersionedDocStatusSchema.default('draft'),
  approved_at: IsoTimestampSchema.nullable().default(null),
});
export type NewPlanInput = z.infer<typeof NewPlanInputSchema>;
