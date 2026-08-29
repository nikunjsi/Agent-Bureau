import type { Role } from '../models/role';
import type { Rule } from './types';
import { IMMUTABLE_RULES, IMMUTABLE_RULE_IDS } from './immutableRules';

export const ROLE_RULE_PRIORITY = 100;
/** Default priority for M7-seam-supplied rules that don't set their own —
 * runs after role rules, before the autonomy-default fallback. */
export const ADDITIONAL_RULE_PRIORITY = 200;

export class ImmutableRuleViolationError extends Error {
  constructor(ruleId: string, reason: string) {
    super(
      `rule id "${ruleId}" ${reason} — immutable global rules cannot be overridden by any role, pack, or setting (§11.3).`,
    );
    this.name = 'ImmutableRuleViolationError';
  }
}

/**
 * Tier 100 — real M1 schema (`role.tools_allow`/`tools_deny`), not
 * invented this session; §11.3 is what gives these arrays real teeth. No
 * pack loader exists yet to populate a real role row with real content
 * (nothing in `src/main` seeds `roles`), so in practice these arrays are
 * empty for any role today — the mechanism is real, the content is M7's.
 *
 * Does NOT yet synthesise a rule from `role.network_allow` — see the
 * KNOWN GAP comment on the network branch of `autonomyDefault.ts`. The
 * `domain_matches` condition it would need is real and tested; nothing
 * constructs that rule from `network_allow` yet.
 */
export function roleRulesFrom(role: Pick<Role, 'full_key' | 'tools_allow' | 'tools_deny'>): Rule[] {
  const denyRules: Rule[] = role.tools_deny.map((pattern, index) => ({
    id: `role:${role.full_key}:deny:${index}`,
    immutable: false,
    effect: 'deny',
    toolPattern: pattern,
    reason: `denied by role ${role.full_key}'s tools_deny`,
    priority: ROLE_RULE_PRIORITY,
  }));
  const allowRules: Rule[] = role.tools_allow.map((pattern, index) => ({
    id: `role:${role.full_key}:allow:${index}`,
    immutable: false,
    effect: 'allow',
    toolPattern: pattern,
    priority: ROLE_RULE_PRIORITY,
  }));
  return [...denyRules, ...allowRules];
}

/**
 * S3: "a pack attempting to allow an immutable deny fails validation at
 * LOAD, not at evaluation time." The evaluator's own deny-wins-immediately
 * logic already makes an `allow` structurally unable to out-argue a
 * `deny` *during evaluation* regardless of priority — so the real attack
 * a role or (M7) pack could mount is replacing/shadowing an immutable
 * rule's id in the loaded set before evaluation ever runs. That's what
 * this guards.
 *
 * Deliberately does NOT trust an incoming rule's own `immutable` field —
 * only a rule that is one of the actual `IMMUTABLE_RULES` objects (by
 * identity) is exempt. A hand-built rule that merely sets `immutable:
 * true` on itself to try to slip past the id check is still rejected;
 * self-declaring immunity is not the same as being one of the real seven.
 */
export function validateRuleSet(rules: readonly Rule[]): void {
  const realImmutableObjects = new Set<Rule>(IMMUTABLE_RULES);

  for (const rule of rules) {
    if (realImmutableObjects.has(rule)) continue;
    if (IMMUTABLE_RULE_IDS.has(rule.id)) {
      throw new ImmutableRuleViolationError(rule.id, 'is reserved by an immutable global rule');
    }
  }

  // Belt and suspenders: every one of the seven must still be present,
  // unchanged — defends against a future refactor accidentally letting
  // something replace the array entry itself rather than merely
  // appending alongside it.
  for (const immutableRule of IMMUTABLE_RULES) {
    if (!rules.includes(immutableRule)) {
      throw new ImmutableRuleViolationError(immutableRule.id, 'is missing from the loaded rule set');
    }
  }
}

/**
 * Assembles the full rule set: Tier 0 (immutable, always first, always
 * real) + Tier 100 (role-supplied, real schema, empty content until M7's
 * pack loader exists) + Tier 200 (`additionalRules` — the explicit M7
 * seam; nothing in production passes this, tests pass a hand-built array
 * directly, never a parsed pack file). Validated at load, every time —
 * this IS "load", there being no separate persistent cache to load from
 * yet.
 */
export function buildRuleSet(options: { roleRules?: readonly Rule[]; additionalRules?: readonly Rule[] } = {}): Rule[] {
  // `Rule.priority` is required, not optional — an M7 pack rule fed
  // through `additionalRules` must set its own; `ADDITIONAL_RULE_PRIORITY`
  // is the recommended value (documented above), not a silent default,
  // since a pack loader may legitimately need its own finer-grained tiers.
  const rules: Rule[] = [...IMMUTABLE_RULES, ...(options.roleRules ?? []), ...(options.additionalRules ?? [])];
  validateRuleSet(rules);
  return rules;
}
