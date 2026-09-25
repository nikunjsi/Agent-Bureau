import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getEmployeeById, releaseEmployeeTask } from '../db/repositories/employees';
import { getProjectById } from '../db/repositories/projects';
import { getTaskById, requeueExcluding } from '../db/repositories/tasks';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { getWorktreeById } from '../db/repositories/worktrees';
import { insertOutboxMessage } from '../db/repositories/messages';
import { commitTaskWork, UnexpectedCommitDetectedError } from '../workspace/employeeCommit';
import { runGit } from '../workspace/gitProcess';
import type { ValidatorResult } from '../workspace/validators';
import type { Task } from '../../shared/models/task';
import { getSetting } from '../db/repositories/settings';
import { acceptTask } from './taskDecision';

/**
 * §8.5.1, how a task actually completes (M11 S3-4a; risk #10).
 *
 * `bureau_task_done` only reports: the task goes to `review` and the
 * employee's turn ends. When it has ended (`employee.idle`, reason
 * `task_reported`), this commits the work and runs the validators through
 * the one commit path (`commitTaskWork`: HEAD reconciliation, the push
 * check, the validators, then the commit). Then:
 *
 * - **A pass**: the Director gets a coalesced `task_submitted` trigger with
 *   the employee's summary, what was and was not verified, the files that
 *   changed, every check's result and the acceptance criteria, and evaluates
 *   it (`bureau_get_task_detail` for the diff). The task stays `review` until
 *   the Director accepts or rejects it (S3-4b).
 * - **A validator failure**: `commitTaskWork` blocks the task and counts the
 *   attempt; nothing is committed. The first time, the failure goes back to
 *   the employee as **its one repair attempt**. The second time (M11 S3-6b,
 *   §8.8), the task is reassigned without that employee, or, past
 *   `orchestrator.maxReassignments`, blocked with a checkpoint saying what
 *   was tried; the Director is told either way. An employee that says done
 *   while its own tests fail is therefore never accepted (risk #10).
 * - **An unexpected commit** (layer 4) blocks the task inside
 *   `commitTaskWork`; the Director is told.
 *
 * One evaluation at a time, in order. Never a timer.
 */
export interface TaskCompletionDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly director?: {
    offerTaskSubmitted(input: { key: string; projectId: string; text: string }): void;
  };
}

export interface TaskCompletion {
  /** Resolves when no evaluation is running (tests, and shutdown). */
  settled(): Promise<void>;
  stop(): void;
}

/** One repair attempt after a failed check (§8.5.1). */
const REPAIR_ATTEMPTS = 1;

export function createTaskCompletion(deps: TaskCompletionDeps): TaskCompletion {
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let stopped = false;

  const unsubscribe = deps.activityLog.onEvent((entry) => {
    if (stopped || entry.type !== 'employee.idle' || entry.task_id === null) return;
    const reason = (entry.payload as { reason?: unknown } | null)?.reason;
    if (reason !== 'task_reported') return;
    const taskId = entry.task_id;
    pending += 1;
    chain = chain
      .then(() => (stopped ? undefined : evaluate(deps, taskId)))
      .catch((err: unknown) => console.error('[task completion]', err))
      .finally(() => {
        pending -= 1;
      });
  });

  return {
    settled: async () => {
      while (pending > 0) await chain;
    },
    stop: () => {
      stopped = true;
      unsubscribe();
    },
  };
}

async function evaluate(deps: TaskCompletionDeps, taskId: string): Promise<void> {
  const { db, activityLog } = deps;
  const task = getTaskById(db, taskId);
  if (task === null || task.status !== 'review' || task.assignee_employee_id === null) return;
  const employee = getEmployeeById(db, task.assignee_employee_id);
  const project = getProjectById(db, task.project_id);
  const worktree =
    employee?.worktree_id === null || employee === null
      ? null
      : getWorktreeById(db, employee.worktree_id);
  if (employee === null || project === null || worktree === null) return;

  let result;
  try {
    result = await commitTaskWork({ db, activityLog, project, employee, worktree, task });
  } catch (err) {
    if (!(err instanceof UnexpectedCommitDetectedError)) throw err;
    deps.director?.offerTaskSubmitted({
      key: `unexpected-commit:${task.id}`,
      projectId: task.project_id,
      text:
        `${task.display_key} "${task.title}" was reported done by ${employee.name}, but its ` +
        'worktree has a commit Bureau did not make, so nothing was accepted and the task is ' +
        'blocked. Tell the user plainly; this needs a person to look at.',
    });
    return;
  }

  if (result.outcome === 'push_detected') return; // blocked on its own checkpoint

  if (result.outcome === 'validator_failed') {
    const attempts = getTaskById(db, task.id)?.attempts ?? 0;
    const failures = describeChecks(result.results);
    if (attempts <= REPAIR_ATTEMPTS) {
      sendRepairRequest(deps, task, employee.id, failures);
    } else {
      // M11 S3-6b, §8.8: "Task fails max_attempts on one employee → employee
      // added to excluded_employees; Director reassigns. Fails
      // max_reassignments → blocker checkpoint." Reassigned in plain code (the
      // loop picks someone else), or, past the limit, a blocker saying what
      // was tried.
      const outcome = reassignOrBlock(deps, task, employee, failures);
      deps.director?.offerTaskSubmitted({
        key: `checks-failed-twice:${task.id}:${task.reassignments}`,
        projectId: task.project_id,
        text:
          `${task.display_key} "${task.title}" failed its checks twice with ${employee.name}, so ` +
          `it was not committed. ${employee.name} said: "${task.result_summary ?? ''}". The ` +
          `checks said:\n${failures}\n` +
          (outcome === 'reassigned'
            ? `Bureau is giving it to someone else, without ${employee.name}.`
            : 'It has now failed with every employee it may go to, so it is blocked and the ' +
              'user has a checkpoint saying what was tried. Tell them what you think is wrong.'),
      });
    }
    return;
  }

  const submitted = latestSubmission(db, task.id);
  const changed = await changedFiles(project.path, result.baseCommit, result.commitSha);

  // M11 S3-4b: `review.autoAcceptTrivialTasks` — a small change whose every
  // check passed is accepted in plain code, and the Director is told rather
  // than asked. Anything larger, or a merge that conflicts, goes to it.
  if (getSetting(db, 'review.autoAcceptTrivialTasks')) {
    const lines = await changedLineCount(project.path, result.baseCommit, result.commitSha);
    if (lines <= getSetting(db, 'review.trivialTaskMaxChangedLines')) {
      const accepted = await acceptTask(
        { db, activityLog },
        {
          taskId: task.id,
          rationale: `Accepted automatically: ${lines} line${lines === 1 ? '' : 's'} changed, every check passed.`,
          by: 'auto',
        },
      );
      if (accepted.kind === 'accepted') {
        deps.director?.offerTaskSubmitted({
          key: `auto-accepted:${task.id}`,
          projectId: task.project_id,
          text:
            `${task.display_key} "${task.title}" by ${employee.name} was accepted automatically ` +
            `(${lines} line${lines === 1 ? '' : 's'} changed, every check passed) and merged into ` +
            `${accepted.mergedInto}. They did not verify: ${list(submitted.notVerified)}. Nothing ` +
            'to do unless you disagree.',
        });
        return;
      }
    }
  }

  deps.director?.offerTaskSubmitted({
    key: `evaluate:${task.id}:${result.commitSha}`,
    projectId: task.project_id,
    text: [
      `${task.display_key} "${task.title}" was reported done by ${employee.name}, and its work ` +
        'is committed on its own branch.',
      `Their summary: ${task.result_summary ?? '(none)'}`,
      `They verified: ${list(submitted.verified)}`,
      `They did NOT verify: ${list(submitted.notVerified)}`,
      `Files changed: ${list(changed)}`,
      `Checks:\n${describeChecks(result.validators)}`,
      `Acceptance criteria:\n${task.acceptance_criteria.map((c) => `- ${c}`).join('\n')}`,
      'Evaluate it against the criteria — call bureau_get_task_detail for the full diff — then ' +
        'accept it with bureau_accept_task or send it back with bureau_reject_task. If you cannot ' +
        'tell, do not guess: raise a review checkpoint for the user (bureau_raise_checkpoint, ' +
        'type "review"), or send it back with a follow-up review task for a reviewer. What was ' +
        'not verified stays not verified: say so when you report it.',
    ].join('\n'),
  });
}

/** The one repair attempt: the failure, back to the employee who did it. */
function sendRepairRequest(
  deps: TaskCompletionDeps,
  task: Task,
  employeeId: string,
  failures: string,
): void {
  const message = insertOutboxMessage(deps.db, {
    idempotency_key: `repair:${task.id}:${task.attempts}`,
    from_addr: 'director',
    to_addr: `employee:${employeeId}`,
    task_id: task.id,
    kind: 'handoff',
    subject: 'Checks failed',
    body:
      `Bureau's checks failed on your work for ${task.display_key}, so nothing was committed:\n` +
      `${failures}\nFix it, then report with bureau_task_done again. This is your one repair ` +
      'attempt; after it, the task goes back to the Director.',
  });
  deps.activityLog.logEvent({
    actor: 'system',
    type: 'message.sent',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: employeeId,
    checkpoint_id: null,
    payload: { messageId: message.id, kind: message.kind, to: message.to_addr, reason: 'repair' },
  });
}

function describeChecks(results: readonly ValidatorResult[]): string {
  return results
    .map(
      (r) =>
        `- ${r.name}: ${r.passed ? 'passed' : 'FAILED'}` +
        (r.passed || r.output === '' ? '' : `\n${r.output.slice(0, 2000)}`),
    )
    .join('\n');
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '(nothing)' : items.join('; ');
}

/** What the employee said it verified, from its `bureau_task_done` record. */
export function latestSubmission(
  db: Database.Database,
  taskId: string,
): { verified: string[]; notVerified: string[] } {
  const row = db
    .prepare(
      "SELECT payload FROM events WHERE task_id = ? AND type = 'task.submitted_for_review' ORDER BY seq DESC LIMIT 1",
    )
    .get(taskId) as { payload: string | null } | undefined;
  const payload = row?.payload
    ? (JSON.parse(row.payload) as { verified?: string[]; not_verified?: string[] })
    : {};
  return { verified: payload.verified ?? [], notVerified: payload.not_verified ?? [] };
}

/** Lines added plus removed between two commits. */
async function changedLineCount(repoPath: string, from: string, to: string): Promise<number> {
  const { stdout } = await runGit(['diff', '--numstat', from, to], {
    cwd: repoPath,
    repoKey: repoPath,
  });
  // A binary file shows "-": count it as larger than any trivial change.
  const count = (column: string | undefined): number =>
    column === '-' ? 1_000 : Number(column ?? 0);
  return stdout
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((cols) => cols.length >= 2)
    .reduce((sum, [added, removed]) => sum + count(added) + count(removed), 0);
}

/** The files a commit changed against the commit it was cut from. */
export async function changedFiles(
  repoPath: string,
  baseCommit: string,
  commitSha: string,
): Promise<string[]> {
  const { stdout } = await runGit(['diff', '--name-only', baseCommit, commitSha], {
    cwd: repoPath,
    repoKey: repoPath,
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * §8.8's repeated failure (M11 S3-6b). Below `orchestrator.maxReassignments`
 * the task goes back to the queue with this employee excluded, its attempts
 * reset (the next one gets its own repair attempt) and one `task.reassigned`.
 * At the limit, a `blocker` checkpoint says what was tried and by whom, and
 * the task stays blocked.
 */
function reassignOrBlock(
  deps: TaskCompletionDeps,
  task: Task,
  employee: { readonly id: string; readonly name: string },
  failures: string,
): 'reassigned' | 'blocked' {
  const { db, activityLog } = deps;
  if (task.reassignments < getSetting(db, 'orchestrator.maxReassignments')) {
    const reason = `Failed its checks twice with ${employee.name}; given to someone else.`;
    db.transaction(() => {
      requeueExcluding(db, task.id, employee.id, reason);
      releaseEmployeeTask(db, employee.id, task.id);
    })();
    activityLog.logEvent({
      actor: 'system',
      type: 'task.reassigned',
      severity: 'info',
      project_id: task.project_id,
      task_id: task.id,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { from: employee.id, to: null, reason: 'failed_checks' },
    });
    return 'reassigned';
  }
  const tried = (
    db
      .prepare(
        `SELECT DISTINCT e.name FROM events ev JOIN employees e ON e.id = ev.employee_id
          WHERE ev.task_id = ? AND ev.type = 'git.validator_failed' ORDER BY ev.seq`,
      )
      .all(task.id) as { name: string }[]
  ).map((row) => row.name);
  insertCheckpoint(db, activityLog, {
    project_id: task.project_id,
    task_id: task.id,
    employee_id: null,
    type: 'blocker',
    urgency: 'blocking',
    title: `${task.display_key} has failed ${tried.length} time${tried.length === 1 ? '' : 's'}`,
    context:
      `"${task.title}" failed its checks with ${tried.join(', then ')}, each after a repair ` +
      `attempt. The last checks said:\n${failures}`,
    options: [
      {
        id: 'leave_blocked',
        label: 'Leave it blocked for now',
        consequence: 'Nothing is retried; the Director can split or rewrite the task.',
        reversible: true,
      },
    ],
    default_action: 'leave_blocked',
  });
  return 'blocked';
}
