import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { WorktreeSchema, NewWorktreeInputSchema, type Worktree, type NewWorktreeInput } from '../../../shared/models/worktree';

export function insertWorktree(db: Database.Database, input: NewWorktreeInput): Worktree {
  const parsed = NewWorktreeInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO worktrees (id, project_id, path, branch, base_commit, lease_holder, lease_expires_at, status, created_at, updated_at)
     VALUES (@id, @project_id, @path, @branch, @base_commit, NULL, NULL, @status, @created_at, @updated_at)`,
  ).run({
    id,
    project_id: parsed.project_id,
    path: parsed.path,
    branch: parsed.branch,
    base_commit: parsed.base_commit,
    status: parsed.status,
    created_at: now,
    updated_at: now,
  });
  return getWorktreeById(db, id) as Worktree;
}

export function getWorktreeById(db: Database.Database, id: string): Worktree | null {
  const row = db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id);
  return row ? WorktreeSchema.parse(row) : null;
}

export function listWorktreesByProject(db: Database.Database, projectId: string): Worktree[] {
  const rows = db.prepare('SELECT * FROM worktrees WHERE project_id = ?').all(projectId);
  return rows.map((row) => WorktreeSchema.parse(row));
}

/** Every worktree path across the whole table, not scoped to one
 * project — worktrees live at `<company.home_path>/.bureau/worktrees/
 * <employee>/` (§10.1), shared across every project of the company (only
 * one exists in practice, §5.1), so a name collision check has to be
 * company-wide, not per-project: "Ravi" hired on project A and "ravi"
 * hired on project B would still collide at the same company_home. */
export function listAllWorktreePaths(db: Database.Database): string[] {
  const rows = db.prepare('SELECT path FROM worktrees').all() as Array<{ path: string }>;
  return rows.map((row) => row.path);
}

/** M5 plan review fix #7: written immediately before `git worktree
 * remove` on the fire path — the one real writer of `'pruning'` this
 * session (not a creation-in-progress marker; that state is resolved
 * from disk alone, see `reconcileGit.ts`). Also used generically by
 * `hireEmployeeWorktree`'s own `'free'` write and anything else that
 * needs a plain status transition. */
export function setWorktreeStatus(db: Database.Database, worktreeId: string, status: string): void {
  db.prepare('UPDATE worktrees SET status = ? WHERE id = ?').run(status, worktreeId);
}

/** §10.3: updated at every task assignment. */
export function setWorktreeBranchAndBaseCommit(db: Database.Database, worktreeId: string, branch: string, baseCommit: string): void {
  db.prepare('UPDATE worktrees SET branch = ?, base_commit = ? WHERE id = ?').run(branch, baseCommit, worktreeId);
}

/** Fire path only, after the real `git worktree remove`+`prune` succeed
 * — §10.3's branch-retention rule keeps the *branch* around for audit;
 * this row's only job was tracking "where is this employee's live
 * worktree", which no longer applies once it's gone. Caller must null
 * `employees.worktree_id` first (FK) — see `employeeWorktree.ts`. */
export function deleteWorktree(db: Database.Database, worktreeId: string): void {
  db.prepare('DELETE FROM worktrees WHERE id = ?').run(worktreeId);
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
  return acquireTxn.immediate();
}

export interface ReclaimedLease {
  readonly worktreeId: string;
  readonly projectId: string;
}

/** Releases every worktree whose lease has expired — the DB-level half of
 * `reconcile()`'s lease reclamation (§4.4). Returns each reclaimed
 * worktree's id and project, which is what `git.lease_reclaimed` (§5.2)
 * needs to be emitted per worktree, not just as an aggregate count. */
export function reclaimExpiredLeases(db: Database.Database): ReclaimedLease[] {
  const reclaimTxn = db.transaction(() => {
    const now = nowIso();
    const expired = db
      .prepare(
        `SELECT id, project_id FROM worktrees
          WHERE lease_holder IS NOT NULL AND lease_expires_at < ?`,
      )
      .all(now) as Array<{ id: string; project_id: string }>;

    if (expired.length === 0) return [];

    db.prepare(
      `UPDATE worktrees
          SET lease_holder = NULL, lease_expires_at = NULL, status = 'free'
        WHERE lease_holder IS NOT NULL AND lease_expires_at < ?`,
    ).run(now);

    return expired.map((row) => ({ worktreeId: row.id, projectId: row.project_id }));
  });
  return reclaimTxn.immediate();
}
