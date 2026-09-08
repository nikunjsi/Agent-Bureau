import { runGit } from './gitProcess';

/**
 * M5 part 2 / §10.6: `git merge-tree --write-tree` (git 2.38+ — recorded
 * as a documented prerequisite in docs/BUILD-SPEC.md §10; enforcement is
 * M13's job via §15.3's `Prerequisite.detect()`, not built here) performs
 * a real three-way merge entirely at the object-database level — no
 * working directory is ever touched, which is what let this session drop
 * a "dedicated integration worktree" design entirely (M5 part 2 plan,
 * D2). Verified empirically against a real throwaway repo before this
 * was written, not assumed from memory:
 *
 *   clean:    exit 0, stdout is exactly the resulting tree SHA (one line)
 *   conflict: exit 1, stdout is the tree SHA, then one stage line per
 *             conflicting path per side present (`<mode> <blobSHA>
 *             <stage> TAB <path>`, stage 1/2/3 = base/ours/theirs), then
 *             a blank line, then human-readable messages
 *             ("Auto-merging X", "CONFLICT (content): ...").
 */

export interface BlobRef {
  readonly mode: string;
  readonly sha: string;
}

export interface ConflictEntry {
  readonly path: string;
  readonly base: BlobRef | null;
  readonly ours: BlobRef | null;
  readonly theirs: BlobRef | null;
}

export interface MergeTreeCleanResult {
  readonly clean: true;
  readonly treeSha: string;
}

export interface MergeTreeConflictResult {
  readonly clean: false;
  readonly treeSha: string;
  readonly conflicts: readonly ConflictEntry[];
  readonly messages: readonly string[];
}

export type MergeTreeResult = MergeTreeCleanResult | MergeTreeConflictResult;

const STAGE_LINE_PATTERN = /^(\d+) ([0-9a-f]{40}) ([123])\t(.+)$/;

/** Pure parser, tested separately against real captured output — same
 * discipline as part 1's `parseWorktreeListPorcelain`. */
export function parseMergeTreeOutput(stdout: string, exitCode: number): MergeTreeResult {
  const lines = stdout.split('\n');
  const treeSha = (lines[0] ?? '').trim();

  if (exitCode === 0) {
    return { clean: true, treeSha };
  }

  const conflictsByPath = new Map<
    string,
    { base: BlobRef | null; ours: BlobRef | null; theirs: BlobRef | null }
  >();
  let i = 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.trim().length === 0) {
      i += 1;
      break;
    }
    const match = STAGE_LINE_PATTERN.exec(line);
    if (!match) break; // unrecognized shape — stop treating as stage lines
    const [, mode, sha, stage, filePath] = match as unknown as [
      string,
      string,
      string,
      '1' | '2' | '3',
      string,
    ];
    const entry = conflictsByPath.get(filePath) ?? { base: null, ours: null, theirs: null };
    const blobRef: BlobRef = { mode, sha };
    if (stage === '1') entry.base = blobRef;
    else if (stage === '2') entry.ours = blobRef;
    else entry.theirs = blobRef;
    conflictsByPath.set(filePath, entry);
  }

  const messages: string[] = [];
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) messages.push(line.trim());
  }

  const conflicts: ConflictEntry[] = Array.from(conflictsByPath.entries()).map(
    ([path, stages]) => ({ path, ...stages }),
  );
  return { clean: false, treeSha, conflicts, messages };
}

/** `ours`/`theirs` are commit-ish refs (branch names or SHAs) — the
 * integration branch and the task branch, in that order (D2). Accepts
 * exit 1 as a normal outcome (a real conflict, not a git failure) via
 * `runGit`'s new `acceptExitCodes` option. */
export async function mergeTreeCheck(
  repoPath: string,
  ours: string,
  theirs: string,
): Promise<MergeTreeResult> {
  const { stdout, exitCode } = await runGit(['merge-tree', '--write-tree', ours, theirs], {
    cwd: repoPath,
    repoKey: repoPath,
    acceptExitCodes: [1],
  });
  return parseMergeTreeOutput(stdout, exitCode);
}

/** Retrieves one side's real file content for the conflict checkpoint
 * (D6) — `git cat-file -p` on the blob SHA `parseMergeTreeOutput`
 * reported for that stage. Never touches a working directory either. */
export async function getBlobContent(repoPath: string, blobSha: string): Promise<string> {
  const { stdout } = await runGit(['cat-file', '-p', blobSha], {
    cwd: repoPath,
    repoKey: repoPath,
  });
  return stdout;
}
