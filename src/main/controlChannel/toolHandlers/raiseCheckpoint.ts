import { getEmployeeById } from '../../db/repositories/employees';
import { getTaskById } from '../../db/repositories/tasks';
import { askCheckpoint } from '../../checkpoints/ask';
import { RaiseCheckpointArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9: `bureau_raise_checkpoint`. M8 makes it real end to end.
 *
 * §9.2's per-option `consequence` rule is enforced by
 * `RaiseCheckpointArgsSchema` (which now imports the shared
 * `CheckpointOptionSchema` rather than re-declaring it) and again by
 * `insertCheckpoint`'s own parse — the same schema, on the same real path,
 * so there is one rule and no way around it. `safeParse` below turns a
 * violation into the agent-readable message §7.9 requires rather than a
 * raw Zod throw.
 *
 * `employee_id`/`task_id`/`project_id` remain derived from the caller's own
 * current row, never agent-supplied: a checkpoint attributed to the wrong
 * employee would misattribute a real decision.
 *
 * ## Two changes from M4's version
 *
 * 1. **It no longer emits `checkpoint.raised` itself.** That moved inside
 *    `insertCheckpoint`, so all five creation paths emit it and none can
 *    forget (AUDIT #23).
 * 2. **It goes through `askCheckpoint`**, which runs §9.2's duplicate
 *    check first. When the project has already answered this question, no
 *    checkpoint is created and the agent gets the existing decision back
 *    in the same call — so the employee proceeds immediately instead of
 *    waiting on a question the user already answered. That is CLAUDE.md
 *    invariant #9 as behaviour rather than as a rule nothing enforces.
 */
export const handleRaiseCheckpoint: ToolHandler = async (ctx, rawArgs) => {
  const parsed = RaiseCheckpointArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_raise_checkpoint: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  const employee = getEmployeeById(ctx.db, ctx.employeeId);
  const task = employee?.current_task_id ? getTaskById(ctx.db, employee.current_task_id) : null;

  let result;
  try {
    result = await askCheckpoint(
      { db: ctx.db, activityLog: ctx.activityLog },
      {
        project_id: task?.project_id ?? null,
        task_id: task?.id ?? null,
        employee_id: ctx.employeeId,
        type: parsed.data.type,
        urgency: parsed.data.urgency,
        tool_call_id: ctx.idempotencyKey,
        tool_name: 'bureau_raise_checkpoint',
        title: parsed.data.title,
        context: parsed.data.context,
        options: parsed.data.options,
        preview: parsed.data.preview ?? null,
        // §9.1: every non-`permission` type "blocks work for the dependent
        // task". An agent that raises a checkpoint has, by definition,
        // reached a fork it cannot resolve alone.
        blocksTask: task !== null,
      },
    );
  } catch (err) {
    // `insertCheckpoint`'s parse can still reject what this handler's own
    // schema let through — `default_action` naming no option, two
    // `recommended` options. §7.9's rule applies: the message is read by
    // an agent, so it says what to fix.
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_raise_checkpoint: ${(err as Error).message}`,
    };
  }

  if (result.kind === 'duplicate') {
    const answer = result.checkpoint.answer;
    return {
      ok: true,
      data: {
        duplicate: true,
        checkpointId: result.checkpoint.id,
        alreadyAsked: result.checkpoint.title,
        answeredOption: answer?.optionId ?? null,
        answeredFreeText: answer?.freeText ?? null,
        note: 'This project already answered this. Use the answer above and continue — do not ask again.',
      },
    };
  }

  return { ok: true, data: { duplicate: false, checkpointId: result.checkpoint.id } };
};
