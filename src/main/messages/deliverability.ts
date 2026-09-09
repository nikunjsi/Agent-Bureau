import type Database from 'better-sqlite3';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { Supervisor } from '../engine/supervisor';
import { getEmployeeById, getDirectorEmployee } from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { getTaskById } from '../db/repositories/tasks';
import type { MessageAddress } from './addressing';

/**
 * **The one place that decides whether a message can be delivered right
 * now.** Standing rule 6: "the same decision must not be made in two
 * places." Both the direct-employee path and `role:` resolution call this;
 * neither re-derives it, and neither computes its own notion of "is this
 * employee idle".
 *
 * ## Where idleness actually comes from
 *
 * `Supervisor` owns the employee state machine. It derives `idle` from its
 * adapter's own events and writes the result to `employees.status` inside
 * `transition()`. This function READS that one derivation — from the live
 * object for the employee it is about to deliver to, and from the column
 * for the cross-employee `role:` candidate query, which nothing in memory
 * can answer. There is no second derivation anywhere.
 *
 * ## Four outcomes, and why holding is not failing
 *
 * `hold` writes **nothing at all** — no `attempts++`, no `next_attempt_at`,
 * no event. That is load-bearing, not laziness. §9.7's retry ladder tops
 * out at ~43 minutes before dead-lettering, so a hold that consumed retry
 * budget would dead-letter a message to a switched-off employee in under an
 * hour — the exact opposite of "held, not dropped ... delivered when that
 * employee next starts". The row is unchanged, so there is also no state
 * change for §5.2 to demand an event for; held counts and reasons come back
 * in the router's report instead.
 *
 * `undeliverable` is reserved for addresses no amount of waiting can fix:
 * an employee that does not exist, or one that has been fired. That is
 * §28 M8's own gate line — "a question to a dead employee ends in a blocker
 * checkpoint, not silence."
 *
 * `deliver_to_user` is the fourth, added in M9 session 2 (§J.4). It is a
 * separate outcome rather than a `deliver` with a null supervisor because
 * the user is not an engine process: there is no §7.4 turn boundary to
 * wait for, no adapter to hand bytes to, and no consumption to record.
 * The router appends it to the conversation instead.
 */

export type HoldReason =
  /** §9.7: "Held, not auto-started. Starting an engine process costs money;
   *  Bureau never spends money to deliver a message." */
  | 'target_not_running'
  /** Live, but mid-turn. §7.4 — never inject into a running agent. */
  | 'target_mid_turn'
  /** §9.7: no idle employee of that role. The Director would be notified so
   *  it could propose a hire; there is no Director until M11, so this
   *  reason is what a restart report will read. */
  | 'no_idle_employee_for_role'
  /** No Director has been hired yet. Until M9 session 2 this was
   *  unreachable-by-construction (`hireEmployee` hardcoded
   *  `is_director: false`); now it means what it says — nobody has hired
   *  one. Holding stays right: the target can exist, so this is not a
   *  dead end. */
  | 'no_director_yet'
  /** A message for the user, in a company that has no conversation row to
   *  put it in. A real data state, not a missing mechanism: nothing
   *  creates a conversation before M11's project intake or M13's wizard.
   *  Held rather than dead-lettered for the same reason `no_director_yet`
   *  is — the target can come to exist. */
  | 'no_conversation_yet';

export type UndeliverableReason =
  'unknown_employee' | 'employee_fired' | 'unknown_role' | 'unparseable_address';

export type Deliverability =
  | { readonly kind: 'deliver'; readonly employeeId: string; readonly supervisor: Supervisor }
  /** §9.4 surface 1 — the Director chat is the user's inbox. */
  | { readonly kind: 'deliver_to_user'; readonly conversationId: string }
  | { readonly kind: 'hold'; readonly reason: HoldReason }
  | { readonly kind: 'undeliverable'; readonly reason: UndeliverableReason };

export interface DeliverabilityDeps {
  readonly db: Database.Database;
  readonly supervisorRegistry: SupervisorRegistry;
}

/** What the message being routed carries that the address alone does not.
 * Only the `user` branch reads it — a conversation is chosen per project
 * (see `resolveConversationForDelivery`) — but it is a parameter rather
 * than a second query so this function stays the only place any of these
 * decisions is made. */
export interface DeliverabilityContext {
  readonly taskId: string | null;
}

export function deliverabilityOf(
  deps: DeliverabilityDeps,
  address: MessageAddress,
  context: DeliverabilityContext = { taskId: null },
): Deliverability {
  switch (address.kind) {
    case 'unparseable':
      return { kind: 'undeliverable', reason: 'unparseable_address' };
    case 'user': {
      // §J.4 closed (M9 session 2). The user's inbox is the conversation,
      // and the writer — `appendChatMessage` — has existed since session
      // 1. There is no "is the user available" question to ask: a
      // conversation is durable and a person reads it whenever they read
      // it, which is what `read_at` records.
      const projectId =
        context.taskId === null ? null : (getTaskById(deps.db, context.taskId)?.project_id ?? null);
      const conversation = resolveConversationForDelivery(deps.db, projectId);
      if (conversation === null) return { kind: 'hold', reason: 'no_conversation_yet' };
      return { kind: 'deliver_to_user', conversationId: conversation.id };
    }
    case 'director': {
      const director = getDirectorEmployee(deps.db);
      if (director === null) return { kind: 'hold', reason: 'no_director_yet' };
      return employeeDeliverability(deps, director.id);
    }
    case 'employee':
      return employeeDeliverability(deps, address.employeeId);
    case 'role':
      return roleDeliverability(deps, address.roleKey);
  }
}

function employeeDeliverability(deps: DeliverabilityDeps, employeeId: string): Deliverability {
  const employee = getEmployeeById(deps.db, employeeId);
  if (employee === null) return { kind: 'undeliverable', reason: 'unknown_employee' };
  // M7 archives rather than deletes, so a fired employee keeps its row (the
  // memory keyed by its id must stay reachable). The row existing is
  // therefore NOT evidence anyone is there to read this.
  if (employee.archived_at !== null) return { kind: 'undeliverable', reason: 'employee_fired' };

  const supervisor = deps.supervisorRegistry.get(employeeId);
  // No live Supervisor means no process. Deliberately NOT "so start one":
  // §9.7's rule is that Bureau never spends money to deliver a message.
  if (supervisor === undefined) return { kind: 'hold', reason: 'target_not_running' };
  if (supervisor.currentState !== 'idle') return { kind: 'hold', reason: 'target_mid_turn' };

  return { kind: 'deliver', employeeId, supervisor };
}

/**
 * §9.7: "`role:<key>` resolves to the least-loaded idle employee of that
 * role. If none exists, the message is held and the Director is notified so
 * it can propose a hire — it does not silently vanish."
 *
 * Load is the count of that employee's own tasks that are still live —
 * `assigned`, `running`, `blocked` or `review`. An idle employee can still
 * hold several (blocked ones especially), so "idle" and "unloaded" are
 * genuinely different questions and both are asked. Ties break on
 * `created_at` then `id`, so the choice is deterministic and a test can
 * assert WHICH employee was picked rather than only that one was.
 */
function roleDeliverability(deps: DeliverabilityDeps, roleKey: string): Deliverability {
  if (getRoleByFullKey(deps.db, roleKey) === null) {
    return { kind: 'undeliverable', reason: 'unknown_role' };
  }

  const candidates = deps.db
    .prepare(
      `SELECT e.id AS id,
              (SELECT COUNT(*) FROM tasks t
                WHERE t.assignee_employee_id = e.id
                  AND t.status IN ('assigned','running','blocked','review')) AS load
         FROM employees e
        WHERE e.role_key = ?
          AND e.archived_at IS NULL
          AND e.status = 'idle'
        ORDER BY load ASC, e.created_at ASC, e.id ASC`,
    )
    .all(roleKey) as { id: string; load: number }[];

  for (const candidate of candidates) {
    // `employees.status` is the Supervisor's own written-through state, but
    // a row can outlive the process that wrote it (a crash between the
    // transition and the next reconcile). Re-asking the single
    // deliverability question is what keeps that from becoming a second,
    // weaker definition of "reachable".
    const resolved = employeeDeliverability(deps, candidate.id);
    if (resolved.kind === 'deliver') return resolved;
  }

  return { kind: 'hold', reason: 'no_idle_employee_for_role' };
}
