import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { Project } from '../../shared/models/project';
import type { Task } from '../../shared/models/task';
import type { Worktree } from '../../shared/models/worktree';
import { setTaskStatus } from '../db/repositories/tasks';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { blockTaskForCheckpoint } from '../checkpoints/taskBlocking';
import { resolveRef } from './gitWorktree';
import { mergeTreeCheck, getBlobContent, type ConflictEntry } from './mergeTree';
import { runGit, GitCommandError } from './gitProcess';
import { identityConfigArgs } from './gitInit';

/**
 * M5 part 2 plan D2: three concurrent merges against one integration
 * branch produce real compare-and-swap mismatches in normal operation
 * (D11's soak), not just as an edge case — bounded, not a spin loop,
 * same shape as `gitProcess.ts`'s own lock-contention retry but a
 * separately-named constant (a legitimate concurrent update racing
 * fairly is conceptually different from a lock held by something
 * external, worth tuning independently).
 */
const MAX_MERGE_CAS_RETRY_ATTEMPTS = 4;
const MERGE_CAS_RETRY_BACKOFF_MS = [20, 50, 100];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MergeRefRaceExhaustedError extends Error {
  constructor(integrationBranch: string, attempts: number, cause: unknown) {
    super(
      `merge into ${integrationBranch} failed after ${attempts} attempts — the branch kept moving under concurrent merges faster than this one could land. Fails loudly rather than retrying forever (CLAUDE.md invariant #6). Last attempt's cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MergeRefRaceExhaustedError';
  }
}

async function createMergeCommit(
  repoPath: string,
  treeSha: string,
  parentShas: readonly string[],
  message: string,
): Promise<string> {
  const parentArgs = parentShas.flatMap((sha) => ['-p', sha]);
  const { stdout } = await runGit(
    [...identityConfigArgs(), 'commit-tree', treeSha, ...parentArgs, '-m', message],
    {
      cwd: repoPath,
      repoKey: repoPath,
    },
  );
  return stdout.trim();
}

/** `git update-ref <ref> <new> <old>` — the three-argument compare-and-
 * swap form: only updates `ref` if it currently points at `old`. Throws
 * `GitCommandError` on a mismatch (or any other failure) — the caller
 * decides whether that's worth retrying. */
async function updateRefCompareAndSwap(
  repoPath: string,
  ref: string,
  newSha: string,
  oldSha: string,
): Promise<void> {
  await runGit(['update-ref', '-m', 'bureau: merge', ref, newSha, oldSha], {
    cwd: repoPath,
    repoKey: repoPath,
  });
}

export interface MergeAcceptedTaskOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly project: Project;
  readonly task: Task;
  /** `worktree.branch` is the task's own branch — the "theirs" side of
   * the merge. The worktree itself is otherwise untouched: this whole
   * operation is plumbing-only (D2), no working directory involved. */
  readonly worktree: Worktree;
  readonly integrationBranch: string;
}

export type MergeAcceptedTaskResult =
  | { readonly outcome: 'merged'; readonly commitSha: string }
  | {
      readonly outcome: 'conflict';
      readonly conflicts: readonly ConflictEntry[];
      readonly checkpointId: string;
    };

/**
 * D1's acceptance seam — called explicitly by this session's tests and
 * the soak driver, standing in for what M11's Director will eventually
 * call after real acceptance-criteria evaluation (§8.5.1). Nothing in
 * `employeeCommit.ts` calls this; nothing here auto-fires on a
 * successful commit. Resolved spec contradiction: this is task
 * *acceptance*, not task *completion* (§10.6 rule 3/§8.5.1, not §28's
 * own item-6 wording, fixed in the same commit as this file).
 *
 * D2: the merge itself runs entirely as git plumbing (`git merge-tree
 * --write-tree`, `git commit-tree`, `git update-ref`) — no working
 * directory is ever touched, so there's no "which physical folder does
 * this run in" question and nothing here can violate §10.1's "never
 * touch what the user has checked out" promise.
 */
export async function mergeAcceptedTask(
  options: MergeAcceptedTaskOptions,
): Promise<MergeAcceptedTaskResult> {
  const { db, activityLog, project, task, worktree, integrationBranch } = options;
  const taskBranch = worktree.branch;
  const message = `bureau: merge ${taskBranch} into ${integrationBranch} (${task.display_key})`;

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_MERGE_CAS_RETRY_ATTEMPTS; attempt += 1) {
    const integrationSha = await resolveRef(project.path, integrationBranch);
    const taskBranchSha = await resolveRef(project.path, taskBranch);

    const mergeResult = await mergeTreeCheck(project.path, integrationBranch, taskBranch);

    if (!mergeResult.clean) {
      return handleConflict(
        db,
        activityLog,
        project,
        task,
        integrationBranch,
        mergeResult.conflicts,
      );
    }

    const newCommitSha = await createMergeCommit(
      project.path,
      mergeResult.treeSha,
      [integrationSha, taskBranchSha],
      message,
    );

    try {
      await updateRefCompareAndSwap(
        project.path,
        `refs/heads/${integrationBranch}`,
        newCommitSha,
        integrationSha,
      );
    } catch (err) {
      if (!(err instanceof GitCommandError) || attempt === MAX_MERGE_CAS_RETRY_ATTEMPTS - 1) {
        lastError = err;
        break;
      }
      lastError = err;
      await sleep(MERGE_CAS_RETRY_BACKOFF_MS[attempt] ?? 100);
      continue;
    }

    setTaskStatus(db, task.id, 'done');
    activityLog.logEvent({
      actor: 'system',
      type: 'git.merged',
      severity: 'info',
      project_id: project.id,
      task_id: task.id,
      employee_id: null,
      checkpoint_id: null,
      payload: { integrationBranch, taskBranch, commitSha: newCommitSha },
    });
    return { outcome: 'merged', commitSha: newCommitSha };
  }

  throw new MergeRefRaceExhaustedError(integrationBranch, MAX_MERGE_CAS_RETRY_ATTEMPTS, lastError);
}

/** §10.6 rule 4 / M5 part 2 plan D6: no auto-resolution, no `--strategy`,
 * nothing that guesses — a real `checkpoints` row listing the
 * conflicting files and both sides' actual content, `expires_at`/
 * `default_action` both null (the schema's own "no safe default" case,
 * CLAUDE.md invariants #7/#8 — a merge conflict genuinely has none).
 * Real options with the invariant-#8-required `consequence`, matching
 * §10.6 rule 4's own text almost verbatim. Nothing executes either
 * option this session (no live checkpoint-resolution flow exists before
 * M8) — the row is the correct, real, spec-shaped record. */
async function handleConflict(
  db: Database.Database,
  activityLog: ActivityLog,
  project: Project,
  task: Task,
  integrationBranch: string,
  conflicts: readonly ConflictEntry[],
): Promise<MergeAcceptedTaskResult> {
  const preview = await Promise.all(
    conflicts.map(async (conflict) => ({
      path: conflict.path,
      base: conflict.base ? await getBlobContent(project.path, conflict.base.sha) : null,
      ours: conflict.ours ? await getBlobContent(project.path, conflict.ours.sha) : null,
      theirs: conflict.theirs ? await getBlobContent(project.path, conflict.theirs.sha) : null,
    })),
  );

  const fileList = conflicts.map((c) => c.path).join(', ');
  const checkpoint = insertCheckpoint(db, activityLog, {
    project_id: project.id,
    task_id: task.id,
    employee_id: null,
    type: 'blocker',
    urgency: 'blocking',
    title: `Merge conflict in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}`,
    context: `Task ${task.display_key}'s branch conflicts with ${integrationBranch} in: ${fileList}. Bureau does not guess at merge resolutions (§10.6).`,
    options: [
      {
        id: 'create_follow_up_task',
        label: 'Create a follow-up task to resolve the conflict',
        consequence:
          'A new task is created in this phase, assigned to one employee with both branches available; the original task stays blocked until it completes.',
      },
      {
        id: 'resolve_manually',
        label: 'Resolve the conflict yourself, outside Bureau',
        consequence:
          'You edit the conflicting files directly and tell Bureau when it is safe to retry the merge; Bureau does not guess at a resolution on your behalf.',
      },
    ],
    preview,
    default_action: null,
  });

  // M8: the task is blocked THROUGH the checkpoint. The bare
  // setTaskStatus this replaces ran BEFORE the row existed (so it could
  // not name it) and emitted no `task.blocked` event at all — a real
  // state change going unrecorded, against invariant #3. Ordering also
  // matters: the checkpoint is committed first, then the block that
  // points at it, so there is never a task blocked on a checkpoint id
  // that does not exist.
  blockTaskForCheckpoint(db, activityLog, {
    taskId: task.id,
    checkpointId: checkpoint.id,
    detail: `merge conflict in ${fileList}`,
  });

  activityLog.logEvent({
    actor: 'system',
    type: 'git.merge_conflict',
    severity: 'warn',
    project_id: project.id,
    task_id: task.id,
    employee_id: null,
    checkpoint_id: checkpoint.id,
    payload: { integrationBranch, files: conflicts.map((c) => c.path) },
  });

  return { outcome: 'conflict', conflicts, checkpointId: checkpoint.id };
}
