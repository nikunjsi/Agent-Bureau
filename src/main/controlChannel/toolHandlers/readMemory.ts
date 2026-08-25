import { ReadMemoryArgsSchema } from './schemas';
import type { ToolHandler } from './types';

/**
 * §7.9: bureau_read_memory — HONEST EMPTY. No memory store exists until
 * M7 (the `memory`/`memory_fts` tables are real from M1, but nothing
 * populates them for a role to search yet). Returns a well-formed empty
 * result with a clear reason an agent can read and act on — never an
 * error shaped like a transport failure, and never silently returning
 * results as if a real search ran and found nothing, which would be a
 * false claim (§1.5) indistinguishable from "there really is nothing
 * relevant".
 *
 * No activity event: a read that changes nothing is not a state-changing
 * operation (§5.2's own rule: "every state-changing operation emits
 * exactly one event"), so there is nothing here for that rule to require.
 */
export const handleReadMemory: ToolHandler = (_ctx, rawArgs) => {
  const parsed = ReadMemoryArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_read_memory: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }

  return {
    ok: true,
    data: {
      results: [],
      reason: 'No memory store exists yet (lands at M7) — this is not a failed search, there is nothing to search yet.',
    },
  };
};
