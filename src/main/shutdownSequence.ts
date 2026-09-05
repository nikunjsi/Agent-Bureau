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
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

export interface ShutdownTargets {
  readonly controlChannelServer: { stop(): Promise<void> };
  readonly resumeTick: { stop(): void };
  readonly activityLog: { close(): void };
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

  // Stop the timer first: it must not fire against a database that is
  // about to close.
  targets.resumeTick.stop();

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
