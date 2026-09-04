import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_DEFAULT_MODEL_TIERS,
  SHIPPING_MODEL_TIERS,
  resolveModelTier,
} from '../../../src/main/engine/modelTiers';

/**
 * §7.5: "Roles declare abstract tiers, not model names." This is the pure
 * half of that chain — `role.model_preference` (an ordered list of tier
 * names, §6.5) plus `settings.engines.modelTiers` (tier -> concrete id,
 * PER ENGINE) resolving to one model id.
 *
 * AUDIT #1: before this existed, `costSafetyArgs()` returned the `fast`
 * tier's id for every role of every engine, and `model_preference` was
 * read nowhere at all.
 */
describe('resolveModelTier (§7.5) — role tier -> settings map -> concrete model id', () => {
  it('resolves the role’s first declared tier against the configured per-engine map', () => {
    const resolved = resolveModelTier({
      modelPreference: ['capable'],
      engineKey: 'claude-code',
      configured: { 'claude-code': { capable: 'configured-capable-id' } },
    });
    expect(resolved).toEqual({ tier: 'capable', modelId: 'configured-capable-id', source: 'settings' });
  });

  it('honours the ORDER of model_preference — the first tier with a mapping wins, not the last or the cheapest', () => {
    const resolved = resolveModelTier({
      modelPreference: ['capable', 'fast'],
      engineKey: 'claude-code',
      configured: { 'claude-code': { fast: 'fast-id', capable: 'capable-id' } },
    });
    expect(resolved?.tier).toBe('capable');
    expect(resolved?.modelId).toBe('capable-id');
  });

  it('falls through to the next declared tier only when the first resolves NOWHERE — settings or shipping default', () => {
    const resolved = resolveModelTier({
      modelPreference: ['capable', 'balanced'],
      engineKey: 'engine-with-partial-config', // no shipping defaults at all
      configured: { 'engine-with-partial-config': { balanced: 'balanced-id' } }, // no `capable` anywhere
    });
    expect(resolved?.tier).toBe('balanced');
    expect(resolved?.modelId).toBe('balanced-id');
  });

  it('does NOT fall through just because a later tier happens to be the configured one — a partial user override never silently downgrades a role', () => {
    // The role prefers `capable`; the user configured only `balanced`.
    // `capable` still resolves (via its shipping default), so it wins —
    // otherwise configuring one unrelated tier would quietly demote every
    // capable-tier role on the engine.
    const resolved = resolveModelTier({
      modelPreference: ['capable', 'balanced'],
      engineKey: 'claude-code',
      configured: { 'claude-code': { balanced: 'balanced-id' } },
    });
    expect(resolved).toEqual({
      tier: 'capable',
      modelId: CLAUDE_CODE_DEFAULT_MODEL_TIERS.capable,
      source: 'shipping-default',
    });
  });

  it('is PER ENGINE — another engine’s mapping is never borrowed', () => {
    const resolved = resolveModelTier({
      modelPreference: ['balanced'],
      engineKey: 'generic-pty',
      configured: { 'claude-code': { balanced: 'claude-only-id' } },
    });
    // generic-pty has no configured mapping and no shipping default, so
    // there is genuinely nothing to resolve — never claude-code's id.
    expect(resolved).toBeNull();
  });

  it('falls back to the shipping defaults when settings carry no mapping for the tier', () => {
    const resolved = resolveModelTier({
      modelPreference: ['balanced'],
      engineKey: 'claude-code',
      configured: {},
    });
    expect(resolved).toEqual({
      tier: 'balanced',
      modelId: CLAUDE_CODE_DEFAULT_MODEL_TIERS.balanced,
      source: 'shipping-default',
    });
    // And the shipping defaults are exposed per-engine, not as a bare map.
    expect(SHIPPING_MODEL_TIERS['claude-code']).toEqual(CLAUDE_CODE_DEFAULT_MODEL_TIERS);
  });

  it('a configured mapping WINS over the shipping default for the same tier', () => {
    const resolved = resolveModelTier({
      modelPreference: ['fast'],
      engineKey: 'claude-code',
      configured: { 'claude-code': { fast: 'user-overrode-this' } },
    });
    expect(resolved?.modelId).toBe('user-overrode-this');
    expect(resolved?.modelId).not.toBe(CLAUDE_CODE_DEFAULT_MODEL_TIERS.fast);
  });

  it('a role declaring no preference defaults to `balanced` — §7.5’s "default for most implementation work", NOT `fast`', () => {
    const resolved = resolveModelTier({
      modelPreference: null,
      engineKey: 'claude-code',
      configured: {},
    });
    expect(resolved?.tier).toBe('balanced');
    // The regression this whole finding is about: every role used to get
    // the `fast` id regardless of what it declared.
    expect(resolved?.modelId).not.toBe(CLAUDE_CODE_DEFAULT_MODEL_TIERS.fast);
  });

  it('an empty preference list behaves as "no preference", not as "nothing resolves"', () => {
    expect(resolveModelTier({ modelPreference: [], engineKey: 'claude-code', configured: {} })?.tier).toBe('balanced');
  });

  it('returns null for an engine with neither configured mapping nor shipping default — caller passes no --model', () => {
    expect(
      resolveModelTier({ modelPreference: ['balanced'], engineKey: 'some-future-engine', configured: {} }),
    ).toBeNull();
  });

  it('ignores an unknown tier name rather than resolving it to something arbitrary', () => {
    const resolved = resolveModelTier({
      modelPreference: ['turbo' as never, 'balanced'],
      engineKey: 'claude-code',
      configured: { 'claude-code': { balanced: 'balanced-id' } },
    });
    expect(resolved?.tier).toBe('balanced');
  });
});
