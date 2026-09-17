import path from 'node:path';
import type Database from 'better-sqlite3';
import { getEmployeeById } from '../../db/repositories/employees';
import { getWorktreeById } from '../../db/repositories/worktrees';
import { canonicalizePath } from '../policy/pathCanonicalize';
import { isInside } from '../../security/pathConfinement';

export type ArtifactPathResolution =
  | { readonly ok: true; readonly path: string | null }
  | {
      readonly ok: false;
      readonly reason: 'NO_WORKTREE' | 'ARTIFACT_PATH_OUTSIDE_WORKTREE';
      readonly attempted: string;
    };

/**
 * B-1 / invariant #5's carve-out. `bureau_task_done` is a Bureau tool, so the
 * policy evaluator short-circuits it to `allow` before any immutable deny is
 * scanned. That makes this function the only thing standing between an
 * agent-supplied `artifacts[].path` and a row that a later reader (the
 * Inspector, a deliverable, the Director) will open. It follows the
 * `attachments.ts` / `memoryTarget.ts` pattern: canonicalise, confine, fail
 * closed.
 *
 * - `null` needs no confinement: a content-only artifact names no file.
 * - A relative path is resolved against the employee's OWN worktree, which is
 *   the only directory an employee's work is written in.
 * - Both sides are canonicalised through the real filesystem, so `..`, 8.3
 *   short names, case, and a junction inside the worktree that points
 *   elsewhere are all judged by where the path really lands.
 * - No worktree means nothing can be inside one, so any path is refused.
 *
 * What is stored is the resolved absolute path as spelled, not the
 * canonical form: canonical form is lower-cased for comparison and would be
 * shown back wrong. Canonicalisation makes the decision; it is not the record.
 */
export function confineArtifactPath(
  db: Database.Database,
  employeeId: string,
  rawPath: string | null,
): ArtifactPathResolution {
  if (rawPath === null) return { ok: true, path: null };

  const employee = getEmployeeById(db, employeeId);
  const worktree =
    employee?.worktree_id === null || employee?.worktree_id === undefined
      ? null
      : getWorktreeById(db, employee.worktree_id);
  if (worktree === null) return { ok: false, reason: 'NO_WORKTREE', attempted: rawPath };

  const resolved = path.resolve(worktree.path, rawPath);
  if (!isInside(canonicalizePath(worktree.path), canonicalizePath(resolved))) {
    return { ok: false, reason: 'ARTIFACT_PATH_OUTSIDE_WORKTREE', attempted: rawPath };
  }
  return { ok: true, path: resolved };
}
