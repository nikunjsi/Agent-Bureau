import { describe, expect, it } from 'vitest';
import { computeEffectiveAutonomy } from '../../../src/shared/policy/autonomy';

describe('computeEffectiveAutonomy — CLAUDE.md’s named trap: compute, never overwrite employees.autonomy', () => {
  it('an unconfirmed "autonomous" employee computes to "guided" — the M9 seam is real but no dialog exists yet', () => {
    expect(computeEffectiveAutonomy({ autonomy: 'autonomous', autonomous_confirmed_at: null })).toBe('guided');
  });

  it('a confirmed "autonomous" employee computes to "autonomous"', () => {
    expect(computeEffectiveAutonomy({ autonomy: 'autonomous', autonomous_confirmed_at: '2026-08-28T00:00:00.000Z' })).toBe(
      'autonomous',
    );
  });

  it('"guided" and "ask" pass through unchanged regardless of the confirmation column — only "autonomous" is gated', () => {
    expect(computeEffectiveAutonomy({ autonomy: 'guided', autonomous_confirmed_at: null })).toBe('guided');
    expect(computeEffectiveAutonomy({ autonomy: 'ask', autonomous_confirmed_at: null })).toBe('ask');
  });

  it('never returns a value not already present on the input — never invents "autonomous" from nothing', () => {
    const result = computeEffectiveAutonomy({ autonomy: 'guided', autonomous_confirmed_at: '2026-01-01T00:00:00.000Z' });
    expect(result).toBe('guided');
  });
});
