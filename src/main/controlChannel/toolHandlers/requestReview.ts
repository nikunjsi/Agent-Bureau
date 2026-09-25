import { resolveDirectorProject } from '../../director/currentProject';
import { getPhaseById } from '../../db/repositories/phases';
import { requestPhaseReview } from '../../projects/phaseReview';
import { RequestReviewArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_request_review`: *"Moves a phase to review and posts the
 * review card."* A Director tool (M11 S3-5a, §8.6). The phase must be the
 * turn's project's; "not verified" may not be empty.
 */
export const handleRequestReview: ToolHandler = (ctx, rawArgs) => {
  const parsed = RequestReviewArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) return refuse('this conversation is not about a project.');
  const phase = getPhaseById(ctx.db, parsed.data.phase_id);
  const phaseProject =
    phase === null
      ? null
      : ((
          ctx.db.prepare('SELECT project_id FROM plans WHERE id = ?').get(phase.plan_id) as
            { project_id: string } | undefined
        )?.project_id ?? null);
  if (phase === null || phaseProject !== project.id) {
    return refuse(`there is no phase ${parsed.data.phase_id} in ${project.display_key}.`);
  }
  const result = requestPhaseReview(
    {
      db: ctx.db,
      activityLog: ctx.activityLog,
      ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
    },
    {
      phaseId: phase.id,
      summary: parsed.data.summary,
      verified: parsed.data.verified,
      notVerified: parsed.data.not_verified,
      knownIssues: parsed.data.known_issues,
    },
  );
  if (result.kind === 'refused') return refuse(result.reason);
  return { ok: true, data: { phaseId: phase.id, status: 'review' } };
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_request_review: ${message}` };
}
