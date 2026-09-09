import { z } from 'zod';
import { ConversationMessageSchema } from '../../models/conversationMessage';
import { CheckpointSchema } from '../../models/checkpoint';
import { EventSchema } from '../../models/event';
import { IdSchema } from '../../models/ids';

/**
 * §17.2: "The renderer holds no authoritative state. It hydrates from
 * `stateDelta` and re-hydrates fully on reconnect." Two kinds:
 *   - `full`  — a complete snapshot of every slice. Sent once per window
 *               on `did-finish-load` (initial load *and* any reload/
 *               crash-recovery — see stateDelta.ts), which is what makes
 *               "re-hydrates fully on reconnect" true without needing an
 *               explicit renderer-initiated "give me state" call.
 *   - `patch` — an incremental update to exactly one slice, carrying a
 *               monotonic `seq`. The renderer applies a patch only if its
 *               `seq` is exactly `lastAppliedSeq + 1`; any gap means a
 *               `full` delta is needed and the patch is dropped, not
 *               applied out of order.
 *
 * `slices` is intentionally loose (`z.unknown()` per named slice) rather
 * than one giant discriminated shape — each slice's real content is owned
 * by whichever milestone produces it (settings is M2's own; employees/
 * tasks/projects are M1's tables read back; chat/checkpoints arrive by
 * their own dedicated events, not through here).
 */
/**
 * `on.chatMessage` — "new/updated Director message (incl. streaming
 * deltas)" (§17.1), wrapped in an envelope carrying a **per-window channel
 * sequence** (M9).
 *
 * The bare row was the obvious shape and is the wrong one: a push can be
 * missed, and this channel carries the product's primary surface. Without a
 * sequence, a dropped terminal flush leaves a message rendering as
 * mid-stream forever while the database says `complete` — worse than the
 * `aborted` state M9 works to mark, because nothing marks it at all.
 * `conversation_messages.seq` cannot see that case (an update does not
 * advance a row's own sequence), which is why the sequence lives on the
 * channel and the column keeps meaning what §5.1 says it means.
 *
 * The renderer's rule is in `bureauStore`: a gap re-fetches through
 * `chat.listMessages` rather than patching.
 */
export const ChatMessageEventSchema = z.object({
  seq: z.number().int().positive(),
  message: ConversationMessageSchema,
});

export const StateDeltaSliceNameSchema = z.enum([
  'settings',
  'company',
  'projects',
  'tasks',
  'employees',
  'checkpoints',
]);
export type StateDeltaSliceName = z.infer<typeof StateDeltaSliceNameSchema>;

export const StateDeltaSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('full'),
    seq: z.number().int().nonnegative(),
    slices: z.record(StateDeltaSliceNameSchema, z.unknown()),
  }),
  z.object({
    kind: z.literal('patch'),
    seq: z.number().int().positive(),
    slice: StateDeltaSliceNameSchema,
    value: z.unknown(),
  }),
]);
export type StateDelta = z.infer<typeof StateDeltaSchema>;

/** `{ employeeId, seq, base64 }` — coalesced ~16ms, per §17.1's own
 * comment. A gap in `seq` triggers a resubscribe with `fromSeq`; if the
 * data has aged out of the ring buffer, a `resync` marker is sent instead
 * of a chunk (both are M3's job to actually produce). */
export const TerminalChunkSchema = z.object({
  employeeId: IdSchema,
  seq: z.number().int().nonnegative(),
  base64: z.string(),
  resync: z.boolean().default(false),
});

export const FloorEventSchema = z.object({
  type: z.enum(['hire', 'walk_to_director', 'handoff', 'fire']),
  employeeId: IdSchema,
});

export const ToastSchema = z.object({
  id: z.string(),
  kind: z.enum(['info', 'success', 'warning', 'error']),
  message: z.string().min(1),
});

export const IPC_EVENT_SCHEMAS = {
  stateDelta: StateDeltaSchema,
  chatMessage: ChatMessageEventSchema,
  terminalChunk: TerminalChunkSchema,
  activityEvent: EventSchema,
  checkpointRaised: CheckpointSchema,
  floorEvent: FloorEventSchema,
  toast: ToastSchema,
} as const;
