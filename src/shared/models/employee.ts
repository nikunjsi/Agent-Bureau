import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { AutonomySchema, EmployeeStatusSchema, EngineModeSchema } from './enums';
import { UsdMicrosSchema } from './money';

export const EmployeeSchema = z.object({
  id: IdSchema,
  name: z.string().min(1),
  // Stores "pack:key" (roles.full_key), not the bare roles.key — see role.ts.
  role_key: z.string().min(1),
  is_director: z.coerce.boolean(),
  desk_x: z.number().int(),
  desk_y: z.number().int(),
  sprite_variant: z.string().min(1),
  status: EmployeeStatusSchema,
  status_detail: z.string().nullable(),
  engine: z.string().min(1),
  engine_mode: EngineModeSchema.nullable(),
  engine_version: z.string().nullable(),
  model: z.string().nullable(),
  session_id: z.string().nullable(),
  pid: z.number().int().nullable(),
  process_start_time: IsoTimestampSchema.nullable(),
  worktree_id: IdSchema.nullable(),
  current_task_id: IdSchema.nullable(),
  autonomy: AutonomySchema,
  daily_budget_usd_micros: UsdMicrosSchema.nullable(),
  resume_at: IsoTimestampSchema.nullable(),
  heartbeat_at: IsoTimestampSchema.nullable(),
  consecutive_failures: z.number().int(),
  lifetime_spend_usd_micros: UsdMicrosSchema,
  hired_at: IsoTimestampSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Employee = z.infer<typeof EmployeeSchema>;

export const NewEmployeeInputSchema = z.object({
  name: z.string().min(1),
  role_key: z.string().min(1),
  is_director: z.boolean().default(false),
  desk_x: z.number().int(),
  desk_y: z.number().int(),
  sprite_variant: z.string().min(1),
  status: EmployeeStatusSchema.default('off'),
  status_detail: z.string().nullable().default(null),
  engine: z.string().min(1),
  engine_mode: EngineModeSchema.nullable().default(null),
  engine_version: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  session_id: z.string().nullable().default(null),
  pid: z.number().int().nullable().default(null),
  process_start_time: IsoTimestampSchema.nullable().default(null),
  worktree_id: IdSchema.nullable().default(null),
  current_task_id: IdSchema.nullable().default(null),
  autonomy: AutonomySchema,
  daily_budget_usd_micros: UsdMicrosSchema.nullable().default(null),
  resume_at: IsoTimestampSchema.nullable().default(null),
  heartbeat_at: IsoTimestampSchema.nullable().default(null),
  consecutive_failures: z.number().int().default(0),
  lifetime_spend_usd_micros: UsdMicrosSchema.default(0),
});
export type NewEmployeeInput = z.infer<typeof NewEmployeeInputSchema>;
