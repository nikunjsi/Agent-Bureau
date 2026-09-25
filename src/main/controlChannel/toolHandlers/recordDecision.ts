import { appendDirectorDecision } from '../../checkpoints/decisionLog';
import { resolveDirectorProject } from '../../director/currentProject';
import { nowIso } from '../../../shared/models/ids';
import { RecordDecisionArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_record_decision`: *"Appends to `project/decisions.md`
 * (§12.5)."* A Director tool (M11 S2-2b).
 *
 * The decision log is how invariant #9 holds across a project: a decision
 * written here is one the Director's own question check
 * (`alreadyAnswered.ts`) and every employee's memory pack will find. The
 * common case is the user saying "you decide" — §8.1: the Director decides,
 * states the decision and its consequence, and moves on; recording it is
 * what stops the same question coming back.
 *
 * The project is the one of the turn's conversation, never an argument:
 * a decision belongs to the project it was made in, and the company
 * conversation has none to write to.
 */
export const handleRecordDecision: ToolHandler = (ctx, rawArgs) => {
  const parsed = RecordDecisionArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_record_decision: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message:
        'bureau_record_decision: this conversation is not about a project, and a decision is recorded in the project it was made for.',
    };
  }
  const written = appendDirectorDecision(ctx.db, {
    baseDir: ctx.baseDir,
    projectId: project.id,
    decision: {
      title: parsed.data.title,
      askedBecause: parsed.data.asked_because,
      options: parsed.data.options,
      chosen: parsed.data.chosen,
      consequence: parsed.data.consequence,
      decidedAtIso: nowIso(),
    },
  });
  ctx.activityLog.logEvent({
    actor: 'director',
    type: 'memory.write_applied',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: ctx.employeeId,
    checkpoint_id: null,
    payload: {
      change: 'updated',
      scope: 'project',
      path: written.relativePath,
      gated: false,
      via: 'bureau_record_decision',
      title: parsed.data.title,
    },
  });
  return { ok: true, data: { path: written.relativePath, entry: written.entry } };
};
