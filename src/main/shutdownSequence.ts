/**
 * §7.10 / CLAUDE.md invariant #3 (AUDIT #16) — the app's own quit path.
 *
 * `before-quit` used to call `void controlChannelServer.stop()` and then
 * synchronously close the activity log and the database. `stop()` does
 * synchronously deny every HELD policy check, which is correct and
 * fail-closed — but the `httpServer.close()` that drains in-flight
 * NON-held requests (a DB-writing tool handler mid-call) lives inside that
 * discarded promise, so the DB could close underneath one. The comment
 * above it said to revisit once bureau-hook/bureau-tools were real
 * processes able to be mid-request at quit time; they have been since M4.
 *
 * Extracted from `index.ts` so the ORDER is observable to a test. It was
 * unobservable before, which is why the gap survived: `app.on('before-quit')`
 * needs a live Electron runtime that vitest never has.
 */

/** Bounded on purpose: a hung request must not strand the user in an app
 *  that will not quit. Long enough for a real in-flight tool call to
 *  finish, short enough that a wedged one is not the user's problem. */
import type { NewEventInput } from '../shared/models/event';

const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export interface ShutdownTargets {
  /**
   * Every live Supervisor (D-2). Structural rather than `SupervisorRegistry`
   * so a test can wrap it, and because what this file needs is "who is
   * running, and how do I stop them" — not the registry's whole surface.
   *
   * It stopped nothing before pre-M11 D-2, which was survivable only while
   * nothing in production hired: the first real hire at M11 would have meant
   * quitting Bureau while its employees' engine processes kept running, with
   * their rows left claiming `working` for the next launch to clean up.
   */
  readonly supervisors: {
    all(): ReadonlyArray<{
      readonly employeeId: string;
      readonly supervisor: { stop(graceMs?: number): Promise<void> };
    }>;
  };
  readonly controlChannelServer: { stop(): Promise<void> };
  readonly resumeTick: { stop(): void };
  /** M8's checkpoint sweep and surfacing tick. Same hazard as `resumeTick`:
   * a tick that fires against a closing database would be a crash on the
   * way out, and — worse for this one — a half-applied timeout resolution. */
  readonly checkpointTick: { stop(): void };
  /** M8 session 2's message router. The same hazard again, with its own
   * shape: this one is `async`, so a pass already in flight can still be
   * between `adapter.send()` and its `markMessageDelivered` when the
   * database closes. `stop()` sets a flag its loop checks before starting
   * any further pass, so no NEW pass begins once shutdown starts — an
   * in-flight one is bounded by the same drain race everything else here
   * is, and its worst outcome is a redelivery, which §9.7 already makes
   * safe. */
  readonly messageRouter: { stop(): void };
  /**
   * M9's live-state broadcast. Unsubscribed before the database closes for
   * the plainest possible reason: it re-queries on every checkpoint event,
   * and the events written *during* shutdown are real ones.
   */
  readonly stopLiveState: () => void;
  /**
   * M9's in-flight streamed replies. A stream still open at quit time would
   * otherwise be left for the next launch's `reconcile()` to mark
   * `aborted` — which works, and tells the user their reply was interrupted
   * by a crash when it was interrupted by them closing the app. Ending them
   * here writes the same row state through the same path, at the moment it
   * actually happened.
   */
  readonly chatStreams: { abortAll(): number };
  readonly activityLog: {
    close(): void;
    /** AUDIT #18 — `app.stopping` is written through the real logEvent,
     *  not a bespoke write, so it is validated and sequenced like every
     *  other event (#2). */
    logEvent(input: NewEventInput): unknown;
  };
  readonly db: { close(): void };
}

export interface ShutdownOptions {
  readonly drainTimeoutMs?: number;
}

export async function runShutdownSequence(
  targets: ShutdownTargets,
  options: ShutdownOptions = {},
): Promise<void> {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;

  // AUDIT M0–M2 #18. §5.2's `app.stopping`, FIRST — before any target is
  // stopped and long before the log itself closes at the bottom of this
  // function. Emitting it last would mean racing the very thing that
  // writes it. A failure here must not prevent the shutdown: an app that
  // refuses to quit because it could not write about quitting is a worse
  // outcome than a missing line, and this is the one place in the codebase
  // where letting `logEvent` throw would strand the user.
  try {
    targets.activityLog.logEvent({ actor: 'system', type: 'app.stopping', severity: 'info' });
  } catch (err) {
    console.error('[shutdown] could not record app.stopping; quitting anyway', err);
  }

  // Stop the timers first: neither may fire against a database that is
  // about to close.
  targets.resumeTick.stop();
  targets.checkpointTick.stop();
  targets.messageRouter.stop();

  // Streams end before the broadcast stops, so their final rows still
  // reach any window that is still up; the broadcast stops before the
  // database closes, so nothing re-queries a closing connection.
  targets.chatStreams.abortAll();
  targets.stopLiveState();

  // Stop the employees BEFORE the channel drains (D-2). An employee
  // stopping may have a tool call in flight, and that call is served by the
  // control channel: draining first would leave the stop racing a server
  // that had already refused its request. This way no NEW turn begins, and
  // the drain below is what waits for whatever was already in the air.
  //
  // Bounded by the same timeout, and for the same reason: a wedged engine
  // must not strand the user in an app that will not quit. A Supervisor
  // that does not finish stopping loses its process to the OS when this one
  // exits, and its row is reconciled on the next launch — which is exactly
  // the path a crash already takes.
  const live = targets.supervisors.all();
  if (live.length > 0) {
    await Promise.race([
      Promise.allSettled(live.map(({ supervisor }) => supervisor.stop(drainTimeoutMs))),
      new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs)),
    ]);
  }

  // Then genuinely WAIT for the channel to drain — bounded, and never
  // allowed to throw past this point. Whatever happens to the server, the
  // log and the database still close: leaving them open would be a worse
  // failure than a request that did not finish.
  await Promise.race([
    targets.controlChannelServer.stop().catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, drainTimeoutMs)),
  ]);

  // File before mirror, matching §11.6's own ordering: the activity log is
  // the source of truth the `events` table mirrors.
  targets.activityLog.close();
  targets.db.close();
}
