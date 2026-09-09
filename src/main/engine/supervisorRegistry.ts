import type { Supervisor } from './supervisor';

/**
 * M4 session 2 — the blocker session 1 flagged and left open: "the control
 * channel must inform the supervisor when task_done lands, or the gate
 * cannot pass." §7.11's supervisor is one object per employee, already the
 * sole owner of that employee's state machine; the control channel's
 * `bureau_task_done` handler runs in the same process (the loopback server
 * is in-process HTTP, not a separate service) and needs to reach the
 * *specific* Supervisor instance for the employee whose bearer token
 * authenticated the call.
 *
 * Mechanism chosen: a direct method call on the addressed instance via this
 * registry — not a generic in-process event bus. Each control-channel
 * request is already scoped to exactly one employee (by its token), so
 * there is no fan-out need a pub/sub bus would justify; a bus would also
 * make "did the supervisor actually receive this" harder to verify (an
 * unhandled/misrouted event is silent) than a direct call, which either
 * finds the instance or doesn't — and the tool handler treats "not found"
 * as its own explicit, logged case (the employee has no live supervisor:
 * stale token past a stop, or a bug), not a swallowed no-op. Not "supervisor
 * observing the DB": that would mean polling or a SQLite change-notification
 * mechanism this project has none of, and would add a race window between
 * the DB write and the supervisor noticing it that a direct call has zero
 * of, since the DB write and the direct call both happen synchronously in
 * the same tool-handler invocation.
 */
export class SupervisorRegistry {
  private readonly byEmployeeId = new Map<string, Supervisor>();

  register(employeeId: string, supervisor: Supervisor): void {
    this.byEmployeeId.set(employeeId, supervisor);
  }

  unregister(employeeId: string): void {
    this.byEmployeeId.delete(employeeId);
  }

  get(employeeId: string): Supervisor | undefined {
    return this.byEmployeeId.get(employeeId);
  }

  /**
   * Every live Supervisor. M9's `/pause` is the first caller and the
   * reason this exists: §14.2's `/pause` is a company-wide action, and
   * "everyone who is running" is a question only this map can answer —
   * `employees.status` records what each Supervisor last wrote, but a row
   * can outlive the process that wrote it (see `deliverability.ts`), and
   * pausing means calling a method on an object, not updating a column.
   *
   * A copied array, not the map: a caller iterating while a Supervisor
   * unregisters itself mid-`await` would otherwise be mutating what it is
   * walking.
   */
  all(): Array<{ employeeId: string; supervisor: Supervisor }> {
    return [...this.byEmployeeId].map(([employeeId, supervisor]) => ({ employeeId, supervisor }));
  }
}
