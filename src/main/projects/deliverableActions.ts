import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getDeliverableById, setDeliverableStatus } from '../db/repositories/deliverables';
import { getProjectById } from '../db/repositories/projects';
import { conversationForProject } from '../director/directorConversation';

/**
 * The user's own actions on a deliverable (M11 S3-5b, §8.5.2, §8.7):
 * accepting or rejecting one that is in review, and opening where it is.
 * A rejection reaches the Director with the user's words. Each state change
 * has its one event.
 */

export type DeliverableActionResult =
  { readonly kind: 'done' } | { readonly kind: 'refused'; readonly reason: string };

export function acceptDeliverable(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  deliverableId: string,
): DeliverableActionResult {
  const deliverable = getDeliverableById(deps.db, deliverableId);
  if (deliverable === null)
    return { kind: 'refused', reason: 'That deliverable no longer exists.' };
  if (deliverable.status !== 'in_review') {
    return {
      kind: 'refused',
      reason: `"${deliverable.title}" is ${deliverable.status.replace('_', ' ')}, not in review.`,
    };
  }
  setDeliverableStatus(deps.db, deliverable.id, 'accepted');
  deps.activityLog.logEvent({
    actor: 'user',
    type: 'deliverable.accepted',
    severity: 'info',
    project_id: deliverable.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { deliverableId: deliverable.id },
  });
  return { kind: 'done' };
}

export function rejectDeliverable(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly director?: {
      offerUserDecision?(decision: {
        readonly conversationId: string;
        readonly key: string;
        readonly text: string;
      }): void;
    };
  },
  input: { readonly deliverableId: string; readonly feedback: string },
): DeliverableActionResult {
  const deliverable = getDeliverableById(deps.db, input.deliverableId);
  if (deliverable === null)
    return { kind: 'refused', reason: 'That deliverable no longer exists.' };
  if (deliverable.status !== 'in_review') {
    return {
      kind: 'refused',
      reason: `"${deliverable.title}" is ${deliverable.status.replace('_', ' ')}, not in review.`,
    };
  }
  setDeliverableStatus(deps.db, deliverable.id, 'rejected');
  deps.activityLog.logEvent({
    actor: 'user',
    type: 'deliverable.rejected',
    severity: 'info',
    project_id: deliverable.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { deliverableId: deliverable.id, feedback: input.feedback },
  });
  const conversation = conversationForProject(deps.db, deliverable.project_id);
  if (conversation !== null) {
    deps.director?.offerUserDecision?.({
      conversationId: conversation.id,
      key: `deliverable-rejected:${deliverable.id}:${Date.now()}`,
      text:
        `The user rejected "${deliverable.title}": "${input.feedback}". Decide what it takes — ` +
        'new tasks in the current phase, or a change of plan — and tell them.',
    });
  }
  return { kind: 'done' };
}

/**
 * Where a deliverable is: its own folder when it has a path that exists (the
 * folder a file is in), else the project's folder, which is where Bureau's
 * work lands (§10.1).
 */
export function deliverableFolder(db: Database.Database, deliverableId: string): string | null {
  const deliverable = getDeliverableById(db, deliverableId);
  if (deliverable === null) return null;
  if (deliverable.path !== null && existsSync(deliverable.path)) {
    return statSync(deliverable.path).isDirectory()
      ? deliverable.path
      : path.dirname(deliverable.path);
  }
  return getProjectById(db, deliverable.project_id)?.path ?? null;
}
