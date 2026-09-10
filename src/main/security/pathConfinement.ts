/**
 * "Is this path the same as, or beneath, that root?" — asked in exactly one
 * place, because it is the shape of check that is famously wrong in exactly
 * the case an attacker would pick.
 *
 * ## Why this is its own module
 *
 * M9 needed it first and it was written inside `chat/attachments.ts`, where
 * it was correct but privately owned. M10 needs the same answer for a
 * different subject — the memory root — and a second copy of a containment
 * test is the failure standing rule 6 names: two functions that each pass
 * their own tests and are jointly free to drift, with no test of either half
 * able to see it. Moved here rather than copied; `attachments.ts` imports it
 * and its S2 test passes unchanged, which is the evidence the move changed
 * no behaviour.
 *
 * ## The contract, which callers must honour
 *
 * **Both arguments must already be canonical** (`canonicalizePath` —
 * lower-cased, forward slashes, junctions and 8.3 names collapsed). This
 * function does not canonicalise, on purpose: canonicalisation touches the
 * filesystem and has its own failure modes, and a helper that silently did
 * it would hide from the caller that the answer depends on what is on disk.
 */

/**
 * `true` when `candidate` is `root` itself or lies beneath it.
 *
 * The separator in the prefix test is the load-bearing part: without it
 * `e:/bureau2/secrets` passes a naive `startsWith('e:/bureau')`, and a
 * sibling directory whose name merely begins with the root's name is
 * admitted as if it were inside.
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const withSeparator = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(withSeparator);
}
