/**
 * §11.3 (M6) — the real permission-rule grammar and evaluator's own types.
 * Deliberately three separate, non-interchangeable "verdict" shapes exist
 * in this codebase, on purpose, not by accident:
 *
 *   - `Verdict` (this file) — the evaluator's own internal type. Includes
 *     `ask`, because the evaluator can genuinely produce it.
 *   - `PolicyVerdict` (src/shared/engine/types.ts, §7.1.1) — the
 *     adapter-facing shape. Excludes `ask`: "'ask' is resolved to
 *     allow/deny by the Core before reaching the adapter."
 *   - `PolicyCheckResponseSchema` (src/shared/controlChannel/schemas.ts)
 *     — the wire shape between the Core and bureau-hook. Also excludes
 *     `ask`, for the same reason, for a different boundary.
 *
 * §11.3 used to carry an HTML comment flagging `Verdict` as used-but-
 * undefined. This file is where it's defined; the flag comment is removed
 * in the same commit.
 */
import type { Autonomy } from '../models/enums';

/** §11.3: "declared by each adapter" — read/write/command/network/bureau,
 * plus `other`, which is not a real engine class but the fallback bucket
 * for any tool name an adapter's own classification map doesn't cover. */
export type ToolClass = 'read' | 'write' | 'command' | 'network' | 'bureau' | 'other';

export type RuleEffect = 'allow' | 'deny' | 'ask';

export type Verdict =
  | { effect: 'allow'; ruleId: string }
  | { effect: 'deny'; ruleId: string; reason: string }
  | { effect: 'ask'; ruleId: string; reason: string };

/** One term of the pattern grammar: `TOOL "(" argglob ")" | TOOL`. A bare
 * `argGlob: null` means the term matches the named tool regardless of
 * arguments. */
export interface PatternTerm {
  tool: string;
  argGlob: string | null;
}

/**
 * The seven condition kinds are an exhaustive list per §11.3 — this union
 * is deliberately complete even though two of them
 * (`sql_statement_kind_not_in`, `catalog_matches`) have no real tool in
 * §23's inventory to exercise them against yet (no SQL/catalog tool
 * exists). Kept type-complete rather than dropped, so a future rule using
 * them doesn't require another type-level pass — see conditions.ts for
 * the (honestly unexercised) evaluation logic.
 */
export type Condition =
  | { kind: 'path_matches'; globs: readonly string[] }
  | { kind: 'path_outside'; roots: readonly string[] }
  | { kind: 'domain_matches'; globs: readonly string[] }
  | { kind: 'sql_statement_kind_not_in'; kinds: readonly string[] }
  | { kind: 'catalog_matches'; globs: readonly string[] }
  | { kind: 'arg_regex'; pattern: string; flags?: string }
  | { kind: 'time_window'; startHourLocal: number; endHourLocal: number };

/**
 * The evaluator's own internal rule shape — what `immutableRules.ts`,
 * role-derived rules, and (M7) pack-derived rules all compile down to
 * before `evaluate()` ever sees them.
 */
export interface Rule {
  id: string;
  immutable: boolean;
  effect: RuleEffect;
  /** Raw pattern string, e.g. `"Write(**)|Edit(**)|MultiEdit(**)"` — parsed
   * lazily by patternGrammar.ts, not pre-parsed here, so a Rule stays a
   * plain, loggable, JSON-serialisable object. */
  toolPattern: string;
  condition?: Condition;
  /** Required in practice for deny/ask (validated at load by ruleLoader.ts,
   * not by the type — a hand-built test rule that omits it for `allow`
   * is legitimate). */
  reason?: string;
  /** Lower runs earlier. Only affects which rule's id gets attributed to
   * the first non-deny match — a `deny` always wins immediately
   * regardless of scan position. See ruleLoader.ts's tier constants. */
  priority: number;
}

/** Variables available in patterns and path conditions (§11.3). `null`
 * means "unset for this context" (e.g. `${worktree}` for the Director) —
 * never `''`, so callers can't accidentally treat "unset" and "empty
 * string root" as the same thing. */
export interface PolicyVariables {
  worktree: string | null;
  project: string | null;
  home: string | null;
  bureau_state: string | null;
}

/** Everything `matchCondition`/`matchToolPattern` need about the call
 * being evaluated, already canonicalised where relevant. Built by
 * src/main/controlChannel/policy/contextBuilder.ts — this file itself
 * stays Node-free. */
export interface MatchContext {
  toolClass: ToolClass;
  /** Canonicalised absolute path, only present for file-tool classes
   * (`read`/`write`) — canonicalisation itself requires `fs.realpathSync
   * .native`, so it happens in main/ and arrives here pre-computed. */
  canonicalPath: string | null;
  /** Whitespace-normalised command line (Bash) or canonical JSON (MCP
   * tools) — whatever the adapter's own "canonical argument string" rule
   * produces for this tool. Used for `arg_regex` and for the argglob half
   * of the pattern grammar. */
  canonicalArg: string;
  /** Hostname extracted from network-tool args (e.g. `args.url`), if any. */
  domain: string | null;
  variables: PolicyVariables;
  effectiveAutonomy: Autonomy;
  now: Date;
  /** The raw, un-canonicalised tool arguments — only consulted by
   * `sql_statement_kind_not_in`/`catalog_matches` (see conditions.ts),
   * since no §23 tool has a stable path/domain-shaped arg for those. */
  rawArgs: unknown;
}

/**
 * §7.10's evaluator seam — defined here (not in server.ts, where it used
 * to live) so both `server.ts` and `src/main/controlChannel/policy/
 * policyEvaluator.ts` (the real implementation) can import one shared
 * type without a circular import between them.
 */
export interface PolicyEvaluatorRequest {
  tool: string;
  rawTool: string;
  args: unknown;
  preview: string;
}

export type PolicyEvaluatorFn = (request: PolicyEvaluatorRequest, employeeId: string) => Promise<Verdict>;
