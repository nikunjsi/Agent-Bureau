import type Database from 'better-sqlite3';
import path from 'node:path';
import { getSoleCompany } from '../db/repositories/companies';
import { canonicalizePath } from '../controlChannel/policy/pathCanonicalize';

/**
 * §14.2's "file attach (path reference into the conversation)", and the
 * one security decision in the composer.
 *
 * ## What this is, and what it is NOT
 *
 * Attaching a path puts it in front of the Director, which may act on it.
 * Nothing stops a user typing `C:\Users\me\.ssh\id_rsa`, and invariant #5
 * is absolute: *nothing outside the workspace is readable or writable, at
 * any autonomy level. Not overridable.*
 *
 * Two different questions, answered in two different places, and conflating
 * them is the mistake this comment exists to prevent:
 *
 *  - **"Should the user be told now?"** — usability. That is this function.
 *    Refusing at attach time means the user learns immediately instead of
 *    three turns later when an agent is denied mid-task.
 *  - **"Can the path actually be read?"** — security. That is *not* this
 *    function, and must never be claimed to be. It is the policy
 *    evaluator's `deny.read_outside_project` and `deny.credential_paths`
 *    (§11.3, both immutable), enforced at the moment a tool call is made,
 *    proven by **S2** at every autonomy level in
 *    `tests/integration/controlChannel/policyRealEvaluator.test.ts`. That
 *    check would stop `.ssh/id_rsa` whether or not this file existed.
 *
 * Standing rule 2 is why the split is written down: a guard the real path
 * does not call is not a guard, and a *renderer-side* guard on a
 * main-process invariant is not one either. This runs in the main process,
 * on the real `chat.send` path, and it is still only the friendly half.
 *
 * ## The boundary it uses, and why that one
 *
 * `companies.home_path` — §10.1's `<company home>`, the root that contains
 * the user's own project checkouts as well as `.bureau/`. It is the widest
 * thing that is still unambiguously "inside Bureau's world", which is the
 * right shape for a usability check: the read-time policy is stricter
 * (an employee sees its worktree, its project and its own scratch space,
 * and no more), and a check that is *narrower* than the security answer
 * would refuse paths that are in fact readable.
 *
 * **Fail closed** (invariant #6): no company row, an empty `home_path`, or
 * a path that cannot be canonicalised all refuse. Refusing an attachment
 * costs a user one sentence; accepting one wrongly is the invariant.
 */

export type AttachmentRefusal =
  | { readonly kind: 'no_workspace' }
  | { readonly kind: 'outside_workspace'; readonly attachment: string; readonly workspace: string }
  | { readonly kind: 'not_absolute'; readonly attachment: string };

export type AttachmentResolution =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly refusal: AttachmentRefusal };

/**
 * `true` when `candidate` is `root` or lies beneath it. Both arguments must
 * already be canonical (`canonicalizePath`), which lower-cases and uses
 * forward slashes.
 *
 * The separator in the prefix test is load-bearing: without it
 * `E:/Bureau2/secrets` passes a naive `startsWith('e:/bureau')`, which is
 * the classic way a containment check is wrong in exactly the case an
 * attacker would pick.
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const withSeparator = root.endsWith('/') ? root : `${root}/`;
  return candidate.startsWith(withSeparator);
}

export function resolveAttachments(
  db: Database.Database,
  attachments: readonly string[],
): AttachmentResolution {
  if (attachments.length === 0) return { ok: true, paths: [] };

  const company = getSoleCompany(db);
  const home = company?.home_path ?? '';
  // No company, or a company whose home was never set: there is no
  // workspace to be inside, so nothing is. Not "allow everything".
  if (home.trim() === '') return { ok: false, refusal: { kind: 'no_workspace' } };
  const root = canonicalizePath(home);

  const resolved: string[] = [];
  for (const raw of attachments) {
    const attachment = raw.trim();
    // A relative path has no meaning here — there is no "current
    // directory" a chat message is written from, and resolving one
    // against the main process's cwd would silently mean something
    // different on every launch.
    if (!path.isAbsolute(attachment)) {
      return { ok: false, refusal: { kind: 'not_absolute', attachment } };
    }
    const canonical = canonicalizePath(attachment);
    if (!isInside(root, canonical)) {
      return { ok: false, refusal: { kind: 'outside_workspace', attachment, workspace: home } };
    }
    // The path as the user gave it, not the canonicalised one: canonical
    // form is lower-cased for comparison and would be shown back to the
    // user wrong. Canonicalisation is how the decision is made, not what
    // is stored.
    resolved.push(attachment);
  }
  return { ok: true, paths: resolved };
}

/**
 * §14.6: "what happened in plain language, why, and a concrete next
 * action." Content, not presentation — the same category as an error
 * payload's `explanation`.
 */
export function describeRefusal(refusal: AttachmentRefusal): string {
  switch (refusal.kind) {
    case 'no_workspace':
      return (
        'Bureau has no workspace folder yet, so there is nowhere a file could be attached from. ' +
        'Set one up first, then attach the file again.'
      );
    case 'not_absolute':
      return (
        `“${refusal.attachment}” is not a full path. Give the complete path to the file, ` +
        'starting from the drive letter.'
      );
    case 'outside_workspace':
      return (
        `“${refusal.attachment}” is outside your Bureau workspace (${refusal.workspace}), and ` +
        'Bureau never reads anything outside it. Copy the file into the workspace and attach it ' +
        'from there.'
      );
  }
}
