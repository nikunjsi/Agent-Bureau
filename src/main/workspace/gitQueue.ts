import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Thrown when `runSerialized` is called for a `repoKey` that is already
 * the active context on the current async continuation — i.e. a queued
 * operation tried to enqueue another operation for the *same* repo from
 * within its own execution. A promise-chain queue would otherwise wait on
 * a tail the outer call itself is blocking, which never resolves: a
 * silent hang, not a loud failure. This is the structural guard plan
 * review asked for, not a "don't do this" comment — see gitProcess.ts's
 * own doc comment for why only it ever calls `runSerialized`.
 */
export class ReentrantGitQueueError extends Error {
  constructor(repoKey: string) {
    super(
      `re-entrant git queue call for repo "${repoKey}" — a queued git operation attempted to enqueue another operation for the same repo from within its own execution, which would deadlock waiting on itself.`,
    );
    this.name = 'ReentrantGitQueueError';
  }
}

/**
 * §10.5/Q6 of the M5 plan: `packed-refs`, loose refs, and
 * `.git/worktrees/*` metadata are shared across every worktree of one
 * repository, so concurrent Bureau-initiated git commands touching the
 * *same* repo (from different worktrees or the main tree) must serialize
 * against each other, or the 100-cycle soak (part 2) flakes on ref-lock
 * collisions. Per-repo granularity, not per-worktree — a per-worktree
 * queue would let two worktrees of the same repo race.
 *
 * Deliberately the *only* thing that owns a queue in this codebase's git
 * layer — `gitProcess.ts`'s `runGit()` is the sole caller of
 * `runSerialized`. Nothing above it (the orchestration functions in
 * `employeeWorktree.ts`) enqueues anything; they're plain `async`
 * functions that call `runGit` one `await` at a time and get
 * serialization for free, because every one of those calls passes
 * through this same gate. A second enqueuing layer above this one is
 * exactly what would create the re-entrancy deadlock this class guards
 * against.
 */
export class RepoCommandQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly activeContext = new AsyncLocalStorage<string>();

  async runSerialized<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeContext.getStore() === repoKey) {
      throw new ReentrantGitQueueError(repoKey);
    }

    const previousTail = this.tails.get(repoKey) ?? Promise.resolve();
    // Run only after the previous slot has *settled* (success or
    // failure) — a failed previous command must not skip or corrupt the
    // ordering of the next one. AsyncLocalStorage.run marks this
    // execution (and everything it awaits) as running inside `repoKey`'s
    // context, which is what the re-entrancy check above reads.
    const run = previousTail.then(
      () => this.activeContext.run(repoKey, fn),
      () => this.activeContext.run(repoKey, fn),
    );
    // The stored tail only ever needs to signal "the previous slot is
    // done", never the previous slot's actual value or rejection —
    // otherwise every subsequent caller in the chain would also see
    // this one's rejection. `run` itself (returned below) still rejects
    // normally for its own caller.
    this.tails.set(
      repoKey,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}
