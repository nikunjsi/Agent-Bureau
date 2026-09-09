import { z } from 'zod';
import { IdSchema } from './ids';
import type { ConversationMessageKind } from './enums';

/**
 * §14.2's eight message kinds, as the **facts** each one carries.
 *
 * `conversation_messages.payload` is "JSON: structured content for non-text
 * kinds" (§5.1) and M1 typed it `z.record(z.unknown())` because M1 had no
 * way to know what went in it. This is that shape, one schema per kind,
 * used in both directions: the writer (`src/main/chat/appendMessage.ts`)
 * validates on the way in, and the renderer's cards parse on the way out.
 * One definition, two boundaries — not a Core shape and a UI shape that
 * agree today.
 *
 * ## The rule these schemas exist to hold
 *
 * **The Core returns facts; the renderer decides how they look.** Nothing
 * here is a display string, a colour, an icon, a severity-to-styling hint,
 * a card/collapse/layout flag, or a UI destination. Concretely, what is
 * deliberately absent:
 *
 *  - No `$0.00` and no "cost not reported" — `costMicros: null` is the
 *    *fact* that the engine does not report usage (§11.5.1), and the
 *    renderer writes both sentences.
 *  - No button `label` and no `open_settings`-style route. An error's
 *    `remedy.kind` says what needs to happen in the **domain**; where that
 *    button goes and what it reads is the view's business.
 *  - No `allowFreeText` on a question. §14.2 gives every question a
 *    free-text box unconditionally, so a flag could only ever be driving
 *    layout.
 *  - No "expanded"/"collapsed" on a plan's phases. Collapsing is a
 *    rendering choice about a list that is simply a list here.
 *
 * The whole chat view is expected to be thrown away and rebuilt after this
 * phase. These payloads are the part that must survive that, so a field
 * that exists only to drive the current layout would be a field the
 * replacement inherits and cannot use.
 *
 * ## Adding a kind
 *
 * Don't, without changing §5.1's own column list and §14.2's table. The
 * eight are the spec's, and M11 builds on them. If a card seems to want a
 * ninth kind, the payload is the thing that is wrong.
 */

/**
 * `text` carries its prose in `body` (markdown). Its payload is `null` for
 * the ordinary case and stayed that way through session 1; session 2 gave
 * it two facts that are genuinely not prose.
 *
 * **`attachments`** — §14.2's "file attach (path reference into the
 * conversation)". Deliberately NOT formatted into `body`: how an attached
 * path reads to a person is the renderer's decision, and a stored row is
 * the one place presentation must never be baked in. Every path here has
 * already been canonicalised and confined to the company home by
 * `src/main/chat/attachments.ts` before the row was written.
 *
 * > **M11, read this.** An attachment reaches **neither** of the two things
 * > that carry a user's words to the Director: not `conversation_messages
 * > .body`, and not the `messages` outbox row `chat.send` writes (whose
 * > body is a copy of the same text). That is on purpose, and it is
 * > deliberately not solved here — writing the paths into either body
 * > would put formatting into a stored row, which is the boundary this
 * > file exists to hold.
 * >
 * > **M11 owns the decision and has two places to make it:** compose the
 * > outbox body from `payload.attachments` at send time (the shape
 * > `bureau_ask_director` already uses when it appends its own "Context:"
 * > block), or fold them into the Director's context when it reads the
 * > conversation. Either is legitimate; picking one is M11's, because M11
 * > is the first thing that knows what the Director actually gets given.
 *
 * **`delivered`** — set when this row is a `messages` outbox row that was
 * addressed to `user` and delivered into the conversation (§9.7/§J.4).
 * `author` is `system` for those: `MessageAuthorSchema` is a closed enum of
 * `user | director | system`, an employee is none of them, `director` would
 * be a lie (any employee can address `user` via `bureau_send_message`), and
 * adding a fourth value is a migration plus an enum M11 inherits for a
 * distinction this field already carries as a fact.
 */
export const TextPayloadSchema = z
  .object({
    attachments: z.array(z.string().min(1)).default([]),
    delivered: z
      .object({
        /** `messages.id` — the durable link back to the outbox row. */
        messageId: IdSchema,
        /** Verbatim `messages.from_addr`: an employee id, or `system`.
         * A name is the renderer's business; it has the roster. */
        fromAddr: z.string().min(1),
        subject: z.string(),
      })
      .strict()
      .nullable()
      .default(null),
  })
  // `.strict()`: an unknown key on a `text` payload is a producer writing
  // the wrong shape — a brief payload on a text message, a misspelt field
  // — and the writer throws on it (`validatePayload`) rather than storing
  // something no card can read. Stripping it silently would put the
  // discovery days later at the point furthest from the cause. The
  // pre-session-2 schema was `z.null()`, which rejected every object for
  // the same reason; this keeps that guard rather than trading it for two
  // new fields.
  .strict()
  .nullable()
  .default(null);

/** §14.2: "Bubble + inline option chips + a free-text box." The chips. */
export const QuestionPayloadSchema = z.object({
  options: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .min(1),
});

/** §8.3's brief, as much of it as a card shows. `assumptions` is separate
 * from `scope` because §14.2 requires assumptions to be *highlighted* —
 * which is a rendering decision the renderer can only make if the Core
 * tells it which statements are assumptions rather than facts. That is the
 * fact/presentation line: "these three are assumptions" is a fact; "show
 * them in amber" is not. */
export const BriefPayloadSchema = z.object({
  briefId: IdSchema.nullable().default(null),
  title: z.string().min(1),
  goal: z.string().min(1),
  scope: z.array(z.string().min(1)).default([]),
  outOfScope: z.array(z.string().min(1)).default([]),
  deliverables: z.array(z.string().min(1)).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
});

export const PlanPayloadSchema = z.object({
  planId: IdSchema.nullable().default(null),
  phases: z
    .array(
      z.object({
        name: z.string().min(1),
        goal: z.string().default(''),
        tasks: z
          .array(
            z.object({
              title: z.string().min(1),
              /** A person's name, not an id: this is what the card shows and
               * the Director knows it at plan time. Null when the plan does
               * not name an assignee — §13.5's orchestrator assigns, not the
               * plan. */
              assignee: z.string().nullable().default(null),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /** §11.5.1 again: null is "not estimable", not zero. */
  estimatedCostMicros: z.number().int().nullable().default(null),
  /** Roles the plan needs that the company does not have. */
  hiresNeeded: z.array(z.string().min(1)).default([]),
});

export const ReportPayloadSchema = z.object({
  whatHappened: z.string().min(1),
  whatChanged: z.array(z.string().min(1)).default([]),
  whatIsNext: z.string().default(''),
  /**
   * §11.5.1 / CLAUDE.md's named trap. **`null` means this engine does not
   * report usage** — it is not zero, and the renderer must not print
   * `$0.00` for it. The decision "is this engine metered" is made once, in
   * the Core, where `capabilities().usageReporting` lives; the renderer
   * only ever asks "is this a number".
   */
  costMicros: z.number().int().nullable().default(null),
});

/** §14.2's "compact phase-completion card with a deliverable link". */
export const SummaryPayloadSchema = z.object({
  phaseName: z.string().min(1),
  deliverable: z
    .object({
      id: IdSchema.nullable().default(null),
      title: z.string().min(1),
      /** Absolute path inside the workspace; the renderer opens it through
       * `system.openPath`, which does its own containment check. */
      path: z.string().min(1),
    })
    .nullable()
    .default(null),
});

/**
 * §14.6: "Every error surfaced to the user MUST have: what happened in
 * plain language, why, and a concrete next action." And CLAUDE.md's trap:
 * *do not show raw engine output to the user by default — translate.*
 *
 * So `explanation` is authored prose (content, like `body` — not
 * formatting) and is what gets shown. `technical` is the raw text: kept,
 * because a user who wants it should not have to open a log file, but
 * never the default rendering and never the whole bubble.
 */
export const ErrorPayloadSchema = z.object({
  /** A stable domain code, for the renderer to key off and for the
   * activity log to correlate with. Not shown as-is. */
  code: z.string().min(1),
  explanation: z.string().min(1),
  remedy: z
    .object({
      /** What needs to happen, in domain terms. Never a UI route: a
       * rebuilt view is free to put `answer_checkpoint` behind a different
       * tab, a modal, or a keystroke. */
      kind: z.enum(['answer_checkpoint', 'reconnect_engine', 'raise_budget', 'retry', 'open_path']),
      /** The thing the remedy acts on — a checkpoint id, an employee id, a
       * path — when the remedy needs one. */
      targetId: z.string().min(1).nullable().default(null),
    })
    .nullable()
    .default(null),
  technical: z.string().nullable().default(null),
});

/** `checkpoint` messages carry no payload: the card renders from the
 * `checkpoints` row named by `checkpoint_id`, which is the same state
 * `checkpoints.listPending` returns (§9.4 — "all reflecting one piece of
 * state" is a property of sharing the query, not of two payloads
 * agreeing). Copying a checkpoint's options into the message payload would
 * be exactly the second copy §9.4 forbids, and it would go stale the
 * moment the checkpoint was answered. */
const CheckpointPayloadSchema = z.null();

export const CHAT_PAYLOAD_SCHEMAS = {
  text: TextPayloadSchema,
  question: QuestionPayloadSchema,
  brief: BriefPayloadSchema,
  plan: PlanPayloadSchema,
  report: ReportPayloadSchema,
  checkpoint: CheckpointPayloadSchema,
  summary: SummaryPayloadSchema,
  error: ErrorPayloadSchema,
} as const satisfies Record<ConversationMessageKind, z.ZodTypeAny>;

export type ChatPayloadFor<K extends ConversationMessageKind> = z.infer<
  (typeof CHAT_PAYLOAD_SCHEMAS)[K]
>;

/**
 * Parse a stored payload for its kind. Used by the writer (where a failure
 * is a programming error and throws) and by the renderer (where a failure
 * is a row it cannot render and must not crash on — hence `safeParse`, not
 * an exception, at that end).
 */
export function parseChatPayload<K extends ConversationMessageKind>(
  kind: K,
  payload: unknown,
): z.SafeParseReturnType<unknown, ChatPayloadFor<K>> {
  const schema = CHAT_PAYLOAD_SCHEMAS[kind] as z.ZodType<ChatPayloadFor<K>>;
  return schema.safeParse(payload ?? null);
}
