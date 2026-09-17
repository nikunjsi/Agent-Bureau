import { runGit } from './gitProcess';

/**
 * N-9 / §10.6 rule 6: pushes are **detected**, not only denied.
 *
 * `deny.git_write` matches shell text, and §10.3.1 already lists why that can
 * never be complete (`node -e`, aliases, absolute paths). So, the way layer 4
 * detects an unexpected commit by checking `HEAD`, this detects a push after
 * the fact from the repository's own record of it.
 *
 * ## The mechanism
 *
 * A successful `git push` to a named remote updates that remote's
 * remote-tracking refs, and git's reflog writes the entry `update by push`
 * for each one. The refs and their logs live in the main repository, which
 * every worktree shares, so a push from an employee's worktree is visible
 * here. "Since the task started" is the task branch's own reflog creation
 * entry, which is durable and needs no snapshot, so it survives a restart.
 *
 * ## What it cannot see (stated, not hidden)
 *
 * - A push to a URL or an unnamed remote updates no remote-tracking ref.
 * - A repository with `core.logAllRefUpdates=false` writes no reflog.
 * - The user's own push from their checkout during a task looks the same, and
 *   is reported. That false positive is the safe direction (invariant #6).
 */

export interface DetectedPush {
  /** e.g. `refs/remotes/origin/main` */
  readonly ref: string;
  readonly remote: string;
  /** The pushed branch as the remote names it, e.g. `main`. */
  readonly branch: string;
  readonly newSha: string;
  /** Reflog time, whole seconds since the epoch. */
  readonly atUnixSeconds: number;
  /** `branch` is in `projects.protected_refs`. */
  readonly protected: boolean;
}

const PUSH_REFLOG_SUBJECT = 'update by push';

/** `name@{1789648292}` → 1789648292, or null for anything else. */
function reflogUnixSeconds(selector: string): number | null {
  const match = /@\{(\d+)\}$/.exec(selector.trim());
  return match?.[1] === undefined ? null : Number(match[1]);
}

async function branchCreatedAtUnixSeconds(repoPath: string, branch: string): Promise<number> {
  const { stdout } = await runGit(
    ['reflog', 'show', '--date=unix', '--format=%gd', `refs/heads/${branch}`, '--'],
    { cwd: repoPath, repoKey: repoPath, acceptExitCodes: [128] },
  );
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  const oldest = lines.at(-1);
  // No reflog means the start of the task is unknowable. Every push on
  // record is then reported once (fail closed), and `alreadyReported` in
  // the caller stops the same one being reported twice.
  return oldest === undefined ? 0 : (reflogUnixSeconds(oldest) ?? 0);
}

/**
 * Every push recorded in a remote-tracking reflog at or after the creation
 * of `taskBranch`. Newest first per ref, in `for-each-ref` order.
 */
export async function detectPushesSinceBranchCreated(
  repoPath: string,
  taskBranch: string,
  protectedRefs: readonly string[],
): Promise<DetectedPush[]> {
  const since = await branchCreatedAtUnixSeconds(repoPath, taskBranch);
  const { stdout: refList } = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/remotes'],
    { cwd: repoPath, repoKey: repoPath },
  );

  const pushes: DetectedPush[] = [];
  for (const ref of refList.split('\n').map((line) => line.trim())) {
    if (ref.length === 0 || ref.endsWith('/HEAD')) continue;
    const [remote, ...branchParts] = ref.slice('refs/remotes/'.length).split('/');
    const branch = branchParts.join('/');
    if (remote === undefined || branch.length === 0) continue;

    const { stdout: log } = await runGit(
      ['reflog', 'show', '--date=unix', '--format=%gd%x09%gs%x09%H', ref, '--'],
      { cwd: repoPath, repoKey: repoPath },
    );
    for (const line of log.split('\n')) {
      const [selector, subject, sha] = line.split('\t');
      if (selector === undefined || subject === undefined || sha === undefined) continue;
      if (!subject.startsWith(PUSH_REFLOG_SUBJECT)) continue;
      const at = reflogUnixSeconds(selector);
      if (at === null || at < since) continue;
      pushes.push({
        ref,
        remote,
        branch,
        newSha: sha.trim(),
        atUnixSeconds: at,
        protected: protectedRefs.includes(branch),
      });
    }
  }
  return pushes;
}
