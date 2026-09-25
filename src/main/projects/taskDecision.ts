import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getEmployeeById } from '../db/repositories/employees';
import { getProjectById } from '../db/repositories/projects';
import { getPhaseById } from '../db/repositories/phases';
import { getTaskById, insertTask, markTaskDone, setTaskStatus } from '../db/repositories/tasks';
import { getWorktreeById } from '../db/repositories/worktrees';
import { mergeAcceptedTask } from '../workspace/integrationMerge';
import { usdToMicros } from '../../shared/models/money';
import type { Task } from '../../shared/models/task';

/**
 * The Director's decision on a finished task (M11 S3-4b; §8.5.1, §10.6
 * rules 2–3). One function each, called by `bureau_accept_task`,
 * `bureau_reject_task` and, for a trivial change, by the completion path.
 *
 * **Accepting merges into the task's phase integration branch,
 * `bureau/phase/<n>` — never `base_ref`** (§F P-6). The user's branch moves
 * only when the user accepts the phase (rule 5, S3-5). Only a task in `review`
 * whose work was committed and checked after its latest report can be
 * accepted, so a task that failed its checks never is (risk #10).
 */

export type AcceptTaskResult =
  | { readonly kind: 'accepted'; readonly mergeCommit: string; readonly mergedInto: string }
  | { readonly kind: 'conflict'; readonly checkpointId: string }
  | { readonly kind: 'refused'; readonly reason: string };

export function acceptTask(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: {
    readonly taskId: string;
    readonly rationale: string;
    /** What the Director did not verify (M11 S3-11); absent for an auto-accept. */
    readonly notVerified?: readonly string[];
    readonly by: 'director' | 'auto';
  },
): Promise<AcceptTaskResult> {
  return acceptTaskInner(deps, input);
}

async function acceptTaskInner(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: {
    readonly taskId: string;
    readonly rationale: string;
    /** What the Director did not verify (M11 S3-11); absent for an auto-accept. */
    readonly notVerified?: readonly string[];
    readonly by: 'director' | 'auto';
  },
): Promise<AcceptTaskResult> {
  const { db, activityLog } = deps;
  const task = getTaskById(db, input.taskId);
  if (task === null) return { kind: 'refused', reason: 'there is no such task.' };
  if (task.status !== 'review') {
    return {
      kind: 'refused',
      reason: `${task.display_key} is not in review (it is ${task.status}${task.status_reason ? `: ${task.status_reason}` : ''}), so there is nothing checked to accept.`,
    };
  }
  if (!committedSinceReport(db, task.id)) {
    return {
      kind: 'refused',
      reason: `${task.display_key}'s work is not committed and checked yet; wait for its checks.`,
    };
  }
  const employee = task.assignee_employee_id
    ? getEmployeeById(db, task.assignee_employee_id)
    : null;
  const worktree = employee?.worktree_id ? getWorktreeById(db, employee.worktree_id) : null;
  const project = getProjectById(db, task.project_id);
  const phase = task.phase_id ? getPhaseById(db, task.phase_id) : null;
  if (worktree === null || project === null || phase === null) {
    return { kind: 'refused', reason: `${task.display_key} has no branch to merge.` };
  }
  const mergedInto = `bureau/phase/${phase.ordinal}`;

  const merged = await mergeAcceptedTask({
    db,
    activityLog,
    project,
    task,
    worktree,
    integrationBranch: mergedInto,
  });
  if (merged.outcome === 'conflict') return { kind: 'conflict', checkpointId: merged.checkpointId };

  markTaskDone(db, task.id);
  activityLog.logEvent({
    actor: input.by === 'auto' ? 'system' : 'director',
    type: 'task.completed',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: task.assignee_employee_id,
    checkpoint_id: null,
    payload: {
      mergedInto,
      mergeCommit: merged.commitSha,
      rationale: input.rationale,
      ...(input.notVerified === undefined ? {} : { notVerified: [...input.notVerified] }),
      by: input.by,
    },
  });
  return { kind: 'accepted', mergeCommit: merged.commitSha, mergedInto };
}

export interface FollowUpTask {
  readonly title: string;
  readonly body: string;
  readonly acceptance_criteria: readonly string[];
  readonly required_skills: readonly string[];
  readonly deliverable_type: Task['deliverable_type'];
  readonly estimated_cost_usd: number | null;
}

export type RejectTaskResult =
  | { readonly kind: 'failed_with_follow_up'; readonly followUpTaskId: string }
  | { readonly kind: 'blocked' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * §7.9: *"Criteria not met → follow-up task or blocked."* With a follow-up,
 * the task fails (its branch is kept, not merged) and the follow-up is
 * queued in the same phase, pointing at it, for the loop to assign. Without
 * one, the task is blocked with the Director's reason.
 */
export function rejectTask(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: { readonly taskId: string; readonly rationale: string; readonly followUp?: FollowUpTask },
): RejectTaskResult {
  const { db, activityLog } = deps;
  const task = getTaskById(db, input.taskId);
  if (task === null) return { kind: 'refused', reason: 'there is no such task.' };
  if (task.status !== 'review' && task.status !== 'blocked') {
    return {
      kind: 'refused',
      reason: `${task.display_key} is ${task.status}; only a task in review or blocked can be sent back.`,
    };
  }

  if (input.followUp === undefined) {
    setTaskStatus(db, task.id, 'blocked', input.rationale);
    activityLog.logEvent({
      actor: 'director',
      type: 'task.blocked',
      severity: 'info',
      project_id: task.project_id,
      task_id: task.id,
      employee_id: task.assignee_employee_id,
      checkpoint_id: null,
      payload: { reason: input.rationale, by: 'director' },
    });
    return { kind: 'blocked' };
  }

  const followUp = input.followUp;
  const created = db.transaction(() => {
    setTaskStatus(db, task.id, 'failed', input.rationale);
    return insertTask(db, {
      project_id: task.project_id,
      phase_id: task.phase_id,
      parent_task_id: task.id,
      title: followUp.title,
      body: followUp.body,
      acceptance_criteria: [...followUp.acceptance_criteria],
      required_skills: [...followUp.required_skills],
      deliverable_type: followUp.deliverable_type,
      estimated_cost_usd_micros:
        followUp.estimated_cost_usd === null ? null : usdToMicros(followUp.estimated_cost_usd),
    });
  })();
  activityLog.logEvent({
    actor: 'director',
    type: 'task.failed',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: task.assignee_employee_id,
    checkpoint_id: null,
    payload: { reason: input.rationale, followUpTaskId: created.id },
  });
  activityLog.logEvent({
    actor: 'director',
    type: 'task.created',
    severity: 'info',
    project_id: task.project_id,
    task_id: created.id,
    employee_id: null,
    checkpoint_id: null,
    payload: { parentTaskId: task.id, reason: 'follow_up' },
  });
  return { kind: 'failed_with_follow_up', followUpTaskId: created.id };
}

/** The task's latest report was followed by a commit (its checks passed). */
function committedSinceReport(db: Database.Database, taskId: string): boolean {
  const row = db
    .prepare(
      `SELECT
         (SELECT MAX(seq) FROM events WHERE task_id = ? AND type = 'git.committed') AS committed,
         (SELECT MAX(seq) FROM events WHERE task_id = ? AND type = 'task.submitted_for_review') AS reported`,
    )
    .get(taskId, taskId) as { committed: number | null; reported: number | null };
  return row.committed !== null && (row.reported === null || row.committed > row.reported);
}
