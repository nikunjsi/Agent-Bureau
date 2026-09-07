import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './ids';
import { nullableJsonColumnSchema } from './json';
import { CheckpointStatusSchema, CheckpointTypeSchema, CheckpointUrgencySchema } from './enums';

/**
 * §9.2's option anatomy. **Exported** (M8) because the control channel's
 * `bureau_raise_checkpoint` args schema re-declared a near-copy of this
 * shape, with its own comment claiming it was "reused directly rather than
 * re-declared here". It now genuinely is — one rule, one place.
 *
 * `consequence` is `.min(1)`, not a bare `z.string()`. That is not a
 * stylistic tightening: CLAUDE.md invariant #8 and §9.2 both say an option
 * with no consequence is *rejected by validation*, and a bare `z.string()`
 * accepts `''` — so the rule was already false before M8 made it true.
 */
export const CheckpointOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().optional(),
  consequence: z.string().min(1),
  recommended: z.boolean().optional(),
});
export type CheckpointOption = z.infer<typeof CheckpointOptionSchema>;

const CheckpointOptionsSchema = z.array(CheckpointOptionSchema);

/** Diff, file list, command, or document excerpt — shape varies; owned by
 * M8/M9. M1 only needs "JSON". */
const CheckpointPreviewSchema = z.unknown();

const CheckpointAnswerSchema = z.object({
  optionId: z.string().optional(),
  freeText: z.string().optional(),
});
export type CheckpointAnswer = z.infer<typeof CheckpointAnswerSchema>;

/**
 * §9.2's "Rules (MUST)", as the five things a schema can actually decide.
 * Written once and applied to both the read shape and the write shape, so
 * a row that could be written can always be read back.
 *
 * **What is deliberately NOT here**, because no schema can judge it:
 * whether `default_action` really names the *reversible* option, and
 * whether the wording is fit for a non-expert (§9.2's own example —
 * "denormalise the orders table" vs "optimise for read speed at the cost
 * of some duplicated data"). So what the code below guarantees is narrower
 * than §9.2's prose, and is claimed that way everywhere: **a timeout only
 * ever applies an option the author explicitly designated as the safe
 * default.** The designation itself is authored. The one place it is
 * structural rather than trusted is `permission`, whose default is
 * hardcoded to `deny` by `createPermissionCheckpoint`.
 */
interface AnatomyShape {
  readonly type: z.infer<typeof CheckpointTypeSchema>;
  readonly options: readonly CheckpointOption[] | null;
  readonly default_action: string | null;
  readonly tool_call_id: string | null;
  readonly tool_name: string | null;
}

function checkAnatomy(row: AnatomyShape, ctx: z.RefinementCtx): void {
  const options = row.options ?? [];
  const ids = options.map((option) => option.id);

  // "At most one option is `recommended`."
  const recommended = options.filter((option) => option.recommended === true);
  if (recommended.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `at most one option may be recommended; ${recommended.length} are (${recommended.map((o) => o.id).join(', ')})`,
    });
  }

  // Duplicate ids would make `default_action` and an answer's `optionId`
  // ambiguous — the two things that resolve BY id.
  const duplicated = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicated.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `option ids must be unique; duplicated: ${duplicated.join(', ')}`,
    });
  }

  // A default naming nothing cannot be applied on timeout, which would
  // turn "resolves to the safe default" into "resolves to nothing" —
  // silently, and only ever an hour after the fact.
  if (row.default_action !== null && !ids.includes(row.default_action)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default_action'],
      message: `default_action '${row.default_action}' names none of this checkpoint's options (${ids.join(', ') || 'none'})`,
    });
  }

  // §9.2: options are "omitted only for pure `information`".
  if (row.options === null && row.type !== 'information') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['options'],
      message: `a '${row.type}' checkpoint must offer options; only 'information' may omit them`,
    });
  }

  // §9.1: `permission` carries tool_call_id/tool_name. Without the call
  // id there is no hold to release, so the agent waits out the full
  // timeout and is denied — a real failure, silent at creation time.
  if (row.type === 'permission' && (row.tool_call_id === null || row.tool_name === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tool_call_id'],
      message: 'a permission checkpoint must carry tool_call_id and tool_name (§9.1)',
    });
  }
}

/**
 * §5.1's own CHECK, and CLAUDE.md invariant #7 in the schema. Read it in
 * this direction: **expires_at ⇒ default_action** — "no expiry without a
 * safe default". A checkpoint whose every option is irreversible has no
 * safe default, so it simply never expires and the task stays parked
 * indefinitely (§9.5: correct behaviour, not a bug).
 *
 * The converse would be wrong and must never be "corrected" into place: a
 * `whenever` checkpoint that *does* have a safe default is legal and has
 * no expiry at all.
 */
const NO_EXPIRY_WITHOUT_DEFAULT = {
  message: 'default_action must be set whenever expires_at is set',
  path: ['default_action'],
};

export const CheckpointSchema = z
  .object({
    id: IdSchema,
    project_id: IdSchema.nullable(),
    task_id: IdSchema.nullable(),
    employee_id: IdSchema.nullable(),
    type: CheckpointTypeSchema,
    urgency: CheckpointUrgencySchema,
    tool_call_id: z.string().nullable(),
    tool_name: z.string().nullable(),
    args_preview: z.string().nullable(),
    title: z.string().min(1),
    context: z.string().min(1),
    options: nullableJsonColumnSchema(CheckpointOptionsSchema),
    preview: nullableJsonColumnSchema(CheckpointPreviewSchema),
    default_action: z.string().nullable(),
    status: CheckpointStatusSchema,
    answer: nullableJsonColumnSchema(CheckpointAnswerSchema),
    answered_by: z.string().nullable(),
    expires_at: IsoTimestampSchema.nullable(),
    answered_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
    // Not in §5.1's own listing; §5.0's blanket rule applies (status is
    // mutable).
    updated_at: IsoTimestampSchema,
  })
  .refine(
    (row) => row.default_action !== null || row.expires_at === null,
    NO_EXPIRY_WITHOUT_DEFAULT,
  )
  .superRefine(checkAnatomy);
export type Checkpoint = z.infer<typeof CheckpointSchema>;

/**
 * **`expires_at` is deliberately absent from this input shape** (M8).
 *
 * Every checkpoint deadline is now derived in exactly one place —
 * `src/main/checkpoints/expiry.ts`, from the urgency, the type, and
 * whether a safe default exists — and `insertCheckpoint` applies it. A
 * caller-supplied `expires_at` would be a second place deciding the same
 * thing, which is exactly the shape of the bug standing rule 6 was earned
 * by. All five pre-M8 call sites passed `expires_at: null`, so nothing
 * loses an expressible option.
 */
export const NewCheckpointInputSchema = z
  .object({
    project_id: IdSchema.nullable().default(null),
    task_id: IdSchema.nullable().default(null),
    employee_id: IdSchema.nullable().default(null),
    type: CheckpointTypeSchema,
    urgency: CheckpointUrgencySchema,
    tool_call_id: z.string().nullable().default(null),
    tool_name: z.string().nullable().default(null),
    args_preview: z.string().nullable().default(null),
    title: z.string().min(1),
    context: z.string().min(1),
    options: CheckpointOptionsSchema.nullable().default(null),
    preview: CheckpointPreviewSchema.nullable().default(null),
    default_action: z.string().nullable().default(null),
    status: CheckpointStatusSchema.default('pending'),
  })
  .superRefine(checkAnatomy);
export type NewCheckpointInput = z.input<typeof NewCheckpointInputSchema>;
export type ParsedNewCheckpointInput = z.output<typeof NewCheckpointInputSchema>;
