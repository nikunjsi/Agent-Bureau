import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { DeliverableStatusSchema, DeliverableTypeSchema } from './enums';

export const DeliverableSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  phase_id: IdSchema.nullable(),
  type: DeliverableTypeSchema,
  title: z.string().min(1),
  path: z.string().nullable(),
  summary: z.string().min(1),
  status: DeliverableStatusSchema,
  version: z.number().int(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Deliverable = z.infer<typeof DeliverableSchema>;

export const NewDeliverableInputSchema = z.object({
  project_id: IdSchema,
  phase_id: IdSchema.nullable().default(null),
  type: DeliverableTypeSchema,
  title: z.string().min(1),
  path: z.string().nullable().default(null),
  summary: z.string().min(1),
  status: DeliverableStatusSchema.default('draft'),
  version: z.number().int().default(1),
});
export type NewDeliverableInput = z.infer<typeof NewDeliverableInputSchema>;
