import type { MatchContext, Rule, ToolClass, Verdict } from './types';
import { matchToolPatternWithVariables } from './patternGrammar';
import { matchCondition } from './conditions';
import { autonomyDefaultFor } from './autonomyDefault';

/**
 * M4 session 2 trap #1, carried forward: engines present MCP-server-
 * provided tools as `mcp__<server>__<tool>` (§11.3's own
 * `deny.subagent_spawn` rule already uses this exact shape —
 * `mcp__*__spawn_*`). `bureau-tools` registers its MCP server under this
 * exact name, so the real tool name bureau-hook actually sees for, say,
 * `bureau_task_done` is `mcp__bureau__bureau_task_done` — found against a
 * real agent, not from docs (see the real-agent gate test).
 */
export const BUREAU_MCP_SERVER_NAME = 'bureau';
const MCP_BUREAU_TOOL_PREFIX = `mcp__${BUREAU_MCP_SERVER_NAME}__`;
const BUREAU_TOOL_PREFIX = 'bureau_';

/** §23.2: "Bureau's own tools, always allowed." Kept alongside the
 * MCP-namespaced check, not replaced by it, so a bare `bureau_*` name
 * (unit tests, any future non-MCP transport) still short-circuits
 * without needing to fabricate an MCP-shaped string. Does NOT match a
 * same-named tool from a *different* MCP server (`mcp__other_server__
 * bureau_task_done`) — the server name is what's authoritative, not a
 * substring of the tool name. */
export function isBureauTool(tool: string): boolean {
  return tool.startsWith(MCP_BUREAU_TOOL_PREFIX) || tool.startsWith(BUREAU_TOOL_PREFIX);
}

function patternMatchOptionsFor(toolClass: ToolClass): {
  pathSemantics: boolean;
  caseInsensitive: boolean;
} {
  const isPathClass = toolClass === 'read' || toolClass === 'write';
  return { pathSemantics: isPathClass, caseInsensitive: isPathClass };
}

/**
 * CLAUDE.md invariant #6 names "ambiguous rule" explicitly as a
 * fail-closed case — but what "closed" means depends on the rule's own
 * effect, which `matchCondition` itself doesn't know. A condition that
 * throws (e.g. a malformed `arg_regex` pattern from a future role/pack
 * rule) is resolved here instead: for a `deny` rule, an error makes the
 * condition MATCH (the deny fires — the safe direction, since denying is
 * never the unsafe outcome). For `allow`/`ask`, an error makes it NOT
 * match (the rule doesn't fire, falls through to something stricter).
 * Defaulting a thrown error to "no match" unconditionally — as an
 * earlier version of this code did, inside `matchCondition` itself —
 * would be silently unsafe specifically for a malformed `deny` rule.
 */
function conditionMatchesFailClosed(rule: Rule, ctx: MatchContext): boolean {
  if (rule.condition === undefined) return true;
  try {
    return matchCondition(rule.condition, ctx);
  } catch {
    return rule.effect === 'deny';
  }
}

/**
 * §11.3's evaluation pseudocode, exactly:
 *
 *   let verdict: Verdict | null = null;
 *   for (const rule of rulesSortedByPriorityAscending) {
 *     if (!matches(rule, tool, args, ctx)) continue;
 *     if (rule.effect === 'deny') return DENY(rule);
 *     if (verdict === null) verdict = rule.effect === 'ask' ? ASK(rule) : ALLOW(rule);
 *   }
 *   return verdict ?? autonomyDefaultFor(toolClass);
 *
 * Plus the `bureau` short-circuit ahead of the scan (§23.2: "always
 * allowed" — checked first, not merely a high-priority allow rule among
 * others).
 */
export function evaluate(rules: readonly Rule[], tool: string, ctx: MatchContext): Verdict {
  if (isBureauTool(tool)) {
    return { effect: 'allow', ruleId: 'bureau.always_allow' };
  }

  const matchOptions = patternMatchOptionsFor(ctx.toolClass);
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  let verdict: Verdict | null = null;
  for (const rule of sorted) {
    const patternMatches = matchToolPatternWithVariables(
      rule.toolPattern,
      tool,
      ctx.canonicalArg,
      ctx.variables,
      matchOptions,
    );
    if (!patternMatches) continue;
    if (!conditionMatchesFailClosed(rule, ctx)) continue;

    if (rule.effect === 'deny') {
      return { effect: 'deny', ruleId: rule.id, reason: rule.reason ?? `denied by ${rule.id}` };
    }
    // Load-bearing: without this guard, a lower-priority ask/allow match
    // found later in the scan would silently overwrite an
    // already-recorded higher-priority verdict. See evaluator.test.ts's
    // dedicated test, constructed to fail if this guard is removed.
    if (verdict === null) {
      verdict =
        rule.effect === 'ask'
          ? { effect: 'ask', ruleId: rule.id, reason: rule.reason ?? `ask required by ${rule.id}` }
          : { effect: 'allow', ruleId: rule.id };
    }
    // keep scanning ONLY to find a deny
  }

  return verdict ?? autonomyDefaultFor(ctx.toolClass, ctx.effectiveAutonomy);
}
