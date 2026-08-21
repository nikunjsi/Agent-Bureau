import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';

// §5.2's dotted taxonomy (e.g. "task.completed") — validated against the
// full enumerated list by whichever subsystem emits it (M6+), not by the
// generic row schema here.
const EventTypeSchema = z.string().min(1);
// §5.1 never gives a closed list of severities (and §10.3.1 uses at least
// one value, "security", not covered by the usual debug/info/warn/error
// guess) — kept open rather than inventing a wrong enum.
const SeveritySchema = z.string().min(1);
const EventPayloadSchema = z.record(z.unknown());

export const EventSchema = z.object({
  seq: z.number().int(),
  id: IdSchema,
  // The event's own original time, from the activity.jsonl entry —
  // immutable even if this mirror row is inserted later during
  // reconcile()'s repair (§11.6, finding #3).
  ts: IsoTimestampSchema,
  actor: z.string().min(1),
  type: EventTypeSchema,
  severity: SeveritySchema,
  project_id: IdSchema.nullable(),
  task_id: IdSchema.nullable(),
  employee_id: IdSchema.nullable(),
  checkpoint_id: IdSchema.nullable(),
  payload: nullableJsonColumnSchema(EventPayloadSchema),
  // When this mirror row was inserted — may be later than `ts` if
  // reconcile() repaired a gap after a crash.
  created_at: IsoTimestampSchema,
});
export type Event = z.infer<typeof EventSchema>;

/** The shape of one line in `activity.jsonl` — the authoritative record
 * (§11.6). Deliberately not `seq`-keyed the same way as the mirror row
 * type, since the file is the source of truth `seq` is assigned from. */
export const ActivityLogEntrySchema = z.object({
  seq: z.number().int(),
  id: IdSchema,
  ts: IsoTimestampSchema,
  actor: z.string().min(1),
  type: EventTypeSchema,
  severity: SeveritySchema,
  project_id: z.string().nullable().default(null),
  task_id: z.string().nullable().default(null),
  employee_id: z.string().nullable().default(null),
  checkpoint_id: z.string().nullable().default(null),
  payload: z.record(z.unknown()).nullable().default(null),
});
export type ActivityLogEntry = z.infer<typeof ActivityLogEntrySchema>;

export const NewEventInputSchema = z.object({
  actor: z.string().min(1),
  type: EventTypeSchema,
  severity: SeveritySchema.default('info'),
  project_id: IdSchema.nullable().default(null),
  task_id: IdSchema.nullable().default(null),
  employee_id: IdSchema.nullable().default(null),
  checkpoint_id: IdSchema.nullable().default(null),
  payload: EventPayloadSchema.nullable().default(null),
});
export type NewEventInput = z.infer<typeof NewEventInputSchema>;
