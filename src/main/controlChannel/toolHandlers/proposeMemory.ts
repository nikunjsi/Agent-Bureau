import { ProposeMemoryArgsSchema } from './schemas';
import { proposeMemoryWrite } from '../../memory/memoryProposals';
import { getTaskById } from '../../db/repositories/tasks';
import { getEmployeeById } from '../../db/repositories/employees';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_propose_memory`, real from M10.
 *
 * ## What changed, and why it took until now
 *
 * From M4 until this milestone this was **ROW ONLY**: it logged a
 * `memory.write_proposed` event and wrote nothing durable. Its own comment
 * said exactly why — *"§12.4's real memory-write-proposal flow needs a
 * dedicated proposal-queue table that does not exist yet; designing one was
 * not M4's to do."* Migration `0010` is that table, so the honest-empty
 * response is gone and the tool now does what §7.9's own row says it does:
 * *"Memory write proposal (§12.4). Free for `employee` scope; a `whenever`
 * checkpoint otherwise."*
 *
 * ## The path is confined here
 *
 * This is a `bureau_` tool, so the policy evaluator allowed it before
 * scanning a single immutable deny (§23.2). **For this tool the handler is
 * the guard** — see `memoryTarget.ts` and CLAUDE.md invariant #5's
 * carve-out. `employeeId` comes from the verified bearer token, never from
 * the arguments, which is what makes `employee`-scope confinement mean
 * anything: an employee writes into its own notebook and nobody else's.
 *
 * ## The refusal is written for an agent
 *
 * §7.9: "VALIDATION ERRORS ARE READ BY AN AGENT, NOT A HUMAN." A refusal
 * says which rule it broke and what a legal path looks like, so the next
 * call can be right.
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

  // The batch is keyed on (project, phase) — §12.4's "at most once per
  // phase" — and both come from the employee's current task rather than from
  // the arguments, for the same reason the employee id does: an agent naming
  // its own project could file a note into somebody else's review.
  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const task =
    employee?.current_task_id === null || employee?.current_task_id === undefined
      ? null
      : getTaskById(ctx.db, employee.current_task_id);

  const outcome = proposeMemoryWrite(
    { db: ctx.db, activityLog: ctx.activityLog, baseDir: ctx.baseDir },
    {
      scope: parsed.data.scope,
      path: parsed.data.path,
      content: parsed.data.content,
      rationale: parsed.data.rationale,
      employeeId: ctx.employeeId,
      writer: 'employee',
      proposedBy: `employee:${ctx.employeeId}`,
      projectId: task?.project_id ?? null,
      phaseId: task?.phase_id ?? null,
    },
  );

  switch (outcome.kind) {
    case 'refused':
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `bureau_propose_memory: ${outcome.reason}`,
      };
    case 'applied':
      return {
        ok: true,
        data: {
          applied: true,
          path: outcome.path,
          note: 'Written to your own notes. Employee-scope memory needs no approval (§12.4).',
        },
      };
    case 'queued':
      return {
        ok: true,
        data: {
          applied: false,
          proposalId: outcome.proposal.id,
          checkpointId: outcome.checkpointId,
          pendingCount: outcome.pendingCount,
          note:
            'Queued for review. Notes outside your own scope are written only after the user ' +
            'accepts them, so do not assume this note is readable yet.',
        },
      };
  }
};
