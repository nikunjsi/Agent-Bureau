import { describe, expect, it } from 'vitest';
import { autonomyDefaultFor } from '../../../src/shared/policy/autonomyDefault';
import type { Autonomy } from '../../../src/shared/models/enums';
import type { ToolClass } from '../../../src/shared/policy/types';

const LEVELS: Autonomy[] = ['ask', 'guided', 'autonomous'];

describe('autonomyDefaultFor — §11.2’s table, exactly', () => {
  it('reads: allow at every level', () => {
    for (const level of LEVELS) expect(autonomyDefaultFor('read', level).effect).toBe('allow');
  });

  it('writes: ask at "ask", allow at guided/autonomous', () => {
    expect(autonomyDefaultFor('write', 'ask').effect).toBe('ask');
    expect(autonomyDefaultFor('write', 'guided').effect).toBe('allow');
    expect(autonomyDefaultFor('write', 'autonomous').effect).toBe('allow');
  });

  it('commands: ask at "ask" and "guided" (allow-listed only — nothing matched, so ask), allow at "autonomous"', () => {
    expect(autonomyDefaultFor('command', 'ask').effect).toBe('ask');
    expect(autonomyDefaultFor('command', 'guided').effect).toBe('ask');
    expect(autonomyDefaultFor('command', 'autonomous').effect).toBe('allow');
  });

  it(
    'network: ask at "ask", allow at guided/autonomous (M6 session 2 Fix A — the domain allow-list gate ' +
      'now lives in a synthesized deny rule, ruleLoader.ts’s networkDenyRuleFor, evaluated BEFORE this ' +
      'fallback is ever reached; reaching here means the domain was already on the list)',
    () => {
      expect(autonomyDefaultFor('network', 'ask').effect).toBe('ask');
      expect(autonomyDefaultFor('network', 'guided').effect).toBe('allow');
      expect(autonomyDefaultFor('network', 'autonomous').effect).toBe('allow');
    },
  );

  it('"other" denies by default at every level, never asks (§11.3 explicit instruction)', () => {
    for (const level of LEVELS) expect(autonomyDefaultFor('other', level).effect).toBe('deny');
  });

  it('bureau always allows (defensive default — never actually reached, isBureauTool short-circuits first)', () => {
    for (const level of LEVELS) expect(autonomyDefaultFor('bureau', level).effect).toBe('allow');
  });

  it('a deny carries a reason; an allow does not need one', () => {
    const denied = autonomyDefaultFor('other', 'guided');
    expect(denied.effect === 'deny' && denied.reason.length > 0).toBe(true);
  });

  it('every non-allow verdict carries a distinct, attributable ruleId per class and level', () => {
    const classes: ToolClass[] = ['write', 'command', 'network'];
    const ids = new Set<string>();
    for (const c of classes) for (const level of LEVELS) ids.add(autonomyDefaultFor(c, level).ruleId);
    expect(ids.size).toBe(classes.length * LEVELS.length);
  });
});
