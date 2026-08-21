import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { WorktreeSchema, type Worktree, type NewWorktreeInput } from '../../../shared/models/worktree';

export function insertWorktree(db: Database.Database, input: NewWorktreeInput): Worktree {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO worktrees (id, project_id, path, branch, base_commit, lease_holder, lease_expires_at, status, created_at, updated_at)
     VALUES (@id, @project_id, @path, @branch, @base_commit, NULL, NULL, @status, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: input.project_id,
    path: input.path,
    branch: input.branch,
    base_commit: input.base_commit,
    status: input.status,
    created_at: now,
    updated_at: now,
  });
  return getWorktreeById(db, id) as Worktree;
}

export function getWorktreeById(db: Database.Database, id: string): Worktree | null {
  const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id);
  return row ? WorktreeSchema.parse(row) : null;
}

/**
 * The §5.1 transactional lease-acquisition pattern, exactly: a single
 * `BEGIN IMMEDIATE` with an expiry predicate. Returns `true` if the lease
 * was acquired, `false` if someone else holds a live one (0 rows changed
 * — the caller should pick another worktree, not retry this one).
 */
export function acquireWorktreeLease(
  db: Database.Database,
  worktreeId: string,
  employeeId: string,
  leaseExpiresAt: string,
): boolean {
  const acquireTxn = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE worktrees
            SET lease_holder = ?, lease_expires_at = ?, status = 'leased'
          WHERE id = ? AND (lease_holder IS NULL OR lease_expires_at < ?)`,
      )
      .run(employeeId, leaseExpiresAt, worktreeId, nowIso());
    return result.changes > 0;
  });
  return acquireTxn();
}
