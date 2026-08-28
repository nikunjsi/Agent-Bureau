import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { RepoCommandQueue } from './gitQueue';

/** Carries everything needed to diagnose a failed git invocation without
 * re-running it — the command, argv, cwd, and git's own stderr. Never
 * constructed from a shell-interpolated string (trap a): `args` is always
 * the literal argv array that was passed to `execFile`. */
export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} (cwd=${cwd}) failed with exit code ${exitCode}: ${stderr.trim()}`);
    this.name = 'GitCommandError';
  }
}

/**
 * §10.1's promise that Bureau never changes what's checked out in the
 * user's own project folder, made structural (M5 plan review, Q5): the
 * one place `runGit` is ever called with `checkout`/`switch` targeting
 * the main repo path throws before a process is even spawned, rather
 * than relying on every call site remembering not to.
 */
export class MainWorktreeCheckoutError extends Error {
  constructor(args: readonly string[], cwd: string) {
    super(
      `refused: "git ${args.join(' ')}" would run checkout/switch against the main project working tree (${cwd}) — §10.1 promises Bureau never changes what the user has checked out there. Run checkout-family commands against a worktree's own path instead.`,
    );
    this.name = 'MainWorktreeCheckoutError';
  }
}

export interface RunGitOptions {
  /** Where the command actually executes — a worktree's own path for
   * worktree-scoped operations, or the main repo path for ref-level ones. */
  cwd: string;
  /** The main repo's own absolute path — always the same value for every
   * call touching one repository, worktree-scoped or not (Q6). Used both
   * as the serialization key and as the "never checkout here" guard's
   * comparison target (Q5) — one parameter, two jobs, not two lookups. */
  repoKey: string;
  env?: NodeJS.ProcessEnv;
}

const queue = new RepoCommandQueue();

const CHECKOUT_LIKE_SUBCOMMANDS = new Set(['checkout', 'switch']);

/** Matches the transient, retryable lock-contention failures §10.5 and
 * trap (9) name — the user running `git status` in their own terminal on
 * the same repo (§10.1 explicitly permits this) can legitimately hold
 * `index.lock` or a ref lock for a moment. Not retried: anything else,
 * including a genuine merge conflict or a missing ref, which retrying
 * would never fix. */
const LOCK_CONTENTION_PATTERN = /index\.lock|cannot lock ref|unable to create .*\.lock/i;
const MAX_LOCK_RETRY_ATTEMPTS = 4;
const LOCK_RETRY_BACKOFF_MS = [100, 300, 600];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMainWorktreeCheckout(args: readonly string[], cwd: string, repoKey: string): boolean {
  const subcommand = args[0];
  if (subcommand === undefined || !CHECKOUT_LIKE_SUBCOMMANDS.has(subcommand)) return false;
  try {
    return fs.realpathSync.native(cwd) === fs.realpathSync.native(repoKey);
  } catch {
    // Either path doesn't exist (yet) — can't be the same directory a
    // real repo lives at, so this can't be the guarded case.
    return false;
  }
}

function spawnGitOnce(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', args as string[], { cwd, env, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const exitCode = typeof error.code === 'number' ? error.code : null;
        reject(new GitCommandError(args, cwd, exitCode, stderr));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * The sole `git`-spawning function in this codebase (trap a: argv array,
 * never a shell string — `args` goes straight to `execFile`, no shell
 * involved at all). Serializes every call for one repository through
 * `RepoCommandQueue` (Q6), refuses a main-tree checkout/switch before
 * spawning anything (Q5), and retries transient lock contention with a
 * short bounded backoff (trap 9) — real value for part 2's 100-cycle
 * soak, cheap to have now.
 */
export async function runGit(args: string[], options: RunGitOptions): Promise<{ stdout: string; stderr: string }> {
  if (isMainWorktreeCheckout(args, options.cwd, options.repoKey)) {
    throw new MainWorktreeCheckoutError(args, options.cwd);
  }

  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    // Never let git block waiting on stdin for credentials — every
    // command this codebase runs is local (init/worktree/branch/commit/
    // rev-parse/status); nothing here should ever need a prompt, and if
    // something unexpected does, failing loudly beats hanging silently.
    GIT_TERMINAL_PROMPT: '0',
  };

  return queue.runSerialized(options.repoKey, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_LOCK_RETRY_ATTEMPTS; attempt += 1) {
      try {
        return await spawnGitOnce(args, options.cwd, env);
      } catch (err) {
        lastError = err;
        const isLockContention = err instanceof GitCommandError && LOCK_CONTENTION_PATTERN.test(err.stderr);
        if (!isLockContention || attempt === MAX_LOCK_RETRY_ATTEMPTS - 1) throw err;
        await sleep(LOCK_RETRY_BACKOFF_MS[attempt] ?? 600);
      }
    }
    // Unreachable — the loop above always either returns or throws — but
    // TypeScript can't see that from a `for` loop alone.
    throw lastError;
  });
}
