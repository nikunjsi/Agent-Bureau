import { z } from 'zod';
import { IdSchema } from '../../models/ids';
import { listOutputSchema } from './common';

/**
 * New namespace (see the M2 plan / PROGRESS.md): §14.5's Inspector "Files"
 * tab — "what this employee changed in their worktree, with diffs" —
 * and the Board view's task detail ("what changed (file list / diff
 * link)", §14.2) both need this; §17.1's original code block never listed
 * it. Real git plumbing is M5's job (§10) — M2 defines the shape and
 * stubs the behavior.
 */
const FileDiffSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed']),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
});

const DiffResultSchema = z.object({ files: z.array(FileDiffSchema) });

const FileTreeEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'dir']),
  status: z.enum(['added', 'modified', 'deleted']).nullable(),
});

export const Workspace = {
  diffForTask: { input: z.object({ taskId: IdSchema }), output: z.object({ item: DiffResultSchema }) },
  diffForEmployee: { input: z.object({ employeeId: IdSchema }), output: z.object({ item: DiffResultSchema }) },
  fileTree: { input: z.object({ worktreeId: IdSchema }), output: listOutputSchema(FileTreeEntrySchema) },
};
