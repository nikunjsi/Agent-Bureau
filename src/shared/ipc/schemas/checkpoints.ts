import { z } from 'zod';
import { CheckpointSchema } from '../../models/checkpoint';
import { IdSchema } from '../../models/ids';
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
  listPending: { input: EmptyInputSchema, output: listOutputSchema(CheckpointSchema) },
  get: { input: IdInputSchema, output: nullableGetOutputSchema(CheckpointSchema) },
  answer: {
    input: z.object({
      id: IdSchema,
      optionId: z.string().optional(),
      freeText: z.string().optional(),
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
