import { WriteMemoryArgsSchema } from './schemas';
import { proposeMemoryWrite } from '../../memory/memoryProposals';
import { resolveDirectorProject } from '../../director/currentProject';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_write_memory` — a Director tool (M11 row S1-12b,
 * `NEXT-VERSION` §M.4): *"Direct write (`project` scope without approval;
 * `company` scope still asks)."*
 *
 * ## It is the same writer as the employee's, with a different answer
 *
 * There is exactly one memory-write path (`proposeMemoryWrite`), which
 * resolves the target, writes the free case and queues the gated one. What
 * differs for the Director is only **which scopes are free**, and that
 * question is answered in the one function that answers it for everyone:
 * `memoryScopeRequiresApproval(scope, writer)`. A second writer here would
 * be a second place the rule could drift — standing rule 6.
 *
 * So the tool name says "write" and it means it for `project`, while
 * `company` still becomes a queued proposal on a review checkpoint, and the
 * reply says plainly which of the two happened. An agent that assumed a
 * gated note was readable would be building on something the user has not
 * agreed to.
 *
 * ## The path is confined here
 *
 * `bureau_` tools are allowed by the evaluator before any immutable deny is
 * scanned (§23.2), so policy did not check this path — `resolveMemoryTarget`
 * did, inside `proposeMemoryWrite`. CLAUDE.md invariant #5's carve-out.
 */

export const handleWriteMemory: ToolHandler = (ctx, rawArgs) => {
  const parsed = WriteMemoryArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_write_memory: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  // The project a queued note belongs to, so its review lands in the right
  // batch. Null is fine — a company-scope note before any project exists is
  // a real case, and §12.4's batch key allows it.
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);

  const outcome = proposeMemoryWrite(
    { db: ctx.db, activityLog: ctx.activityLog, baseDir: ctx.baseDir },
    {
      scope: parsed.data.scope,
      path: parsed.data.path,
      content: parsed.data.content,
      rationale: parsed.data.rationale,
      // The Director has an employee row, so `employee` scope resolves to
      // its own notebook exactly as an employee's does — taken from the
      // token, never from the arguments.
      employeeId: ctx.employeeId,
      writer: 'director',
      proposedBy: 'director',
      projectId: project?.id ?? null,
      phaseId: null,
    },
  );

  switch (outcome.kind) {
    case 'refused':
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `bureau_write_memory: ${outcome.reason}`,
      };
    case 'applied':
      return {
        ok: true,
        data: {
          applied: true,
          path: outcome.path,
          note: `Written to ${parsed.data.scope} memory. It is readable now.`,
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
            `${parsed.data.scope} memory is written only after the user accepts it, so this ` +
            'note is queued for review and is not readable yet.',
        },
      };
  }
};
