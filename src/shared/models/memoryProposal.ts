import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { MemoryScopeSchema } from './enums';

/**
 * §12.4's queue row — the table `bureau_propose_memory` has been waiting for
 * since M4, when it was left ROW ONLY because designing one ahead of a real
 * memory store would have been guessing.
 *
 * `pending → accepted | rejected | expired`, and `expired` is a rejection:
 * §12.4 says a proposal is "auto-rejected **with a record**" after
 * `retention.memoryProposalDays`. The two are separate statuses only so the
 * trail can answer *who* — a person deciding, or the clock running out —
 * without parsing a reason string.
 */
export const MemoryProposalStatusSchema = z.enum(['pending', 'accepted', 'rejected', 'expired']);
export type MemoryProposalStatus = z.infer<typeof MemoryProposalStatusSchema>;

export const MemoryProposalSchema = z.object({
  id: IdSchema,
  scope: MemoryScopeSchema,
  scope_ref: z.string().nullable(),
  /** Memory-root-relative and already confined — `resolveMemoryTarget`
   *  produced it, so nothing downstream re-derives or re-validates a path. */
  path: z.string().min(1),
  title: z.string().min(1),
  /** The proposed note, as markdown. **Content, not presentation** — the
   *  same category as a chat message's body; how a proposal is displayed is
   *  the renderer's decision. */
  content: z.string(),
  rationale: z.string(),
  /** `employee:<id>` | `director` | `user` — the activity log's actor shape,
   *  so a proposal and the events about it read alike. */
  proposed_by: z.string().min(1),
  employee_id: IdSchema.nullable(),
  project_id: IdSchema.nullable(),
  phase_id: IdSchema.nullable(),
  /** The review batch this proposal joined. Null for a proposal that needed
   *  no approval, and briefly null between insert and attach. */
  checkpoint_id: IdSchema.nullable(),
  status: MemoryProposalStatusSchema,
  resolution_reason: z.string().nullable(),
  resolved_by: z.string().nullable(),
  resolved_at: IsoTimestampSchema.nullable(),
  applied_memory_id: IdSchema.nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const NewMemoryProposalInputSchema = z.object({
  scope: MemoryScopeSchema,
  scope_ref: z.string().nullable().default(null),
  path: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
  rationale: z.string(),
  proposed_by: z.string().min(1),
  employee_id: IdSchema.nullable().default(null),
  project_id: IdSchema.nullable().default(null),
  phase_id: IdSchema.nullable().default(null),
  checkpoint_id: IdSchema.nullable().default(null),
});
export type NewMemoryProposalInput = z.input<typeof NewMemoryProposalInputSchema>;

/** One person's answer about one proposed note — §12.4's "accept/reject per
 *  item". Carried on `checkpoints.answer`, because the review IS a
 *  checkpoint and a second answering surface would be a second door. */
export const MemoryProposalDecisionSchema = z.object({
  proposalId: IdSchema,
  decision: z.enum(['accept', 'reject']),
});
export type MemoryProposalDecision = z.infer<typeof MemoryProposalDecisionSchema>;
