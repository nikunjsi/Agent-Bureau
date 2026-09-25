import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { DeliverableTypeSchema, ProjectKindSchema, VersionedDocStatusSchema } from './enums';

// The column holds a JSON object. What the Director writes into it is
// §8.3's `Brief` (below, M11 S2-3a); rows written before M11, and the
// structured content an edit carries over, are only guaranteed to be an
// object, so the column's own schema stays this loose.
const BriefContentSchema = z.record(z.unknown());

/**
 * §8.3's `Brief`, as `bureau_write_brief` accepts it (M11 S2-3a) — verbatim
 * from the spec, with `.min(1)` on the strings a card or a deliverable row
 * cannot do without.
 */
export const BriefDocumentSchema = z.object({
  title: z.string().min(1),
  one_liner: z.string().min(1),
  goal: z.string().min(1),
  kind: ProjectKindSchema,
  users: z.string(),
  scope: z.array(z.string().min(1)).min(1),
  non_goals: z.array(z.string().min(1)),
  deliverables: z
    .array(
      z.object({
        type: DeliverableTypeSchema,
        name: z.string().min(1),
        description: z.string().min(1),
        acceptance: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1),
  constraints: z.object({
    tech: z.array(z.string()),
    platform: z.array(z.string()),
    deadline: z.string().nullable(),
    budget_usd: z.number().nullable(),
    other: z.array(z.string()),
  }),
  existing_assets: z.array(z.string()),
  success_criteria: z.array(z.string().min(1)).min(1),
  assumptions: z.array(z.string().min(1)),
  open_questions: z.array(z.string().min(1)),
  risks: z.array(
    z.object({
      risk: z.string().min(1),
      impact: z.enum(['low', 'medium', 'high']),
      mitigation: z.string().min(1),
    }),
  ),
});
export type BriefDocument = z.infer<typeof BriefDocumentSchema>;

export const BriefSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  version: z.number().int(),
  content: jsonColumnSchema(BriefContentSchema),
  markdown: z.string(),
  status: VersionedDocStatusSchema,
  approved_at: IsoTimestampSchema.nullable(),
  created_at: IsoTimestampSchema,
  // Not in §5.1's own listing; §5.0's blanket rule applies (status is
  // mutable: draft → awaiting_approval → approved/superseded).
  updated_at: IsoTimestampSchema,
});
export type Brief = z.infer<typeof BriefSchema>;

export const NewBriefInputSchema = z.object({
  project_id: IdSchema,
  version: z.number().int(),
  content: BriefContentSchema,
  markdown: z.string(),
  status: VersionedDocStatusSchema.default('draft'),
  approved_at: IsoTimestampSchema.nullable().default(null),
});
export type NewBriefInput = z.input<typeof NewBriefInputSchema>;
