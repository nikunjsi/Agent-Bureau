import type { PricingTable } from '../../shared/models/pricing';

/**
 * §24.3: "exponential backoff with jitter (2s, 5s, 15s, 45s, cap 2m)."
 * `attempt` is 0-indexed (the first retry after the first rate-limited
 * response is attempt 0). Jitter is +/-20% of the base delay — enough that
 * several simultaneously-rate-limited employees don't all retry in lockstep
 * — clamped so the result never exceeds the 2-minute cap regardless of
 * jitter direction. `random` is injectable so tests can assert exact
 * bounds without depending on `Math.random()`'s real output.
 */
const BACKOFF_SCHEDULE_MS: readonly number[] = [2_000, 5_000, 15_000, 45_000];
const BACKOFF_CAP_MS = 120_000;

export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = attempt < BACKOFF_SCHEDULE_MS.length ? BACKOFF_SCHEDULE_MS[attempt]! : BACKOFF_CAP_MS;
  const jitterRange = base * 0.2;
  const jitter = (random() * 2 - 1) * jitterRange;
  return Math.min(BACKOFF_CAP_MS, Math.max(0, Math.round(base + jitter)));
}

export interface ResumeAtResolution {
  readonly resumeAtIso: string;
  /** `false` means `resumeAtIso` is the `now + 1h` fallback, not a real
   * provider-confirmed reset — callers (the checkpoint text builder) must
   * never present it as a known time when this is false. */
  readonly known: boolean;
}

const UNKNOWN_RESET_FALLBACK_MS = 60 * 60_000; // §24.3: "do not invent one... set resume_at = now + 1h"

/**
 * §24.3: reads `pricing.yaml`'s `quota_reset` for this engine. `unknown`
 * (claude-code's real, researched value this session — see
 * resources/pricing.yaml's own comment) or a missing pricing table/engine
 * entry all fall to the same honest `now + 1h` fallback — never a fabricated
 * duration.
 */
export function resolveResumeAt(pricing: PricingTable | null, engine: string, now: Date = new Date()): ResumeAtResolution {
  const quotaReset = pricing?.engines[engine]?.quota_reset;
  if (!quotaReset || quotaReset.kind === 'unknown') {
    return { resumeAtIso: new Date(now.getTime() + UNKNOWN_RESET_FALLBACK_MS).toISOString(), known: false };
  }
  if (quotaReset.kind === 'rolling') {
    return { resumeAtIso: new Date(now.getTime() + quotaReset.window_minutes * 60_000).toISOString(), known: true };
  }
  // kind === 'daily' — not exercised by any real engine today (claude-code
  // is 'unknown'; see pricing.yaml), but real, tested code for a future
  // engine that genuinely publishes a daily wall-clock reset.
  return { resumeAtIso: nextDailyResetIso(quotaReset.hour, quotaReset.timezone, now), known: true };
}

/**
 * Converts Y/M/D H:mm:ss *as observed in `timezone`* to the UTC instant it
 * represents, via the standard "guess as UTC, measure the real offset at
 * that guess, correct" two-pass trick — no timezone-database dependency
 * beyond what `Intl` already carries. Two passes converge correctly except
 * within the ~1h window of a DST transition itself, where the correction
 * can land on the wrong side of the jump; a known, narrow limitation,
 * flagged rather than silently assumed exact, and irrelevant to every fixed-
 * offset zone (UTC, most of Asia) `nextDailyResetIso`'s own tests use.
 */
function zonedTimeToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, timezone: string): number {
  const asIfUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = asIfUtc;
  for (let i = 0; i < 2; i++) {
    const offset = offsetAtMs(guess, timezone);
    guess = asIfUtc - offset;
  }
  return guess;
}

/** The target timezone's offset from UTC (ms, positive east of UTC) at a given instant. */
function offsetAtMs(ms: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const zonedAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return zonedAsUtc - ms;
}

function dateComponentsInZone(ms: number, timezone: string): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { y: get('year'), mo: get('month'), d: get('day') };
}

function nextDailyResetIso(hour: number, timezone: string, now: Date): string {
  const { y, mo, d } = dateComponentsInZone(now.getTime(), timezone);
  let candidateMs = zonedTimeToUtcMs(y, mo, d, hour, 0, 0, timezone);
  if (candidateMs <= now.getTime()) {
    const tomorrow = dateComponentsInZone(candidateMs + 24 * 60 * 60_000, timezone);
    candidateMs = zonedTimeToUtcMs(tomorrow.y, tomorrow.mo, tomorrow.d, hour, 0, 0, timezone);
  }
  return new Date(candidateMs).toISOString();
}

/**
 * §24.3's exact template: *"We've used up today's free quota for {engine}.
 * Work is paused and will resume automatically {when}. You can also connect
 * a paid key in Settings to continue now."* — `{when}` is the known reset
 * time (rendered in the machine's own local clock — the only clock the user
 * actually reads this on) or, when unknown, the literal fallback phrase the
 * spec itself gives. Never interpolates a duration/time this function
 * cannot actually support.
 */
export function buildQuotaExhaustedCheckpointText(engine: string, resumeAt: ResumeAtResolution): string {
  const when = resumeAt.known
    ? `at ${new Date(resumeAt.resumeAtIso).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}`
    : 'when we retry in an hour';
  return `We've used up today's free quota for ${engine}. Work is paused and will resume automatically ${when}. You can also connect a paid key in Settings to continue now.`;
}
