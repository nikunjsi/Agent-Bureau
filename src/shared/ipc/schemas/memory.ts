import { z } from 'zod';
import { MemorySchema } from '../../models/memory';
import { MemoryProposalSchema } from '../../models/memoryProposal';
import { MemoryScopeSchema } from '../../models/enums';
import { IdInputSchema, OkOutputSchema, nullableGetOutputSchema } from './common';

/**
 * §17.1's `memory` namespace, real from M10. **The six method names are
 * unchanged** — §17.1's surface is fixed and `check:ipc-surface` diffs it
 * against the spec — so everything M10 needed arrived as fields on existing
 * methods, the way `chat.send` gained `attachments` at M9.
 *
 * Two consequences worth stating, because both look like omissions:
 *
 *  - **There is no `acceptProposal` method.** §12.4's review is a
 *    checkpoint, so it is answered through `checkpoints.answer` with
 *    `itemDecisions`. A second answering surface would be a second door onto
 *    "a checkpoint stops being pending".
 *  - **`write` covers editing, creating and pinning.** A pin is a real state
 *    change with no layer-1 representation (§12.1), not a separate kind of
 *    operation; `write` writes whatever it is given.
 */
export const Memory = {
  /**
   * The memory view's one call: what memory holds, and what is being asked
   * of it. Proposals travel alongside the notes because a person browsing
   * memory is the same person deciding what joins it, and two round trips
   * for one screen would be two chances for them to disagree.
   */
  list: {
    input: z.object({
      scope: MemoryScopeSchema.optional(),
      scopeRef: z.string().nullable().optional(),
    }),
    output: z.object({
      items: z.array(MemorySchema),
      /** Pending only. A decided proposal is history, and history belongs to
       *  the activity log, not to a list of things awaiting an answer. */
      proposals: z.array(MemoryProposalSchema),
    }),
  },
  /**
   * Reconciles that one note against layer 1 before answering (§12.1's
   * out-of-band edits), so what comes back is the file rather than a
   * remembered copy of it. `item: null` when the file has been deleted
   * outside Bureau — the row goes with it.
   */
  read: { input: IdInputSchema, output: nullableGetOutputSchema(MemorySchema) },
  write: {
    input: z
      .object({
        scope: MemoryScopeSchema,
        /** Relative to the scope directory. Confined by the same Core-side
         *  guard the agent-facing write path uses — see `memoryTarget.ts`. */
        path: z.string().min(1),
        /** Optional: derived from the first markdown heading when absent, by
         *  the same `titleFromMarkdown` the index uses for a file Bureau did
         *  not write. One derivation, not two. */
        title: z.string().min(1).optional(),
        /** Markdown. Absent means "change nothing about the file" — which is
         *  what a pin or unpin is. */
        body: z.string().optional(),
        pinned: z.boolean().optional(),
      })
      .refine((input) => input.body !== undefined || input.pinned !== undefined, {
        message: 'give a body to write, a pinned state to change, or both',
      }),
    output: z.object({ item: MemorySchema }),
  },
  /** Deletes the markdown file and then its row — layer 1 first, for the
   *  same reason writes go in that order (§12.1). */
  remove: { input: IdInputSchema, output: OkOutputSchema },
  search: {
    input: z.object({ query: z.string().min(1) }),
    output: z.object({
      items: z.array(MemorySchema),
      /**
       * §12.1 layer 3, reported rather than swallowed. `'off'` is the
       * default; `'unavailable'` means the user turned semantic search on
       * and there is no local model, so these are FTS results and the caller
       * is told so. Degrading loudly is the point — a silent fallback looks
       * exactly like a semantic search that worked.
       */
      semantic: z.enum(['off', 'unavailable']),
    }),
  },
  reindex: {
    input: z.object({
      /**
       * `false` (default) reconciles: new and changed files are indexed,
       * rows for deleted files are dropped, **and pins survive**.
       *
       * `true` is §12.1's wipe-and-rebuild — the repair for an index that is
       * wrong in a way a content hash cannot see. It rebuilds every row from
       * layer 1, and **that clears every pin**, because pinning is a user
       * decision with no representation in a markdown file. Stated in the
       * result rather than hidden, so the UI can warn before and report
       * after.
       */
      full: z.boolean().default(false),
    }),
    output: z.object({
      indexed: z.number().int(),
      removed: z.number().int(),
      /** How many notes lost their pin. Always 0 for an incremental run. */
      pinsCleared: z.number().int(),
    }),
  },
};
