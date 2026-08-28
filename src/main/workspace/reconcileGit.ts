import type Database from 'better-sqlite3';
import fs from 'node:fs';
import type { ActivityLog } from '../db/activityLog';
import type { Project } from '../../shared/models/project';
import { listRepoInitialisedProjects } from '../db/repositories/projects';
import { listWorktreesByProject, deleteWorktree } from '../db/repositories/worktrees';
import { clearEmployeeWorktreeReference } from '../db/repositories/employees';
import { listWorktreesPorcelain, removeWorktree, pruneWorktrees } from './gitWorktree';

export interface ProjectWorktreeReconcileReport {
  readonly orphansRemoved: readonly string[];
  readonly phantomsDeleted: readonly string[];
}

/**
 * §4.4/trap (c): makes the `worktrees` table and the real repository on
 * disk agree, in both directions, regardless of *how* they diverged (a
 * crash mid-hire, a crash mid-fire, or anything else) — it diffs
 * `listWorktreesPorcelain` (already excludes the main tree, M5 plan
 * review fix #3) against the DB rows for one project and resolves each
 * side's leftovers:
 *
 * - A DB row with no matching directory on disk (phantom — the crash
 *   window between the row insert and `git worktree add` succeeding,
 *   fix #5) → the employee's `worktree_id` reference is cleared first
 *   (FK, same lesson as the fire path), then the row is deleted.
 * - A directory on disk with no matching DB row (orphan — the crash
 *   window between `git worktree remove`+row-delete on the fire path,
 *   or any other divergence) → `git worktree remove --force` + `prune`.
 *
 * Both directions reuse `git.worktree_released` (not a new taxonomy
 * entry — the session's explicit four names) with a `reason` in the
 * payload distinguishing how each one was resolved, the same pattern
 * `task.blocked`'s own `reason: 'app_restart'` already establishes.
 */
export async function reconcileProjectWorktrees(
  db: Database.Database,
  activityLog: ActivityLog,
  project: Project,
): Promise<ProjectWorktreeReconcileReport> {
  const dbRows = listWorktreesByProject(db, project.id);
  const diskEntries = await listWorktreesPorcelain(project.path);

  const diskPathsReal = new Set<string>();
  for (const entry of diskEntries) {
    try {
      diskPathsReal.add(fs.realpathSync.native(entry.path));
    } catch {
      // Directory doesn't exist — git's own record is stale too; not a
      // real disk path to match against, so it's simply absent from the set.
    }
  }

  const phantomsDeleted: string[] = [];
  for (const row of dbRows) {
    let rowPathReal: string | null = null;
    try {
      rowPathReal = fs.realpathSync.native(row.path);
    } catch {
      // The row's own path doesn't exist on disk at all — definitely a phantom.
    }
    if (rowPathReal !== null && diskPathsReal.has(rowPathReal)) continue;

    const clearedEmployeeId = clearEmployeeWorktreeReference(db, row.id);
    deleteWorktree(db, row.id);
    phantomsDeleted.push(row.id);
    activityLog.logEvent({
      actor: 'system',
      type: 'git.worktree_released',
      severity: 'warn',
      project_id: project.id,
      task_id: null,
      employee_id: clearedEmployeeId,
      checkpoint_id: null,
      payload: { worktreeId: row.id, path: row.path, reason: 'reconcile_phantom_row' },
    });
  }

  const dbPathsReal = new Set<string>();
  for (const row of dbRows) {
    if (!phantomsDeleted.includes(row.id)) {
      try {
        dbPathsReal.add(fs.realpathSync.native(row.path));
      } catch {
        // Already handled above (would have been a phantom); unreachable here.
      }
    }
  }

  const orphansRemoved: string[] = [];
  for (const entry of diskEntries) {
    let entryPathReal: string;
    try {
      entryPathReal = fs.realpathSync.native(entry.path);
    } catch {
      // Directory already gone — `git worktree prune` below cleans up
      // git's own metadata for it; nothing to remove.
      continue;
    }
    if (dbPathsReal.has(entryPathReal)) continue;

    await removeWorktree(project.path, entry.path);
    orphansRemoved.push(entry.path);
    activityLog.logEvent({
      actor: 'system',
      type: 'git.worktree_released',
      severity: 'warn',
      project_id: project.id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { path: entry.path, branch: entry.branch, reason: 'reconcile_orphan_directory' },
    });
  }

  // Unconditional, on top of the two loops above — catches anything git
  // itself considers stale that didn't correspond to a live porcelain
  // entry at all (§4.4: "git worktree prune run").
  await pruneWorktrees(project.path);

  return { orphansRemoved, phantomsDeleted };
}

export interface WorktreeReconcileReport {
  readonly orphansRemoved: readonly string[];
  readonly phantomsDeleted: readonly string[];
}

/** Called from `db/reconcile.ts`, after lease reclaim (Q7) — iterates
 * every project whose workspace has actually been registered. */
export async function reconcileAllProjectsWorktrees(db: Database.Database, activityLog: ActivityLog): Promise<WorktreeReconcileReport> {
  const projects = listRepoInitialisedProjects(db);
  const orphansRemoved: string[] = [];
  const phantomsDeleted: string[] = [];
  for (const project of projects) {
    const report = await reconcileProjectWorktrees(db, activityLog, project);
    orphansRemoved.push(...report.orphansRemoved);
    phantomsDeleted.push(...report.phantomsDeleted);
  }
  return { orphansRemoved, phantomsDeleted };
}
