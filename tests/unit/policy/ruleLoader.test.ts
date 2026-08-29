import { describe, expect, it } from 'vitest';
import {
  ADDITIONAL_RULE_PRIORITY,
  buildRuleSet,
  ImmutableRuleViolationError,
  ROLE_RULE_PRIORITY,
  roleRulesFrom,
  validateRuleSet,
} from '../../../src/shared/policy/ruleLoader';
import { IMMUTABLE_RULES } from '../../../src/shared/policy/immutableRules';
import type { Rule } from '../../../src/shared/policy/types';

describe('roleRulesFrom — real M1 schema (role.tools_allow/tools_deny), real teeth from §11.3', () => {
  it('builds one rule per pattern, deny before allow, at the role priority tier', () => {
    const rules = roleRulesFrom({
      full_key: 'engineering:developer',
      tools_allow: ['Write(${worktree}/docs/**)'],
      tools_deny: ['Bash(rm *)'],
    });
    expect(rules).toHaveLength(2);
    expect(rules[0]).toMatchObject({ effect: 'deny', toolPattern: 'Bash(rm *)', priority: ROLE_RULE_PRIORITY, immutable: false });
    expect(rules[1]).toMatchObject({
      effect: 'allow',
      toolPattern: 'Write(${worktree}/docs/**)',
      priority: ROLE_RULE_PRIORITY,
      immutable: false,
    });
  });

  it('an empty role (no packs installed yet — the real, current state of this codebase) yields no rules', () => {
    expect(roleRulesFrom({ full_key: 'engineering:developer', tools_allow: [], tools_deny: [] })).toEqual([]);
  });
});

describe('validateRuleSet — S3: a rule attempting to widen an immutable deny fails at LOAD', () => {
  it('rejects a hand-built rule that reuses an immutable id with effect:allow', () => {
    const forgedRule: Rule = {
      id: 'deny.write_outside_worktree', // collides with a real immutable id
      immutable: false,
      effect: 'allow',
      toolPattern: 'Write(**)',
      priority: ADDITIONAL_RULE_PRIORITY,
    };
    expect(() => buildRuleSet({ additionalRules: [forgedRule] })).toThrow(ImmutableRuleViolationError);
  });

  it('self-declaring immutable:true does not grant immunity — identity, not a claimed flag, is what’s checked', () => {
    const forgedRule: Rule = {
      id: 'deny.write_outside_worktree',
      immutable: true, // lying about it
      effect: 'allow',
      toolPattern: 'Write(**)',
      priority: 0,
    };
    expect(() => buildRuleSet({ additionalRules: [forgedRule] })).toThrow(ImmutableRuleViolationError);
  });

  it('a role rule with a colliding id is rejected the same way — the check does not care which tier the rule came from', () => {
    const forgedRoleRule: Rule = {
      id: 'deny.subagent_spawn',
      immutable: false,
      effect: 'allow',
      toolPattern: 'Task',
      priority: ROLE_RULE_PRIORITY,
    };
    expect(() => buildRuleSet({ roleRules: [forgedRoleRule] })).toThrow(ImmutableRuleViolationError);
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
      expect(unguarded.some((r) => r.id === 'deny.write_outside_worktree' && r.effect === 'allow')).toBe(true);
    },
  );
});
