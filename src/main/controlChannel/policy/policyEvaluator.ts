import type Database from 'better-sqlite3';
import { getSetting } from '../../db/repositories/settings';
import type { PolicyEvaluatorFn, PolicyEvaluatorRequest, Verdict } from '../../../shared/policy/types';
import { evaluate } from '../../../shared/policy/evaluator';
import { buildRuleSet, networkDenyRuleFor, roleRulesFrom } from '../../../shared/policy/ruleLoader';
import { buildEmployeePolicyContext } from './contextBuilder';
import { classifyTool } from './toolClassify';
import { extractArgs } from './argExtraction';
import { LoopDetector } from './loopDetector';
import type { SupervisorRegistry } from '../../engine/supervisorRegistry';

/** ruleId the loop detector's forced ask carries — `handlePolicyCheck`
 * checks for this exact id to also emit the dedicated `tool.loop_detected`
 * event alongside its normal tool.allowed/tool.denied bookkeeping. */
export const LOOP_DETECTED_RULE_ID = 'breaker.loop_detected';

export interface CreatePolicyEvaluatorOptions {
  /** Injectable clock, for the loop detector's sliding window in tests. */
  now?: () => number;
}

/**
 * Replaces the deleted interim `policyEvaluator.ts` through the exact
 * seam `server.ts`/`bureau-hook`/`checkPolicyFailClosed` already use
 * (`PolicyEvaluatorFn`) — not a parallel path. Closes over `db` and
 * `baseDir` (Electron's userData root, needed to compute `${bureau_state}`
 * per employee — same value `main/index.ts` already passes to
 * `getDbPaths`/`reconcile()` via `app.getPath('userData')`).
 *
 * `supervisorRegistry` (M6 session 2, Fix B): the real, probe-and-mode-
 * aware `EngineCapabilities` for the calling employee now come from its
 * live `Supervisor` (`.getCapabilities()`), not a fabricated probe built
 * fresh per call. A policy check can only ever arrive from a real,
 * running employee process, so `supervisorRegistry.get(employeeId)`
 * should always resolve here in practice; `undefined`/not-yet-`assign()`ed
 * falls through to `capabilities: null`, which `classifyTool` already
 * treats as "other" — deny by default, not a crash.
 */
export function createPolicyEvaluator(
  db: Database.Database,
  baseDir: string,
  supervisorRegistry: SupervisorRegistry,
  options: CreatePolicyEvaluatorOptions = {},
): PolicyEvaluatorFn {
  const repeatedToolLimit = getSetting(db, 'breaker.repeatedToolLimit');
  const repeatedToolWindowS = getSetting(db, 'breaker.repeatedToolWindowS');
  const loopDetector = new LoopDetector({
    limit: repeatedToolLimit,
    windowMs: repeatedToolWindowS * 1000,
    ...(options.now ? { now: options.now } : {}),
  });

  return async function evaluatePolicy(request: PolicyEvaluatorRequest, employeeId: string): Promise<Verdict> {
    const ctx = buildEmployeePolicyContext(db, baseDir, employeeId);
    const capabilities = supervisorRegistry.get(employeeId)?.getCapabilities() ?? null;
    const toolClass = classifyTool(request.tool, capabilities);

    // §11.5, item 10 (M6 session 3) — the circuit breaker's "constrain"
    // step, wired exactly the way Fix B (session 2) wired live
    // capabilities: a live-Supervisor override, not a rewrite of
    // computeEffectiveAutonomy itself (which stays scoped to the
    // `autonomous`-confirmation gap only). NEVER written to
    // employees.autonomy — "computed, not persisted" holds exactly as
    // before; this is one more live input to the computation.
    if (supervisorRegistry.get(employeeId)?.isBreakerConstrained()) {
      ctx.effectiveAutonomy = 'ask';
    }

    const extracted = extractArgs(toolClass, request.args, ctx.variables.worktree ?? ctx.variables.project);

    // networkDenyRuleFor is called unconditionally, even with no role row
    // — a role-less employee (ctx.role === null) still needs the deny,
    // or autonomyDefaultFor('network') would allow unconditionally at
    // guided/autonomous with nothing left to filter it. See ruleLoader.ts's
    // own comment on why this can't be folded into roleRulesFrom's own
    // "only if a role exists" gate.
    const roleRules = [
      ...(ctx.role ? roleRulesFrom(ctx.role) : []),
      networkDenyRuleFor(ctx.role?.network_allow ?? [], ctx.role?.full_key ?? 'no-role'),
    ];
    const rules = buildRuleSet({ roleRules });

    const verdict = evaluate(rules, request.tool, {
      toolClass,
      canonicalPath: extracted.canonicalPath,
      canonicalArg: extracted.canonicalArg,
      domain: extracted.domain,
      variables: ctx.variables,
      effectiveAutonomy: ctx.effectiveAutonomy,
      now: new Date(),
      rawArgs: request.args,
    });

    // Loop detection only ever downgrades an `allow` to `ask` — an
    // existing `deny` is already the stricter outcome (nothing to gain by
    // also asking about something already blocked), and something that
    // already resolved to `ask` is untouched too. Tracked regardless of
    // verdict, so a denied-then-retried-identically pattern still counts
    // toward the window.
    const looping = loopDetector.recordAndCheck(employeeId, request.tool, extracted.canonicalArg);
    if (looping && verdict.effect === 'allow') {
      return {
        effect: 'ask',
        ruleId: LOOP_DETECTED_RULE_ID,
        reason: `${repeatedToolLimit} identical calls to "${request.tool}" within ${repeatedToolWindowS}s — forcing confirmation`,
      };
    }
    return verdict;
  };
}
