import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getTaskById } from '../db/repositories/tasks';

/**
 * §9.1's "Blocks work? Yes, for the dependent task", as **one** writer and
 * **one** reader agreeing on **one** key.
 *
 * ## What this replaces, and the invariant #3 violation it closes
 *
 * Two production paths already blocked a task alongside raising a
 * checkpoint, each with its own hand-written call and its own ad-hoc
 * reason string:
 *
 *   - `integrationMerge.ts`: `setTaskStatus(db, id, 'blocked', 'merge
 *     conflict — see the raised checkpoint')`
 *   - `Supervisor.stopForBreaker`: `setTaskStatus(db, id, 'blocked',
 *     'breaker_tripped')`
 *
 * **Neither emitted `task.blocked`.** §5.2 lists it, `bureau_task_blocked`
 * emits it, and CLAUDE.md invariant #3 requires exactly one event per
 * state change — so two real state changes were going unrecorded. That was
 * a live defect, not a stylistic difference, and it is fixed here rather
 * than by adding two more emit calls, for the same reason the
 * `checkpoint.raised` event moved inside `insertCheckpoint`.
 *
 * ## Why `status_reason` is a KEY, not prose
 *
 * `checkpoint:<id>` is what `answerCheckpoint` matches on to decide
 * whether it may unblock. An exact-match key means answering can never
 * clobber a *different*, later block — an employee that subsequently
 * called `bureau_task_blocked` for an unrelated reason keeps its block,
 * because the reason no longer names this checkpoint. Prose would make
 * that comparison a guess.
 *
 * The human-readable detail is not lost: it goes in the `task.blocked`
 * payload, and the checkpoint's own title and context carry it for the
 * reader who actually has to act on it.
 */
export function statusReasonForCheckpoint(checkpointId: string): string {
  return `checkpoint:${checkpointId}`;
}

export function blockTaskForCheckpoint(
  db: Database.Database,
  activityLog: ActivityLog,
  input: {
    readonly taskId: string;
    readonly checkpointId: string;
    /** Why, in words — for the event payload, not for matching. */
    readonly detail: string;
    readonly employeeId?: string | null;
  },
): boolean {
  const task = getTaskById(db, input.taskId);
  if (task === null) return false;

  // A genuinely TERMINAL task cannot be blocked out from under its own
  // outcome. Deliberately a smaller set than `bureau_task_blocked`'s,
  // which also refuses `review` — and the difference is the point:
  //
  //   - `bureau_task_blocked` is an AGENT saying "I am stuck". An agent
  //     that already reported done may not un-report it, so `review` is
  //     refused there.
  //   - This is the SYSTEM discovering that a decision is needed, and
  //     `review` is not an outcome, it is "waiting for a judgement". A
  //     merge conflict on accepted work is precisely that judgement going
  //     badly, and `integrationMerge` blocks a task in `review` for real
  //     (it is the only status an accepted task being merged can be in).
  //
  // Getting this wrong is silent: the merge raises its checkpoint, the
  // task stays in `review`, and the conflict looks resolved.
  if (task.status === 'done' || task.status === 'cancelled' || task.status === 'failed') {
    return false;
  }

  db.prepare('UPDATE tasks SET status = ?, status_reason = ? WHERE id = ?').run(
    'blocked',
    statusReasonForCheckpoint(input.checkpointId),
    input.taskId,
  );

  activityLog.logEvent({
    actor: 'system',
    type: 'task.blocked',
    severity: 'warn',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: input.employeeId ?? task.assignee_employee_id,
    checkpoint_id: input.checkpointId,
    payload: { detail: input.detail, blockedBy: 'checkpoint' },
  });
  return true;
}

/**
 * The other half, called only from `answerCheckpoint`. Unblocks **only**
 * when the task is still blocked on this exact checkpoint.
 *
 * Restores to `assigned` when the task still has an assignee and to
 * `queued` when it does not, rather than remembering a prior status.
 * Storing the pre-block status would be a second piece of state to keep
 * true across a crash; re-deriving it is exactly what M11's assignment
 * loop will read anyway — a task with an owner is that owner's next piece
 * of work, and one without an owner is up for assignment.
 */
export function unblockTaskForCheckpoint(
  db: Database.Database,
  activityLog: ActivityLog,
  input: { readonly taskId: string; readonly checkpointId: string },
): boolean {
  const task = getTaskById(db, input.taskId);
  if (task === null) return false;
  if (task.status !== 'blocked') return false;
  if (task.status_reason !== statusReasonForCheckpoint(input.checkpointId)) return false;

  const restored = task.assignee_employee_id === null ? 'queued' : 'assigned';
  db.prepare('UPDATE tasks SET status = ?, status_reason = NULL WHERE id = ?').run(
    restored,
    input.taskId,
  );

  activityLog.logEvent({
    actor: 'system',
    type: 'task.unblocked',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: task.assignee_employee_id,
    checkpoint_id: input.checkpointId,
    payload: { restoredTo: restored },
  });
  return true;
}
