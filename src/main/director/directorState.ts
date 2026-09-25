import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import {
  getConversationById,
  setConversationDirectorState,
} from '../db/repositories/conversations';
import type { Conversation } from '../../shared/models/conversation';
import type { DirectorState } from '../../shared/models/directorState';
import type { EventType } from '../../shared/models/eventTypes';

/**
 * Appendix A.3, as one table (M11 row S1-14). Every arrow in the spec's
 * diagram is a row here, and nothing else moves the Director's state.
 *
 * ```
 * IDLE ──user message──► RESPONDING ──► IDLE
 * IDLE ──new project──► INTAKE ──enough understood──► DRAFTING_BRIEF
 * DRAFTING_BRIEF ──► AWAITING_BRIEF_APPROVAL ──approved──► PLANNING
 *                                             ──edits───► DRAFTING_BRIEF
 * PLANNING ──► AWAITING_PLAN_APPROVAL ──approved──► SUPERVISING
 *                                      ──edits────► PLANNING
 * SUPERVISING ──phase done──► PHASE_REVIEW ──accepted──► SUPERVISING
 *                                           ──changes──► PLANNING
 * SUPERVISING ──blocked/ambiguous──► ESCALATING ──answered──► SUPERVISING
 * SUPERVISING ──reality diverged──► REPLANNING ──► AWAITING_PLAN_APPROVAL
 * SUPERVISING ──all phases done──► DELIVERING ──► IDLE
 * ```
 *
 * `event` is the one event the transition emits (invariant #3). Three arrows
 * already have a name in §5.2 and use it; every other arrow is
 * `director.state_changed`, carrying `from`, `to` and the trigger.
 */
export interface DirectorTransition {
  readonly from: DirectorState;
  readonly to: DirectorState;
  readonly trigger: string;
  readonly event: EventType;
}

const CHANGED: EventType = 'director.state_changed';

export const DIRECTOR_TRANSITIONS: readonly DirectorTransition[] = [
  { from: 'IDLE', to: 'RESPONDING', trigger: 'user_message', event: CHANGED },
  { from: 'RESPONDING', to: 'IDLE', trigger: 'responded', event: CHANGED },
  { from: 'IDLE', to: 'INTAKE', trigger: 'new_project', event: 'director.intake_started' },
  { from: 'INTAKE', to: 'DRAFTING_BRIEF', trigger: 'enough_understood', event: CHANGED },
  {
    from: 'DRAFTING_BRIEF',
    to: 'AWAITING_BRIEF_APPROVAL',
    trigger: 'brief_written',
    event: CHANGED,
  },
  { from: 'AWAITING_BRIEF_APPROVAL', to: 'PLANNING', trigger: 'brief_approved', event: CHANGED },
  { from: 'AWAITING_BRIEF_APPROVAL', to: 'DRAFTING_BRIEF', trigger: 'brief_edits', event: CHANGED },
  { from: 'PLANNING', to: 'AWAITING_PLAN_APPROVAL', trigger: 'plan_written', event: CHANGED },
  { from: 'AWAITING_PLAN_APPROVAL', to: 'SUPERVISING', trigger: 'plan_approved', event: CHANGED },
  { from: 'AWAITING_PLAN_APPROVAL', to: 'PLANNING', trigger: 'plan_edits', event: CHANGED },
  { from: 'SUPERVISING', to: 'PHASE_REVIEW', trigger: 'phase_done', event: CHANGED },
  { from: 'PHASE_REVIEW', to: 'SUPERVISING', trigger: 'phase_accepted', event: CHANGED },
  { from: 'PHASE_REVIEW', to: 'PLANNING', trigger: 'phase_changes', event: CHANGED },
  { from: 'SUPERVISING', to: 'ESCALATING', trigger: 'blocked', event: 'director.escalated' },
  { from: 'ESCALATING', to: 'SUPERVISING', trigger: 'answered', event: CHANGED },
  {
    from: 'SUPERVISING',
    to: 'REPLANNING',
    trigger: 'reality_diverged',
    event: 'director.replanned',
  },
  { from: 'REPLANNING', to: 'AWAITING_PLAN_APPROVAL', trigger: 'plan_amended', event: CHANGED },
  { from: 'SUPERVISING', to: 'DELIVERING', trigger: 'all_phases_done', event: CHANGED },
  { from: 'DELIVERING', to: 'IDLE', trigger: 'delivered', event: CHANGED },
];

/** A transition A.3 does not have. Nothing was written when this is thrown. */
export class InvalidDirectorTransitionError extends Error {
  constructor(
    readonly from: DirectorState,
    readonly to: DirectorState,
  ) {
    super(`The Director cannot go from ${from} to ${to}: Appendix A.3 has no such transition.`);
    this.name = 'InvalidDirectorTransitionError';
  }
}

export interface DirectorStateSnapshot {
  readonly state: DirectorState;
  readonly data: Record<string, unknown>;
}

function snapshotOf(conversation: Conversation): DirectorStateSnapshot {
  return {
    state: conversation.director_state ?? 'IDLE',
    data: conversation.director_state_data ?? {},
  };
}

/** The Director's state in one conversation, as persisted. A conversation
 *  nothing has moved yet is `IDLE`. */
export function getDirectorState(
  db: Database.Database,
  conversationId: string,
): DirectorStateSnapshot {
  const conversation = getConversationById(db, conversationId);
  if (conversation === null) throw new Error(`no conversation ${conversationId}`);
  return snapshotOf(conversation);
}

/**
 * The one way the Director's state moves. Validated against the table, then
 * written (state and data in one statement), then the transition's event —
 * committed before anything acts on it (invariant #3). `data` replaces the
 * state's data; omitted, it is cleared, because what intake remembered is
 * not what planning needs.
 */
export function transitionDirectorState(
  db: Database.Database,
  activityLog: ActivityLog,
  conversationId: string,
  to: DirectorState,
  options: { readonly trigger: string; readonly data?: Record<string, unknown> },
): DirectorStateSnapshot {
  const written = writeDirectorTransition(db, conversationId, to, options);
  emitDirectorTransition(activityLog, written);
  return { state: to, data: written.data };
}

/** A transition that has been validated and written, and whose one event is
 *  still to be emitted. */
export interface WrittenDirectorTransition {
  readonly conversationId: string;
  readonly projectId: string | null;
  readonly from: DirectorState;
  readonly to: DirectorState;
  readonly trigger: string;
  readonly event: EventType;
  readonly data: Record<string, unknown>;
}

/**
 * The first half of `transitionDirectorState`, for a caller that moves the
 * Director's state as part of a larger transaction (M11 S2-1b: a project
 * created from the chat). Validated against the same table, written, and
 * nothing emitted: `logEvent` refuses to run inside a transaction, so the
 * caller emits with `emitDirectorTransition` once it has committed.
 */
export function writeDirectorTransition(
  db: Database.Database,
  conversationId: string,
  to: DirectorState,
  options: { readonly trigger: string; readonly data?: Record<string, unknown> },
): WrittenDirectorTransition {
  const conversation = getConversationById(db, conversationId);
  if (conversation === null) throw new Error(`no conversation ${conversationId}`);
  const from = snapshotOf(conversation).state;
  const transition = DIRECTOR_TRANSITIONS.find((t) => t.from === from && t.to === to);
  if (transition === undefined) throw new InvalidDirectorTransitionError(from, to);

  const data = options.data ?? {};
  setConversationDirectorState(db, conversationId, to, data);
  return {
    conversationId,
    projectId: conversation.project_id,
    from,
    to,
    trigger: options.trigger,
    event: transition.event,
    data,
  };
}

/** The second half: the transition's one event (invariant #3). */
export function emitDirectorTransition(
  activityLog: ActivityLog,
  written: WrittenDirectorTransition,
): void {
  activityLog.logEvent({
    actor: 'director',
    type: written.event,
    severity: 'info',
    project_id: written.projectId,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      conversationId: written.conversationId,
      from: written.from,
      to: written.to,
      trigger: written.trigger,
    },
  });
}

/**
 * What the Director's next turn is told about where it is (M11 row S1-14).
 * S1-17's context assembly renders it; it lives here so the state and the
 * words for it cannot drift apart.
 */
export function describeDirectorStateForContext(conversation: Conversation): string {
  const { state, data } = snapshotOf(conversation);
  const detail = Object.keys(data).length > 0 ? ` State data: ${JSON.stringify(data)}.` : '';
  return `Your current state in this conversation: ${state}.${detail}`;
}
