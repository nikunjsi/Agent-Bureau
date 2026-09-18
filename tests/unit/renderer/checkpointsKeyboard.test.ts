import { describe, expect, it } from 'vitest';
import { resolveCheckpointKey } from '../../../src/renderer/src/components/checkpoints/keyboard';
import { sortForReview } from '../../../src/renderer/src/components/checkpoints/CheckpointsTab';
import type { Checkpoint } from '../../../src/shared/models/checkpoint';

/**
 * X-16 / §14.4: "pending checkpoints, `blocking` first … keyboard-driven —
 * `J`/`K` to move, `1`–`9` to choose an option, `Enter` to confirm", and
 * §9.1's `permission` card "answered with a single keypress".
 *
 * The rules are pure, so each one is stated here on its own. The keyboard
 * genuinely reaching the Core is `tests/e2e/checkpointsKeyboard.spec.ts`,
 * against the packaged app — a rule that is right and unwired is still a
 * view nobody can drive (standing rule 1).
 */
function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    project_id: null,
    task_id: null,
    employee_id: null,
    type: 'decision',
    urgency: 'blocking',
    tool_call_id: null,
    tool_name: null,
    args_preview: null,
    title: 'Skip the unreadable rows?',
    context: 'Three rows cannot be parsed.',
    options: [
      { id: 'skip', label: 'Skip them', consequence: 'The import finishes without them.' },
      { id: 'stop', label: 'Stop', consequence: 'Nothing is imported.', reversible: true },
    ],
    preview: null,
    default_action: 'stop',
    status: 'pending',
    answer: null,
    answered_by: null,
    expires_at: null,
    answered_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Checkpoint;
}

const state = (overrides: Partial<Parameters<typeof resolveCheckpointKey>[1]> = {}) => ({
  checkpoint: checkpoint(),
  cursor: 0,
  count: 3,
  markedOptionId: null,
  ...overrides,
});

describe('§14.4 checkpoint keyboard rules (X-16)', () => {
  it('J moves down and K moves up', () => {
    expect(resolveCheckpointKey({ key: 'j' }, state({ cursor: 0 }))).toEqual({
      kind: 'move',
      to: 1,
    });
    expect(resolveCheckpointKey({ key: 'K' }, state({ cursor: 2 }))).toEqual({
      kind: 'move',
      to: 1,
    });
  });

  it('stops at both ends rather than wrapping', () => {
    // Wrapping would move the cursor furthest at the moment the user is
    // least expecting it — the last item in a batch is where they stop.
    expect(resolveCheckpointKey({ key: 'j' }, state({ cursor: 2 }))).toEqual({
      kind: 'move',
      to: 2,
    });
    expect(resolveCheckpointKey({ key: 'k' }, state({ cursor: 0 }))).toEqual({
      kind: 'move',
      to: 0,
    });
  });

  it('a number marks an option and Enter answers with it — two keys, not one', () => {
    expect(resolveCheckpointKey({ key: '1' }, state())).toEqual({ kind: 'mark', optionId: 'skip' });
    expect(resolveCheckpointKey({ key: 'Enter' }, state({ markedOptionId: 'skip' }))).toEqual({
      kind: 'answer',
      optionId: 'skip',
    });
  });

  it('Enter with nothing marked does nothing', () => {
    expect(resolveCheckpointKey({ key: 'Enter' }, state())).toBeNull();
  });

  it('a number past the last option does nothing', () => {
    expect(resolveCheckpointKey({ key: '9' }, state())).toBeNull();
  });

  it('answers a permission checkpoint on a single keypress (§9.1)', () => {
    const permission = checkpoint({
      type: 'permission',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      options: [
        { id: 'allow_once', label: 'Allow once', consequence: 'It runs.', reversible: false },
        { id: 'deny', label: 'Deny', consequence: 'It does not run.', reversible: true },
      ],
      default_action: 'deny',
    });
    expect(resolveCheckpointKey({ key: '1' }, state({ checkpoint: permission }))).toEqual({
      kind: 'permission',
      allow: true,
    });
    expect(resolveCheckpointKey({ key: '2' }, state({ checkpoint: permission }))).toEqual({
      kind: 'permission',
      allow: false,
    });
  });

  it('reads the verdict from the option id, not its position', () => {
    // A card that ever renders deny first must not turn a "deny" keypress
    // into an allow. The ids are the Core's; the order is presentation.
    const reordered = checkpoint({
      type: 'permission',
      tool_call_id: 'call-1',
      tool_name: 'Bash',
      options: [
        { id: 'deny', label: 'Deny', consequence: 'It does not run.', reversible: true },
        { id: 'allow_once', label: 'Allow once', consequence: 'It runs.', reversible: false },
      ],
      default_action: 'deny',
    });
    expect(resolveCheckpointKey({ key: '1' }, state({ checkpoint: reordered }))).toEqual({
      kind: 'permission',
      allow: false,
    });
  });

  it('ignores a keystroke carrying a modifier', () => {
    expect(resolveCheckpointKey({ key: '1', ctrlKey: true }, state())).toBeNull();
    expect(resolveCheckpointKey({ key: 'j', metaKey: true }, state())).toBeNull();
  });
});

describe('§14.4 ordering: blocking first (X-16)', () => {
  it('puts blocking above soon above whenever, oldest first inside a band', () => {
    const rows = [
      checkpoint({ id: 'a', urgency: 'whenever', created_at: '2026-01-01T00:00:00.000Z' }),
      checkpoint({ id: 'b', urgency: 'blocking', created_at: '2026-01-03T00:00:00.000Z' }),
      checkpoint({ id: 'c', urgency: 'soon', created_at: '2026-01-02T00:00:00.000Z' }),
      checkpoint({ id: 'd', urgency: 'blocking', created_at: '2026-01-02T00:00:00.000Z' }),
    ];

    expect(sortForReview(rows).map((row) => row.id)).toEqual(['d', 'b', 'c', 'a']);
  });

  it('does not mutate what it was given', () => {
    const rows = [checkpoint({ id: 'a', urgency: 'soon' }), checkpoint({ id: 'b' })];
    sortForReview(rows);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
  });
});
