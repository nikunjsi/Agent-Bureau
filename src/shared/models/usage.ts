import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { UsageSourceSchema } from './enums';

export const UsageSchema = z.object({
  id: IdSchema,
  employee_id: IdSchema.nullable(),
  task_id: IdSchema.nullable(),
  // M6 session 2 (migration 0005) — explicit, not re-derived through
  // task_id's own project_id: the write path can attribute spend to a
  // project even with no task_id (the Director has no task in the
  // traditional sense), which a join through tasks alone could never see
  // — found while designing reconcile.ts's own counter-drift check.
  project_id: IdSchema.nullable(),
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
  // M6 session 2 (migration 0005) — Bureau's own pricing.yaml-derived
  // estimate, populated whenever a rate exists, independently of whether
  // `cost_usd_micros` (the authoritative figure — engine-reported when
  // present, else this same computed value) came from the engine or from
  // this computation. Never discarded when the engine's own figure wins;
  // see the migration's own comment.
  computed_cost_usd_micros: z.number().int().nullable(),
  turn_index: z.number().int().nullable(),
  source: UsageSourceSchema,
  ts: IsoTimestampSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

// project_id is deliberately absent here — never set via the input, only
// via insertUsage()'s own separate `attribution` parameter (same
// convention as lease_holder/pending_commit_task_id/
// autonomous_confirmed_at: a real column, set only by the one function
// responsible for it, not a free-form input field).
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
  computed_cost_usd_micros: z.number().int().nullable().default(null),
  turn_index: z.number().int().nullable().default(null),
  source: UsageSourceSchema.default('turn'),
});
export type NewUsageInput = z.input<typeof NewUsageInputSchema>;
