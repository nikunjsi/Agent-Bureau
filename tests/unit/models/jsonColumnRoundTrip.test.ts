import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  jsonColumnSchema,
  nullableJsonColumnSchema,
  toJsonColumn,
} from '../../../src/shared/models/json';
import {
  CheckpointSchema,
  CheckpointOutputSchema,
  type Checkpoint,
} from '../../../src/shared/models/checkpoint';
import { TaskSchema } from '../../../src/shared/models/task';

/**
 * A row schema must be idempotent: parsing an already-parsed row has to be
 * a no-op. `dispatchIpcCall` re-parses every handler's success payload
 * against the method's own output schema (§17.2), and those output schemas
 * ARE these row schemas — so a schema that only accepts stored TEXT turns
 * every list handler over a JSON-bearing table into an `INTERNAL_ERROR`.
 *
 * That is not hypothetical: `checkpoints.listPending`, `checkpoints.get`
 * and `tasks.list` all did exactly that until M8 session 2. Pinned by name
 * here so the fix cannot be quietly undone by "simplifying" the union.
 */

const CHECKPOINT_ROW = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  project_id: null,
  task_id: null,
  employee_id: null,
  type: 'decision',
  urgency: 'soon',
  tool_call_id: null,
  tool_name: null,
  args_preview: null,
  title: 'A question',
  context: 'Some context.',
  // `reversible: true` because this row has a `default_action` (X-9): only an
  // option that can be undone may be the one a timeout applies.
  options: JSON.stringify([
    { id: 'a', label: 'A', consequence: 'Something happens.', reversible: true },
  ]),
  // NOT null. Audit M0–M2 #1: this fixture held `null` here, so the one
  // column where the idempotency property actually fails was the one value
  // the test named for idempotency never exercised.
  preview: toJsonColumn({ kind: 'diff', text: '- old\n+ new' }),
  default_action: 'a',
  status: 'pending',
  answer: null,
  answered_by: null,
  expires_at: null,
  answered_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('JSON column schemas are idempotent (§17.2 re-validates handler output)', () => {
  it('parses a stored TEXT column into structure, as it always did', () => {
    const parsed = jsonColumnSchema(z.array(z.string())).parse('["a","b"]');
    expect(parsed).toEqual(['a', 'b']);
  });

  it('accepts an already-parsed value unchanged', () => {
    expect(jsonColumnSchema(z.array(z.string())).parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(nullableJsonColumnSchema(z.array(z.string())).parse(null)).toBeNull();
  });

  it('still rejects a value that is neither stored JSON nor the right shape', () => {
    // The widening must not become "accepts anything": a TEXT column
    // holding valid JSON of the wrong shape is still an error.
    expect(() => jsonColumnSchema(z.array(z.string())).parse('[1,2]')).toThrow();
    expect(() => jsonColumnSchema(z.array(z.string())).parse([1, 2])).toThrow();
  });

  it('prefers the stored-TEXT reading when a value could be read either way', () => {
    // `checkpoints.preview` is `z.unknown()`, which accepts a raw string
    // too. The stored-TEXT branch must win, or a real column value would
    // arrive at a consumer unparsed.
    expect(nullableJsonColumnSchema(z.unknown()).parse('{"kind":"diff"}')).toEqual({
      kind: 'diff',
    });
  });

  it('re-parses a parsed Checkpoint — the defect checkpoints.listPending had', () => {
    const once = CheckpointSchema.parse(CHECKPOINT_ROW);
    expect(once.options).toHaveLength(1);
    const twice = CheckpointSchema.parse(once);
    expect(twice).toEqual(once);
  });

  it('re-parses a parsed Checkpoint with a structured preview', () => {
    const once = CheckpointSchema.parse(CHECKPOINT_ROW);
    expect(once.preview).toEqual({ kind: 'diff', text: '- old\n+ new' });
    expect(CheckpointOutputSchema.parse(once)).toEqual(once);
  });

  it('re-parses a parsed Task — the same latent defect in tasks.list', () => {
    const row = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      display_key: 'T-0001',
      project_id: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      phase_id: null,
      parent_task_id: null,
      title: 'A task',
      body: 'Do it.',
      acceptance_criteria: JSON.stringify(['it works']),
      required_skills: JSON.stringify(['code']),
      deliverable_type: null,
      assignee_employee_id: null,
      excluded_employees: JSON.stringify([]),
      status: 'queued',
      status_reason: null,
      priority: 50,
      attempts: 0,
      reassignments: 0,
      estimated_cost_usd_micros: null,
      spend_usd_micros: null,
      result_summary: null,
      started_at: null,
      finished_at: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const once = TaskSchema.parse(row);
    expect(once.acceptance_criteria).toEqual(['it works']);
    expect(TaskSchema.parse(once)).toEqual(once);
  });
});

/**
 * Audit M0–M2 finding #1 (BLOCKER). The M8 widening above made
 * parse-then-parse-again a no-op for every JSON column whose `inner`
 * rejects strings — which is all of them except one.
 *
 * `checkpoints.preview` is `z.unknown()`, so for that column BOTH arms of
 * the union match a string and the value alone cannot say which reading is
 * meant. An employee chooses the preview's contents via
 * `bureau_raise_checkpoint`; if what it sends happens to be valid JSON,
 * the row read yields a string and §17.2's re-parse of the same value
 * yields the parsed JSON — a different type from the one the database
 * holds. A preview of exactly `"null"` becomes `null`, and
 * `kinds.tsx`'s `preview !== null` then drops the preview block from the
 * checkpoint card: the surface on which a human approves or denies what an
 * agent wants to do.
 *
 * Ordering cannot fix this. With a permissive `inner`, TEXT-first is wrong
 * for the re-parse and inner-first is wrong for the row read. The two
 * readings are genuinely distinct operations, so they get two schemas:
 * `CheckpointSchema` parses a stored row, `CheckpointOutputSchema`
 * re-validates an already-parsed one and never transforms.
 */
describe('checkpoint previews survive the row → wire round trip unchanged (audit #1)', () => {
  // Every shape an agent can put in a preview that is ALSO valid JSON.
  // These are the ones that moved; 'hello' and structured values never did.
  const AGENT_PREVIEWS = ['null', 'true', 'false', '123', '{"a":1}', '[1,2]', '"quoted"', 'hello'];

  for (const preview of AGENT_PREVIEWS) {
    it(`preserves a preview of ${JSON.stringify(preview)} through both parses`, () => {
      const stored = { ...CHECKPOINT_ROW, preview: toJsonColumn(preview) };

      // Read 1 — the repository parses the stored TEXT column.
      const fromRow = CheckpointSchema.parse(stored);
      expect(fromRow.preview).toBe(preview);

      // Read 2 — §17.2's dispatcher re-validates the handler's payload.
      const onWire = CheckpointOutputSchema.parse(fromRow);
      expect(onWire.preview).toBe(preview);
      expect(typeof onWire.preview).toBe('string');
    });
  }

  it('keeps a preview of "null" visible to the card, rather than making it vanish', () => {
    const stored = { ...CHECKPOINT_ROW, preview: toJsonColumn('null') };
    const onWire = CheckpointOutputSchema.parse(CheckpointSchema.parse(stored));
    // kinds.tsx renders the preview block only when this is true.
    expect(onWire.preview !== null).toBe(true);
  });

  it('the wire schema does not widen: it never parses a raw stored column', () => {
    // This is the property that makes the split load-bearing rather than
    // cosmetic. If CheckpointOutputSchema also accepted TEXT it would be
    // the row schema again, under a second name.
    const parsed = CheckpointSchema.parse(CHECKPOINT_ROW);
    expect(() => CheckpointOutputSchema.parse(CHECKPOINT_ROW)).toThrow();
    expect(() => CheckpointOutputSchema.parse(parsed)).not.toThrow();
  });

  it('re-validating the wire shape is a fixed point', () => {
    const onWire = CheckpointOutputSchema.parse(CheckpointSchema.parse(CHECKPOINT_ROW));
    expect(CheckpointOutputSchema.parse(onWire)).toEqual(onWire);
  });
});

/**
 * The row shape and the wire shape are two schemas for one table, so the
 * failure mode the split introduces is drift: a §9.2 rule tightened on one
 * and not the other would let a checkpoint the repository refuses to read
 * still reach the card, or the reverse. They share their field map and
 * both refinements in `checkpoint.ts`; these assert that sharing actually
 * holds, from the outside.
 */
describe('the row and wire checkpoint shapes agree on every §9.2 rule (audit #1)', () => {
  const parsed = CheckpointSchema.parse(CHECKPOINT_ROW);

  // Each case is a §9.2 anatomy violation, expressed on the PARSED shape
  // so both schemas can be handed the identical value.
  const VIOLATIONS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [
      'two recommended options',
      {
        // Each case violates exactly the rule it is named for, so the
        // default option stays reversible throughout (X-9).
        options: [
          { id: 'a', label: 'A', consequence: 'x', recommended: true, reversible: true },
          { id: 'b', label: 'B', consequence: 'y', recommended: true },
        ],
        default_action: 'a',
      },
    ],
    [
      'duplicate option ids',
      {
        options: [
          { id: 'a', label: 'A', consequence: 'x', reversible: true },
          { id: 'a', label: 'B', consequence: 'y' },
        ],
        default_action: 'a',
      },
    ],
    ['a default_action naming no option', { default_action: 'nope' }],
    [
      'an option with an empty consequence',
      { options: [{ id: 'a', label: 'A', consequence: '', reversible: true }] },
    ],
    ['a non-information checkpoint with no options', { options: null, default_action: null }],
    [
      'a permission checkpoint missing tool_call_id',
      { type: 'permission', tool_call_id: null, tool_name: 'Bash' },
    ],
    [
      'an expiry with no safe default',
      { default_action: null, expires_at: '2026-01-01T00:00:00.000Z' },
    ],
  ];

  for (const [name, patch] of VIOLATIONS) {
    it(`both shapes reject ${name}`, () => {
      const candidate = { ...parsed, ...patch };
      expect(CheckpointSchema.safeParse(candidate).success).toBe(false);
      expect(CheckpointOutputSchema.safeParse(candidate).success).toBe(false);
    });
  }

  it('both shapes accept the same valid checkpoint', () => {
    expect(CheckpointSchema.safeParse(parsed).success).toBe(true);
    expect(CheckpointOutputSchema.safeParse(parsed).success).toBe(true);
  });
});

/**
 * `Checkpoint` is inferred from the row shape and is the type the whole
 * app passes around, renderer included — so if the wire shape ever infers
 * something different, the renderer would be typed against a value it does
 * not receive. This is a compile-time assertion: it fails `npm run
 * typecheck`, not the runner.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _wireMatchesRow: Exact<Checkpoint, z.infer<typeof CheckpointOutputSchema>> = true;
void _wireMatchesRow;
