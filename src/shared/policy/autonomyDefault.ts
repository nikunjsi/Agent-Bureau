import type { Autonomy } from '../models/enums';
import type { ToolClass, Verdict } from './types';

/**
 * §11.2's autonomy table — the fallback consulted only once no rule (not
 * even a role- or pack-supplied one) matched a call at all:
 *
 *          Reads   Writes-in-ws   Commands          Network tools    Outside ws
 *   ask    allow   ask            ask               ask              deny
 *   guided allow   allow          allow-listed only  domain allow-list deny
 *   auton. allow   allow          allow              domain allow-list deny
 *
 * "Outside workspace" is not a toolClass — it's already handled by the
 * immutable `deny.write_outside_worktree`/`deny.read_outside_project`
 * rules (which run before this fallback is ever reached), so this table
 * only needs read/write/command/network/bureau/other.
 *
 * "Commands: allow-listed only" (guided) and "network tools: domain
 * allow-list" mean the same thing structurally: guided/autonomous don't
 * grant a blanket allow here — they defer to whatever role/pack rules
 * exist for the specific command or domain. With no rule having matched
 * at all (this IS the no-match fallback), there is nothing to allow-list
 * against, so the honest fallback for guided/autonomous command and
 * network calls is `ask` — never a silent allow of an unlisted command or
 * an unlisted domain, and never a silent deny either (that would make an
 * unconfigured role permanently unable to use *any* command/network tool,
 * which is `ask`'s job to surface, not deny's).
 */
export function autonomyDefaultFor(toolClass: ToolClass, autonomy: Autonomy): Verdict {
  const ruleId = `autonomy_default.${autonomy}.${toolClass}`;

  if (toolClass === 'bureau') {
    // Never actually reached — isBureauTool() short-circuits before the
    // evaluator gets this far — but defined rather than throwing, so this
    // function stays total over ToolClass.
    return { effect: 'allow', ruleId };
  }

  // §11.3: "`other` defaults to deny, not ask." An `ask` default would
  // quietly turn every unknown engine tool into a permission prompt the
  // user learns to click through; denying makes it an explicit,
  // attributable event instead.
  if (toolClass === 'other') {
    return { effect: 'deny', ruleId, reason: 'tool is not in any declared class (§23) — denied, not asked, by default' };
  }

  if (toolClass === 'read') {
    return { effect: 'allow', ruleId };
  }

  if (toolClass === 'write') {
    return autonomy === 'ask'
      ? { effect: 'ask', ruleId, reason: 'writes require confirmation at the "ask" autonomy level' }
      : { effect: 'allow', ruleId };
  }

  if (toolClass === 'command') {
    if (autonomy === 'autonomous') {
      // The one cell in §11.2's table where autonomous drops the
      // allow-list restriction entirely ("Commands: allow") — unlike
      // network, which stays gated by network_allow at every level.
      return { effect: 'allow', ruleId };
    }
    // ask: every command asks, unconditionally. guided: "allow-listed
    // only" — a role/pack ALLOW rule for this specific command would
    // already have matched above if one existed; reaching here means it
    // didn't, so the honest answer is "ask", not a silent allow.
    return { effect: 'ask', ruleId, reason: `no command allow-list rule matched this call at "${autonomy}" autonomy` };
  }

  // network — M6 session 2: ruleLoader.ts's networkDenyRuleFor already
  // denies (unconditionally, at every autonomy level) any network call
  // whose domain is NOT on role.network_allow, called before this
  // fallback is ever reached. Reaching here with toolClass:'network'
  // therefore means the domain WAS on the list (or the role has no
  // restriction — networkDenyRuleFor makes that impossible; an empty
  // network_allow denies everything) and no OTHER rule had an opinion.
  // §11.2's table: ask asks regardless; guided/autonomous allow, since
  // the domain-allow-list gate has already run.
  if (autonomy === 'ask') {
    return { effect: 'ask', ruleId, reason: 'network calls require confirmation at the "ask" autonomy level' };
  }
  return { effect: 'allow', ruleId };
}
