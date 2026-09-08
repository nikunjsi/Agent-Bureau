import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { Employee } from '../../shared/models/employee';
import type { Project } from '../../shared/models/project';
import type { Task } from '../../shared/models/task';
import type { Worktree } from '../../shared/models/worktree';
import {
  getWorktreeById,
  setWorktreePendingCommitTask,
  clearWorktreePendingCommitTask,
  setWorktreeBaseCommitAndClearPendingCommit,
} from '../db/repositories/worktrees';
import { setTaskStatus, incrementTaskAttempts } from '../db/repositories/tasks';
import { getPhaseById } from '../db/repositories/phases';
import { getUsageSummaryForTask } from '../db/repositories/usage';
import { getEmployeeIdByWorktreeId } from '../db/repositories/employees';
import { resolveHeadInWorktree, stageAll, commitWithIdentity } from './gitWorktree';
import { sanitizeEmployeeDirName } from './pathSanitize';
import {
  detectValidators,
  runValidators,
  type Validator,
  type ValidatorResult,
} from './validators';
import { redactText } from '../secrets/redactor';

/**
 * §10.3.1: an unexpected `HEAD` with no Bureau-written intent marker to
 * explain it — the S6 case. Bureau never attempts the commit in this
 * state; the caller finds out via this throw plus the
 * `git.unexpected_commit_detected` security event already on the log by
 * the time it's caught.
 */
export class UnexpectedCommitDetectedError extends Error {
  constructor(worktreePath: string, expected: string, actual: string) {
    super(
      `worktree ${worktreePath}: HEAD (${actual}) does not match the expected base_commit (${expected}), and no Bureau-recorded commit was in flight — §10.3.1 layer 4: something wrote a commit to this repository outside Bureau's own path. Refusing to commit.`,
    );
    this.name = 'UnexpectedCommitDetectedError';
  }
}

function buildEmployeeAuthorIdentity(employee: Employee): {
  readonly name: string;
  readonly email: string;
} {
  return {
    name: `${employee.name} (Bureau)`,
    email: `${sanitizeEmployeeDirName(employee.name)}@bureau.local`,
  };
}

/** §10.3's structured commit message. `Phase:`/`Cost:` are included only
 * when there's real data to put in them — no phase lookup for a
 * phase-less task, no fabricated `$0.00` for a task with no recorded
 * usage (CLAUDE.md's own "don't show $0.00 for unreported usage" trap,
 * applied here by the same reasoning). */
function buildStructuredCommitMessage(
  db: Database.Database,
  employee: Employee,
  task: Task,
): string {
  const roleKey = employee.role_key.includes(':')
    ? (employee.role_key.split(':')[1] ?? employee.role_key)
    : employee.role_key;
  const summary = task.result_summary ?? task.title;
  const lines = [`bureau(${sanitizeEmployeeDirName(employee.name)}): ${summary}`, ''];

  lines.push(`Task:    ${task.display_key}`);
  if (task.phase_id !== null) {
    const phase = getPhaseById(db, task.phase_id);
    if (phase) lines.push(`Phase:   ${phase.ordinal} — ${phase.name}`);
  }
  lines.push(`Role:    ${roleKey}`);
  lines.push(`Engine:  ${employee.engine}`);

  const usage = getUsageSummaryForTask(db, task.id);
  if (usage) {
    const dollars = (usage.costUsdMicros / 1_000_000).toFixed(2);
    const totalTokens = (usage.tokensIn + usage.tokensOut).toLocaleString('en-US');
    lines.push(`Cost:    $${dollars} · ${totalTokens} tokens`);
  }

  // §11.4 choke point 5/6: `summary` (task.result_summary/title) is
  // agent-authored free text — the one place in this message a leaked
  // credential could plausibly appear. Redacted here, once, before the
  // message is ever written to a real git commit (git history is
  // effectively permanent — there is no "revoke it later" for this path).
  return redactText(lines.join('\n'));
}

export interface ResolvePendingCommitMarkerOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly project: Project;
  readonly worktree: Worktree;
}

/**
 * §10.3.1 layer 4 / M5 part 2 plan D4: resolves a durable commit-intent
 * marker left over from an interrupted `commitTaskWork` call — either
 * because that call was itself killed mid-flight, or because it's being
 * called fresh at startup by `reconcileGit.ts` for a worktree nobody has
 * asked about since. If `HEAD` moved past `base_commit`, Bureau's own
 * commit landed before the interruption — converge (the same atomic
 * update `commitTaskWork`'s own success path uses). If `HEAD` still
 * equals `base_commit`, the marker was written but `git commit` itself
 * never ran — nothing to converge, just clear the stale marker.
 *
 * Disk state alone cannot make this call the way part 1's worktree
 * create/remove windows could (a directory either exists or it doesn't,
 * with exactly one legitimate cause either way) — a commit object at
 * `HEAD` looks the same whether Bureau wrote it or a bypass forged a
 * Bureau-shaped one, so this function trusts only the marker it itself
 * wrote in advance, never the commit's own content or metadata.
 */
export async function resolvePendingCommitMarker(
  options: ResolvePendingCommitMarkerOptions,
): Promise<Worktree> {
  const { db, activityLog, project, worktree } = options;
  if (worktree.pending_commit_task_id === null) return worktree;

  const headSha = await resolveHeadInWorktree(project.path, worktree.path);
  if (headSha !== worktree.base_commit) {
    setWorktreeBaseCommitAndClearPendingCommit(db, worktree.id, headSha);
    activityLog.logEvent({
      actor: 'system',
      type: 'git.committed',
      severity: 'info',
      project_id: project.id,
      task_id: worktree.pending_commit_task_id,
      employee_id: getEmployeeIdByWorktreeId(db, worktree.id),
      checkpoint_id: null,
      payload: { worktreeId: worktree.id, commitSha: headSha, reason: 'reconcile_recovered' },
    });
  } else {
    clearWorktreePendingCommitTask(db, worktree.id);
  }
  return getWorktreeById(db, worktree.id) as Worktree;
}

export interface CommitTaskWorkOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly project: Project;
  readonly employee: Employee;
  readonly worktree: Worktree;
  readonly task: Task;
  /** Defaults to `detectValidators(project.path)` — a caller only needs
   * this for tests that want a controlled, dependency-free validator
   * set (the soak, the gate tests). */
  readonly validators?: readonly Validator[];
  /**
   * **Test-only** seam (AUDIT #4), the same shape and the same reason as
   * `ActivityLog.logEvent`'s own `afterFileWrite` hook (AUDIT finding #4
   * of the M0/M1 audit): §10.3.1's crash-window gate has to pin a real
   * process kill precisely at the two boundaries inside this function —
   * after the durable intent marker is written and before the `git
   * commit`, and after the commit and before the atomic update.
   *
   * The fixture used to hand-write these same calls in its own order,
   * which meant the ordering under test was the FIXTURE's, and moving
   * the marker write after the commit here changed nothing that any test
   * could see. Calling the real function with a hook that pauses at
   * exactly the internal boundary is what makes the ordering observable.
   * Never passed by any production caller.
   */
  readonly testHooks?: {
    readonly afterIntentMarker?: () => void | Promise<void>;
    readonly afterGitCommit?: () => void | Promise<void>;
  };
}

export type CommitTaskWorkResult =
  | { readonly outcome: 'committed'; readonly commitSha: string; readonly worktree: Worktree }
  | { readonly outcome: 'validator_failed'; readonly results: readonly ValidatorResult[] };

/**
 * §28 M5 item 4: diff inspection (via validators) → structured commit
 * message → HEAD reconciliation. M5 part 2 plan D4's corrected sequence
 * — the durable intent marker is written *before* the real `git commit`
 * (CLAUDE.md invariant #3, the right way round this time; the first
 * draft had it backwards, caught in plan review before any code
 * existed — see PROGRESS.md's M5 part 2 entry).
 */
export async function commitTaskWork(
  options: CommitTaskWorkOptions,
): Promise<CommitTaskWorkResult> {
  const { db, activityLog, project, employee, task } = options;

  // Step 1: self-heal any marker left by a prior interrupted call before
  // doing anything else.
  const worktree = await resolvePendingCommitMarker({
    db,
    activityLog,
    project,
    worktree: options.worktree,
  });

  // Step 2: HEAD-reconciliation (layer 4's real check — S6's case).
  const headSha = await resolveHeadInWorktree(project.path, worktree.path);
  if (headSha !== worktree.base_commit) {
    setTaskStatus(
      db,
      task.id,
      'blocked',
      'unexpected commit detected in worktree (§10.3.1 layer 4)',
    );
    activityLog.logEvent({
      actor: 'system',
      type: 'git.unexpected_commit_detected',
      severity: 'security',
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { worktreeId: worktree.id, expectedHead: worktree.base_commit, actualHead: headSha },
    });
    throw new UnexpectedCommitDetectedError(worktree.path, worktree.base_commit, headSha);
  }

  // Step 3: validators (§10.4/D5) — a failure blocks the commit; no
  // marker is ever written and no commit is attempted, so there's
  // exactly one real commit attempt per task regardless of how many
  // times a failed one gets retried.
  const validators = options.validators ?? detectValidators(project.path);
  const report = await runValidators(project.path, worktree.path, validators);
  if (!report.allPassed) {
    setTaskStatus(
      db,
      task.id,
      'blocked',
      'validator failure — see git.validator_failed for details',
    );
    incrementTaskAttempts(db, task.id);
    activityLog.logEvent({
      actor: 'system',
      type: 'git.validator_failed',
      severity: 'warn',
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      checkpoint_id: null,
      payload: { results: report.results },
    });
    return { outcome: 'validator_failed', results: report.results };
  }

  // Step 4: write the durable intent marker — BEFORE the side effect.
  setWorktreePendingCommitTask(db, worktree.id, task.id);
  await options.testHooks?.afterIntentMarker?.(); // crash window 1

  // Step 5: the real side effect.
  await stageAll(project.path, worktree.path);
  const author = buildEmployeeAuthorIdentity(employee);
  const message = buildStructuredCommitMessage(db, employee, task);
  const commitSha = await commitWithIdentity(project.path, worktree.path, message, author);
  await options.testHooks?.afterGitCommit?.(); // crash window 2

  // Step 6: one atomic UPDATE — no third crash window between recording
  // the commit and clearing the marker.
  setWorktreeBaseCommitAndClearPendingCommit(db, worktree.id, commitSha);

  // Step 7.
  activityLog.logEvent({
    actor: 'system',
    type: 'git.committed',
    severity: 'info',
    project_id: project.id,
    task_id: task.id,
    employee_id: employee.id,
    checkpoint_id: null,
    payload: { worktreeId: worktree.id, commitSha },
  });

  return {
    outcome: 'committed',
    commitSha,
    worktree: getWorktreeById(db, worktree.id) as Worktree,
  };
}
