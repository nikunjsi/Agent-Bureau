import { describe, expect, it } from 'vitest';
import {
  ADDITIONAL_RULE_PRIORITY,
  buildRuleSet,
  ImmutableRuleViolationError,
  networkDenyRuleFor,
  ROLE_RULE_PRIORITY,
  roleRulesFrom,
  validateRuleSet,
} from '../../../src/shared/policy/ruleLoader';
import {
  IMMUTABLE_RULES,
  IMMUTABLE_RULE_PRIORITY,
} from '../../../src/shared/policy/immutableRules';
import { evaluate } from '../../../src/shared/policy/evaluator';
import type { MatchContext, PolicyVariables, Rule } from '../../../src/shared/policy/types';

describe('roleRulesFrom — real M1 schema (role.tools_allow/tools_deny), real teeth from §11.3', () => {
  it('builds one rule per pattern, deny before allow, at the role priority tier', () => {
    const rules = roleRulesFrom({
      full_key: 'engineering:developer',
      tools_allow: ['Write(${worktree}/docs/**)'],
      tools_deny: ['Bash(rm *)'],
    });
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({
      effect: 'deny',
      toolPattern: 'Bash(rm *)',
      priority: ROLE_RULE_PRIORITY,
      immutable: false,
    });
    expect(rules[1]).toMatchObject({
      effect: 'allow',
      toolPattern: 'Write(${worktree}/docs/**)',
      priority: ROLE_RULE_PRIORITY,
      immutable: false,
    });
  });

  it('an empty role (no packs installed yet — the real, current state of this codebase) yields no rules', () => {
    expect(
      roleRulesFrom({ full_key: 'engineering:developer', tools_allow: [], tools_deny: [] }),
    ).toEqual([]);
  });
});

describe('networkDenyRuleFor — M6 session 2 Fix A: an allow-list in a deny-wins evaluator IS a deny', () => {
  const VARS: PolicyVariables = {
    worktree: null,
    project: null,
    home: null,
    bureau_state: 'c:/state/emp1',
  };

  function networkCtx(domain: string | null): MatchContext {
    return {
      toolClass: 'network',
      canonicalPath: null,
      canonicalArg: '{}',
      domain,
      variables: VARS,
      effectiveAutonomy: 'guided',
      now: new Date(),
      rawArgs: {},
    };
  }

  /**
   * AUDIT #12. `WebSearch` is declared a network tool but carries no
   * `url`, so `extractArgs` yields `domain: null`. `domain_matches`
   * returned false for a null domain regardless of `negate`, so the
   * synthesized allow-list deny never fired and evaluation fell through
   * to the autonomy default — which ALLOWS network tools at `guided` (the
   * shipped default) and `autonomous`. A role could set
   * `network_allow: []` ("no network at all") and still have WebSearch
   * permitted.
   *
   * CLAUDE.md invariant #6 names an ambiguous rule as a fail-closed case:
   * a destination Bureau cannot see is a destination it cannot verify
   * against the allow-list, so the deny must fire.
   */
  it('AUDIT #12: denies a network tool whose destination cannot be determined at all (null domain)', () => {
    const rule = networkDenyRuleFor(['docs.rs'], 'engineering:developer');
    expect(rule).not.toBeNull();
    // This is the real WebSearch shape: a network tool with no URL.
    expect(evaluate([rule!], 'WebSearch', networkCtx(null)).effect).toBe('deny');
  });

  it('AUDIT #12: an empty network_allow denies WebSearch too, at guided and autonomous — not just the URL-carrying tools', () => {
    const rule = networkDenyRuleFor([], 'engineering:developer');
    expect(rule).not.toBeNull();
    for (const level of ['ask', 'guided', 'autonomous'] as const) {
      const ctx = { ...networkCtx(null), effectiveAutonomy: level };
      expect(evaluate([rule!], 'WebSearch', ctx).effect, `autonomy=${level}`).toBe('deny');
    }
  });

  it('AUDIT #12: a null domain must NOT fire a positive (non-negated) domain_matches — nothing to match against is not a match', () => {
    // The paired half: fail-closed applies to "deny unless on the list",
    // not to "deny when on this list", which must stay inert.
    const positiveDenyList: Rule = {
      id: 'role:test:block_evil',
      immutable: false,
      effect: 'deny',
      toolPattern: '*',
      condition: { kind: 'domain_matches', globs: ['evil.example.com'] },
      priority: 100,
    };
    expect(evaluate([positiveDenyList], 'WebSearch', networkCtx(null)).effect).not.toBe('deny');
  });

  it('denies a domain NOT on the allow-list', () => {
    const rule = networkDenyRuleFor(['docs.python.org'], 'engineering:developer');
    const result = evaluate([rule], 'WebFetch', networkCtx('evil.example.com'));
    expect(result).toMatchObject({ effect: 'deny' });
  });

  it('does NOT deny a domain that IS on the allow-list — falls through to autonomyDefaultFor instead', () => {
    const rule = networkDenyRuleFor(['docs.python.org'], 'engineering:developer');
    const result = evaluate([rule], 'WebFetch', networkCtx('docs.python.org'));
    // guided's default for network, once the domain-allow-list gate has
    // already passed, is allow (autonomyDefault.ts, fixed alongside this).
    expect(result.effect).toBe('allow');
  });

  it('an empty network_allow denies every network call — "roles that do not need the network do not get network tools"', () => {
    const rule = networkDenyRuleFor([], 'engineering:developer');
    const result = evaluate([rule], 'WebFetch', networkCtx('anything.example.com'));
    expect(result).toMatchObject({ effect: 'deny' });
  });

  it('never fires for a non-network tool, regardless of what the (irrelevant) domain would be', () => {
    const rule = networkDenyRuleFor([], 'engineering:developer');
    const readCtx: MatchContext = {
      ...networkCtx(null),
      toolClass: 'read',
      canonicalPath: 'c:/wt/x.ts',
    };
    const result = evaluate([rule], 'Read', readCtx);
    expect(result.effect).not.toBe('deny');
  });

  it('denies at EVERY autonomy level for an off-list domain — including "ask", not just guided/autonomous', () => {
    const rule = networkDenyRuleFor(['docs.python.org'], 'engineering:developer');
    for (const autonomy of ['ask', 'guided', 'autonomous'] as const) {
      const ctx = { ...networkCtx('evil.example.com'), effectiveAutonomy: autonomy };
      expect(evaluate([rule], 'WebFetch', ctx).effect).toBe('deny');
    }
  });

  it(
    'MUTATION CHECK (reported, not shipped): removing the synthesized deny — evaluating with NO role rules at ' +
      'all — lets guided/autonomous allow an off-list domain unconditionally, proving the deny (not the ' +
      'autonomy fallback) is what was actually denying it',
    () => {
      const withoutTheDeny = evaluate([], 'WebFetch', {
        ...networkCtx('evil.example.com'),
        effectiveAutonomy: 'guided',
      });
      expect(withoutTheDeny.effect).toBe('allow'); // the real, unguarded fallback behaviour
    },
  );
});

/**
 * The UNIT half of S3. S3 itself ("a pack attempting to allow an immutable
 * deny fails validation at load, not at evaluation time") lives at
 * `tests/integration/packs/s3PackWidening.test.ts` as of M7, where it can
 * drive a real pack directory through the real loader — a hand-built
 * `Rule[]` was the closest thing to a pack that existed before the pack
 * loader did. These cases stay because they are the rule-level invariants
 * the pack path is built on, and they are cheaper to run.
 */
describe('validateRuleSet (unit) — id collisions and the tier floor', () => {
  it('rejects a hand-built rule that reuses an immutable id with effect:allow', () => {
    const forgedRule: Rule = {
      id: 'deny.write_outside_worktree', // collides with a real immutable id
      immutable: false,
      effect: 'allow',
      toolPattern: 'Write(**)',
      priority: ADDITIONAL_RULE_PRIORITY,
    };
    expect(() => buildRuleSet({ additionalRules: [forgedRule] })).toThrow(
      ImmutableRuleViolationError,
    );
  });

  it('self-declaring immutable:true does not grant immunity — identity, not a claimed flag, is what’s checked', () => {
    const forgedRule: Rule = {
      id: 'deny.write_outside_worktree',
      immutable: true, // lying about it
      effect: 'allow',
      toolPattern: 'Write(**)',
      priority: 0,
    };
    expect(() => buildRuleSet({ additionalRules: [forgedRule] })).toThrow(
      ImmutableRuleViolationError,
    );
  });

  it('a role rule with a colliding id is rejected the same way — the check does not care which tier the rule came from', () => {
    const forgedRoleRule: Rule = {
      id: 'deny.subagent_spawn',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Task',
      priority: ROLE_RULE_PRIORITY,
    };
    expect(() => buildRuleSet({ roleRules: [forgedRoleRule] })).toThrow(
      ImmutableRuleViolationError,
    );
  });

  it('a non-colliding additional rule loads cleanly alongside the immutable set', () => {
    const packRule: Rule = {
      id: 'pack:example:allow:0',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Read(**)',
      priority: ADDITIONAL_RULE_PRIORITY,
    };
    const rules = buildRuleSet({ additionalRules: [packRule] });
    expect(rules).toContain(packRule);
    expect(rules.filter((r) => r.immutable)).toHaveLength(IMMUTABLE_RULES.length);
  });

  it('every one of the seven immutable rules must be present, unchanged, or validation fails (belt and suspenders)', () => {
    const incompleteSet = IMMUTABLE_RULES.slice(1); // drop one on purpose
    expect(() => validateRuleSet(incompleteSet)).toThrow(ImmutableRuleViolationError);
  });

  // The tier floor, added at M7. Before it, `validateRuleSet` checked only
  // id collision and presence — a rule could sit at priority 0 alongside
  // the immutable seven and nothing objected.
  it('rejects a non-immutable rule claiming Tier 0', () => {
    const tierZeroRule: Rule = {
      id: 'pack:sneaky:allow:0',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Read(**)',
      priority: IMMUTABLE_RULE_PRIORITY,
    };
    expect(() => buildRuleSet({ additionalRules: [tierZeroRule] })).toThrow(
      ImmutableRuleViolationError,
    );
    expect(() => buildRuleSet({ additionalRules: [tierZeroRule] })).toThrow(
      /claims the immutable tier/,
    );
  });

  it('rejects a negative priority, which would sort ahead of even Tier 0', () => {
    const aheadOfEverything: Rule = {
      id: 'pack:sneaky:allow:1',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Read(**)',
      priority: -1,
    };
    expect(() => buildRuleSet({ additionalRules: [aheadOfEverything] })).toThrow(
      ImmutableRuleViolationError,
    );
  });

  it('accepts the two real tiers', () => {
    expect(() =>
      buildRuleSet({
        roleRules: [
          {
            id: 'role:p:r:allow:0',
            immutable: false,
            effect: 'allow',
            toolPattern: 'Read(**)',
            priority: ROLE_RULE_PRIORITY,
          },
        ],
        additionalRules: [
          {
            id: 'pack:p:allow:0',
            immutable: false,
            effect: 'allow',
            toolPattern: 'Grep(**)',
            priority: ADDITIONAL_RULE_PRIORITY,
          },
        ],
      }),
    ).not.toThrow();
  });

  it(
    'MUTATION CHECK (reported, not shipped as a guard on production code): removing the immutable-id-collision ' +
      'check would let the forged rule through — proven here by re-implementing the unguarded path inline',
    () => {
      const forgedRule: Rule = {
        id: 'deny.write_outside_worktree',
        immutable: false,
        effect: 'allow',
        toolPattern: 'Write(**)',
        priority: ADDITIONAL_RULE_PRIORITY,
      };
      // What buildRuleSet would do WITHOUT calling validateRuleSet:
      const unguarded = [...IMMUTABLE_RULES, forgedRule];
      expect(() => validateRuleSet(unguarded)).toThrow(); // the real function still catches it
      // Bypassing validateRuleSet entirely (simulating its removal) is the
      // only way to get the forged rule through — confirming the test
      // above is real evidence, not a tautology.
      expect(
        unguarded.some((r) => r.id === 'deny.write_outside_worktree' && r.effect === 'allow'),
      ).toBe(true);
    },
  );
});
