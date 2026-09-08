import type { MatchContext, PolicyVariables, Rule, ToolClass } from './types';
import { IMMUTABLE_RULES } from './immutableRules';
import { compileGlob, parseToolPattern, splitTopLevel, matchToolName } from './patternGrammar';
import { expandTemplate } from './variables';
import { evaluate } from './evaluator';

/**
 * §6.7 check 5 — "no role declares a tool pattern that would widen an
 * immutable global deny (§11.3)", and CLAUDE.md's "do not let a pack widen
 * an immutable deny. Validation rejects it at load."
 *
 * ## What this is, and honestly what it is not
 *
 * It is **exemplar-based**, not a general glob-intersection proof. Each
 * immutable deny carries a handful of canonical calls it forbids; an allow
 * pattern that reaches for one of those exemplars is rejected, naming both
 * the pattern and the rule it collides with. A sufficiently exotic glob
 * could in principle overlap an immutable deny without touching any
 * exemplar, and this would not catch it.
 *
 * That limitation cannot open a runtime hole. The evaluator is deny-wins
 * and returns on the first matching deny regardless of priority, so an
 * allow never out-argues a deny at evaluation time. This check exists to
 * reject **misleading** packs at load — a pack author who writes
 * `Bash(git commit *)` in `tools_allow` should be told it will never take
 * effect, not left to discover it when an employee is blocked mid-task.
 *
 * ## Why the exemplars cannot silently rot
 *
 * `verifyExemplars()` runs the REAL evaluator over each exemplar against
 * the single immutable rule it claims to demonstrate, and throws if that
 * rule does not actually deny it. Without that, an edit to §11.3's rules
 * would leave this file quietly checking allow patterns against calls
 * nothing forbids any more — passing while testing nothing. It is called
 * at the top of `assertNoImmutableWidening`, so every real use pays for it.
 *
 * ## Why the variables are set
 *
 * `matchToolPatternWithVariables` DROPS any alternative referencing an
 * unset variable. With `worktree`/`project`/`home`/`bureau_state` all
 * null — the shape a plain unit test reaches for first — every
 * `${worktree}`-bearing pattern is dropped and this whole check becomes
 * vacuous. So a canonical synthetic set is used, and it is not optional.
 */

/** Not a real machine's paths — a fixed synthetic set, so the same pattern
 * validates identically on every machine and in every test. */
export const CANONICAL_POLICY_VARIABLES: PolicyVariables = {
  worktree: 'C:/bureau/wt',
  project: 'C:/bureau/proj',
  home: 'C:/bureau/home',
  bureau_state: 'C:/bureau/state',
};

interface Exemplar {
  /** The immutable rule this exemplar exists to demonstrate. */
  readonly ruleId: string;
  readonly tool: string;
  readonly toolClass: ToolClass;
  readonly canonicalArg: string;
  readonly canonicalPath: string | null;
  /** Plain language, for the error a pack author reads. */
  readonly describes: string;
}

const V = CANONICAL_POLICY_VARIABLES;

const EXEMPLARS: readonly Exemplar[] = [
  {
    ruleId: 'deny.write_outside_worktree',
    tool: 'Write',
    toolClass: 'write',
    canonicalArg: `${V.project}/src/index.ts`,
    canonicalPath: `${V.project}/src/index.ts`,
    describes:
      'writing to the canonical project checkout instead of the employee\u2019s own worktree',
  },
  {
    ruleId: 'deny.read_outside_project',
    tool: 'Read',
    toolClass: 'read',
    canonicalArg: `${V.home}/Documents/notes.txt`,
    canonicalPath: `${V.home}/Documents/notes.txt`,
    describes: 'reading outside the worktree, the project, and the scratch space',
  },
  {
    ruleId: 'deny.credential_paths',
    tool: 'Read',
    toolClass: 'read',
    // Deliberately INSIDE the worktree: a credential-shaped path that
    // `deny.read_outside_project` would not catch, so this exemplar
    // isolates its own rule instead of being denied incidentally.
    canonicalArg: `${V.worktree}/.env`,
    canonicalPath: `${V.worktree}/.env`,
    describes: 'reading a credential-shaped path',
  },
  {
    ruleId: 'deny.credential_paths',
    tool: 'Read',
    toolClass: 'read',
    canonicalArg: `${V.worktree}/config/id_rsa.pem`,
    canonicalPath: `${V.worktree}/config/id_rsa.pem`,
    describes: 'reading a private key',
  },
  {
    ruleId: 'deny.system_paths',
    tool: 'Read',
    toolClass: 'read',
    canonicalArg: 'C:/Windows/System32/drivers/etc/hosts',
    canonicalPath: 'C:/Windows/System32/drivers/etc/hosts',
    describes: 'reaching into a Windows system path',
  },
  {
    ruleId: 'deny.system_paths',
    tool: 'Read',
    toolClass: 'read',
    // Bureau's own state, memory included (§12.1) — an employee's file
    // tools must never reach it; Core-side code writes it.
    canonicalArg: `${V.home}/AppData/Roaming/Bureau/memory/company/standards.md`,
    canonicalPath: `${V.home}/AppData/Roaming/Bureau/memory/company/standards.md`,
    describes: 'reaching into Bureau\u2019s own state directory',
  },
  {
    ruleId: 'deny.git_write',
    tool: 'Bash',
    toolClass: 'command',
    canonicalArg: 'git commit -m "wip"',
    canonicalPath: null,
    describes: 'committing — the Core is the sole committer (CLAUDE.md invariant #4)',
  },
  {
    ruleId: 'deny.git_write',
    tool: 'Bash',
    toolClass: 'command',
    canonicalArg: 'git push origin main',
    canonicalPath: null,
    describes: 'pushing',
  },
  {
    ruleId: 'deny.destructive',
    tool: 'Bash',
    toolClass: 'command',
    canonicalArg: 'rm -rf /var/data',
    canonicalPath: null,
    describes: 'a destructive recursive delete',
  },
  {
    ruleId: 'deny.subagent_spawn',
    tool: 'Task',
    toolClass: 'other',
    canonicalArg: '{}',
    canonicalPath: null,
    describes: 'spawning a sub-agent outside every one of Bureau\u2019s controls',
  },
  {
    ruleId: 'deny.subagent_spawn',
    tool: 'mcp__somepack__spawn_worker',
    toolClass: 'other',
    canonicalArg: '{}',
    canonicalPath: null,
    describes: 'spawning a sub-agent through an MCP server',
  },
];

function contextFor(exemplar: Exemplar): MatchContext {
  return {
    toolClass: exemplar.toolClass,
    canonicalPath: exemplar.canonicalPath,
    canonicalArg: exemplar.canonicalArg,
    domain: null,
    variables: CANONICAL_POLICY_VARIABLES,
    // Irrelevant here — every exemplar is proven to hit an explicit deny,
    // which returns before `autonomyDefaultFor` is ever consulted.
    effectiveAutonomy: 'autonomous',
    now: new Date('2026-01-01T12:00:00Z'),
    rawArgs: {},
  };
}

export class ExemplarDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExemplarDriftError';
  }
}

/**
 * The anti-vacuity guard. Every exemplar must actually be denied by the
 * one immutable rule it names — checked against the real evaluator, one
 * rule at a time so the attribution is exact rather than "something in the
 * set denied it".
 */
export function verifyExemplars(): void {
  const byId = new Map(IMMUTABLE_RULES.map((rule) => [rule.id, rule]));
  for (const exemplar of EXEMPLARS) {
    const rule = byId.get(exemplar.ruleId);
    if (!rule) {
      throw new ExemplarDriftError(
        `check 5 has an exemplar for "${exemplar.ruleId}", which is no longer an immutable rule.`,
      );
    }
    const verdict = evaluate([rule], exemplar.tool, contextFor(exemplar));
    if (verdict.effect !== 'deny') {
      throw new ExemplarDriftError(
        `check 5's exemplar "${exemplar.tool}: ${exemplar.canonicalArg}" is no longer denied by ` +
          `${exemplar.ruleId} (got "${verdict.effect}") — the check would silently pass while testing nothing.`,
      );
    }
  }
}

/**
 * A deny that names TOOLS rather than arguments or paths: every term is a
 * bare tool name and there is no condition. For these the denied thing IS
 * the tool, so any allow reaching the tool at all is a widening — there is
 * no "broad grant with a carve-out" reading available.
 */
function deniesToolIdentity(rule: Rule): boolean {
  if (rule.condition !== undefined) return false;
  return parseToolPattern(rule.toolPattern).every((term) => term.argGlob === null);
}

/**
 * `Read(**)` is how §6.5's own example role says "this role reads files",
 * and the immutable denies carve the exceptions out of it at evaluation
 * time. Flagging that would make the spec's own reference role
 * uninstallable. What check 5 is actually looking for is an allow AIMED at
 * forbidden ground — `Read(${home}/.ssh/**)`, `Write(${project}/**)`,
 * `Bash(git commit *)` — so an unrestricted argglob is not a widening and
 * a targeted one is.
 */
function isUnrestrictedArgGlob(glob: string): boolean {
  const trimmed = glob.trim();
  return trimmed === '**' || trimmed === '*';
}

function matchOptionsFor(toolClass: ToolClass): {
  pathSemantics: boolean;
  caseInsensitive: boolean;
} {
  const isPathClass = toolClass === 'read' || toolClass === 'write';
  return { pathSemantics: isPathClass, caseInsensitive: isPathClass };
}

/**
 * Returns one readable error per (allow pattern, immutable rule) collision.
 * Empty means nothing widens.
 *
 * Takes `Rule[]` rather than a role, deliberately: today only
 * `roleRulesFrom`'s Tier-100 output is fed here, because §6.3/§6.5 give a
 * pack no rule syntax beyond `tools_allow`/`tools_deny`. Whoever first
 * feeds the Tier-200 `additionalRules` seam calls this same function on
 * the same shape rather than reinventing it.
 *
 * Only `allow` rules are examined. An `ask` or `deny` rule cannot widen a
 * deny — the evaluator returns on the first matching deny regardless of
 * what else matched.
 *
 * NOT folded into `validateRuleSet`, which would close the seam
 * permanently, because `buildRuleSet` runs on EVERY policy check
 * (`policyEvaluator.ts` rebuilds the set per `/v1/policy/check`) and this
 * is real regex compilation across rules x exemplars. Load-time work
 * belongs at load time, which is also the only place the readable error is
 * any use.
 */
export function assertNoImmutableWidening(rules: readonly Rule[]): string[] {
  verifyExemplars();

  const errors: string[] = [];
  const immutableObjects = new Set<Rule>(IMMUTABLE_RULES);
  const byId = new Map(IMMUTABLE_RULES.map((rule) => [rule.id, rule]));

  for (const rule of rules) {
    if (immutableObjects.has(rule) || rule.effect !== 'allow') continue;

    for (const exemplar of EXEMPLARS) {
      const immutable = byId.get(exemplar.ruleId)!;
      const options = matchOptionsFor(exemplar.toolClass);
      const collision = termCollides(rule.toolPattern, exemplar, immutable, options);
      if (collision === null) continue;
      errors.push(
        `tool pattern "${rule.toolPattern}" (rule ${rule.id}) would allow ${exemplar.describes}, ` +
          `which ${exemplar.ruleId} denies and no role, pack, or setting can override (§11.3). ` +
          `The offending part is "${collision}".`,
      );
      // One error per rule is enough to make the point; listing every
      // exemplar the same bad pattern reaches would bury the fix.
      break;
    }
  }

  return errors;
}

/** The offending term/alternative if this pattern reaches the exemplar, else null. */
function termCollides(
  toolPattern: string,
  exemplar: Exemplar,
  immutable: Rule,
  options: { pathSemantics: boolean; caseInsensitive: boolean },
): string | null {
  const toolIdentity = deniesToolIdentity(immutable);
  const deniedToolPatterns = toolIdentity
    ? parseToolPattern(immutable.toolPattern).map((t) => t.tool)
    : [];

  for (const term of parseToolPattern(toolPattern)) {
    if (toolIdentity) {
      // For a tool-identity deny the comparison runs in BOTH directions,
      // and the second one is the load-bearing half. Exemplar-matching
      // alone (`matchToolName(term.tool, exemplar.tool)`) catches a
      // literal `Task` and a blanket `*`, but a pack allowing its own
      // `mcp__mypack__spawn_helper` never equals the exemplar's name — it
      // is the DENY's `mcp__*__spawn_*` that matches IT. Checking only one
      // direction would let every concretely-named spawn tool through,
      // which is the exact family §11.3 wrote a glob to cover.
      const reachesExemplar = matchToolName(term.tool, exemplar.tool);
      const isDeniedByName = deniedToolPatterns.some((denied) => matchToolName(denied, term.tool));
      if (!reachesExemplar && !isDeniedByName) continue;
      return term.argGlob === null ? term.tool : `${term.tool}(${term.argGlob})`;
    }

    if (!matchToolName(term.tool, exemplar.tool)) continue;
    // A bare tool name here means "all of this tool" — the broad grant the
    // immutable rule carves its exception out of, not a targeted one.
    if (term.argGlob === null) continue;

    for (const alt of splitTopLevel(term.argGlob, '|')) {
      if (isUnrestrictedArgGlob(alt)) continue;
      const expanded = expandTemplate(alt, CANONICAL_POLICY_VARIABLES);
      if (expanded === null) continue;
      if (compileGlob(expanded, options).test(exemplar.canonicalArg)) {
        return `${term.tool}(${alt.trim()})`;
      }
    }
  }
  return null;
}
