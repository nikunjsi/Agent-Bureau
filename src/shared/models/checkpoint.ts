import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';
import { CheckpointStatusSchema, CheckpointTypeSchema, CheckpointUrgencySchema } from './enums';

const CheckpointOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().optional(),
  consequence: z.string(),
  recommended: z.boolean().optional(),
});
const CheckpointOptionsSchema = z.array(CheckpointOptionSchema);

/** Diff, file list, command, or document excerpt — shape varies; owned by
 * M8/M9. M1 only needs "JSON". */
const CheckpointPreviewSchema = z.unknown();

const CheckpointAnswerSchema = z.object({
  optionId: z.string().optional(),
  freeText: z.string().optional(),
});

export const CheckpointSchema = z
  .object({
    id: IdSchema,
    project_id: IdSchema.nullable(),
    task_id: IdSchema.nullable(),
    employee_id: IdSchema.nullable(),
    type: CheckpointTypeSchema,
    urgency: CheckpointUrgencySchema,
    tool_call_id: z.string().nullable(),
    tool_name: z.string().nullable(),
    args_preview: z.string().nullable(),
    title: z.string().min(1),
    context: z.string().min(1),
    options: nullableJsonColumnSchema(CheckpointOptionsSchema),
    preview: nullableJsonColumnSchema(CheckpointPreviewSchema),
    default_action: z.string().nullable(),
    status: CheckpointStatusSchema,
    answer: nullableJsonColumnSchema(CheckpointAnswerSchema),
    answered_by: z.string().nullable(),
    expires_at: IsoTimestampSchema.nullable(),
    answered_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
    // Not in §5.1's own listing; §5.0's blanket rule applies (status is
    // mutable).
    updated_at: IsoTimestampSchema,
  })
  // §5.1's own CHECK: a checkpoint whose every option is irreversible has
  // no safe default, so it simply never expires — a non-null expires_at
  // with a null default_action is invalid.
  .refine((row) => row.default_action !== null || row.expires_at === null, {
    message: 'default_action must be set whenever expires_at is set',
    path: ['default_action'],
  });
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const NewCheckpointInputSchema = z
  .object({
    project_id: IdSchema.nullable().default(null),
    task_id: IdSchema.nullable().default(null),
    employee_id: IdSchema.nullable().default(null),
    type: CheckpointTypeSchema,
    urgency: CheckpointUrgencySchema,
    tool_call_id: z.string().nullable().default(null),
    tool_name: z.string().nullable().default(null),
    args_preview: z.string().nullable().default(null),
    title: z.string().min(1),
    context: z.string().min(1),
    options: CheckpointOptionsSchema.nullable().default(null),
    preview: CheckpointPreviewSchema.nullable().default(null),
    default_action: z.string().nullable().default(null),
    status: CheckpointStatusSchema.default('pending'),
    expires_at: IsoTimestampSchema.nullable().default(null),
  })
  .refine((row) => row.default_action !== null || row.expires_at === null, {
    message: 'default_action must be set whenever expires_at is set',
    path: ['default_action'],
  });
export type NewCheckpointInput = z.infer<typeof NewCheckpointInputSchema>;
