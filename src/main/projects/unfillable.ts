import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { setTaskStatus } from '../db/repositories/tasks';
import { RoleSchema, type Role } from '../../shared/models/role';
import type { Task } from '../../shared/models/task';
import { formatUsdMicros } from '../../shared/models/money';

/**
 * Work nobody hired can take (M11 S3-3; §8.5, §9.7, `NEXT-VERSION` §J.3).
 *
 * §8.5: *"if eligible is empty: if role can be hired and department allows
 * more → raise a `decision` checkpoint proposing a hire; else → task stays
 * queued with a recorded reason, and the Director tells the user why."* The
 * checkpoint is the Director's to raise (`bureau_hire_proposal`, with a cost
 * it states); this decides, in plain code, which case it is and says so.
 */

/** Installed roles an employee could be hired into to take `task`: every
 *  required skill, and the task's deliverable type when it names one. */
export function rolesThatCouldTake(
  db: Database.Database,
  task: { readonly required_skills: readonly string[]; readonly deliverable_type: string | null },
): Role[] {
  const roles = (
    db
      .prepare(
        "SELECT * FROM roles WHERE enabled = 1 AND key != 'director' ORDER BY priority DESC, rowid",
      )
      .all() as unknown[]
  ).map((row) => RoleSchema.parse(row));
  return roles.filter(
    (role) =>
      task.required_skills.every((skill) => role.skills.includes(skill)) &&
      (task.deliverable_type === null ||
        (role.deliverable_types as readonly string[]).includes(task.deliverable_type)),
  );
}

export interface Unfillable {
  /** A hire could fix it: at least one installed role could take the task. */
  readonly hirePossible: boolean;
  /** Recorded on the task, and read to the Director. */
  readonly reason: string;
  /** What the Director's turn is told to do. */
  readonly directorText: string;
}

export function describeUnfillable(
  db: Database.Database,
  task: Task,
  rejected: readonly { reason: string }[],
): Unfillable {
  const roles = rolesThatCouldTake(db, task);
  const skills = task.required_skills.join(', ') || 'no particular skill';
  const why =
    rejected.length === 0 ? 'nobody is hired yet.' : rejected.map((r) => r.reason).join(' ');
  if (roles.length > 0) {
    const named = roles.map((role) => `${role.title} (${role.full_key})`).join(' or ');
    const reason = `Nobody hired can take it (${why}) A ${named} could.`;
    return {
      hirePossible: true,
      reason,
      directorText:
        `${task.display_key} "${task.title}" is ready, and nobody hired can take it: ${why} ` +
        `A ${named} has the skills it needs (${skills}). Propose the hire with bureau_hire_proposal, ` +
        'stating why and what it would cost, or tell the user why you would not.',
    };
  }
  const reason = `No role in the installed packs has the skills it needs (${skills}), so no hire can take it.`;
  return {
    hirePossible: false,
    reason,
    directorText:
      `${task.display_key} "${task.title}" is ready, and cannot be done: no role in the installed ` +
      `packs has the skills it needs (${skills}), so hiring cannot fix it. Tell the user plainly ` +
      'why it is waiting, and what would unblock it (a pack with such a role, or changing the task).',
  };
}

/**
 * The task waits with its reason recorded (§8.5): `status_reason` on the
 * still-`queued` task, and one `task.waiting` — only when the reason changed,
 * so a loop pass that finds the same thing again writes nothing.
 */
export function recordTaskWaiting(
  db: Database.Database,
  activityLog: ActivityLog,
  task: Task,
  unfillable: Unfillable,
): boolean {
  if (task.status_reason === unfillable.reason) return false;
  setTaskStatus(db, task.id, 'queued', unfillable.reason);
  activityLog.logEvent({
    actor: 'system',
    type: 'task.waiting',
    severity: 'info',
    project_id: task.project_id,
    task_id: task.id,
    employee_id: null,
    checkpoint_id: null,
    payload: { reason: unfillable.reason, hirePossible: unfillable.hirePossible },
  });
  return true;
}

/**
 * §8.4: "if a needed skill has no employee, the plan includes a hire proposal
 * with the cost implication" (M11 S3-3, §F S2-4). For the plan card: each
 * role the plan would need to hire into — a task no hired employee's role
 * could take — with how many tasks need it and what those tasks are
 * estimated to cost. Hired means on the payroll, busy or not.
 */
export function hiresNeededForPlan(
  db: Database.Database,
  tasks: readonly {
    readonly required_skills: readonly string[];
    readonly deliverable_type: string | null;
    readonly estimatedMicros: number | null;
  }[],
): string[] {
  const hiredRoles = (
    db
      .prepare(
        `SELECT DISTINCT r.* FROM employees e JOIN roles r ON r.full_key = e.role_key
          WHERE e.archived_at IS NULL AND e.is_director = 0`,
      )
      .all() as unknown[]
  ).map((row) => RoleSchema.parse(row));
  const covers = (role: Role, task: (typeof tasks)[number]): boolean =>
    task.required_skills.every((skill) => role.skills.includes(skill)) &&
    (task.deliverable_type === null ||
      (role.deliverable_types as readonly string[]).includes(task.deliverable_type));

  const needed = new Map<string, { role: Role; count: number; micros: number | null }>();
  for (const task of tasks) {
    if (hiredRoles.some((role) => covers(role, task))) continue;
    const role = rolesThatCouldTake(db, task)[0];
    if (role === undefined) continue; // `planProblems` refuses a skill no role has
    const entry = needed.get(role.full_key) ?? { role, count: 0, micros: 0 };
    entry.count += 1;
    entry.micros =
      entry.micros === null || task.estimatedMicros === null
        ? null
        : entry.micros + task.estimatedMicros;
    needed.set(role.full_key, entry);
  }
  return [...needed.values()].map(
    ({ role, count, micros }) =>
      `A ${role.title} (${role.full_key}), for ${count} task${count === 1 ? '' : 's'} nobody hired can do; ` +
      (micros === null
        ? 'their cost is not estimated.'
        : `those tasks are estimated at ${formatUsdMicros(micros)}.`),
  );
}
