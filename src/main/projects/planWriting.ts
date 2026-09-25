import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import { appendChatMessage } from '../chat/appendMessage';
import {
  approvePlan,
  getPlanById,
  insertPlan,
  latestPlanVersion,
  supersedePlan,
} from '../db/repositories/plans';
import { insertPhase } from '../db/repositories/phases';
import { insertTask, setTaskStatus } from '../db/repositories/tasks';
import { insertTaskDep } from '../db/repositories/taskDeps';
import { getProjectById, setProjectBriefAndPlan } from '../db/repositories/projects';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import {
  emitDirectorTransition,
  getDirectorState,
  writeDirectorTransition,
  type WrittenDirectorTransition,
} from '../director/directorState';
import { isBriefApproved } from './briefApproval';
import {
  emitProjectStageChanged,
  writeUserProjectStage,
  type WrittenProjectStage,
} from './projectStage';
import type { PlanDocument } from '../../shared/models/plan';
import { usdToMicros } from '../../shared/models/money';

/** §8.4: "Target 5–15 tasks per phase. More means the phase is really two." */
export const MAX_TASKS_PER_PHASE = 15;

/**
 * Everything wrong with a plan that its shape cannot say, in words the
 * Director can act on. Empty when the plan may be written.
 */
export function planProblems(db: Database.Database, plan: PlanDocument): string[] {
  const problems: string[] = [];
  const phaseCount = plan.phases.length;
  plan.tasks.forEach((task, index) => {
    if (task.phase_index >= phaseCount) {
      problems.push(
        `task ${index} ("${task.title}") has phase_index ${task.phase_index}, but the plan has ${phaseCount} phase${phaseCount === 1 ? '' : 's'} (0 to ${phaseCount - 1}).`,
      );
    }
  });
  plan.phases.forEach((phase, index) => {
    const size = plan.tasks.filter((task) => task.phase_index === index).length;
    if (size > MAX_TASKS_PER_PHASE) {
      problems.push(
        `phase ${index} ("${phase.name}") has ${size} tasks; more than ${MAX_TASKS_PER_PHASE} means the phase is really two — split it.`,
      );
    }
  });
  const known = knownSkills(db);
  const unknown = [...new Set(plan.tasks.flatMap((task) => task.required_skills))].filter(
    (skill) => !known.has(skill),
  );
  if (unknown.length > 0) {
    problems.push(
      `no role has the skill${unknown.length === 1 ? '' : 's'} ${unknown.map((s) => `"${s}"`).join(', ')}. Use one of: ${[...known].sort().join(', ')}.`,
    );
  }
  for (const dep of plan.deps) {
    for (const index of [dep.task_index, dep.depends_on_index]) {
      if (index >= plan.tasks.length) {
        problems.push(
          `a dependency names task ${index}, and the plan has ${plan.tasks.length} tasks.`,
        );
      }
    }
  }
  const cycle = findCycle(plan);
  if (cycle !== null) {
    problems.push(
      `the dependencies have a cycle: ${cycle.map((i) => `task ${i}`).join(' → ')}. Dependencies must form a DAG (§8.4).`,
    );
  }
  return problems;
}

/** Every skill an installed role offers. */
function knownSkills(db: Database.Database): Set<string> {
  const skills = new Set<string>();
  for (const row of db.prepare('SELECT skills FROM roles').all() as { skills: string }[]) {
    for (const skill of JSON.parse(row.skills) as string[]) skills.add(skill);
  }
  return skills;
}

/**
 * A dependency cycle among the plan's own tasks, as the loop of indices,
 * or null. Depth-first over "depends on" edges; the repository's own check
 * (`insertTaskDep`) stays as the backstop inside the transaction.
 */
function findCycle(plan: PlanDocument): number[] | null {
  const edges = new Map<number, number[]>();
  for (const dep of plan.deps) {
    if (dep.task_index >= plan.tasks.length || dep.depends_on_index >= plan.tasks.length) continue;
    edges.set(dep.task_index, [...(edges.get(dep.task_index) ?? []), dep.depends_on_index]);
  }
  const state = new Map<number, 'visiting' | 'done'>();
  const stack: number[] = [];
  const visit = (node: number): number[] | null => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'visiting') return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = visit(next);
      if (found !== null) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };
  for (let i = 0; i < plan.tasks.length; i += 1) {
    const found = visit(i);
    if (found !== null) return found;
  }
  return null;
}

export interface PlanDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly broadcaster?: ChatBroadcaster;
}

export class PlanRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanRefusedError';
  }
}

/**
 * `bureau_write_plan`'s work (§7.9: "creates `plans` + `phases` + `tasks` +
 * `task_deps` in one transaction"). Refused unless the brief is approved
 * (invariant #2, `isBriefApproved`) and the plan passes `planProblems`.
 * Then **one transaction**: any version still waiting is superseded and its
 * tasks cancelled; the plan (with its total), its phases, its tasks (each
 * with its estimate in micros, invariant #12) and its dependencies; and the
 * Director's `PLANNING → AWAITING_PLAN_APPROVAL`. Then the events —
 * `project.plan_drafted` (phases and dependencies are part of the plan
 * document it records), a `task.created` each, a `task.cancelled` for each
 * task of a replaced version, the transition's — and the plan card.
 */
export function writePlanFromDirector(
  deps: PlanDeps,
  input: {
    readonly projectId: string;
    readonly conversationId: string;
    readonly plan: PlanDocument;
  },
): { readonly planId: string; readonly version: number } {
  const { db, activityLog } = deps;
  const project = getProjectById(db, input.projectId);
  if (project === null) throw new PlanRefusedError('the project no longer exists.');
  if (!isBriefApproved(db, project.id) || project.brief_id === null) {
    throw new PlanRefusedError(
      'nothing is planned before the brief is approved (invariant #2), and this brief is not approved yet.',
    );
  }
  const problems = planProblems(db, input.plan);
  if (problems.length > 0) throw new PlanRefusedError(problems.join(' '));

  const plan = input.plan;
  const taskMicros = plan.tasks.map((task) =>
    task.estimated_cost_usd === null ? null : usdToMicros(task.estimated_cost_usd),
  );
  const sum = (values: (number | null)[]): number | null =>
    values.length === 0 || values.some((v) => v === null)
      ? null
      : values.reduce<number>((total, v) => total + (v ?? 0), 0);
  const phaseMicros = plan.phases.map((_, index) =>
    sum(taskMicros.filter((_, t) => plan.tasks[t]!.phase_index === index)),
  );
  const totalMicros = sum(taskMicros);

  let transition: WrittenDirectorTransition | null = null;
  const written = db.transaction(() => {
    const waiting = db
      .prepare(
        "SELECT id FROM plans WHERE project_id = ? AND status IN ('draft', 'awaiting_approval')",
      )
      .all(project.id) as { id: string }[];
    const cancelled: string[] = [];
    for (const old of waiting) {
      supersedePlan(db, old.id);
      const oldTasks = db
        .prepare(
          `SELECT t.id FROM tasks t JOIN phases p ON p.id = t.phase_id
            WHERE p.plan_id = ? AND t.status = 'queued'`,
        )
        .all(old.id) as { id: string }[];
      for (const row of oldTasks) {
        setTaskStatus(db, row.id, 'cancelled', 'Replaced by a newer version of the plan.');
        cancelled.push(row.id);
      }
    }
    const version = latestPlanVersion(db, project.id) + 1;
    const row = insertPlan(db, {
      project_id: project.id,
      brief_id: project.brief_id!,
      version,
      content: plan,
      estimated_cost_usd_micros: totalMicros,
      status: 'awaiting_approval',
    });
    const phaseIds = plan.phases.map(
      (phase, index) =>
        insertPhase(db, {
          plan_id: row.id,
          ordinal: index + 1,
          name: phase.name,
          goal: phase.goal,
          review_required: phase.review_required,
        }).id,
    );
    const tasks = plan.tasks.map((task, index) =>
      insertTask(db, {
        project_id: project.id,
        phase_id: phaseIds[task.phase_index]!,
        title: task.title,
        body: task.body,
        acceptance_criteria: task.acceptance_criteria,
        required_skills: task.required_skills,
        deliverable_type: task.deliverable_type,
        estimated_cost_usd_micros: taskMicros[index] ?? null,
      }),
    );
    for (const dep of plan.deps) {
      insertTaskDep(db, tasks[dep.task_index]!.id, tasks[dep.depends_on_index]!.id);
    }
    transition = writeDirectorTransition(db, input.conversationId, 'AWAITING_PLAN_APPROVAL', {
      trigger: 'plan_written',
    });
    return { row, tasks, cancelled, superseded: waiting.map((w) => w.id) };
  })();

  activityLog.logEvent({
    actor: 'director',
    type: 'project.plan_drafted',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      planId: written.row.id,
      version: written.row.version,
      phases: plan.phases.length,
      tasks: plan.tasks.length,
      deps: plan.deps.length,
      estimatedCostMicros: totalMicros,
      supersededPlanIds: written.superseded,
    },
  });
  for (const taskId of written.cancelled) {
    activityLog.logEvent({
      actor: 'system',
      type: 'task.cancelled',
      severity: 'info',
      project_id: project.id,
      task_id: taskId,
      employee_id: null,
      checkpoint_id: null,
      payload: { reason: 'plan_superseded', planId: written.row.id },
    });
  }
  for (const task of written.tasks) {
    activityLog.logEvent({
      actor: 'director',
      type: 'task.created',
      severity: 'info',
      project_id: project.id,
      task_id: task.id,
      employee_id: null,
      checkpoint_id: null,
      payload: { displayKey: task.display_key, title: task.title, planId: written.row.id },
    });
  }
  emitDirectorTransition(activityLog, transition!);

  appendChatMessage(
    { db, activityLog, ...(deps.broadcaster ? { broadcaster: deps.broadcaster } : {}) },
    {
      conversationId: input.conversationId,
      projectId: project.id,
      author: 'director',
      kind: 'plan',
      body: 'Here is the plan. Approve it to start the work, or ask for changes.',
      payload: {
        planId: written.row.id,
        phases: plan.phases.map((phase, index) => ({
          name: phase.name,
          goal: phase.goal,
          estimatedCostMicros: phaseMicros[index] ?? null,
          tasks: plan.tasks
            .filter((task) => task.phase_index === index)
            .map((task) => ({ title: task.title, assignee: null })),
        })),
        estimatedCostMicros: totalMicros,
        hiresNeeded: [],
      },
    },
  );
  return { planId: written.row.id, version: written.row.version };
}

export type ApprovePlanOutcome =
  | {
      readonly kind: 'approved';
      readonly projectId: string;
      readonly conversationId: string | null;
    }
  | { readonly kind: 'already_approved' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'not_found' };

/**
 * `plan.approve` (§8.4): one transaction for M9's compare-and-swap, the
 * project's `plan_id`, the user's `planning → executing`, and the Director's
 * `AWAITING_PLAN_APPROVAL → SUPERVISING` — each move made only where it
 * applies, as with the brief. Then one event per change.
 */
export function approvePlanWithStage(deps: PlanDeps, planId: string): ApprovePlanOutcome {
  const { db, activityLog } = deps;
  const plan = getPlanById(db, planId);
  if (plan === null) return { kind: 'not_found' };
  const conversation = resolveConversationForDelivery(db, plan.project_id);
  const conversationId =
    conversation !== null && conversation.project_id === plan.project_id ? conversation.id : null;

  let stage: WrittenProjectStage | null = null;
  let transition: WrittenDirectorTransition | null = null;
  const approved = db.transaction((): boolean => {
    if (!approvePlan(db, planId)) return false;
    const project = getProjectById(db, plan.project_id)!;
    setProjectBriefAndPlan(db, project.id, project.brief_id, planId);
    if (project.stage === 'planning') {
      stage = writeUserProjectStage(db, {
        projectId: project.id,
        to: 'executing',
        reason: 'The user approved the plan.',
      });
    }
    if (
      conversationId !== null &&
      getDirectorState(db, conversationId).state === 'AWAITING_PLAN_APPROVAL'
    ) {
      transition = writeDirectorTransition(db, conversationId, 'SUPERVISING', {
        trigger: 'plan_approved',
      });
    }
    return true;
  })();
  if (!approved) {
    return getPlanById(db, planId)?.status === 'approved'
      ? { kind: 'already_approved' }
      : { kind: 'superseded' };
  }
  activityLog.logEvent({
    actor: 'user',
    type: 'project.plan_approved',
    severity: 'info',
    project_id: plan.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { planId, version: plan.version },
  });
  if (stage !== null) emitProjectStageChanged(activityLog, 'user', stage);
  if (transition !== null) emitDirectorTransition(activityLog, transition);
  return { kind: 'approved', projectId: plan.project_id, conversationId };
}
