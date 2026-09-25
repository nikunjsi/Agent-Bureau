import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { RoleDeliverableKindSchema, VersionedDocStatusSchema } from './enums';
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
export type NewPlanInput = z.input<typeof NewPlanInputSchema>;

/**
 * §8.4's plan, as `bureau_write_plan` takes it (§7.9's arguments). The
 * structure is checked by this schema; the rules that need the whole plan
 * or the database — the DAG, phase indices, known skills, phase size, and
 * invariant #2 — are `planProblems` (`src/main/projects/planWriting.ts`), in plain code. Shared, because
 * `bureau-tools` registers the same shape with the engine.
 */
export const PlanDocumentSchema = z.object({
  phases: z
    .array(
      z.object({
        name: z.string().min(1),
        goal: z.string().min(1),
        review_required: z.boolean().default(true),
      }),
    )
    .min(1),
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        // §8.4: "a task without a definition of done is rejected".
        acceptance_criteria: z.array(z.string().min(1)).min(1),
        required_skills: z.array(z.string().min(1)).default([]),
        deliverable_type: RoleDeliverableKindSchema.nullable().default(null),
        phase_index: z.number().int().min(0),
        estimated_cost_usd: z.number().min(0).nullable().default(null),
      }),
    )
    .min(1),
  deps: z
    .array(
      z.object({
        task_index: z.number().int().min(0),
        depends_on_index: z.number().int().min(0),
      }),
    )
    .default([]),
});
export type PlanDocument = z.infer<typeof PlanDocumentSchema>;
