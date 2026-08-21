import { z } from 'zod';
import { IsoTimestampSchema } from './ids';

export const SchemaMigrationSchema = z.object({
  version: z.number().int(),
  name: z.string().min(1),
  applied_at: IsoTimestampSchema,
  checksum: z.string().min(1),
});
export type SchemaMigration = z.infer<typeof SchemaMigrationSchema>;
