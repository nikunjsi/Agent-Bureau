import fs from 'node:fs';
import path from 'node:path';
import { runGit, GitCommandError } from './gitProcess';

/**
 * The identity Bureau's own bootstrapping commit is attributed to (Q2 of
 * the M5 plan) — passed per-invocation via `-c`, never written to the
 * repo's persistent config, so nothing about the user's own future
 * commits changes. This session's only commit uses it as both author and
 * committer; part 2's real per-task commits are expected to use it only
 * as committer, with the employee as author (not built this session).
 */
export const BUREAU_GIT_IDENTITY = { name: 'Bureau', email: 'bureau@bureau.local' } as const;

/** Exported (M5 part 2): the real per-task commit path
 * (`gitWorktree.ts`'s `commitWithIdentity`, `integrationMerge.ts`'s
 * merge-commit creation) needs the exact same per-invocation `-c` flags
 * this file's own bootstrapping commit uses — one source of truth for
 * "how Bureau tells git who it is," not a second copy. */
export function identityConfigArgs(): string[] {
  return [
    '-c',
    `user.name=${BUREAU_GIT_IDENTITY.name}`,
    '-c',
    `user.email=${BUREAU_GIT_IDENTITY.email}`,
  ];
}

/**
 * §28 M5 item 1 / §10.5: `git init` if no `.git` exists yet, then apply
 * repo-level config. `core.longpaths=true` always — a pure capability
 * flag with no effect on diffs. `core.autocrlf=input` **only** when
 * Bureau itself is the one running `git init` this call (Q3) — never
 * retroactively on a repo that already had `.git` when this ran, since
 * that would silently change every diff the user sees from then on.
 */
export async function ensureRepoInitialised(
  projectPath: string,
): Promise<{ initialisedNow: boolean }> {
  const gitDirExisted = fs.existsSync(path.join(projectPath, '.git'));

  if (!gitDirExisted) {
    await runGit(['init'], { cwd: projectPath, repoKey: projectPath });
  }

  await runGit(['config', 'core.longpaths', 'true'], { cwd: projectPath, repoKey: projectPath });

  if (!gitDirExisted) {
    await runGit(['config', 'core.autocrlf', 'input'], { cwd: projectPath, repoKey: projectPath });
  }

  return { initialisedNow: !gitDirExisted };
}

/**
 * Q2: `git worktree add` fails against an unborn `HEAD` (a fresh `git
 * init` with zero commits — true of every brand-new project), so Bureau
 * creates an empty bootstrapping commit whenever `HEAD` doesn't resolve
 * yet, regardless of whether Bureau or the user ran `git init` — the
 * "worktree add needs a real start-point" problem doesn't care which.
 * No invented file content; an empty commit is the minimal honest fix.
 */
export async function ensureNonUnbornHead(
  projectPath: string,
): Promise<{ createdInitialCommit: boolean }> {
  try {
    await runGit(['rev-parse', '--verify', 'HEAD'], { cwd: projectPath, repoKey: projectPath });
    return { createdInitialCommit: false };
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
    await runGit([...identityConfigArgs(), 'commit', '--allow-empty', '-m', 'Initial commit'], {
      cwd: projectPath,
      repoKey: projectPath,
    });
    return { createdInitialCommit: true };
  }
}
