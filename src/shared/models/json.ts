import { z } from 'zod';

/**
 * JSON columns are TEXT with `CHECK (json_valid(col))` at the DB level
 * (§5.0). On the application side, every JSON column gets the same
 * parse/validate pair so a malformed value is rejected the same way
 * everywhere rather than trusted.
 *
 * `jsonColumnSchema(inner)` — for parsing a column's stored TEXT value back
 * into its structured shape (used when reading a row out of the DB).
 */
export function jsonColumnSchema<T extends z.ZodTypeAny>(inner: T) {
  return z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(inner);
}

/** A nullable variant, for JSON columns without `NOT NULL`. */
export function nullableJsonColumnSchema<T extends z.ZodTypeAny>(inner: T) {
  return z.union([z.null(), jsonColumnSchema(inner)]);
}

/** Serializes a structured value for storage in a JSON TEXT column. */
export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}
