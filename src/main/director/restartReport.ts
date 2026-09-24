import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { ReconcileReport } from '../db/reconcile';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import { countSuppressedByGrace } from '../checkpoints/checkpointsTick';
import type { DirectorTriggers } from './directorTriggers';

/**
 * **The restart report** (M11 row S1-20, §26.1, §9.6, `NEXT-VERSION` §I.3).
 *
 * §26.1: "App restart with interrupted work — Medium — No, it reports what
 * happened." At startup, with interrupted work, exactly one `restart`
 * trigger goes to the Director (alone, never coalesced), carrying a
 * structured summary; its turn is told to post one report. With nothing
 * interrupted, nothing is offered — a restart is not a reason to spend a
 * turn, and a bare-timer wake is what §26.1 forbids.
 *
 * **What counts as interrupted.** Only what a person would want to hear
 * about: repairs `reconcile()` made to work in flight (orphaned engine
 * processes, tasks blocked mid-run, replies cut off, commits resolved,
 * leases reclaimed, parked employees resumed, stale permission requests
 * cancelled), decisions the post-restart grace held back (§9.6 — "the
 * Director surfaces them in its restart report instead"), checkpoints still
 * waiting on the user, and messages not yet delivered. Bookkeeping every
 * restart does — a stale `control.json`, a counter re-derived, a mirror
 * row repaired — is not news, and counting it would buy a Director turn on
 * every launch.
 */
export interface RestartSummary {
  readonly repaired: readonly string[];
  readonly suppressedByGrace: number;
  readonly pendingCheckpoints: ReadonlyArray<{ readonly title: string; readonly urgency: string }>;
  readonly heldMessages: number;
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function repairsOf(report: ReconcileReport): string[] {
  const lines: string[] = [];
  if (report.orphansKilled.length > 0) {
    lines.push(
      `${count(report.orphansKilled.length, 'engine process', 'engine processes')} left running from before ${report.orphansKilled.length === 1 ? 'was' : 'were'} stopped`,
    );
  }
  if (report.tasksBlocked.length > 0) {
    lines.push(
      `${count(report.tasksBlocked.length, 'task that was running was', 'tasks that were running were')} blocked, to be picked up again`,
    );
  }
  if (report.streamingMessagesAborted > 0) {
    lines.push(
      `${count(report.streamingMessagesAborted, 'reply that was being written was', 'replies that were being written were')} cut off`,
    );
  }
  if (report.pendingCommitsResolved > 0) {
    lines.push(
      `${count(report.pendingCommitsResolved, 'commit that was in progress was', 'commits that were in progress were')} resolved`,
    );
  }
  if (report.leasesReclaimed > 0) {
    lines.push(`${count(report.leasesReclaimed, 'workspace lease', 'workspace leases')} reclaimed`);
  }
  if (report.parkedEmployeesResumed.length > 0) {
    lines.push(
      `${count(report.parkedEmployeesResumed.length, 'parked employee', 'parked employees')} resumed`,
    );
  }
  if (report.stalePermissionCheckpointsCancelled.length > 0) {
    lines.push(
      `${count(report.stalePermissionCheckpointsCancelled.length, 'permission request', 'permission requests')} from a stopped employee cancelled`,
    );
  }
  return lines;
}

/** The summary, or null when nothing was interrupted. */
export function buildRestartSummary(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly baseDir: string;
  },
  input: {
    readonly reconcile: ReconcileReport;
    readonly appStartedAtMs: number;
    readonly nowMs: number;
  },
): RestartSummary | null {
  const repaired = repairsOf(input.reconcile);
  const suppressedByGrace = countSuppressedByGrace(deps.db, {
    appStartedAtMs: input.appStartedAtMs,
    nowMs: input.nowMs,
  });
  const pendingCheckpoints = listPendingCheckpoints(deps.db).map((checkpoint) => ({
    title: checkpoint.title,
    urgency: checkpoint.urgency,
  }));
  const heldMessages = (
    deps.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'pending'").get() as {
      n: number;
    }
  ).n;

  if (
    repaired.length === 0 &&
    suppressedByGrace === 0 &&
    pendingCheckpoints.length === 0 &&
    heldMessages === 0
  ) {
    return null;
  }
  return { repaired, suppressedByGrace, pendingCheckpoints, heldMessages };
}

/** The turn's text: the facts in fixed sections, then what to do with them. */
export function renderRestartSummary(summary: RestartSummary): string {
  const lines = ['Bureau restarted, and some work was interrupted. What Bureau found:', ''];
  lines.push('Repaired on startup:');
  lines.push(
    ...(summary.repaired.length > 0 ? summary.repaired.map((r) => `- ${r}`) : ['- nothing']),
  );
  lines.push('');
  lines.push('Held back by the post-restart grace:');
  lines.push(
    summary.suppressedByGrace > 0
      ? `- ${count(summary.suppressedByGrace, 'decision past its deadline was', 'decisions past their deadlines were')} held back instead of being decided by default. The user decides them now.`
      : '- nothing',
  );
  lines.push('');
  lines.push('Waiting on the user:');
  lines.push(
    ...(summary.pendingCheckpoints.length > 0
      ? summary.pendingCheckpoints.map((c) => `- "${c.title}" (${c.urgency})`)
      : ['- nothing']),
  );
  lines.push('');
  lines.push('Not yet delivered:');
  lines.push(
    summary.heldMessages > 0
      ? `- ${count(summary.heldMessages, 'message is', 'messages are')} still waiting to be delivered`
      : '- nothing',
  );
  lines.push('');
  lines.push(
    'Post ONE report to the user with bureau_report (kind "report"): what was interrupted, ' +
      'what state things are in now, and what happens next, in plain language. Do not list ' +
      'internal details the user cannot act on.',
  );
  return lines.join('\n');
}

/**
 * Offers the report to the Director's queue — once per app start: the key
 * is the start instant, so asking twice is one trigger.
 */
export function offerRestartReport(
  triggers: Pick<DirectorTriggers, 'queue'>,
  summary: RestartSummary,
  appStartedAtMs: number,
): void {
  triggers.queue.offer({
    kind: 'restart',
    key: `restart:${appStartedAtMs}`,
    text: renderRestartSummary(summary),
  });
}
