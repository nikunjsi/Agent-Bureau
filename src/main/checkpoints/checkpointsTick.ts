import { listExpiredPendingCheckpoints } from '../db/repositories/checkpoints';
import { answerCheckpoint, type AnswerDeps } from './answerCheckpoint';
import { postRestartGraceState } from './expiry';
import { expireMemoryProposals } from '../memory/memoryProposals';
import { REVIEW_OPTION_IDS } from '../memory/memoryProposals';
import type { CheckpointSurfacer, CheckpointNotifier } from './surfacing';

/**
 * §9.5's timeouts and §9.6's post-restart grace. Modelled on
 * `parkedEmployeeResumeTick.ts`, and that file's own scoping still applies:
 * **this is not an orchestrator.** No task assignment, no employee
 * spawning — those are M11's.
 *
 * Session 2 added §9.4's surfacing to the same timer (see
 * `startCheckpointsTick` at the bottom for why the two share one, and why
 * that keeps the project at three periodic loops rather than four). The
 * two jobs stay separate functions; only the timer is shared.
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
  /** P-3: monotonic ms since the tick started, for the grace (a duration).
   *  The production tick always supplies it. */
  readonly uptimeMs?: number;
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
  // One derivation, one place — and since M10 it has a second reader
  // (§12.4's proposal expiry, which also auto-resolves a checkpoint).
  const grace = postRestartGraceState(
    deps.db,
    options.appStartedAtMs,
    options.nowMs,
    options.uptimeMs,
  );
  const nowIsoTs = new Date(options.nowMs).toISOString();

  if (grace.active) {
    // Deliberately still runs the query, purely to COUNT. The alternative
    // — returning early with no number — would make the grace invisible,
    // and the count is the one thing M11's restart report will need.
    // Nothing is resolved and no event is emitted: not resolving is not a
    // state change.
    const held = listExpiredPendingCheckpoints(deps.db, nowIsoTs);
    return {
      resolved: [],
      suppressedByGrace: held.length,
      graceRemainingMs: grace.remainingMs,
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

export interface MemoryProposalExpiryReport {
  readonly expired: string[];
  readonly closedCheckpoints: string[];
  readonly suppressedByGrace: number;
}

/**
 * §12.4's proposal expiry — the third job on this timer, and deliberately a
 * separate function from the sweep above rather than a branch inside it.
 *
 * ## Why it is here rather than on a fourth tick
 *
 * It reads the same tables at the same cadence with the same deps, and this
 * file's own note on sharing a timer applies unchanged: "two timers over one
 * table with one owner is a coincidence waiting to become a race." Three
 * ticks remain three ticks.
 *
 * ## Why the resolution is not a timeout
 *
 * The review checkpoint has `expires_at = null` — it is `whenever`, and
 * §9.5 says those never expire. It did **not** time out; its last *proposal*
 * did. Recording it as a timeout would make the activity trail wrong about
 * the one thing a person opening it would be there to learn, so it goes
 * through the same answering door with `source: 'system'` and its own
 * reason. The applied option is `reject_all`, because that is genuinely what
 * happened to every item.
 */
export function expireMemoryProposalsTick(
  deps: AnswerDeps,
  options: CheckpointTimeoutTickOptions,
): MemoryProposalExpiryReport {
  const grace = postRestartGraceState(
    deps.db,
    options.appStartedAtMs,
    options.nowMs,
    options.uptimeMs,
  );
  const result = expireMemoryProposals(
    { db: deps.db, activityLog: deps.activityLog, baseDir: deps.baseDir },
    { nowMs: options.nowMs, graceActive: grace.active },
  );

  const closed: string[] = [];
  for (const checkpointId of result.closedCheckpoints) {
    const answered = answerCheckpoint(deps, {
      checkpointId,
      optionId: REVIEW_OPTION_IDS.rejectAll,
      source: 'system',
      systemReason: 'all_proposals_expired',
    });
    if (answered.ok) closed.push(checkpointId);
  }

  return {
    expired: result.expired,
    closedCheckpoints: closed,
    suppressedByGrace: result.suppressedByGrace,
  };
}

export interface CheckpointsTickHandle {
  stop(): void;
  /** One pass now. The tick's own body, so a test drives what production
   *  runs rather than a copy of it. */
  runNow(): void;
}

/**
 * The checkpoints tick — **two jobs, one timer**: §9.5's timeout sweep and
 * §9.4's surfacing.
 *
 * ## Why they share a timer, and why it is still only three ticks
 *
 * Session 2 could have made surfacing a fourth `setInterval` alongside the
 * parked-employee resume tick, this one, and the new message router. It
 * does not, because surfacing reads *exactly* the state the sweep reads
 * (`listPendingCheckpoints`), at the same cadence, with the same deps —
 * two timers over one table with one owner is a coincidence waiting to
 * become a race. The three that remain are genuinely separate: different
 * cadences, different failure modes, and no ordering relationship between
 * any two of them. `PROGRESS.md` records what would change that.
 *
 * The file's old name (`timeoutTick.ts`) went with it: a function called
 * "timeout tick" that also surfaces is a name that lies.
 *
 * ## The two calls are independent on purpose
 *
 * `resolveExpiredCheckpoints` applies the post-restart grace *inside
 * itself*, before its own query. Surfacing is called separately and is
 * **not** gated by it — see `surfacing.ts` for why suppressing surfacing
 * during the grace would invert §9.6. An early return shared between them
 * would do exactly that, silently.
 *
 * ## 15 s, down from 60
 *
 * §9.4 fires a notification for `blocking` checkpoints — the ones with
 * someone or something stopped waiting. A minute of latency on those is the
 * wrong trade against an indexed query over a table that holds tens of
 * rows. The sweep does not care either way; the grace and every deadline
 * are wall-clock, not tick-counted.
 */
export function startCheckpointsTick(
  deps: AnswerDeps,
  surfacer: CheckpointSurfacer,
  notifier: CheckpointNotifier,
  appStartedAtMs: number,
  intervalMs = 15_000,
  /** P-3: injectable for the clock-jump test; `performance.now()` otherwise. */
  monotonicNow: () => number = () => performance.now(),
): CheckpointsTickHandle {
  const startedMonotonicMs = monotonicNow();
  const runNow = (): void => {
    const nowMs = Date.now();
    const uptimeMs = monotonicNow() - startedMonotonicMs;
    resolveExpiredCheckpoints(deps, { appStartedAtMs, nowMs, uptimeMs });
    // M10 — §12.4. Runs before surfacing so a review emptied by expiry is
    // already resolved and is not announced to a person who has nothing left
    // to decide.
    expireMemoryProposalsTick(deps, { appStartedAtMs, nowMs, uptimeMs });
    surfacer.surface({ notifier, nowMs });
  };
  const timer = setInterval(runNow, intervalMs);
  return { stop: () => clearInterval(timer), runNow };
}
