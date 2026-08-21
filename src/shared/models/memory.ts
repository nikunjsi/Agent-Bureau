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
});
export type NewMemoryInput = z.infer<typeof NewMemoryInputSchema>;
