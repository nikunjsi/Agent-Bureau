import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { OutboxMessageKindSchema, OutboxMessageStatusSchema } from './enums';

export const OutboxMessageSchema = z.object({
  id: IdSchema,
  idempotency_key: z.string().min(1),
  from_addr: z.string().min(1),
  to_addr: z.string().min(1),
  resolved_employee_id: IdSchema.nullable(),
  task_id: IdSchema.nullable(),
  thread_id: z.string().nullable(),
  kind: OutboxMessageKindSchema,
  priority: z.number().int(),
  subject: z.string().nullable(),
  body: z.string().nullable(),
  status: OutboxMessageStatusSchema,
  attempts: z.number().int(),
  next_attempt_at: IsoTimestampSchema.nullable(),
  delivered_at: IsoTimestampSchema.nullable(),
  consumed_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  // Not in §5.1's own listing; §5.0's blanket rule applies (status/attempts
  // are mutable).
  updated_at: IsoTimestampSchema,
});
export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;

export const NewOutboxMessageInputSchema = z.object({
  idempotency_key: z.string().min(1),
  from_addr: z.string().min(1),
  to_addr: z.string().min(1),
  resolved_employee_id: IdSchema.nullable().default(null),
  task_id: IdSchema.nullable().default(null),
  thread_id: z.string().nullable().default(null),
  kind: OutboxMessageKindSchema,
  priority: z.number().int().default(50),
  subject: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  status: OutboxMessageStatusSchema.default('pending'),
  next_attempt_at: IsoTimestampSchema.nullable().default(null),
});
export type NewOutboxMessageInput = z.infer<typeof NewOutboxMessageInputSchema>;
