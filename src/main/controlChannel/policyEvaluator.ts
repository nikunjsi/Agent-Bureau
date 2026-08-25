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

/**
 * M4 session 2 trap #1: engines present MCP-server-provided tools as
 * `mcp__<server>__<tool>` (§11.3's own `deny.subagent_spawn` rule already
 * uses this exact shape — `mcp__*__spawn_*` — confirming the convention;
 * also independently confirmed against the current hooks docs). `bureau-
 * tools` (M4 session 2) registers its MCP server under this exact name, so
 * every real bureau_* tool call bureau-hook actually sees is named
 * `mcp__bureau__bureau_task_done`, not `bureau_task_done` — the interim
 * evaluator's bare `bureau_` prefix check would deny every one of Bureau's
 * own tools. Fixed here, matched against the real string, not a guess —
 * see the real-agent gate test for empirical confirmation.
 */
export const BUREAU_MCP_SERVER_NAME = 'bureau';
const MCP_BUREAU_TOOL_PREFIX = `mcp__${BUREAU_MCP_SERVER_NAME}__`;

export function evaluateInterimPolicy(toolName: string): InterimPolicyOutcome {
  if (HARDCODED_ALLOW_LIST_EXACT.has(toolName)) return 'allow';
  if (toolName.startsWith(MCP_BUREAU_TOOL_PREFIX)) return 'allow';
  // Kept alongside the MCP-namespaced check, not replaced by it: unit
  // tests (and any future non-MCP transport) can still exercise this
  // evaluator with a bare `bureau_*` name without needing to fabricate an
  // MCP-shaped string every time.
  if (toolName.startsWith(BUREAU_TOOL_PREFIX)) return 'allow';
  return 'deny';
}
