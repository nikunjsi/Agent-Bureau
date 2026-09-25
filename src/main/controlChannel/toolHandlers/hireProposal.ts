import { askCheckpoint } from '../../checkpoints/ask';
import { getRoleByFullKey } from '../../db/repositories/roles';
import { resolveDirectorProject } from '../../director/currentProject';
import { HIRE_PROPOSAL_OPTION_IDS, HIRE_PROPOSAL_TOOL } from '../../company/hireProposal';
import { usdToMicros, formatUsdMicros } from '../../../shared/models/money';
import { HireProposalArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/**
 * §7.9's `bureau_hire_proposal`: *"Raises a `decision` checkpoint proposing a
 * hire."* A Director tool (M11 S3-3; §8.5, §9.7).
 *
 * The checkpoint states the cost (§8.5: "a hire proposal with the cost
 * implication"): the Director's monthly estimate, in the option the user
 * would choose. "Not now" is the reversible default, so a timeout never hires
 * anyone (invariant #7). The role is recorded where only this handler writes
 * it — `tool_name` is this tool's, `args_preview` the role's key — and
 * `answerCheckpoint` hires through the real `hireEmployee` when the user
 * accepts. It goes through `askCheckpoint`, so a hire the user already
 * declined is not asked again (invariant #9); the earlier answer comes back.
 */
export const handleHireProposal: ToolHandler = async (ctx, rawArgs) => {
  const parsed = HireProposalArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const role = getRoleByFullKey(ctx.db, parsed.data.role_key);
  if (role === null || !role.enabled) {
    return refuse(`there is no installed role ${parsed.data.role_key} to hire into.`);
  }
  if (role.key === 'director') return refuse('the company has one Director.');

  const costMicros = usdToMicros(parsed.data.estimated_monthly_cost_usd);
  const cost = formatUsdMicros(costMicros);
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  let result;
  try {
    result = await askCheckpoint(
      { db: ctx.db, activityLog: ctx.activityLog },
      {
        project_id: project?.id ?? null,
        employee_id: ctx.employeeId,
        type: 'decision',
        urgency: 'soon',
        tool_call_id: ctx.idempotencyKey,
        tool_name: HIRE_PROPOSAL_TOOL,
        args_preview: role.full_key,
        title: `Hire a ${role.title}?`,
        context: `${parsed.data.reason} The Director estimates a ${role.title} costs about ${cost} a month.`,
        options: [
          {
            id: HIRE_PROPOSAL_OPTION_IDS.hire,
            label: `Hire a ${role.title}`,
            consequence: `A ${role.title} joins the company and can take work needing ${role.skills.join(', ')}. About ${cost} a month, by the Director's estimate; your budgets still cap what is spent.`,
          },
          {
            id: HIRE_PROPOSAL_OPTION_IDS.notNow,
            label: 'Not now',
            consequence:
              'Nobody is hired. Work that needs this role keeps waiting, and the Director will tell you what is held up.',
            reversible: true,
          },
        ],
        default_action: HIRE_PROPOSAL_OPTION_IDS.notNow,
      },
    );
  } catch (err) {
    return refuse((err as Error).message);
  }
  if (result.kind === 'duplicate') {
    const answer = result.checkpoint.answer;
    return {
      ok: true,
      data: {
        duplicate: true,
        checkpointId: result.checkpoint.id,
        answeredOption: answer?.optionId ?? null,
        note: 'The user was already asked about this hire. Use that answer; do not ask again.',
      },
    };
  }
  return {
    ok: true,
    data: {
      duplicate: false,
      checkpointId: result.checkpoint.id,
      estimatedMonthlyCostMicros: costMicros,
    },
  };
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_hire_proposal: ${message}` };
}
