import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { jsonColumnSchema } from './json';
import { MemoryScopeSchema, MemorySourceSchema } from './enums';

const TagsSchema = z.array(z.string());

export const MemorySchema = z.object({
  // Explicit INTEGER PRIMARY KEY — required so VACUUM cannot desynchronise
  // the FTS index (§5.1).
  rowid: z.number().int(),
  id: IdSchema,
  scope: MemoryScopeSchema,
  scope_ref: z.string().nullable(),
  path: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  content_sha256: z.string().min(1),
  tags: jsonColumnSchema(TagsSchema),
  source: MemorySourceSchema,
  pinned: z.coerce.boolean(),
  /**
   * Migration `0010` — the stat of the layer-1 file as it was when this row
   * was last built. A **skip hint for the reconciler, never the authority**:
   * `content_sha256` is what says whether the index matches the file, and
   * these two only say whether it is worth reading the file to find out.
   *
   * Null means "unknown", which forces a read — every row written before
   * `0010` has that, and so does any row whose file has never been stat'ed.
   * Failing toward more work is the correct direction for a cache.
   */
  file_mtime_ms: z.number().nullable(),
  file_size: z.number().int().nullable(),
  created_at: IsoTimestampSchema,
  updated_at: IsoTimestampSchema,
});
export type Memory = z.infer<typeof MemorySchema>;

export const NewMemoryInputSchema = z.object({
  id: IdSchema.optional(),
  scope: MemoryScopeSchema,
  scope_ref: z.string().nullable().default(null),
  path: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  content_sha256: z.string().min(1),
  tags: TagsSchema.default([]),
  source: MemorySourceSchema,
  pinned: z.boolean().default(false),
  file_mtime_ms: z.number().nullable().default(null),
  file_size: z.number().int().nullable().default(null),
});
export type NewMemoryInput = z.input<typeof NewMemoryInputSchema>;
