import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { WorktreeStatusSchema } from './enums';

export const WorktreeSchema = z.object({
  id: IdSchema,
  project_id: IdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  base_commit: z.string().min(1),
  lease_holder: IdSchema.nullable(),
  lease_expires_at: IsoTimestampSchema.nullable(),
  status: WorktreeStatusSchema,
  // §10.3.1 layer 4 / M5 part 2 (migration 0003): the durable commit
  // intent marker — set before the real `git commit` runs, cleared only
  // once `base_commit` is updated to match it, in one atomic UPDATE.
  // Never set at creation (absent from NewWorktreeInputSchema, same
  // convention as lease_holder) — written only by
  // employeeCommit.ts's commitTaskWork/resolvePendingCommitMarker.
  pending_commit_task_id: IdSchema.nullable(),
  // Not in §5.1's own listing; §5.0's blanket rule applies (status is
  // mutable).
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Worktree = z.infer<typeof WorktreeSchema>;

export const NewWorktreeInputSchema = z.object({
  project_id: IdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  base_commit: z.string().min(1),
  status: WorktreeStatusSchema.default('free'),
});
export type NewWorktreeInput = z.input<typeof NewWorktreeInputSchema>;
