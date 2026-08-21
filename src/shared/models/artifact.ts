import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';

export const ArtifactSchema = z.object({
  id: IdSchema,
  task_id: IdSchema.nullable(),
  employee_id: IdSchema.nullable(),
  kind: z.string().min(1),
  title: z.string().min(1),
  path: z.string().nullable(),
  content: z.string().nullable(),
  content_sha256: z.string().nullable(),
  bytes: z.number().int().nullable(),
  mime: z.string().nullable(),
  pinned: z.coerce.boolean(),
  created_at: IsoTimestampSchema,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const NewArtifactInputSchema = z.object({
  task_id: IdSchema.nullable().default(null),
  employee_id: IdSchema.nullable().default(null),
  kind: z.string().min(1),
  title: z.string().min(1),
  path: z.string().nullable().default(null),
  content: z.string().nullable().default(null),
  content_sha256: z.string().nullable().default(null),
  bytes: z.number().int().nullable().default(null),
  mime: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
});
export type NewArtifactInput = z.infer<typeof NewArtifactInputSchema>;
