import { z } from 'zod';
import { IsoTimestampSchema } from './ids';

/** One row of the raw `settings` table. The typed registry (every key,
 * its default, scope, and group) is `src/shared/settings/schema.ts` —
 * this is just the storage shape. */
export const SettingRowSchema = z.object({
  key: z.string().min(1),
  value_json: z.string(),
  updated_at: IsoTimestampSchema,
});
export type SettingRow = z.infer<typeof SettingRowSchema>;

export const UpsertSettingInputSchema = z.object({
  key: z.string().min(1),
  value_json: z.string(),
});
export type UpsertSettingInput = z.infer<typeof UpsertSettingInputSchema>;
