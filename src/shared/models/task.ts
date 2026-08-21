import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { TaskStatusSchema, RoleDeliverableKindSchema } from './enums';
import { UsdMicrosSchema } from './money';

const AcceptanceCriteriaSchema = z.array(z.string()).min(1);
const StringArraySchema = z.array(z.string());

export const TaskSchema = z.object({
  id: IdSchema,
  display_key: z.string().min(1),
  project_id: IdSchema,
  phase_id: IdSchema.nullable(),
  parent_task_id: IdSchema.nullable(),
  title: z.string().min(1),
  body: z.string().min(1),
  acceptance_criteria: jsonColumnSchema(AcceptanceCriteriaSchema),
  required_skills: jsonColumnSchema(StringArraySchema),
  deliverable_type: RoleDeliverableKindSchema.nullable(),
  assignee_employee_id: IdSchema.nullable(),
  excluded_employees: jsonColumnSchema(StringArraySchema),
  status: TaskStatusSchema,
  status_reason: z.string().nullable(),
  priority: z.number().int(),
  attempts: z.number().int(),
  reassignments: z.number().int(),
  estimated_cost_usd_micros: UsdMicrosSchema.nullable(),
  spend_usd_micros: UsdMicrosSchema.nullable(),
  result_summary: z.string().nullable(),
  started_at: IsoTimestampSchema.nullable(),
  finished_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

export const NewTaskInputSchema = z.object({
  project_id: IdSchema,
  phase_id: IdSchema.nullable().default(null),
  parent_task_id: IdSchema.nullable().default(null),
  title: z.string().min(1),
  body: z.string().min(1),
  acceptance_criteria: AcceptanceCriteriaSchema,
  required_skills: StringArraySchema.default([]),
  deliverable_type: RoleDeliverableKindSchema.nullable().default(null),
  assignee_employee_id: IdSchema.nullable().default(null),
  excluded_employees: StringArraySchema.default([]),
  status: TaskStatusSchema.default('queued'),
  status_reason: z.string().nullable().default(null),
  priority: z.number().int().default(50),
  estimated_cost_usd_micros: UsdMicrosSchema.nullable().default(null),
});
export type NewTaskInput = z.infer<typeof NewTaskInputSchema>;
