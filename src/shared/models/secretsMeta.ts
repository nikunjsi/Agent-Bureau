import { z } from 'zod';
import { IsoTimestampSchema } from './ids';

/** No values, ever — §11.4. Only metadata about where a secret is stored. */
export const SecretsMetaSchema = z.object({
  key: z.string().min(1),
  provider: z.string().nullable(),
  storage_ref: z.string().nullable(),
  last_set_at: IsoTimestampSchema.nullable(),
  last_used_at: IsoTimestampSchema.nullable(),
});
export type SecretsMeta = z.infer<typeof SecretsMetaSchema>;

export const UpsertSecretsMetaInputSchema = z.object({
  key: z.string().min(1),
  provider: z.string().nullable().default(null),
  storage_ref: z.string().nullable().default(null),
  last_set_at: IsoTimestampSchema.nullable().default(null),
  last_used_at: IsoTimestampSchema.nullable().default(null),
});
export type UpsertSecretsMetaInput = z.infer<typeof UpsertSecretsMetaInputSchema>;
