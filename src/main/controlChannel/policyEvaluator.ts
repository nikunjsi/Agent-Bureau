/**
 * §20.2's interim evaluator — the real one is M6. "Deny-by-default with a
 * small hardcoded allow-list (Read, Grep, Glob, the bureau_* tools).
 * Fail-closed holds, the gate works, deleted at M6." No partial policy
 * engine: no rule files, no pattern grammar (§11.3), no path
 * canonicalisation, no autonomy-level branching — those are all real,
 * separate M6 work this deliberately does not anticipate or half-build.
 *
 * §11.3's tool classes: `bureau` (Bureau's own tools) is declared "always
 * allowed" — expressed here as one more matched pattern (`bureau_*`), not
 * a separate bypass code path. A `bureau_*` call goes through this exact
 * function like everything else (§7.9: "every tool call is evaluated by
 * the policy engine like any other") — it just always matches.
 */
export type InterimPolicyOutcome = 'allow' | 'deny';

const HARDCODED_ALLOW_LIST_EXACT = new Set(['Read', 'Grep', 'Glob']);
const BUREAU_TOOL_PREFIX = 'bureau_';

export function evaluateInterimPolicy(toolName: string): InterimPolicyOutcome {
  if (HARDCODED_ALLOW_LIST_EXACT.has(toolName)) return 'allow';
  if (toolName.startsWith(BUREAU_TOOL_PREFIX)) return 'allow';
  return 'deny';
}
