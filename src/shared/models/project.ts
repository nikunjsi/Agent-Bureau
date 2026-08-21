import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { ProjectKindSchema, ProjectStageSchema } from './enums';
import { UsdMicrosSchema } from './money';

const ProtectedRefsSchema = z.array(z.string());

export const ProjectSchema = z.object({
  id: IdSchema,
  display_key: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  repo_initialised: z.coerce.boolean(),
  base_ref: z.string().min(1),
  protected_refs: jsonColumnSchema(ProtectedRefsSchema),
  kind: ProjectKindSchema,
  stage: ProjectStageSchema,
  brief_id: IdSchema.nullable(),
  plan_id: IdSchema.nullable(),
  budget_usd_micros: UsdMicrosSchema.nullable(),
  spend_usd_micros: UsdMicrosSchema,
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const NewProjectInputSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  repo_initialised: z.boolean().default(false),
  base_ref: z.string().min(1).default('main'),
  protected_refs: ProtectedRefsSchema.default(['main', 'master']),
  kind: ProjectKindSchema,
  stage: ProjectStageSchema.default('intake'),
  brief_id: IdSchema.nullable().default(null),
  plan_id: IdSchema.nullable().default(null),
  budget_usd_micros: UsdMicrosSchema.nullable().default(null),
  spend_usd_micros: UsdMicrosSchema.default(0),
});
export type NewProjectInput = z.infer<typeof NewProjectInputSchema>;
