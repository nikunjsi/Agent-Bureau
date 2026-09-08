import { z } from 'zod';

/**
 * JSON columns are TEXT with `CHECK (json_valid(col))` at the DB level
 * (§5.0). On the application side, every JSON column gets the same
 * parse/validate pair so a malformed value is rejected the same way
 * everywhere rather than trusted.
 *
 * `jsonColumnSchema(inner)` — for parsing a column's stored TEXT value back
 * into its structured shape (used when reading a row out of the DB).
 *
 * ## It also accepts an already-parsed value, and that is load-bearing
 *
 * A row read from SQLite carries TEXT. But a row that has ALREADY been
 * parsed — a `Checkpoint`, a `Task` — gets re-validated in one real place:
 * `dispatchIpcCall` parses every handler's success payload against the
 * method's own output schema (§17.2), and those output schemas are these
 * same row schemas. Parse-then-parse-again has to be a no-op, and without
 * the second branch below it was not: `options` came back an array, and the
 * schema only accepted a string.
 *
 * That was not theoretical. **`checkpoints.listPending` and
 * `checkpoints.get` returned `INTERNAL_ERROR` for every checkpoint that had
 * options** — which is every type except `information` — and would have
 * done so for M9's chat card and the Checkpoints view badge, the two §9.4
 * surfaces that call them. `tasks.list` had the identical latent defect via
 * `acceptance_criteria`. Found in M8 session 2 while proving that surfacing
 * reads the same state `listPending` returns; fixed here, in the one place
 * both share, rather than in a bespoke wire schema per namespace.
 *
 * Order matters and is deliberate: the TEXT branch is tried FIRST, so a
 * genuine stored column value is still parsed as JSON rather than being
 * handed to a permissive `inner` (`checkpoints.preview` is `z.unknown()`,
 * which would otherwise swallow the raw string unparsed). The `inner`
 * branch is only reached when the value is not a string at all.
 */
export function jsonColumnSchema<T extends z.ZodTypeAny>(inner: T) {
  const fromStoredText = z
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
  return z.union([fromStoredText, inner]);
}

/** A nullable variant, for JSON columns without `NOT NULL`. */
export function nullableJsonColumnSchema<T extends z.ZodTypeAny>(inner: T) {
  return z.union([z.null(), jsonColumnSchema(inner)]);
}

/** Serializes a structured value for storage in a JSON TEXT column. */
export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value);
}
