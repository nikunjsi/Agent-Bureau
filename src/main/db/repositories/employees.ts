import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import {
  EmployeeSchema,
  NewEmployeeInputSchema,
  type Employee,
  type NewEmployeeInput,
} from '../../../shared/models/employee';
import type { ModelTier } from '../../../shared/models/enums';

export function insertEmployee(db: Database.Database, input: NewEmployeeInput): Employee {
  const parsed = NewEmployeeInputSchema.parse(input);
  const id = parsed.id ?? newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO employees (
       id, name, role_key, is_director, desk_x, desk_y, sprite_variant, status, status_detail,
       engine, engine_mode, engine_version, model, model_tier_override, session_id, pid, process_start_time,
       worktree_id, current_task_id, autonomy, daily_budget_usd_micros, resume_at,
       heartbeat_at, consecutive_failures, lifetime_spend_usd_micros, hired_at, created_at, updated_at
     ) VALUES (
       @id, @name, @role_key, @is_director, @desk_x, @desk_y, @sprite_variant, @status, @status_detail,
       @engine, @engine_mode, @engine_version, @model, @model_tier_override, @session_id, @pid, @process_start_time,
       @worktree_id, @current_task_id, @autonomy, @daily_budget_usd_micros, @resume_at,
       @heartbeat_at, @consecutive_failures, @lifetime_spend_usd_micros, @hired_at, @created_at, @updated_at
     )`,
  ).run({
    id,
    name: parsed.name,
    role_key: parsed.role_key,
    is_director: parsed.is_director ? 1 : 0,
    desk_x: parsed.desk_x,
    desk_y: parsed.desk_y,
    sprite_variant: parsed.sprite_variant,
    status: parsed.status,
    status_detail: parsed.status_detail,
    engine: parsed.engine,
    engine_mode: parsed.engine_mode,
    engine_version: parsed.engine_version,
    model: parsed.model,
    model_tier_override: parsed.model_tier_override,
    session_id: parsed.session_id,
    pid: parsed.pid,
    process_start_time: parsed.process_start_time,
    worktree_id: parsed.worktree_id,
    current_task_id: parsed.current_task_id,
    autonomy: parsed.autonomy,
    daily_budget_usd_micros: parsed.daily_budget_usd_micros,
    resume_at: parsed.resume_at,
    heartbeat_at: parsed.heartbeat_at,
    consecutive_failures: parsed.consecutive_failures,
    lifetime_spend_usd_micros: parsed.lifetime_spend_usd_micros,
    hired_at: now,
    created_at: now,
    updated_at: now,
  });
  return getEmployeeById(db, id) as Employee;
}

export function getEmployeeById(db: Database.Database, id: string): Employee | null {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
  return row ? EmployeeSchema.parse(row) : null;
}

/**
 * The active roster by default — `archived_at IS NULL`.
 *
 * `includeArchived` became necessary at M7 session 2, when firing started
 * archiving rather than deleting (§6.8, migration 0007). Active-only is
 * the default because every question anyone asks of this function today is
 * about people who currently work here: a fired employee is not on the
 * floor, not in the roster, and not a candidate for assignment. The two
 * existing call sites were both reviewed when the default changed —
 * `system.ts`'s support bundle (which wants transcripts for everyone,
 * including the archived, so it passes `includeArchived`) and
 * `employeesHandlers.list` (which wants the roster).
 *
 * Ordered by `hired_at` so callers get a stable sequence rather than
 * SQLite's default row order.
 */
export function listEmployees(
  db: Database.Database,
  options: { includeArchived?: boolean } = {},
): Employee[] {
  const where = options.includeArchived === true ? '' : 'WHERE archived_at IS NULL';
  const rows = db.prepare(`SELECT * FROM employees ${where} ORDER BY hired_at, id`).all();
  return rows.map((row) => EmployeeSchema.parse(row));
}

/**
 * **The one place "who is the Director" is asked of the database.**
 *
 * `deliverability.ts` had its own private copy of this query, written in
 * M8 and dead in production ever since — nothing could set `is_director`
 * until M9 session 2 gave `hireEmployee` a Director path. M9's hire
 * refusal needs the same question answered, so it became one function
 * with two callers rather than two queries free to drift (standing rule
 * 6). Archived employees are excluded for the same reason `fireEmployee`
 * keeps their row at all: a fired employee's row survives so their memory
 * stays reachable, and the row existing is not evidence anyone is there.
 *
 * `companies.director_employee_id` (§5.1.1) is written alongside
 * `is_director` in the hire's own transaction, but it is a schema-required
 * pointer, not a second source of truth: nothing derives the answer from
 * it, and `hireDirector.test.ts` asserts the two agree.
 */
export function getDirectorEmployee(db: Database.Database): Employee | null {
  const row = db
    .prepare('SELECT * FROM employees WHERE is_director = 1 AND archived_at IS NULL LIMIT 1')
    .get();
  return row ? EmployeeSchema.parse(row) : null;
}

/** Archived employees of one role — §6.8's "if rehired into the same role,
 * they resume with what they learned" needs a way to find them. */
export function listArchivedEmployeesForRole(
  db: Database.Database,
  roleFullKey: string,
): Employee[] {
  const rows = db
    .prepare(
      'SELECT * FROM employees WHERE role_key = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC',
    )
    .all(roleFullKey);
  return rows.map((row) => EmployeeSchema.parse(row));
}

/**
 * §6.8 — firing archives, it does not delete. The row survives so that
 * `memory/employee/<id>/` keeps resolving; see migration 0007 for why this
 * is a column rather than a status.
 */
export function archiveEmployee(db: Database.Database, employeeId: string): void {
  db.prepare('UPDATE employees SET archived_at = ? WHERE id = ?').run(nowIso(), employeeId);
}

/** Rehire. Keeps the id (and therefore the memory) and the name. */
export function unarchiveEmployee(db: Database.Database, employeeId: string): void {
  db.prepare('UPDATE employees SET archived_at = NULL, hired_at = ? WHERE id = ?').run(
    nowIso(),
    employeeId,
  );
}

/** §13.3 — the generator decides where people sit; this records it. */
export function setEmployeeDesk(
  db: Database.Database,
  employeeId: string,
  x: number,
  y: number,
): void {
  db.prepare('UPDATE employees SET desk_x = @x, desk_y = @y WHERE id = @id').run({
    id: employeeId,
    x,
    y,
  });
}

/**
 * §6.8's "the user can rename anyone". The first-name uniqueness rule is
 * NOT enforced here — it lives in `allocateName.ts` alongside the
 * allocation rule it belongs with, and `renameEmployee` in
 * `src/main/company/` is the checked entry point. This is the raw write.
 */
export function setEmployeeName(db: Database.Database, employeeId: string, name: string): void {
  db.prepare('UPDATE employees SET name = ? WHERE id = ?').run(name, employeeId);
}

/**
 * Records the concrete model id a spawn actually launched with.
 *
 * **A record, not an input** (migration 0008). `Supervisor.assign()` is
 * the only caller: it resolves the tier and then writes what it resolved,
 * so "which model is this employee actually on" is answerable without
 * anything downstream depending on the answer. Writing it anywhere else
 * would recreate the exact bug this replaced — a stored value that
 * disagreed with the spawn because two places decided it.
 */
export function recordEmployeeResolvedModel(
  db: Database.Database,
  employeeId: string,
  model: string | null,
): void {
  db.prepare('UPDATE employees SET model = ? WHERE id = ?').run(model, employeeId);
}

/**
 * §7.5 — this employee's own tier choice, or NULL to fall back to the
 * role's `model_preference`. A TIER, never a resolved id: see migration
 * 0008 for the three things pinning an id breaks silently.
 */
export function setEmployeeModelTierOverride(
  db: Database.Database,
  employeeId: string,
  tier: ModelTier | null,
): void {
  db.prepare('UPDATE employees SET model_tier_override = ? WHERE id = ?').run(tier, employeeId);
}

export function setEmployeeAutonomy(
  db: Database.Database,
  employeeId: string,
  autonomy: string,
): void {
  db.prepare('UPDATE employees SET autonomy = ? WHERE id = ?').run(autonomy, employeeId);
}

export function setEmployeeDailyBudget(
  db: Database.Database,
  employeeId: string,
  micros: number | null,
): void {
  db.prepare('UPDATE employees SET daily_budget_usd_micros = ? WHERE id = ?').run(
    micros,
    employeeId,
  );
}

export function setEmployeeCurrentTask(
  db: Database.Database,
  employeeId: string,
  taskId: string | null,
): void {
  db.prepare('UPDATE employees SET current_task_id = ? WHERE id = ?').run(taskId, employeeId);
}

/** §10.3 — one worktree per employee, created at hire. `employees.
 * worktree_id` is FK→worktrees; M5's fire flow nulls it *before* deleting
 * the worktree row, or that delete fails on the FK (M5 plan review). */
export function setEmployeeWorktree(
  db: Database.Database,
  employeeId: string,
  worktreeId: string | null,
): void {
  db.prepare('UPDATE employees SET worktree_id = ? WHERE id = ?').run(worktreeId, employeeId);
}

/** Read-only counterpart to `clearEmployeeWorktreeReference` (M5 part 2)
 * — used where an event needs the holding employee's id but the
 * worktree itself isn't being detached, so the mutating version would
 * be the wrong tool. */
export function getEmployeeIdByWorktreeId(
  db: Database.Database,
  worktreeId: string,
): string | null {
  const row = db.prepare('SELECT id FROM employees WHERE worktree_id = ?').get(worktreeId) as
    { id: string } | undefined;
  return row?.id ?? null;
}

/** Same FK-ordering lesson as `setEmployeeWorktree`'s own comment,
 * applied to reconcile()'s phantom-row cleanup: whichever employee (if
 * any) still references a worktree row about to be deleted must be
 * un-referenced first. Returns the employee id that was cleared, if any
 * — the reconcile git.worktree_released event wants it. */
export function clearEmployeeWorktreeReference(
  db: Database.Database,
  worktreeId: string,
): string | null {
  const row = db.prepare('SELECT id FROM employees WHERE worktree_id = ?').get(worktreeId) as
    { id: string } | undefined;
  if (!row) return null;
  db.prepare('UPDATE employees SET worktree_id = NULL WHERE worktree_id = ?').run(worktreeId);
  return row.id;
}

export function setEmployeeStatus(db: Database.Database, employeeId: string, status: string): void {
  db.prepare('UPDATE employees SET status = ? WHERE id = ?').run(status, employeeId);
}

/**
 * M11 row S1-11 — the engine session this employee is resumed from across
 * restarts (§8.0's "resumed by session_id"). Written only by the
 * Supervisor, when the engine reports the session it actually started, and
 * cleared when a resume is refused. One writer, one column: the Director's
 * session id is not copied anywhere else.
 */
export function setEmployeeSessionId(
  db: Database.Database,
  employeeId: string,
  sessionId: string | null,
): void {
  db.prepare('UPDATE employees SET session_id = ? WHERE id = ?').run(sessionId, employeeId);
}

/** §7.9's bureau_report_status: `status_detail` (≤120 chars, enforced by
 * the tool's own Zod schema before this is ever called) drives the speech
 * bubble. Truncation/length is a validation concern, not this repository's. */
export function setEmployeeStatusDetail(
  db: Database.Database,
  employeeId: string,
  statusDetail: string,
): void {
  db.prepare('UPDATE employees SET status_detail = ? WHERE id = ?').run(statusDetail, employeeId);
}

export function setEmployeeHeartbeat(
  db: Database.Database,
  employeeId: string,
  heartbeatAt: string,
): void {
  db.prepare('UPDATE employees SET heartbeat_at = ? WHERE id = ?').run(heartbeatAt, employeeId);
}

/**
 * §7.11 (M3 session 2): backoff must persist across restarts — the column
 * has existed since M1, but nothing wrote to it until the supervisor.
 * Reset to 0 on any genuine success (a real `finished`/`turn.completed`),
 * incremented on `failed`. The supervisor reads the *current* row value at
 * assign() time rather than starting counting from 0, so a permanently
 * broken employee's backoff does not silently reset on every relaunch.
 */
export function setEmployeeConsecutiveFailures(
  db: Database.Database,
  employeeId: string,
  count: number,
): void {
  db.prepare('UPDATE employees SET consecutive_failures = ? WHERE id = ?').run(count, employeeId);
}

/**
 * §24.3: "`employees.resume_at` is a persisted timestamp, not an
 * in-memory timer, so it survives closing the app." `null` clears it
 * (the employee resumed, or was never quota-parked in the first place) —
 * `parkedEmployeeResumeTick.ts`'s own promotion already clears it back to
 * null on the way through `off`, via a raw UPDATE rather than this
 * function (no per-employee Supervisor is guaranteed live at that point);
 * this is the setter Supervisor itself uses when it is the one parking
 * the employee for real, live, in-process.
 */
export function setEmployeeResumeAt(
  db: Database.Database,
  employeeId: string,
  resumeAt: string | null,
): void {
  db.prepare('UPDATE employees SET resume_at = ? WHERE id = ?').run(resumeAt, employeeId);
}

/**
 * §11.2's first-time confirmation requirement — the real seam M9's dialog
 * writes to (migration 0004). Nothing in production calls this yet; it
 * exists so computeEffectiveAutonomy's downgrade behaviour is testable
 * against a real column, not just a hardcoded stub. See
 * src/shared/policy/autonomy.ts.
 */
export function confirmEmployeeAutonomous(db: Database.Database, employeeId: string): void {
  db.prepare('UPDATE employees SET autonomous_confirmed_at = ? WHERE id = ?').run(
    nowIso(),
    employeeId,
  );
}

/** Rows with a recorded `pid` — what `reconcile()`'s orphan sweep scans. */
export function listEmployeesWithPid(
  db: Database.Database,
): Array<{ id: string; pid: number; process_start_time: string | null }> {
  return db
    .prepare('SELECT id, pid, process_start_time FROM employees WHERE pid IS NOT NULL')
    .all() as Array<{ id: string; pid: number; process_start_time: string | null }>;
}
