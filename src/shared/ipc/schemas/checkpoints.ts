import { z } from 'zod';
import { CheckpointOutputSchema } from '../../models/checkpoint';
import { IdSchema } from '../../models/ids';
import { MemoryProposalDecisionSchema } from '../../models/memoryProposal';
import {
  EmptyInputSchema,
  IdInputSchema,
  listOutputSchema,
  nullableGetOutputSchema,
} from './common';

/**
 * `answer` and `answerPermission` return more than a bare `ok` (M8).
 *
 * §9.6's answering does several separable things, and each of them can
 * legitimately not happen: a checkpoint with nothing blocked on it
 * unblocks no task; one with no employee behind it (a budget or
 * merge-conflict row) has nobody to queue the decision for; only a
 * `decision` reaches the decision log. A bare `{ ok: true }` would make
 * those indistinguishable from "it all worked", and M9's card has to tell
 * the user which of them actually happened.
 */
export const Checkpoints = {
  listPending: { input: EmptyInputSchema, output: listOutputSchema(CheckpointOutputSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(CheckpointOutputSchema) },
  answer: {
    input: z.object({
      id: IdSchema,
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      /**
       * §12.4's "accept/reject **per item**" (M10). A field on an existing
       * method rather than a new one, following M9's `chat.send.attachments`:
       * §17.1's namespace/method surface is fixed and `check:ipc-surface`
       * diffs it against the spec, while the schemas are the contract and
       * may grow.
       *
       * A memory review IS a checkpoint, so it is answered where every other
       * checkpoint is answered. A separate `memory.acceptProposal` would be
       * a second door onto "a checkpoint stops being pending", which
       * `answerCheckpoint` exists to be the only one of.
       *
       * Only consulted when the chosen option asks for per-item decisions;
       * an answer that names that option and omits a note is refused with
       * the count still outstanding, and nothing is written.
       */
      itemDecisions: z.array(MemoryProposalDecisionSchema).optional(),
    }),
    output: z.object({
      ok: z.literal(true),
      /** Null when nothing was blocked on this checkpoint. */
      unblockedTaskId: IdSchema.nullable(),
      /** The outbox row carrying the decision to the employee's next turn
       * (§9.7). Null when the checkpoint has no employee to address. */
      queuedMessageId: IdSchema.nullable(),
      /** §12.5 — true when this answer was appended to `project/decisions.md`. */
      decisionLogged: z.boolean(),
      /** §12.4 — the proposals this answer wrote to memory, and the ones it
       *  discarded. Ids rather than a sentence: how "3 notes saved, 1
       *  discarded" reads is the renderer's decision. */
      memoryProposalsApplied: z.array(IdSchema),
      memoryProposalsRejected: z.array(IdSchema),
    }),
  },
  answerPermission: {
    input: z.object({ id: IdSchema, allow: z.boolean() }),
    output: z.object({
      ok: z.literal(true),
      allowed: z.boolean(),
      /** False when no hold was still open — the employee stopped waiting,
       * died, or the hold already timed out to deny. The answer is still
       * recorded; the user is told it arrived too late rather than being
       * shown a success that did nothing. */
      holdReleased: z.boolean(),
    }),
  },
};
