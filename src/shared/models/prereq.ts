import { z } from 'zod';
import { IsoTimestampSchema } from './ids';

export const PrereqSchema = z.object({
  key: z.string().min(1),
  status: z.string().min(1),
  version: z.string().nullable(),
  path: z.string().nullable(),
  detected_at: IsoTimestampSchema.nullable(),
  notes: z.string().nullable(),
});
export type Prereq = z.infer<typeof PrereqSchema>;

export const UpsertPrereqInputSchema = z.object({
  key: z.string().min(1),
  status: z.string().min(1),
  version: z.string().nullable().default(null),
  path: z.string().nullable().default(null),
  detected_at: IsoTimestampSchema.nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type UpsertPrereqInput = z.infer<typeof UpsertPrereqInputSchema>;
