import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonColumnSchema, nullableJsonColumnSchema } from '../../../src/shared/models/json';
import { CheckpointSchema } from '../../../src/shared/models/checkpoint';
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
  options: JSON.stringify([{ id: 'a', label: 'A', consequence: 'Something happens.' }]),
  preview: null,
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
