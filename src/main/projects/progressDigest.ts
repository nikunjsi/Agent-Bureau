import type Database from 'better-sqlite3';
import { getProjectById } from '../db/repositories/projects';
import { getSetting } from '../db/repositories/settings';
import { formatUsdMicros } from '../../shared/models/money';

/**
 * The state of the work, in a few plain lines (M11 S3-6b; §8.5: "a progress
 * report at each phase boundary, on request, and on a heartbeat").
 *
 * Plain code over the rows, so what the Director reports from is the record,
 * not its memory of the last turn: the current phase, how many tasks are
 * done, what is blocked or waiting and why, and the spend against the
 * budget. The heartbeat's turn carries it (`companyDigest`), and so does the
 * turn after a phase is accepted.
 */
export function projectDigest(db: Database.Database, projectId: string): string {
  const project = getProjectById(db, projectId);
  if (project === null) return '';
  const phase = db
    .prepare(
      `SELECT ph.ordinal, ph.name, ph.status FROM phases ph
         JOIN projects pr ON pr.plan_id = ph.plan_id
        WHERE pr.id = ? AND ph.status NOT IN ('done', 'skipped')
        ORDER BY ph.ordinal LIMIT 1`,
    )
    .get(projectId) as { ordinal: number; name: string; status: string } | undefined;
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
         FROM tasks t JOIN phases ph ON ph.id = t.phase_id
         JOIN projects pr ON pr.plan_id = ph.plan_id
        WHERE pr.id = ? AND t.status NOT IN ('cancelled')`,
    )
    .get(projectId) as { total: number; done: number | null };
  const stuck = db
    .prepare(
      `SELECT display_key, status, status_reason FROM tasks
        WHERE project_id = ? AND (status = 'blocked' OR (status = 'queued' AND status_reason IS NOT NULL))
        ORDER BY rowid`,
    )
    .all(projectId) as { display_key: string; status: string; status_reason: string | null }[];
  const budget = project.budget_usd_micros ?? getSetting(db, 'budgets.projectUsd');

  const lines = [
    `${project.display_key} ${project.name} (${project.stage})` +
      (phase ? `, phase ${phase.ordinal} "${phase.name}" ${phase.status}` : '') +
      `: ${counts.done ?? 0} of ${counts.total} task${counts.total === 1 ? '' : 's'} done; ` +
      `spent ${formatUsdMicros(project.spend_usd_micros)} of ${formatUsdMicros(budget)}.`,
    ...stuck.map(
      (t) =>
        `  - ${t.display_key} ${t.status === 'blocked' ? 'blocked' : 'waiting'}: ${t.status_reason ?? 'no reason recorded'}`,
    ),
  ];
  return lines.join('\n');
}

/** Every project with work under way, for the heartbeat. */
export function companyDigest(db: Database.Database): string {
  const projects = db
    .prepare(
      "SELECT id FROM projects WHERE stage IN ('executing', 'review') ORDER BY created_at, rowid",
    )
    .all() as { id: string }[];
  return projects.map((p) => projectDigest(db, p.id)).join('\n');
}
