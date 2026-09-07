import { getSetting } from '../db/repositories/settings';
import { listExpiredPendingCheckpoints } from '../db/repositories/checkpoints';
import { answerCheckpoint, type AnswerDeps } from './answerCheckpoint';

/**
 * §9.5's timeouts and §9.6's post-restart grace, as one narrow periodic
 * loop. Modelled on `parkedEmployeeResumeTick.ts` — that file's own
 * scoping applies here verbatim: this does exactly one job and nothing
 * else. **It is not an orchestrator.** No task assignment, no employee
 * spawning, no surfacing; those belong to M11, M11 and session 2.
 *
 * ## The post-restart grace, and why it is the subtle one
 *
 * §9.6: "After an app restart, auto-resolution is suppressed for
 * `settings.checkpoints.postRestartGraceMinutes` (default 10) **even if
 * the wall-clock timer expired while the app was closed.** Auto-resolving
 * a three-day-old checkpoint the instant the user opens the app is the
 * exact opposite of what this system is for."
 *
 * CLAUDE.md names it as a trap in its own right, and the trap is specific:
 * the naive implementation is correct-looking and wrong. `expires_at <=
 * now` is true for every checkpoint raised before the machine was shut
 * down, so the first tick after launch resolves the user's entire backlog
 * to defaults before they have read a word of it — while the app is
 * technically doing exactly what §9.5 says.
 *
 * So the grace is checked **before the query runs**, in this one function,
 * from an injected `appStartedAt`. Not in the SQL, not at the caller, not
 * duplicated into `reconcile()`: one decision, one place.
 *
 * **The other half of §9.6 is a seam.** "The Director surfaces them in its
 * restart report instead." There is no Director (M11). What exists is the
 * suppression and the count of what was suppressed, returned so a future
 * restart report has something real to read; nothing here pretends to
 * surface anything.
 *
 * ## What a timeout may and may not do
 *
 * `listExpiredPendingCheckpoints` cannot return a checkpoint with no
 * `default_action`, because `computeExpiresAt` gives such a checkpoint no
 * `expires_at` at all — CLAUDE.md invariant #7 holds structurally rather
 * than by a check here. It also excludes `permission`, whose deadline
 * belongs to the live hold; see that function for why.
 */

export interface CheckpointTimeoutTickOptions {
  /** Epoch ms this process started. Injected, never read from a global. */
  readonly appStartedAtMs: number;
  /** Epoch ms "now". Injected so tests drive real instants, not fake timers. */
  readonly nowMs: number;
}

export interface CheckpointTimeoutReport {
  /** Checkpoint ids resolved to their safe default. */
  readonly resolved: string[];
  /** How many expired checkpoints the grace period held back. */
  readonly suppressedByGrace: number;
  /** Milliseconds until the grace lifts; 0 once it has. */
  readonly graceRemainingMs: number;
}

export function resolveExpiredCheckpoints(
  deps: AnswerDeps,
  options: CheckpointTimeoutTickOptions,
): CheckpointTimeoutReport {
  const graceMs = getSetting(deps.db, 'checkpoints.postRestartGraceMinutes') * 60_000;
  const graceEndsAtMs = options.appStartedAtMs + graceMs;
  const nowIsoTs = new Date(options.nowMs).toISOString();

  if (options.nowMs < graceEndsAtMs) {
    // Deliberately still runs the query, purely to COUNT. The alternative
    // — returning early with no number — would make the grace invisible,
    // and the count is the one thing M11's restart report will need.
    // Nothing is resolved and no event is emitted: not resolving is not a
    // state change.
    const held = listExpiredPendingCheckpoints(deps.db, nowIsoTs);
    return {
      resolved: [],
      suppressedByGrace: held.length,
      graceRemainingMs: graceEndsAtMs - options.nowMs,
    };
  }

  const expired = listExpiredPendingCheckpoints(deps.db, nowIsoTs);
  const resolved: string[] = [];

  for (const checkpoint of expired) {
    // `default_action` is non-null by construction here (no safe default
    // ⇒ no expiry ⇒ not selected), and the schema guarantees it names a
    // real option. The narrow, honest claim this delivers: a timeout only
    // ever applies an option the author explicitly designated as safe.
    if (checkpoint.default_action === null) continue;

    // One resolution path, two triggers. A timeout is an answer applied by
    // the system, so it goes through the same function a person's answer
    // does — same CAS, same unblock, same outbox message, same decision
    // log — differing only in status, actor and event type.
    const result = answerCheckpoint(deps, {
      checkpointId: checkpoint.id,
      optionId: checkpoint.default_action,
      source: 'timeout',
    });
    if (result.ok) resolved.push(checkpoint.id);
  }

  return { resolved, suppressedByGrace: 0, graceRemainingMs: 0 };
}

export interface CheckpointTimeoutTickHandle {
  stop(): void;
}

/** The real, minimal tick — the same `setInterval` primitive
 * `startResumeTick` and `Supervisor`'s heartbeat monitor already use. */
export function startCheckpointTimeoutTick(
  deps: AnswerDeps,
  appStartedAtMs: number,
  intervalMs = 60_000,
): CheckpointTimeoutTickHandle {
  const timer = setInterval(() => {
    resolveExpiredCheckpoints(deps, { appStartedAtMs, nowMs: Date.now() });
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
