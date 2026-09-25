import { expect } from 'vitest';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../../src/main/db/activityLog';
import type { ReconcileReport } from '../../src/main/db/reconcile';
import { getCheckpointById } from '../../src/main/db/repositories/checkpoints';
import { buildRestartSummary } from '../../src/main/director/restartReport';
import { companyDigest } from '../../src/main/projects/progressDigest';
import { resolveExpiredCheckpoints } from '../../src/main/checkpoints/checkpointsTick';

const NOTHING_REPAIRED: ReconcileReport = {
  orphansKilled: [],
  mirrorRepaired: 0,
  leasesReclaimed: 0,
  tasksBlocked: [],
  streamingMessagesAborted: 0,
  staleControlJsonDeleted: [],
  worktreeOrphansRemoved: [],
  worktreePhantomsDeleted: [],
  pendingCommitsResolved: 0,
  usageCountersDrifted: 0,
  parkedEmployeesResumed: [],
  stalePermissionCheckpointsCancelled: [],
  claimsReleased: [],
};

const YEAR_MS = 365 * 86_400_000;

/**
 * A checkpoint that states no reversible option (§9.2, pre-M11 X-9) has no
 * safe default, so nothing but the user may ever decide it. While it waits:
 * the restart report names it, the heartbeat's content names it, and a year
 * of checkpoint ticks leaves it pending (§9.5, invariant #7).
 */
export function expectItWaitsOnTheUser(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly baseDir: string;
  },
  checkpointId: string,
): void {
  const checkpoint = getCheckpointById(deps.db, checkpointId);
  expect(checkpoint?.status).toBe('pending');
  expect(checkpoint?.default_action).toBeNull();
  expect(checkpoint?.expires_at).toBeNull();
  const title = checkpoint!.title;

  const now = Date.now();
  const summary = buildRestartSummary(deps, {
    reconcile: NOTHING_REPAIRED,
    appStartedAtMs: now,
    nowMs: now,
  });
  expect(summary?.pendingCheckpoints.map((c) => c.title)).toContain(title);

  expect(companyDigest(deps.db)).toContain(title);

  const report = resolveExpiredCheckpoints(deps, {
    appStartedAtMs: now - YEAR_MS,
    nowMs: now + YEAR_MS,
  });
  expect(report.resolved).not.toContain(checkpointId);
  expect(getCheckpointById(deps.db, checkpointId)?.status).toBe('pending');
}
