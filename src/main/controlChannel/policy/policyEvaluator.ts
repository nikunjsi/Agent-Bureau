import type Database from 'better-sqlite3';
import { getSetting } from '../../db/repositories/settings';
import type { PolicyEvaluatorFn, PolicyEvaluatorRequest, Verdict } from '../../../shared/policy/types';
import { evaluate } from '../../../shared/policy/evaluator';
import { buildRuleSet, roleRulesFrom } from '../../../shared/policy/ruleLoader';
import { buildEmployeePolicyContext } from './contextBuilder';
import { capabilitiesForEngine, classifyTool } from './toolClassify';
import { extractArgs } from './argExtraction';
import { LoopDetector } from './loopDetector';

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
 */
export function createPolicyEvaluator(
  db: Database.Database,
  baseDir: string,
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
    const capabilities = await capabilitiesForEngine(ctx.employee.engine);
    const toolClass = classifyTool(request.tool, capabilities);

    const extracted = extractArgs(toolClass, request.args, ctx.variables.worktree ?? ctx.variables.project);

    const rules = buildRuleSet({ roleRules: ctx.role ? roleRulesFrom(ctx.role) : [] });

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
