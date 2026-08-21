import { ulid } from 'ulid';
import { z } from 'zod';

/**
 * IDs are ULIDs (sortable by creation time), stored as TEXT (§5.0).
 */
export function newId(): string {
  return ulid();
}

/**
 * ISO-8601 UTC with milliseconds, stored as TEXT (§5.0). `Date#toISOString`
 * already produces exactly this format (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Zod schema for a ULID-shaped id (26 Crockford-base32 characters). */
export const IdSchema = z.string().length(26);

/** Zod schema for an ISO-8601 timestamp string. */
export const IsoTimestampSchema = z.string().datetime({ offset: false });
