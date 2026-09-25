import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getEmployeeById } from '../db/repositories/employees';
import { getProjectById } from '../db/repositories/projects';
import { getTaskById } from '../db/repositories/tasks';
import { getWorktreeById } from '../db/repositories/worktrees';
import { insertOutboxMessage } from '../db/repositories/messages';
import { commitTaskWork, UnexpectedCommitDetectedError } from '../workspace/employeeCommit';
import { runGit } from '../workspace/gitProcess';
import type { ValidatorResult } from '../workspace/validators';
import type { Task } from '../../shared/models/task';

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
 *   the employee as **its one repair attempt**. The second, the task stays
 *   blocked and the Director is told. An employee that says done while its
 *   own tests fail is therefore never accepted (risk #10).
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
      deps.director?.offerTaskSubmitted({
        key: `checks-failed-twice:${task.id}`,
        projectId: task.project_id,
        text:
          `${task.display_key} "${task.title}" failed its checks twice, so it was not ` +
          `committed and is blocked. ${employee.name} said: "${task.result_summary ?? ''}". ` +
          `The checks said:\n${failures}\nDecide what happens next — reassign it, split it, or ` +
          'tell the user it is stuck and why.',
      });
    }
    return;
  }

  const submitted = latestSubmission(db, task.id);
  const changed = await changedFiles(project.path, result.baseCommit, result.commitSha);
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
        'accept it with bureau_accept_task or send it back with bureau_reject_task. What was not ' +
        'verified stays not verified: say so when you report it.',
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
