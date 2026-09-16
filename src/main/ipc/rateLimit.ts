/**
 * AUDIT M0–M2 #22 — §17.2: "Every handler … rate-limits where abuse is
 * possible."
 *
 * ## Why a named list, not all 109 methods
 *
 * The renderer is the only permitted sender (the sender check runs first),
 * so the abuse this guards against is not an attacker — it is **a renderer
 * bug that calls something in a loop**. That only matters where a call is
 * expensive, and from M11 onward some calls cost real money: `chat.send`
 * wakes the Director. A limit on `settings.get` would never catch anything
 * except a bug in the limiter.
 *
 * ## The numbers
 *
 * Chosen so a person can never hit them and a loop always does — not tuned
 * against measurement, because there is no traffic to measure yet. If one
 * ever binds on real human use, raise it; the test that pins "a person is
 * never stopped" (one message every two seconds for a minute) is the
 * contract to keep.
 *
 * Per-channel and per-process: all windows share one bucket per channel,
 * which is the right unit when what is being protected is spend.
 */

interface BucketPolicy {
  /** Calls allowed back-to-back before any are refused. */
  readonly burst: number;
  /** Tokens returned per second. */
  readonly refillPerSecond: number;
}

const POLICIES: Readonly<Record<string, BucketPolicy>> = {
  // From M11, every accepted call can be a Director turn.
  'chat.send': { burst: 10, refillPerSecond: 1 },
  // A file write and an index update per call; an editor autosave loop is
  // the plausible bug.
  'memory.write': { burst: 20, refillPerSecond: 2 },
  // Unpacks, validates and installs a whole pack.
  'packs.install': { burst: 3, refillPerSecond: 0.1 },
};

export const RATE_LIMITED_CHANNELS: readonly string[] = Object.keys(POLICIES);

export interface IpcRateLimiter {
  /** True if the call may proceed; consumes a token when it does. */
  tryAcquire(channel: string): boolean;
}

export function createIpcRateLimiter(now: () => number = Date.now): IpcRateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    tryAcquire(channel) {
      const policy = POLICIES[channel];
      if (policy === undefined) return true;
      const t = now();
      const bucket = buckets.get(channel) ?? { tokens: policy.burst, at: t };
      bucket.tokens = Math.min(
        policy.burst,
        bucket.tokens + ((t - bucket.at) / 1000) * policy.refillPerSecond,
      );
      bucket.at = t;
      buckets.set(channel, bucket);
      if (bucket.tokens < 1) return false;
      bucket.tokens -= 1;
      return true;
    },
  };
}
