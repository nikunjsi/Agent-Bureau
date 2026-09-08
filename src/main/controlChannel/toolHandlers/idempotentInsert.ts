/**
 * Runs an insert that can violate a UNIQUE(idempotency_key) constraint,
 * falling back to a lookup of the row that already won rather than
 * surfacing the raw SQLite error to an agent. Shared by every handler that
 * creates an outbox message (bureau_ask_director, bureau_send_message) —
 * see messages.ts's own getOutboxMessageByIdempotencyKey comment for why
 * this second line of defense exists alongside session 1's in-memory
 * IdempotencyCache.
 */
export function insertOrFetchByIdempotencyKey<T>(
  insert: () => T,
  fetchExisting: () => T | null,
): T {
  try {
    return insert();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('UNIQUE constraint failed') || !message.includes('idempotency_key')) {
      throw err;
    }
    const existing = fetchExisting();
    if (!existing) throw err; // genuinely unexpected — the constraint fired but no row is findable by that key
    return existing;
  }
}
