import fs from 'node:fs';
import { runGit } from './gitProcess';
import { identityConfigArgs } from './gitInit';

export interface WorktreeListEntry {
  path: string;
  head: string;
  /** null when the worktree is detached — never true for anything Bureau creates, but real git state can be anything. */
  branch: string | null;
}

/** Parses `git worktree list --porcelain` output — one block per
 * worktree, separated by a blank line, `worktree <path>` / `HEAD <sha>` /
 * `branch refs/heads/<name>` (or `detached`). Exported separately from
 * the git-invoking function so the parser itself is testable against
 * captured output without spawning a real process. */
export function parseWorktreeListPorcelain(output: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: { path?: string; head?: string; branch: string | null } | null = null;

  const flush = (): void => {
    if (current?.path !== undefined && current.head !== undefined) {
      entries.push({ path: current.path, head: current.head, branch: current.branch });
    }
  };

  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ') && current) {
      const ref = line.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    }
    // 'detached' / 'bare' / 'locked [...]' / 'prunable [...]' lines carry
    // no data this codebase needs — current.branch simply stays null for
    // detached, and locked/prunable worktrees are still real entries the
    // bidirectional reconciler should see.
  }
  flush();
  return entries;
}

/**
 * `git worktree list --porcelain` always lists the **main working tree**
 * first (M5 plan review fix #3) — it is never a row in the `worktrees`
 * table, and a naive diff against it would try to `git worktree remove`
 * the user's own project folder. Git refuses that ("fatal: is a main
 * working tree") rather than destroying it, but the very first
 * reconcile would still throw. Filtered out here, once, so nothing
 * downstream has to remember to.
 */
export async function listWorktreesPorcelain(repoPath: string): Promise<WorktreeListEntry[]> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoPath, repoKey: repoPath });
  const all = parseWorktreeListPorcelain(stdout);
  const mainRealPath = fs.realpathSync.native(repoPath);
  return all.filter((entry) => {
    try {
      return fs.realpathSync.native(entry.path) !== mainRealPath;
    } catch {
      // Directory no longer exists on disk — genuinely orphaned git
      // metadata, not the main tree. Keep it; reconcile needs to see it.
      return true;
    }
  });
}

/** Creates the worktree and its branch together, one command — §10.3/
 * Q1. `startPoint` is always explicit (never implied). */
export async function addWorktree(repoPath: string, worktreePath: string, branch: string, startPoint: string): Promise<void> {
  await runGit(['worktree', 'add', '-b', branch, worktreePath, startPoint], { cwd: repoPath, repoKey: repoPath });
}

/** Trap (b): remove, THEN prune — always this order, always both calls.
 * `prune` alone only cleans records whose directories are already gone. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, repoKey: repoPath });
  await runGit(['worktree', 'prune'], { cwd: repoPath, repoKey: repoPath });
}

/** The standalone prune reconcile() also runs on its own (§4.4) — cheap,
 * catches anything git itself considers stale beyond what the
 * bidirectional table diff already found. */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await runGit(['worktree', 'prune'], { cwd: repoPath, repoKey: repoPath });
}

/**
 * §10.3/Q4/Q5: re-points a worktree to a new branch from an explicit
 * start-point. Runs with `cwd` = the worktree's own path, never the main
 * repo — `checkout -B` only ever affects that one worktree's HEAD.
 * **Always takes `startPoint` explicitly** (M5 plan review fix #4) —
 * bare `checkout -B <branch>` resets to the worktree's *current* HEAD,
 * which silently discards "from the integration head" the moment that
 * HEAD isn't already correct.
 */
export async function checkoutBranch(repoPath: string, worktreePath: string, branch: string, startPoint: string): Promise<void> {
  await runGit(['checkout', '-B', branch, startPoint], { cwd: worktreePath, repoKey: repoPath });
}

/** Q4: checked before every re-point; a non-empty result means something
 * wrote to this worktree outside the expected flow. */
export async function isWorktreeDirty(repoPath: string, worktreePath: string): Promise<boolean> {
  const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktreePath, repoKey: repoPath });
  return stdout.trim().length > 0;
}

/** Parses `git status --porcelain`'s short format (`XY PATH`, or
 * `XY ORIG -> PATH` for a rename — always exactly two status characters
 * then one space before the path starts) into a flat list of paths.
 * Exported separately from the git-invoking wrapper for the same
 * testability reason as `parseWorktreeListPorcelain` (part 1). */
export function parseStatusPorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length < 4) continue; // "XY path" minimum shape
    const rest = line.slice(3); // the two status chars + one space
    const arrowIndex = rest.indexOf(' -> ');
    const filePath = arrowIndex === -1 ? rest : rest.slice(arrowIndex + 4);
    // Unusual-character paths come back double-quoted with escapes —
    // a real edge case, out of scope for this session's secret scan
    // (would need a real C-style unquoting pass); strip surrounding
    // quotes if present so the common case still works correctly.
    const unquoted = filePath.startsWith('"') && filePath.endsWith('"') ? filePath.slice(1, -1) : filePath;
    paths.push(unquoted);
  }
  return paths;
}

/** Every path `git status --porcelain` reports as changed in this
 * worktree — staged, unstaged, or untracked — for the secret scan
 * (M5 part 2, D5) to read directly off disk. */
export async function listChangedFiles(repoPath: string, worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(['status', '--porcelain'], { cwd: worktreePath, repoKey: repoPath });
  return parseStatusPorcelainPaths(stdout);
}

/** Ref-only — creates a branch without checking it out anywhere, so it
 * never touches any working tree (Q5). Used for the hire-time placeholder
 * branch and for `createPhaseIntegrationBranch` (Q8). */
export async function createBranch(repoPath: string, branchName: string, startPoint: string): Promise<void> {
  await runGit(['branch', branchName, startPoint], { cwd: repoPath, repoKey: repoPath });
}

/** Force delete — Bureau's own placeholder/superseded branches are
 * expected to be unmerged (that's the whole point of `-B` re-pointing),
 * so a plain `git branch -d` would always refuse. */
export async function deleteBranch(repoPath: string, branchName: string): Promise<void> {
  await runGit(['branch', '-D', branchName], { cwd: repoPath, repoKey: repoPath });
}

/** Resolves any ref/commit-ish to its full SHA, against the **main repo**
 * (`cwd` and `repoKey` are the same value here on purpose — every call
 * site so far resolves a ref like `project.base_ref` or an integration
 * branch, never a worktree's own HEAD). */
export async function resolveRef(repoPath: string, ref: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', ref], { cwd: repoPath, repoKey: repoPath });
  return stdout.trim();
}

/**
 * §10.3.1 layer 4 (M5 part 2): a worktree's own current HEAD. **Not** a
 * reuse of `resolveRef(worktreePath, 'HEAD')` — that would use the
 * worktree's own path as `repoKey` too, serializing this call against a
 * different queue key than the rest of that repo's git traffic and
 * breaking Q6's whole-repo serialization guarantee (caught in M5 part 2
 * plan review). Matches `isWorktreeDirty`'s existing
 * `(repoPath, worktreePath)` shape instead: `cwd` is the worktree,
 * `repoKey` is always the main repo.
 */
export async function resolveHeadInWorktree(repoPath: string, worktreePath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', 'HEAD'], { cwd: worktreePath, repoKey: repoPath });
  return stdout.trim();
}

/** §10.3: "the employee never runs git write commands" — Bureau's own
 * commit path stages everything (new/modified/deleted files) on the
 * employee's behalf, right before committing (M5 part 2, item 4). */
export async function stageAll(repoPath: string, worktreePath: string): Promise<void> {
  await runGit(['add', '-A'], { cwd: worktreePath, repoKey: repoPath });
}

/** §10.3's structured commit message, with the author/committer split
 * (M5 part 2 plan, D3): the employee is the author, Bureau is the
 * committer — both per-invocation via `-c`/`--author`, reusing
 * `gitInit.ts`'s own identity flags for the committer half so there is
 * exactly one source of truth for "how Bureau tells git who it is."
 * Never written to persistent repo config. Returns the new commit's
 * full SHA (via `resolveHeadInWorktree`, not re-derived). */
export async function commitWithIdentity(
  repoPath: string,
  worktreePath: string,
  message: string,
  author: { readonly name: string; readonly email: string },
): Promise<string> {
  await runGit(
    [...identityConfigArgs(), 'commit', '--author', `${author.name} <${author.email}>`, '-m', message],
    { cwd: worktreePath, repoKey: repoPath },
  );
  return resolveHeadInWorktree(repoPath, worktreePath);
}

/** The branch name currently checked out in the main working tree —
 * gate item 1's "unchanged before/after" assertion reads this. */
export async function getCheckedOutBranch(repoPath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, repoKey: repoPath });
  return stdout.trim();
}
