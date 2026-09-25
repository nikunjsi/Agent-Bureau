import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getProjectById, setProjectStageColumn } from '../db/repositories/projects';
import {
  emitDirectorTransition,
  InvalidDirectorTransitionError,
  writeDirectorTransition,
  type WrittenDirectorTransition,
} from '../director/directorState';
import type { DirectorState } from '../../shared/models/directorState';
import type { Project } from '../../shared/models/project';

type ProjectStage = Project['stage'];

/**
 * §8's lifecycle, as one table (M11 S2-1b), in the same shape as A.3's
 * (`directorState.ts`). Every arrow in §8's diagram is a row: the forward
 * spine, "scope change → re-plan", and "rejected → back to executing".
 * Creation (nothing → `intake`) is `createProject`'s, not a row here.
 *
 * `movedBy` is who may make the move. **The Director may not make the
 * user's moves**: planning starts when the user approves the brief
 * (invariant #2, `brief.approve`), work starts when they approve the plan,
 * and a phase or the project is accepted by them. Each Director move names
 * the A.3 transition that goes with it, and both are made together or not
 * at all.
 */
export interface ProjectStageTransition {
  readonly from: ProjectStage;
  readonly to: ProjectStage;
  readonly movedBy: 'director' | 'user';
  /** What makes the move, in words the Director reads when it is refused. */
  readonly when: string;
  /** For a Director move: the A.3 transition made with it. */
  readonly director?: { readonly to: DirectorState; readonly trigger: string };
}

export const PROJECT_STAGE_TRANSITIONS: readonly ProjectStageTransition[] = [
  {
    from: 'intake',
    to: 'brief',
    movedBy: 'director',
    when: 'intake has understood enough to write the brief',
    director: { to: 'DRAFTING_BRIEF', trigger: 'enough_understood' },
  },
  {
    from: 'brief',
    to: 'planning',
    movedBy: 'user',
    when: 'the user approves the brief',
  },
  {
    from: 'planning',
    to: 'executing',
    movedBy: 'user',
    when: 'the user approves the plan',
  },
  {
    from: 'executing',
    to: 'review',
    movedBy: 'director',
    when: 'a phase is finished and waits for the user to review it',
    director: { to: 'PHASE_REVIEW', trigger: 'phase_done' },
  },
  {
    from: 'executing',
    to: 'planning',
    movedBy: 'director',
    when: 'the scope changed and the plan has to be revised',
    director: { to: 'REPLANNING', trigger: 'reality_diverged' },
  },
  {
    from: 'review',
    to: 'executing',
    movedBy: 'user',
    when: 'the user accepts the phase, or asks for changes to it',
  },
  {
    from: 'review',
    to: 'delivered',
    movedBy: 'user',
    when: 'the user accepts the last phase',
  },
];

export class ProjectStageRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStageRefusedError';
  }
}

/**
 * The Director moves a project's stage. Validated against §8's table (the
 * move exists and is the Director's) and A.3's (the paired Director state
 * move is valid from where its conversation is); both written in one
 * transaction; then `project.stage_changed` and the A.3 transition's event.
 * Anything refused changes nothing, and says why in words the Director can
 * act on.
 */
export function setProjectStageByDirector(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: {
    readonly projectId: string;
    readonly conversationId: string;
    readonly to: ProjectStage;
    readonly reason: string;
  },
): { readonly from: ProjectStage; readonly to: ProjectStage } {
  const { db, activityLog } = deps;
  const project = getProjectById(db, input.projectId);
  if (project === null) throw new ProjectStageRefusedError('there is no such project');
  const from = project.stage;
  if (input.to === 'intake') {
    throw new ProjectStageRefusedError(
      `${project.display_key} is already past creation; 'intake' starts a new project, and only from a conversation that is not already about one.`,
    );
  }
  const transition = PROJECT_STAGE_TRANSITIONS.find((t) => t.from === from && t.to === input.to);
  if (transition === undefined) {
    throw new ProjectStageRefusedError(
      `§8 has no move from '${from}' to '${input.to}' for ${project.display_key}.`,
    );
  }
  if (transition.movedBy === 'user' || transition.director === undefined) {
    throw new ProjectStageRefusedError(
      `Moving ${project.display_key} from '${from}' to '${input.to}' is the user's: it happens when ${transition.when}.`,
    );
  }
  const directorMove = transition.director;

  let written: WrittenDirectorTransition | null = null;
  try {
    db.transaction(() => {
      setProjectStageColumn(db, project.id, input.to);
      written = writeDirectorTransition(db, input.conversationId, directorMove.to, {
        trigger: directorMove.trigger,
      });
    })();
  } catch (err) {
    if (err instanceof InvalidDirectorTransitionError) {
      throw new ProjectStageRefusedError(
        `${project.display_key} cannot move to '${input.to}' now: your state in this conversation is ${err.from}, and ${err.from} → ${err.to} is not a move you can make.`,
      );
    }
    throw err;
  }

  activityLog.logEvent({
    actor: 'director',
    type: 'project.stage_changed',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { from, to: input.to, reason: input.reason },
  });
  emitDirectorTransition(activityLog, written!);
  return { from, to: input.to };
}
