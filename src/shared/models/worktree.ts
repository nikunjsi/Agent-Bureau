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
export type NewWorktreeInput = z.infer<typeof NewWorktreeInputSchema>;
