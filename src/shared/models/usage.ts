import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { UsageSourceSchema } from './enums';

export const UsageSchema = z.object({
  id: IdSchema,
  employee_id: IdSchema.nullable(),
  task_id: IdSchema.nullable(),
  engine: z.string().min(1),
  model: z.string().nullable(),
  tokens_in: z.number().int().nullable(),
  tokens_out: z.number().int().nullable(),
  tokens_cache_read: z.number().int().nullable(),
  tokens_cache_write: z.number().int().nullable(),
  // Nullable, not defaulted to 0 — §21: "do not show $0.00 for an engine
  // that does not report usage. Show 'cost not reported'." A real NULL is
  // what makes that distinction representable.
  cost_usd_micros: z.number().int().nullable(),
  turn_index: z.number().int().nullable(),
  source: UsageSourceSchema,
  ts: IsoTimestampSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

export const NewUsageInputSchema = z.object({
  employee_id: IdSchema.nullable().default(null),
  task_id: IdSchema.nullable().default(null),
  engine: z.string().min(1),
  model: z.string().nullable().default(null),
  tokens_in: z.number().int().nullable().default(null),
  tokens_out: z.number().int().nullable().default(null),
  tokens_cache_read: z.number().int().nullable().default(null),
  tokens_cache_write: z.number().int().nullable().default(null),
  cost_usd_micros: z.number().int().nullable().default(null),
  turn_index: z.number().int().nullable().default(null),
  source: UsageSourceSchema.default('turn'),
});
export type NewUsageInput = z.infer<typeof NewUsageInputSchema>;
