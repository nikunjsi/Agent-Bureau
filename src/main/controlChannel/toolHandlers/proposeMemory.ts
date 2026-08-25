import { ProposeMemoryArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9: bureau_propose_memory — ROW ONLY, per the M4 session 2 prompt.
 * Genuinely different from the other "row only" tools: bureau_ask_director/
 * bureau_send_message/bureau_raise_checkpoint each have a real table
 * already built (M1) with an obvious pending-row shape to insert into.
 * §12.4's real memory-write-proposal flow (batched into one checkpoint per
 * phase, auto-rejected after `retention.memoryProposalDays`) needs a
 * dedicated proposal-queue table that does not exist yet — designing one
 * now, ahead of M7's real memory store, would be guessing at what that
 * system actually needs, the same class of mistake §7.9's own ROW ONLY
 * tools elsewhere avoid by having a real table to point at.
 *
 * So the "row" here is the activity event itself: `memory.write_proposed`
 * with the full proposal (scope/path/content/rationale) in its payload —
 * a genuine, durable, queryable row (events is a real table with a real
 * mirror), just not one a future M7 approval flow can act on yet. The
 * response tells the agent exactly that, honestly, rather than implying a
 * real review queue exists.
 */
export const handleProposeMemory: ToolHandler = (ctx, rawArgs) => {
  const parsed = ProposeMemoryArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_propose_memory: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const entry = ctx.activityLog.logEvent({
    actor: `employee:${ctx.employeeId}`,
    type: 'memory.write_proposed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: {
      scope: parsed.data.scope,
      path: parsed.data.path,
      content: parsed.data.content,
      rationale: parsed.data.rationale,
    },
  });

  return {
    ok: true,
    data: {
      recorded: true,
      eventId: entry.id,
      note: 'Recorded in the activity log. No memory review queue exists yet (lands at M7) — this proposal is not yet actionable.',
    },
  };
};
