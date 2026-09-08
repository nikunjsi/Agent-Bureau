import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import { nowIso } from '../../shared/models/ids';
import {
  listDeliverableMessages,
  listUnconsumedDeliveries,
  markMessageDelivered,
  recordMessageDeliveryFailure,
  requeueMessageForRedelivery,
} from '../db/repositories/messages';
import { getEmployeeById } from '../db/repositories/employees';
import { parseMessageAddress } from './addressing';
import { deliverabilityOf, type HoldReason } from './deliverability';
import { deadLetterMessage } from './deadLetter';
import type { OutboxMessage } from '../../shared/models/message';

/**
 * §9.7 — the message router. Employees and the Director communicate only
 * through the durable `messages` outbox, and this owns delivery.
 *
 * ## SQLite is the source of truth; there is no signal yet
 *
 * §9.7's diagram ends with "signal router (in-process; SQLite is the source
 * of truth, the signal is only a latency optimisation)". **The signal is
 * deliberately not built** (`docs/NEXT-VERSION.md` §J): wiring it means an
 * optional `messageRouter` threaded through five constructors, every one of
 * them optional because tests build those contexts without a router — an
 * optional dependency that degrades silently when omitted, which is exactly
 * standing rule 2's shape. What it buys is bounded by the tick interval:
 * five seconds, against turns that take tens.
 *
 * So the tick is the only trigger, and it is authoritative rather than a
 * backstop. Everything the router does is a pure function of the table.
 *
 * ## At-least-once, stated rather than implied
 *
 * §9.7: "Every message carries `idempotency_key`; redelivery is safe.
 * Exactly-once is not attempted across a process boundary and pretending
 * otherwise causes bugs." Concretely, in this file:
 *
 *   - delivery **sends first, then marks delivered**. A crash in between
 *     redelivers on the next start rather than losing the message;
 *   - `requeueUnconsumedDeliveries` deliberately puts a message that was
 *     delivered-but-never-consumed by a previous run back on the queue;
 *   - nothing anywhere claims a message is delivered exactly once, and
 *     nothing is built as if it were.
 *
 * ## Single-flight
 *
 * `routeOnce` is async — `adapter.send()` is — so two overlapping runs
 * could both select and deliver the same pending row. One in-process
 * router, one flag: a run requested while another is in flight sets a
 * rerun bit and returns, and the in-flight run repeats once when it
 * finishes. That is why no DB-level claim is needed: there is exactly one
 * router per process (§19's single-writer rule), and within the process
 * this is a mutex.
 */

/** §9.7's ladder, verbatim: 5 s → 30 s → 2 min → 10 min → 30 min. */
export const DELIVERY_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

/**
 * How long to wait after `attempts` failed deliveries, or `null` when the
 * ladder is exhausted and §9.7's next step is the dead letter. Pure, so the
 * whole retry policy is one table with one reader.
 */
export function nextAttemptDelayMs(attempts: number): number | null {
  if (attempts < 1) return DELIVERY_BACKOFF_MS[0] as number;
  return DELIVERY_BACKOFF_MS[attempts - 1] ?? null;
}

export interface MessageRouterDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly supervisorRegistry: SupervisorRegistry;
  /**
   * Epoch ms this process started. Bounds redelivery: only a delivery made
   * by a PREVIOUS run can be requeued, so a message is requeued at most
   * once per app start and cannot loop. Injected for the same reason the
   * checkpoints tick injects it — a bound that reads the clock itself is a
   * bound no test can drive.
   */
  readonly appStartedAtMs: number;
}

export interface RouterReport {
  readonly delivered: string[];
  /** Nothing was written for these; the reason is the whole point. */
  readonly held: { readonly messageId: string; readonly reason: HoldReason }[];
  readonly retried: {
    readonly messageId: string;
    readonly attempts: number;
    readonly nextAttemptAt: string;
  }[];
  readonly deadLettered: string[];
  /** Delivered by a previous run, never consumed, put back on the queue. */
  readonly requeued: string[];
}

export interface RouteOnceOptions {
  readonly nowMs: number;
  readonly limit?: number;
}

export async function routeOnce(
  deps: MessageRouterDeps,
  options: RouteOnceOptions,
): Promise<RouterReport> {
  const nowIsoTs = new Date(options.nowMs).toISOString();
  const requeued = requeueUnconsumedDeliveries(deps);

  const delivered: string[] = [];
  const held: { messageId: string; reason: HoldReason }[] = [];
  const retried: { messageId: string; attempts: number; nextAttemptAt: string }[] = [];
  const deadLettered: string[] = [];

  for (const message of listDeliverableMessages(deps.db, nowIsoTs, options.limit ?? 50)) {
    const target = deliverabilityOf(deps, parseMessageAddress(message.to_addr));

    if (target.kind === 'hold') {
      // Nothing is written. See deliverability.ts for why a hold must not
      // consume retry budget.
      held.push({ messageId: message.id, reason: target.reason });
      continue;
    }

    if (target.kind === 'undeliverable') {
      // No ladder: waiting cannot resurrect a fired employee or invent a
      // role. Straight to §9.7's dead letter, which raises the blocker
      // checkpoint when this was a question.
      deadLetterMessage(deps, message, target.reason);
      deadLettered.push(message.id);
      continue;
    }

    try {
      // §7.4 is inside this call. The idle check above and the adapter's
      // own turn-boundary queue are not two decisions about the same
      // thing: the check is what makes `delivered_at` mean "handed over at
      // a real turn boundary", and the queue is the backstop for the race
      // if state flips between the check and the send. Neither can result
      // in text arriving mid-generation.
      await target.supervisor.deliverOutboxMessage(message);
      markMessageDelivered(deps.db, message.id, target.employeeId, nowIso());
      deps.activityLog.logEvent({
        actor: 'system',
        type: 'message.delivered',
        severity: 'info',
        project_id: null,
        task_id: message.task_id,
        employee_id: target.employeeId,
        checkpoint_id: null,
        payload: { messageId: message.id, to: message.to_addr, kind: message.kind },
      });
      delivered.push(message.id);
    } catch (error) {
      const outcome = recordFailure(deps, message, options.nowMs, error);
      if (outcome.kind === 'dead_lettered') deadLettered.push(message.id);
      else retried.push(outcome.entry);
    }
  }

  return { delivered, held, retried, deadLettered, requeued };
}

type FailureOutcome =
  | { readonly kind: 'dead_lettered' }
  | {
      readonly kind: 'retried';
      readonly entry: { messageId: string; attempts: number; nextAttemptAt: string };
    };

function recordFailure(
  deps: MessageRouterDeps,
  message: OutboxMessage,
  nowMs: number,
  error: unknown,
): FailureOutcome {
  const attempts = message.attempts + 1;
  const detail = error instanceof Error ? error.message : String(error);
  const delay = nextAttemptDelayMs(attempts);

  deps.activityLog.logEvent({
    actor: 'system',
    type: 'message.failed',
    severity: 'warn',
    project_id: null,
    task_id: message.task_id,
    employee_id: message.resolved_employee_id,
    checkpoint_id: null,
    payload: { messageId: message.id, attempts, error: detail },
  });

  if (delay === null) {
    deadLetterMessage(deps, { ...message, attempts }, `delivery failed ${attempts} times`);
    return { kind: 'dead_lettered' };
  }

  const nextAttemptAt = new Date(nowMs + delay).toISOString();
  recordMessageDeliveryFailure(deps.db, message.id, attempts, nextAttemptAt);
  return { kind: 'retried', entry: { messageId: message.id, attempts, nextAttemptAt } };
}

/**
 * `consumed_at`'s reader (see `listUnconsumedDeliveries`). A message that
 * a previous run handed to an adapter, and whose employee never started
 * another turn, goes back on the queue — but only when nothing is live for
 * that employee, so this can never fire at a running one mid-turn.
 */
function requeueUnconsumedDeliveries(deps: MessageRouterDeps): string[] {
  const requeued: string[] = [];
  const startedAtIso = new Date(deps.appStartedAtMs).toISOString();

  for (const message of listUnconsumedDeliveries(deps.db, startedAtIso)) {
    const employeeId = message.resolved_employee_id;
    if (employeeId === null) continue;
    // Deliberately NOT gated on "no live Supervisor". `delivered_at <
    // appStartedAt` already restricts this to deliveries made by a
    // PREVIOUS process, whose in-memory awaiting-consumption list died
    // with it — so no live supervisor can be about to mark this consumed,
    // and requiring one to be absent would block the exact case this
    // exists for: the employee came back and should get the message again.
    //
    // A fired employee is never coming back for it; leave the row as the
    // record of what was handed over rather than queueing it only to be
    // dead-lettered on the next pass.
    if (getEmployeeById(deps.db, employeeId)?.archived_at != null) continue;

    requeueMessageForRedelivery(deps.db, message.id);
    requeued.push(message.id);
  }
  return requeued;
}

export interface MessageRouterHandle {
  stop(): void;
  /** Runs one pass now, respecting the single-flight guard. */
  runNow(): Promise<void>;
}

/**
 * The third of this project's three narrow periodic loops, alongside
 * `parkedEmployeeResumeTick` and the checkpoints tick. They are kept
 * separate deliberately — different cadences, different failure modes — and
 * `PROGRESS.md` records what would change that.
 *
 * 5 s because it is §9.7's own shortest backoff: a message whose first
 * retry is due in 5 s never waits an extra cycle for it, and answer
 * delivery is bounded by the same number.
 */
export function startMessageRouter(
  deps: MessageRouterDeps,
  intervalMs = 5_000,
): MessageRouterHandle {
  let running = false;
  let rerun = false;
  let stopped = false;

  const runGuarded = async (): Promise<void> => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        if (stopped) return;
        await routeOnce(deps, { nowMs: Date.now() });
      } while (rerun);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runGuarded();
  }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    runNow: runGuarded,
  };
}
