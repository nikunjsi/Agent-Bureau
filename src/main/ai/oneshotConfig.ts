import type Database from 'better-sqlite3';
import { getSetting } from '../db/repositories/settings';
import { resolveModelTier } from '../engine/modelTiers';
import type { ConfiguredModelTiers } from '../engine/modelTiers';
import { type OneShotConfig, type OneShotProvider } from './oneshot';

/**
 * The seam between the settings registry and §22.4's one-shot client.
 *
 * M7 built `oneshot.ts` deliberately caller-less (§H.1) and said plainly:
 * "if M8 arrives and does not use it, that is the moment to delete it
 * rather than carry it further." M8 uses it — for checkpoint duplicate
 * confirmation on a near-miss — so this is the function that was missing:
 * nothing anywhere turned `engines.oneshotProvider` into an
 * `OneShotConfig`.
 *
 * ## `'none'` is the answer almost every time, and that is correct
 *
 * `engines.oneshotProvider` seeds to `''` (settingsLoader's own dynamic
 * default: "no engine exists to default to until M3/M13's real
 * detection"), and §22.4 explains why the eventual default fails anyway —
 * a subscription login and a free CLI login both hold OAuth credentials
 * *inside* the agent CLI, unusable for a raw HTTP call. So an unset,
 * unrecognised, or non-HTTP value all resolve to `provider: 'none'`, and
 * every caller must have a working fallback. For duplicate detection that
 * fallback is FTS-plus-Dice alone, whose stated consequence (§22.4) is
 * "slightly more duplicates, never a blocker".
 *
 * The **key name** is a convention, not a setting: §16.1 has no
 * `engines.oneshotSecretKey`, and inventing one here would be a settings
 * change made by a feature rather than by §16.1. `retrieveSecret` returns
 * null for a name with no stored key, and `runOneShot` turns that into a
 * clean `no_key` result — the same shape as `no_provider`, taking the same
 * fallback.
 */
export const ONESHOT_SECRET_KEY_NAME = 'oneshot.apiKey';

const HTTP_PROVIDERS: ReadonlySet<string> = new Set<OneShotProvider>([
  'anthropic',
  'openai',
  'google',
  'openai-compatible',
]);

/**
 * Which `engines.modelTiers` key holds this provider's models (X-19).
 *
 * `anthropic` is the vendor behind the `claude-code` engine, so its tiers
 * are the ones Bureau already ships and the user has already configured —
 * mapping it is not a special case so much as the same models under their
 * other name. Every other provider looks itself up by name, which is a key
 * the user has to have written.
 */
function tierKeyForProvider(provider: OneShotProvider): string {
  return provider === 'anthropic' ? 'claude-code' : provider;
}

export function resolveOneShotConfig(db: Database.Database): OneShotConfig {
  const configured = getSetting(db, 'engines.oneshotProvider').trim();

  if (!HTTP_PROVIDERS.has(configured)) {
    // Includes the seeded `''`, and anything the user typed that is not a
    // provider Bureau can actually speak to over HTTP. Both are "no
    // provider", not an error: the caller falls back.
    return { provider: 'none', secretKey: ONESHOT_SECRET_KEY_NAME, model: '' };
  }

  const provider = configured as OneShotProvider;

  // §22.4: "model: resolved from engines.modelTiers['fast']" — **for this
  // provider**, not for the main engine (X-19).
  //
  // The tier map is keyed by engine, and the one-shot provider need not be
  // the engine. This used to resolve against `engines.default`, so a user
  // who pointed `oneshotProvider` at OpenAI got an Anthropic model id sent
  // to OpenAI: a call that could only fail, after they had stored a key.
  // Resolved through `resolveModelTier` rather than by indexing the setting
  // directly, so the shipping defaults apply here exactly as they do for a
  // real spawn — one resolver, not a second reading of the same map.
  const resolved = resolveModelTier({
    modelPreference: ['fast'],
    engineKey: tierKeyForProvider(provider),
    configured: getSetting(db, 'engines.modelTiers') as ConfiguredModelTiers,
  });

  if (resolved === null) {
    // A provider with no resolvable model cannot make a call, and calling
    // with an empty model string would fail at the far end with a much
    // worse message. Fail to `'none'` and let the fallback run — §22.4's
    // "no feature may depend on this" makes that safe by construction.
    //
    // This is the normal answer for every provider but Anthropic until the
    // user names a model, because Bureau ships tiers for `claude-code`
    // only. Guessing one for OpenAI or Google would be inventing a model id
    // that goes stale silently, in a file nobody reads.
    return { provider: 'none', secretKey: ONESHOT_SECRET_KEY_NAME, model: '' };
  }

  return { provider, secretKey: ONESHOT_SECRET_KEY_NAME, model: resolved.modelId };
}
