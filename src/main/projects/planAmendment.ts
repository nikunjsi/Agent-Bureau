import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { askCheckpoint } from '../checkpoints/ask';
import { getProjectById } from '../db/repositories/projects';
import {
  getTaskById,
  insertTask,
  setTaskAcceptanceCriteria,
  setTaskBody,
  setTaskStatus,
} from '../db/repositories/tasks';
import { formatUsdMicros, usdToMicros } from '../../shared/models/money';
import type { Checkpoint } from '../../shared/models/checkpoint';
import type { Task } from '../../shared/models/task';
import { rolesThatCouldTake } from './unfillable';

/**
 * Re-planning while the work runs (M11 S3-6a; §8.5, §8.8, §7.9's
 * `bureau_amend_plan`).
 *
 * §8.5: *"Re-planning is a `decision` checkpoint if it changes cost or scope,
 * silent otherwise."* Changing scope means adding or removing work, or
 * changing a task's acceptance criteria. Changing cost means changing the
 * plan's estimate. A clearer body for a queued task is neither, and applies at
 * once. Anything else is put to the user as a `decision` checkpoint whose
 * preview is the amendment itself (§8.8: "with a diff against the old one")
 * and whose "apply" option states the cost change. "Keep the plan" is the
 * reversible default, so a timeout changes nothing (invariant #7).
 * `answerCheckpoint` applies it when the user chooses "apply".
 *
 * Only queued work is ever amended. A task someone holds, or that is
 * finished, is refused by name.
 */

export const AMEND_PLAN_TOOL = 'bureau_amend_plan';
export const AMEND_OPTION_IDS = { apply: 'apply', keep: 'keep' } as const;

export interface AmendedTask {
  readonly title: string;
  readonly body: string;
  readonly acceptance_criteria: readonly string[];
  readonly required_skills: readonly string[];
  readonly deliverable_type: Task['deliverable_type'];
  readonly phase_index: number;
  readonly estimated_cost_usd: number | null;
}

export interface PlanAmendment {
  readonly add: readonly AmendedTask[];
  readonly remove: readonly string[];
  readonly rescope: readonly {
    readonly task_id: string;
    readonly body?: string | undefined;
    readonly acceptance_criteria?: readonly string[] | undefined;
  }[];
  readonly rationale: string;
}

export type AmendResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'proposed'; readonly checkpointId: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** What the Director asked for, checked, then applied or put to the user. */
export async function amendPlan(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: {
    readonly projectId: string;
    readonly directorEmployeeId: string;
    readonly idempotencyKey: string;
    readonly amendment: PlanAmendment;
  },
): Promise<AmendResult> {
  const { db, activityLog } = deps;
  const problem = amendmentProblem(db, input.projectId, input.amendment);
  if (problem !== null) return { kind: 'refused', reason: problem };
  const { amendment } = input;

  const costDelta =
    sumMicros(amendment.add.map((t) => t.estimated_cost_usd)) -
    amendment.remove.reduce(
      (sum, id) => sum + (getTaskById(db, id)?.estimated_cost_usd_micros ?? 0),
      0,
    );
  const scopeChanges =
    amendment.add.length > 0 ||
    amendment.remove.length > 0 ||
    amendment.rescope.some((r) => r.acceptance_criteria !== undefined);
  if (!scopeChanges && costDelta === 0) {
    applyPlanAmendment(deps, input.projectId, amendment);
    return { kind: 'applied' };
  }

  const cost =
    costDelta === 0
      ? 'The estimate does not change.'
      : `The estimate ${costDelta > 0 ? 'goes up' : 'goes down'} by ${formatUsdMicros(Math.abs(costDelta))}.`;
  const what = [
    ...amendment.add.map((t) => `add "${t.title}"`),
    ...amendment.remove.map((id) => `remove "${getTaskById(db, id)?.title ?? id}"`),
    ...amendment.rescope.map((r) => `change "${getTaskById(db, r.task_id)?.title ?? r.task_id}"`),
  ].join(', ');
  const result = await askCheckpoint(
    { db, activityLog },
    {
      project_id: input.projectId,
      employee_id: input.directorEmployeeId,
      type: 'decision',
      urgency: 'soon',
      tool_call_id: input.idempotencyKey,
      tool_name: AMEND_PLAN_TOOL,
      title: 'Change the plan?',
      context: `${amendment.rationale} Proposed: ${what}.`,
      preview: {
        add: amendment.add,
        remove: amendment.remove,
        rescope: amendment.rescope,
        rationale: amendment.rationale,
        costDeltaMicros: costDelta,
      },
      options: [
        {
          id: AMEND_OPTION_IDS.apply,
          label: 'Change the plan',
          consequence: `The plan changes as proposed: ${what}. ${cost}`,
        },
        {
          id: AMEND_OPTION_IDS.keep,
          label: 'Keep the plan as it is',
          consequence: 'Nothing changes; the work carries on as planned.',
          reversible: true,
        },
      ],
      default_action: AMEND_OPTION_IDS.keep,
    },
  );
  if (result.kind === 'duplicate') {
    return {
      kind: 'refused',
      reason: `the user already answered this change ("${result.checkpoint.answer?.optionId ?? 'no option'}"); do not ask again.`,
    };
  }
  return { kind: 'proposed', checkpointId: result.checkpoint.id };
}

/** The amendment a checkpoint proposes, or `null` if it proposes none.
 *  Only `bureau_amend_plan` writes this `tool_name`. */
export function proposedAmendment(checkpoint: Checkpoint): PlanAmendment | null {
  if (checkpoint.tool_name !== AMEND_PLAN_TOOL || checkpoint.preview === null) return null;
  const preview = checkpoint.preview as Partial<PlanAmendment>;
  return {
    add: preview.add ?? [],
    remove: preview.remove ?? [],
    rescope: preview.rescope ?? [],
    rationale: preview.rationale ?? '',
  };
}

/**
 * Applies an amendment: one transaction, then one `project.plan_amended`,
 * a `task.created` for each added task and a `task.cancelled` for each
 * removed one. Checked again first, because the work may have moved on
 * since it was proposed; if it has, nothing is applied and the reason comes
 * back.
 */
export function applyPlanAmendment(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  projectId: string,
  amendment: PlanAmendment,
): string | null {
  const { db, activityLog } = deps;
  const problem = amendmentProblem(db, projectId, amendment);
  if (problem !== null) return problem;
  const phases = currentPhases(db, projectId);
  const added = db.transaction(() => {
    const created = amendment.add.map((t) =>
      insertTask(db, {
        project_id: projectId,
        phase_id: phases[t.phase_index]!.id,
        title: t.title,
        body: t.body,
        acceptance_criteria: [...t.acceptance_criteria],
        required_skills: [...t.required_skills],
        deliverable_type: t.deliverable_type,
        estimated_cost_usd_micros:
          t.estimated_cost_usd === null ? null : usdToMicros(t.estimated_cost_usd),
      }),
    );
    for (const id of amendment.remove) {
      setTaskStatus(db, id, 'cancelled', `Removed from the plan: ${amendment.rationale}`);
    }
    for (const r of amendment.rescope) {
      if (r.body !== undefined) setTaskBody(db, r.task_id, r.body);
      if (r.acceptance_criteria !== undefined) {
        setTaskAcceptanceCriteria(db, r.task_id, r.acceptance_criteria);
      }
    }
    return created;
  })();

  activityLog.logEvent({
    actor: 'director',
    type: 'project.plan_amended',
    severity: 'info',
    project_id: projectId,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      added: added.map((t) => t.id),
      removed: amendment.remove,
      rescoped: amendment.rescope.map((r) => r.task_id),
      rationale: amendment.rationale,
    },
  });
  for (const task of added) {
    activityLog.logEvent({
      actor: 'director',
      type: 'task.created',
      severity: 'info',
      project_id: projectId,
      task_id: task.id,
      employee_id: null,
      checkpoint_id: null,
      payload: { reason: 'plan_amended' },
    });
  }
  for (const id of amendment.remove) {
    activityLog.logEvent({
      actor: 'director',
      type: 'task.cancelled',
      severity: 'info',
      project_id: projectId,
      task_id: id,
      employee_id: null,
      checkpoint_id: null,
      payload: { reason: 'plan_amended' },
    });
  }
  return null;
}

/** Why an amendment cannot apply, or `null`. */
function amendmentProblem(
  db: Database.Database,
  projectId: string,
  amendment: PlanAmendment,
): string | null {
  const project = getProjectById(db, projectId);
  if (project === null || project.plan_id === null) {
    return 'there is no approved plan to amend yet; write one with bureau_write_plan.';
  }
  const phases = currentPhases(db, projectId);
  for (const t of amendment.add) {
    const phase = phases[t.phase_index];
    if (phase === undefined) {
      return `"${t.title}" names phase_index ${t.phase_index}; the plan has ${phases.length} phase(s).`;
    }
    if (phase.status === 'done' || phase.status === 'skipped') {
      return `"${t.title}" would go into phase ${phase.ordinal}, which is ${phase.status}.`;
    }
    if (rolesThatCouldTake(db, t).length === 0) {
      return `"${t.title}" needs ${t.required_skills.join(', ')}, which no installed role has.`;
    }
  }
  const touched = [...amendment.remove, ...amendment.rescope.map((r) => r.task_id)];
  for (const id of touched) {
    const task = getTaskById(db, id);
    if (task === null || task.project_id !== projectId)
      return `there is no task ${id} in this project.`;
    if (task.status !== 'queued') {
      return `${task.display_key} is ${task.status}; only queued work can be amended.`;
    }
  }
  return null;
}

function currentPhases(
  db: Database.Database,
  projectId: string,
): { id: string; ordinal: number; status: string }[] {
  return db
    .prepare(
      `SELECT ph.id, ph.ordinal, ph.status FROM phases ph
         JOIN projects pr ON pr.plan_id = ph.plan_id
        WHERE pr.id = ? ORDER BY ph.ordinal`,
    )
    .all(projectId) as { id: string; ordinal: number; status: string }[];
}

function sumMicros(values: readonly (number | null)[]): number {
  return values.reduce<number>((sum, v) => sum + (v === null ? 0 : usdToMicros(v)), 0);
}
