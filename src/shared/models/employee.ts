import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { AutonomySchema, EmployeeStatusSchema, EngineModeSchema, ModelTierSchema } from './enums';
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
  /**
   * A **record**, not an input (migration 0008): the concrete model id the
   * last spawn actually launched with, written by `Supervisor.assign()`
   * after it resolves. Nothing reads it to decide anything.
   *
   * It used to be written at hire and ignored at spawn — the M7→M4
   * boundary check's finding. See `model_tier_override` below for what
   * replaced it as the input.
   */
  model: z.string().nullable(),
  /**
   * §7.5 — this employee's own tier choice, overriding the role's
   * `model_preference`. NULL means no override, which is the normal case.
   *
   * A TIER and not a resolved id, deliberately: an id pinned at hire would
   * stop tracking a role's declared tier, stop tracking
   * `settings.engines.modelTiers`, and be meaningless if the employee's
   * engine changed (tiers are per-engine). See migration 0008.
   */
  model_tier_override: ModelTierSchema.nullable(),
  session_id: z.string().nullable(),
  pid: z.number().int().nullable(),
  process_start_time: IsoTimestampSchema.nullable(),
  worktree_id: IdSchema.nullable(),
  current_task_id: IdSchema.nullable(),
  autonomy: AutonomySchema,
  // §28 M6 item 5 / migration 0004. Never set at hire (absent from
  // NewEmployeeInputSchema — same convention as worktree_id/lease-style
  // columns) — written only by confirmEmployeeAutonomous, which nothing
  // in production calls yet (the M9 confirmation dialog is the real
  // caller). See src/shared/policy/autonomy.ts's computeEffectiveAutonomy.
  autonomous_confirmed_at: IsoTimestampSchema.nullable(),
  daily_budget_usd_micros: UsdMicrosSchema.nullable(),
  resume_at: IsoTimestampSchema.nullable(),
  heartbeat_at: IsoTimestampSchema.nullable(),
  consecutive_failures: z.number().int(),
  lifetime_spend_usd_micros: UsdMicrosSchema,
  hired_at: IsoTimestampSchema,
  /**
   * §6.8's "firing archives rather than deletes" (migration 0007). NULL
   * means currently employed.
   *
   * Deliberately NOT an eleventh `EmployeeStatus`: employment and process
   * state are orthogonal, and the row has to survive because employee
   * memory is keyed by this id. See the migration for the full reasoning.
   *
   * Absent from `NewEmployeeInputSchema` — same convention as
   * `worktree_id` and `autonomous_confirmed_at`: a real column written
   * only by the one function responsible for it (`archiveEmployee` /
   * `unarchiveEmployee`), never a free-form input field. Nobody is hired
   * already fired.
   */
  archived_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Employee = z.infer<typeof EmployeeSchema>;

export const NewEmployeeInputSchema = z.object({
  /**
   * Normally minted by the repository. `hireEmployee` supplies one because
   * the sprite variant is seeded by employee id (so an employee keeps
   * their appearance across a rename, a re-pack, and being rehired) and
   * therefore has to be known before the row is written. Same convention
   * as `NewMemoryInputSchema.id`.
   */
  id: IdSchema.optional(),
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
  // A record written by the Supervisor after it resolves, never an
  // input — see EmployeeSchema. Kept on the input for the one legitimate
  // case of seeding a row that already knows what it last ran on.
  model: z.string().nullable().default(null),
  model_tier_override: ModelTierSchema.nullable().default(null),
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
export type NewEmployeeInput = z.input<typeof NewEmployeeInputSchema>;
