import path from 'node:path';

/** Reserved at any path segment, case-insensitively, on Windows — trap
 * (e). Checked against the *sanitized* (already-lowercased) name. */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export class InvalidEmployeeNameError extends Error {
  constructor(originalName: string, reason: string) {
    super(`employee name "${originalName}" cannot be used as a worktree directory name: ${reason}`);
    this.name = 'InvalidEmployeeNameError';
  }
}

export class WorktreeNameCollisionError extends Error {
  constructor(candidatePath: string, existingPath: string) {
    super(
      `worktree path "${candidatePath}" collides with an existing worktree at "${existingPath}" — Windows filesystems are case-insensitive, so two employee names that only differ by case (e.g. "Ravi" and "ravi") must not silently share a directory.`,
    );
    this.name = 'WorktreeNameCollisionError';
  }
}

/**
 * Trap (e): lowercases first (Windows is case-insensitive — this is what
 * makes "Ravi" and "ravi" collide *loudly*, at `assertNoWorktreePathCollision`
 * below, rather than silently sharing a directory: both sanitize to the
 * identical string, so the paths are byte-identical, not merely
 * case-equivalent), strips anything outside `[a-z0-9-_]`, collapses/trims
 * repeated or edge dashes, and rejects a Windows reserved device name.
 */
export function sanitizeEmployeeDirName(name: string): string {
  const lowered = name.toLowerCase();
  const stripped = lowered.replace(/[^a-z0-9_-]/g, '-');
  const collapsed = stripped.replace(/-+/g, '-').replace(/^-+|-+$/g, '');

  if (collapsed.length === 0) {
    throw new InvalidEmployeeNameError(name, 'sanitizes to an empty string');
  }
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(collapsed)) {
    throw new InvalidEmployeeNameError(name, `sanitizes to the reserved Windows device name "${collapsed}"`);
  }
  return collapsed;
}

/** §10.1: worktrees live at `<company home>/.bureau/worktrees/<employee>/`
 * — never under the project's own path (trap d). */
export function computeWorktreePath(companyHomePath: string, employeeName: string): string {
  const sanitized = sanitizeEmployeeDirName(employeeName);
  return path.join(companyHomePath, '.bureau', 'worktrees', sanitized);
}

/** Defense in depth on top of `worktrees.path`'s own `UNIQUE` constraint
 * (not instead of it) — a clear, named, pre-insert error instead of a raw
 * SQLite constraint violation bubbling up from whichever caller happened
 * to trigger it. Case-insensitive on purpose, even though
 * `sanitizeEmployeeDirName` already lowercases (so a collision here is
 * normally a byte-identical string match): this still catches it
 * correctly even if a future caller passes an unsanitized path in by
 * mistake. */
export function assertNoWorktreePathCollision(candidatePath: string, existingPaths: readonly string[]): void {
  const normalizedCandidate = candidatePath.toLowerCase();
  const collision = existingPaths.find((existing) => existing.toLowerCase() === normalizedCandidate);
  if (collision) {
    throw new WorktreeNameCollisionError(candidatePath, collision);
  }
}
