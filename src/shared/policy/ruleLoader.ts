import type { Role } from '../models/role';
import type { Rule } from './types';
import { IMMUTABLE_RULES, IMMUTABLE_RULE_IDS, IMMUTABLE_RULE_PRIORITY } from './immutableRules';
import { WILDCARD_TOOL_PATTERN } from './patternGrammar';

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
 * Does NOT construct a rule from `role.network_allow` — that's
 * `networkDenyRuleFor`, below, called separately (and unconditionally,
 * even with no role at all — see its own comment) rather than folded in
 * here.
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
 * §11.2's own table only has "domain allow-list" cells for network tools,
 * never an unconditional "allow" — an allow-list in a deny-wins evaluator
 * IS a deny: every network-tool call whose domain is NOT on
 * `role.network_allow` is denied, unconditionally, regardless of
 * autonomy. §11.2's ask/guided/autonomous distinction then falls out of
 * `autonomyDefaultFor` alone, once this filter has already run:
 *
 *   ask         on-list → no rule matched → default → ask     off-list → THIS rule denies
 *   guided      on-list → no rule matched → default → allow   off-list → THIS rule denies
 *   autonomous  on-list → no rule matched → default → allow   off-list → THIS rule denies
 *
 * The alternative (an ALLOW rule for on-list domains) would also fire at
 * `ask` autonomy, since a matched rule wins regardless of autonomy level
 * — §11.3's exhaustive condition list has no "autonomy" condition to
 * suppress that, which is exactly why this has to be the inverted deny
 * instead.
 *
 * `WILDCARD_TOOL_PATTERN` + a toolClass-gated condition, same shape as
 * `deny.system_paths`: the pattern matches any tool name, the condition
 * (gated to `toolClass === 'network'` in conditions.ts) does the real
 * filtering, so this rule is structurally harmless against Read/Write/
 * Bash calls regardless of what `networkAllow` contains.
 *
 * Called UNCONDITIONALLY by policyEvaluator.ts — including when the
 * employee has no role row at all (`networkAllow: []`), not gated behind
 * "if a role exists" the way `roleRulesFrom` is. A role-less employee
 * with no such rule would fall straight through to `autonomyDefaultFor`,
 * which (after this fix) allows network calls unconditionally at guided/
 * autonomous — the exact gap this function exists to close for every
 * employee, role or no role.
 */
export function networkDenyRuleFor(networkAllow: readonly string[], roleKeyForId: string): Rule {
  return {
    id: `role:${roleKeyForId}:network_deny`,
    immutable: false,
    effect: 'deny',
    toolPattern: WILDCARD_TOOL_PATTERN,
    condition: { kind: 'domain_matches', globs: networkAllow, negate: true },
    reason:
      networkAllow.length === 0
        ? `role ${roleKeyForId} has no network_allow entries — no network tool is permitted`
        : `domain is not on role ${roleKeyForId}'s network_allow list`,
    priority: ROLE_RULE_PRIORITY,
  };
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
    // The tier floor. Tier 0 belongs to §11.3's seven and nothing else:
    // a role- or pack-supplied rule that sets `priority: 0` (or lower) is
    // claiming Tier 0's scan position, which decides which rule's id gets
    // attributed to an allow/ask verdict. It cannot beat a deny — the
    // evaluator returns on the first matching deny regardless of order —
    // but it CAN take credit for an allow ahead of an immutable rule, and
    // "a pack rule may not sit in the immutable tier" is a rule worth
    // stating in one place rather than trusting every caller to respect.
    //
    // Added at M7 with the pack loader, and load-bearing for S3: without
    // it, inverting IMMUTABLE_RULE_PRIORITY (0 -> 150) changes real
    // ordering and nothing objects.
    if (rule.priority <= IMMUTABLE_RULE_PRIORITY) {
      throw new ImmutableRuleViolationError(
        rule.id,
        `declares priority ${rule.priority}, which claims the immutable tier ` +
          `(${IMMUTABLE_RULE_PRIORITY}) — role rules run at ${ROLE_RULE_PRIORITY} and additional ` +
          `rules at ${ADDITIONAL_RULE_PRIORITY}`,
      );
    }
  }

  // Belt and suspenders: every one of the seven must still be present,
  // unchanged — defends against a future refactor accidentally letting
  // something replace the array entry itself rather than merely
  // appending alongside it.
  for (const immutableRule of IMMUTABLE_RULES) {
    if (!rules.includes(immutableRule)) {
      throw new ImmutableRuleViolationError(
        immutableRule.id,
        'is missing from the loaded rule set',
      );
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
export function buildRuleSet(
  options: { roleRules?: readonly Rule[]; additionalRules?: readonly Rule[] } = {},
): Rule[] {
  // `Rule.priority` is required, not optional — an M7 pack rule fed
  // through `additionalRules` must set its own; `ADDITIONAL_RULE_PRIORITY`
  // is the recommended value (documented above), not a silent default,
  // since a pack loader may legitimately need its own finer-grained tiers.
  const rules: Rule[] = [
    ...IMMUTABLE_RULES,
    ...(options.roleRules ?? []),
    ...(options.additionalRules ?? []),
  ];
  validateRuleSet(rules);
  return rules;
}
