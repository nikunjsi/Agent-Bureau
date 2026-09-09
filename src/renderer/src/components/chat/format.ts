/**
 * Presentation-only formatting. Every function here turns a **fact the
 * Core sent** into a string a person reads; none of them decides anything.
 *
 * This file is the reason no payload carries a pre-formatted string: the
 * Core says `costMicros: null`, and the sentence that fact deserves is
 * written here, where a rebuilt view is free to write a different one.
 */

/**
 * §11.5.1, and CLAUDE.md's named trap: *do not show `$0.00` for an engine
 * that does not report usage.*
 *
 * `null` is not zero. It means nobody knows — the engine reports no token
 * usage, so Bureau is enforcing wall-clock and turn limits instead, and a
 * dollar figure would be a fabricated number the user would then trust.
 */
export function formatCost(micros: number | null): string {
  if (micros === null) return 'cost not reported by this engine';
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

/** Local time, no date, for a message in a conversation the user is
 * reading now. The full timestamp is on the element's `title`. */
export function formatClockTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A countdown to a checkpoint's deadline. Returns null when there is no
 * deadline — which is a real and common state (§9.5: a `whenever`
 * checkpoint has no expiry, and neither does one whose every option is
 * irreversible), not a missing value to paper over.
 */
export function formatTimeRemaining(expiresAt: string | null, nowMs: number): string | null {
  if (expiresAt === null) return null;
  const deadline = new Date(expiresAt).getTime();
  if (Number.isNaN(deadline)) return null;
  const remainingMs = deadline - nowMs;
  if (remainingMs <= 0) return 'overdue';
  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return 'less than a minute left';
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}
