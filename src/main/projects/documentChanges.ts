import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import { appendChatMessage } from '../chat/appendMessage';
import { getBriefById } from '../db/repositories/briefs';
import { getPlanById } from '../db/repositories/plans';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import {
  emitDirectorTransition,
  getDirectorState,
  writeDirectorTransition,
} from '../director/directorState';
import type { DirectorState } from '../../shared/models/directorState';
import type { EventType } from '../../shared/models/eventTypes';

/**
 * **"Ask for changes" to a brief or a plan** — `brief.requestEdit` and
 * `plan.requestEdit` (M11 S2-3b, `NEXT-VERSION` §L.4). One function for
 * both documents, because they are the same act: the user has read a
 * version the Director is waiting on and wants it revised.
 *
 * Only a version **awaiting approval** can be sent back: that is where A.3
 * has an arrow for it (`AWAITING_BRIEF_APPROVAL → DRAFTING_BRIEF`,
 * `AWAITING_PLAN_APPROVAL → PLANNING`). An approved or replaced version is
 * refused in words a person can act on.
 *
 * Three state changes, in order, each with its one event (invariant #3):
 * the Director's move back to drafting; the request itself
 * (`project.brief_changes_requested` / `project.plan_changes_requested`,
 * carrying the version it is about); and the user's words, written into
 * the conversation so the transcript shows what they asked for. Then the
 * caller hands the Director the feedback as a turn.
 */
export interface DocumentChangesDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly broadcaster?: ChatBroadcaster;
}

export type DocumentChangesOutcome =
  | {
      readonly kind: 'requested';
      readonly conversationId: string;
      /** What the Director's turn is told. */
      readonly directorText: string;
      readonly messageId: string;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'refused'; readonly message: string };

interface DocumentSpec {
  readonly noun: 'brief' | 'plan';
  readonly waitingState: DirectorState;
  readonly redraftState: DirectorState;
  readonly trigger: string;
  readonly event: EventType;
  readonly idKey: 'briefId' | 'planId';
  readonly nextStep: string;
}

const BRIEF: DocumentSpec = {
  noun: 'brief',
  waitingState: 'AWAITING_BRIEF_APPROVAL',
  redraftState: 'DRAFTING_BRIEF',
  trigger: 'brief_edits',
  event: 'project.brief_changes_requested',
  idKey: 'briefId',
  nextStep: 'Revise the brief with this in mind and post the new version with bureau_write_brief.',
};

const PLAN: DocumentSpec = {
  noun: 'plan',
  waitingState: 'AWAITING_PLAN_APPROVAL',
  redraftState: 'PLANNING',
  trigger: 'plan_edits',
  event: 'project.plan_changes_requested',
  idKey: 'planId',
  nextStep: 'Revise the plan with this in mind and post the new version.',
};

export function requestBriefChanges(
  deps: DocumentChangesDeps,
  input: { readonly briefId: string; readonly feedback: string },
): DocumentChangesOutcome {
  const brief = getBriefById(deps.db, input.briefId);
  if (brief === null) return { kind: 'not_found' };
  return requestChanges(deps, BRIEF, { ...brief, id: brief.id }, input.feedback);
}

export function requestPlanChanges(
  deps: DocumentChangesDeps,
  input: { readonly planId: string; readonly feedback: string },
): DocumentChangesOutcome {
  const plan = getPlanById(deps.db, input.planId);
  if (plan === null) return { kind: 'not_found' };
  return requestChanges(deps, PLAN, plan, input.feedback);
}

function requestChanges(
  deps: DocumentChangesDeps,
  spec: DocumentSpec,
  document: {
    readonly id: string;
    readonly project_id: string;
    readonly version: number;
    readonly status: string;
  },
  feedback: string,
): DocumentChangesOutcome {
  const { db, activityLog } = deps;
  if (document.status !== 'awaiting_approval') {
    return {
      kind: 'refused',
      message:
        document.status === 'approved'
          ? `This ${spec.noun} is already approved. To change it now, discuss it with the Director.`
          : `This version of the ${spec.noun} was replaced by a newer one. Ask for changes on the latest version instead.`,
    };
  }
  const conversation = resolveConversationForDelivery(db, document.project_id);
  if (conversation === null || conversation.project_id !== document.project_id) {
    return { kind: 'refused', message: `This ${spec.noun}'s project has no conversation.` };
  }
  if (getDirectorState(db, conversation.id).state !== spec.waitingState) {
    return {
      kind: 'refused',
      message: `The Director is not waiting on this ${spec.noun} right now, so there is nothing to send back. Say what you want changed in the conversation instead.`,
    };
  }

  const transition = writeDirectorTransition(db, conversation.id, spec.redraftState, {
    trigger: spec.trigger,
  });
  emitDirectorTransition(activityLog, transition);
  activityLog.logEvent({
    actor: 'user',
    type: spec.event,
    severity: 'info',
    project_id: document.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      [spec.idKey]: document.id,
      version: document.version,
      feedbackChars: feedback.length,
    },
  });
  const message = appendChatMessage(
    { db, activityLog, ...(deps.broadcaster ? { broadcaster: deps.broadcaster } : {}) },
    {
      conversationId: conversation.id,
      projectId: document.project_id,
      author: 'user',
      kind: 'text',
      body: `Changes to the ${spec.noun}, version ${document.version}:\n\n${feedback}`,
    },
  );
  return {
    kind: 'requested',
    conversationId: conversation.id,
    messageId: message.id,
    directorText:
      `The user asked for changes to the ${spec.noun} (version ${document.version}):\n\n` +
      `${feedback}\n\n${spec.nextStep}`,
  };
}
