import { describe, expect, it } from 'vitest';
import { computeEffectiveAutonomy } from '../../../src/shared/policy/autonomy';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import type { ProbeResult } from '../../../src/shared/engine/types';

const PROBE = {} as ProbeResult;

/**
 * §7.3, AUDIT #11 — "Policy interception is mandatory."
 *
 *   effectiveAutonomy = (!caps.permissionCallback && !caps.hookInterception)
 *       ? 'ask'
 *       : employee.autonomy;
 *
 * This clause was not implemented anywhere. `computeEffectiveAutonomy`
 * only handled the separate unconfirmed-`autonomous` downgrade, and
 * grepping for `permissionCallback`/`hookInterception` outside the adapter
 * files and the type definition found zero consumers. So a `generic-pty`
 * employee — both capability flags false, i.e. an engine whose individual
 * tool calls Bureau genuinely cannot gate — ran at whatever autonomy it
 * was hired with, contradicting §7.7's and §7.12's own claim that such
 * employees run at `ask`.
 */
describe('an engine that cannot be gated forces `ask` (§7.3, AUDIT #11)', () => {
  it('forces ask when the engine offers neither a permission callback nor hook interception', () => {
    const effective = computeEffectiveAutonomy(
      { autonomy: 'autonomous', autonomous_confirmed_at: '2026-01-01T00:00:00.000Z' },
      { permissionCallback: false, hookInterception: false },
    );
    expect(effective).toBe('ask');
  });

  it('forces ask even from `guided` — this is not a one-notch downgrade, it is a floor', () => {
    expect(
      computeEffectiveAutonomy(
        { autonomy: 'guided', autonomous_confirmed_at: null },
        { permissionCallback: false, hookInterception: false },
      ),
    ).toBe('ask');
  });

  it('leaves autonomy alone when EITHER gating mechanism exists', () => {
    // Hook interception only — claude-code's real shape.
    expect(
      computeEffectiveAutonomy(
        { autonomy: 'guided', autonomous_confirmed_at: null },
        { permissionCallback: false, hookInterception: true },
      ),
    ).toBe('guided');
    // Permission callback only — FakeAdapter's real shape.
    expect(
      computeEffectiveAutonomy(
        { autonomy: 'guided', autonomous_confirmed_at: null },
        { permissionCallback: true, hookInterception: false },
      ),
    ).toBe('guided');
  });

  it('still applies the unconfirmed-autonomous downgrade when the engine IS gateable', () => {
    expect(
      computeEffectiveAutonomy(
        { autonomy: 'autonomous', autonomous_confirmed_at: null },
        { permissionCallback: false, hookInterception: true },
      ),
    ).toBe('guided');
  });

  it('omitting capabilities entirely leaves the existing behaviour unchanged (call sites that have no probe yet)', () => {
    expect(computeEffectiveAutonomy({ autonomy: 'guided', autonomous_confirmed_at: null })).toBe('guided');
    expect(computeEffectiveAutonomy({ autonomy: 'autonomous', autonomous_confirmed_at: null })).toBe('guided');
  });

  it('the REAL adapters land where §7.7/§7.12 say they do — not asserted against hand-written flags', () => {
    // generic-pty: ungateable by construction, so `ask` regardless of what
    // the employee was hired at. This is the claim §7.7 makes and that
    // nothing enforced before.
    const pty = new GenericPtyAdapter().capabilities(PROBE);
    expect(pty.permissionCallback || pty.hookInterception).toBe(false);
    expect(computeEffectiveAutonomy({ autonomy: 'autonomous', autonomous_confirmed_at: 'x' }, pty)).toBe('ask');

    // claude-code (structured): gated by the real PreToolUse hook, so the
    // employee's own autonomy stands.
    const claude = new ClaudeCodeAdapter().capabilities(PROBE, 'structured');
    expect(claude.hookInterception).toBe(true);
    expect(computeEffectiveAutonomy({ autonomy: 'guided', autonomous_confirmed_at: null }, claude)).toBe('guided');

    // FakeAdapter: permissionCallback true — the combination §7.3's rule
    // treats as gateable.
    const fake = new FakeAdapter().capabilities(PROBE);
    expect(fake.permissionCallback).toBe(true);
    expect(computeEffectiveAutonomy({ autonomy: 'guided', autonomous_confirmed_at: null }, fake)).toBe('guided');
  });
});
