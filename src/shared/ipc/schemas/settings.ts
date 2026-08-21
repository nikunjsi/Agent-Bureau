import { z } from 'zod';
import { SettingsValuesSchema, SETTINGS_KEYS, type SettingKey } from '../../settings/schema';
import { EmptyInputSchema, OkOutputSchema } from './common';

/** Any of the 49 registered keys (§16.1) — "anything not in this table
 * does not exist" is enforced here, not just documented. */
const SettingKeySchema = z.string().refine((k): k is SettingKey => (SETTINGS_KEYS as string[]).includes(k), {
  message: 'Unknown setting key — see §16.1',
});

const SecretMetaViewSchema = z.object({
  key: z.string(),
  provider: z.string().nullable(),
  lastSetAt: z.string().nullable(),
});

export const Settings = {
  /** No per-key filtering — returns every key at once, matching
   * repositories/settings.ts's getAllSettings(). */
  get: { input: EmptyInputSchema, output: z.object({ item: SettingsValuesSchema }) },
  /** `value`'s real shape depends on `key`; re-validated per-key against
   * SettingsValuesSchema inside the handler (the same thing
   * repositories/settings.ts's setSetting() already does) rather than a
   * 49-armed discriminated union here. */
  set: { input: z.object({ key: SettingKeySchema, value: z.unknown() }), output: OkOutputSchema },
  getSecretsStatus: { input: EmptyInputSchema, output: z.object({ items: z.array(SecretMetaViewSchema) }) },
  /** Write-only — §11.4: no secret value is ever read back over IPC. */
  setSecret: { input: z.object({ key: z.string().min(1), value: z.string().min(1) }), output: OkOutputSchema },
  clearSecret: { input: z.object({ key: z.string().min(1) }), output: OkOutputSchema },
};
