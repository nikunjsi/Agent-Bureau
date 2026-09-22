import { z } from 'zod';
import { SettingsValuesSchema, SETTINGS_KEYS, type SettingKey } from '../../settings/schema';
import { EmptyInputSchema, OkOutputSchema } from './common';

/** Any of the 49 registered keys (§16.1) — "anything not in this table
 * does not exist" is enforced here, not just documented. */
const SettingKeySchema = z
  .string()
  .refine((k): k is SettingKey => (SETTINGS_KEYS as string[]).includes(k), {
    message: 'Unknown setting key — see §16.1',
  });

/**
 * The secrets Settings may store (M11 S1-5), and nothing else: the Anthropic
 * API key the broker injects into a claude-code spawn (E-4's primary
 * sign-in), and §22.4's helper key the one-shot client reads. An allowlist
 * in the schema, so any other name is refused by validation before a
 * handler runs. Each name must equal its reader's constant, which a test
 * asserts.
 */
export const STORABLE_SECRET_KEYS = ['anthropic_api_key', 'oneshot.apiKey'] as const;
export type StorableSecretKey = (typeof STORABLE_SECRET_KEYS)[number];
const StorableSecretKeySchema = z.enum(STORABLE_SECRET_KEYS);

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
  // `note` (M6 session 3) — §11.4's own honest text, verbatim
  // (secretStore.ts's API_KEY_HONEST_NOTE): API keys are long-lived and
  // cannot be scoped down or minted short-lived, no provider offers that.
  // The settings screen that renders this is M9/M13's; this is the seam
  // so it renders Bureau's real copy rather than a re-derived paraphrase.
  getSecretsStatus: {
    input: EmptyInputSchema,
    output: z.object({ items: z.array(SecretMetaViewSchema), note: z.string() }),
  },
  /** Write-only — §11.4: no secret value is ever read back over IPC. */
  setSecret: {
    input: z.object({ key: StorableSecretKeySchema, value: z.string().min(1) }),
    output: OkOutputSchema,
  },
  clearSecret: { input: z.object({ key: StorableSecretKeySchema }), output: OkOutputSchema },
};
