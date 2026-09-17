import { describe, expect, it } from 'vitest';
import { NewCheckpointInputSchema } from '../../../src/shared/models/checkpoint';

/**
 * §9.2's "Rules (MUST)", one test per rule, each rejected on its own.
 *
 * These are unit tests of the schema, and on their own they prove nothing
 * about the product — standing rule 2 is explicit that a guard nobody
 * calls is not a guard. What makes these count is
 * `tests/integration/checkpoints/validationOnRealPath.test.ts`, which
 * drives the same rules through `bureau_raise_checkpoint` over the real
 * control-channel HTTP endpoint. This file exists to say precisely WHICH
 * rule rejected WHAT, which a single end-to-end test cannot do legibly.
 */

const valid = {
  type: 'decision' as const,
  urgency: 'soon' as const,
  title: 'Should we optimise for read speed?',
  context: 'The report screen is slow, and the fix trades some duplicated data for speed.',
  options: [
    {
      id: 'optimise',
      label: 'Optimise for read speed',
      consequence: 'Reports load quickly; some data is stored twice and can drift.',
    },
    {
      id: 'leave',
      label: 'Leave it as it is',
      consequence: 'Nothing changes; reports stay slow.',
    },
  ],
};

describe('§9.2 checkpoint anatomy — the rules a schema can actually decide', () => {
  it('accepts a well-formed checkpoint', () => {
    expect(() => NewCheckpointInputSchema.parse(valid)).not.toThrow();
  });

  // CLAUDE.md invariant #8. Before M8 `consequence` was a bare
  // `z.string()`, which accepts '' — so "rejected by validation" was
  // already false for the case the rule most obviously means.
  it('rejects an option whose consequence is missing', () => {
    const options = [{ id: 'a', label: 'Option A' }, valid.options[1]];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow();
  });

  it('rejects an option whose consequence is the empty string', () => {
    const options = [{ ...valid.options[0], consequence: '' }, valid.options[1]];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow(/consequence/i);
  });

  it('rejects an option whose consequence is only whitespace (X-8)', () => {
    // This test used to assert the opposite, on the reasoning that `.min(1)`
    // counts characters and trimming would rewrite the author's value. But
    // invariant #8 is about what the option TELLS the user, and '   ' tells
    // them nothing — a blank consequence passing validation made the
    // invariant false for the one input most likely to produce it (a
    // template that filled in nothing). The check reads the trimmed length;
    // the stored value is still exactly what the author wrote.
    const options = [{ ...valid.options[0], consequence: '   ' }, valid.options[1]];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow(/consequence/i);
  });

  it('keeps the author’s own spacing on a real consequence', () => {
    const options = [
      { ...valid.options[0], consequence: '  Reports load instantly.  ' },
      valid.options[1],
    ];
    const parsed = NewCheckpointInputSchema.parse({ ...valid, options });
    expect(parsed.options?.[0]?.consequence).toBe('  Reports load instantly.  ');
  });

  it('rejects two recommended options', () => {
    const options = valid.options.map((option) => ({ ...option, recommended: true }));
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow(/recommended/i);
  });

  it('accepts exactly one recommended option', () => {
    const options = [{ ...valid.options[0], recommended: true }, valid.options[1]];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).not.toThrow();
  });

  it('rejects duplicate option ids', () => {
    const options = [valid.options[0], { ...valid.options[1], id: 'optimise' }];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow(/unique/i);
  });

  // A default naming nothing would turn "resolves to the safe default"
  // into "resolves to nothing", an hour later, silently.
  it('rejects a default_action that names no option', () => {
    expect(() => NewCheckpointInputSchema.parse({ ...valid, default_action: 'nope' })).toThrow(
      /names none of this checkpoint/i,
    );
  });

  it('accepts a default_action that names a real option marked reversible', () => {
    // 'leave' gained `reversible: true` with X-9: a default is what a
    // timeout applies unattended, so it must be the option that can be
    // undone (invariant #7).
    const options = [valid.options[0], { ...valid.options[1], reversible: true }];
    expect(() =>
      NewCheckpointInputSchema.parse({ ...valid, options, default_action: 'leave' }),
    ).not.toThrow();
  });

  // --- X-9 / §9.2: reversibility is stated, not assumed ------------------
  //
  // §9.2 says `default_action` "is always the safe, reversible choice" and is
  // "nullable only when no reversible option exists". Neither was checkable:
  // options carried no reversibility at all, so a checkpoint could time out
  // into an irreversible option, or hold a reversible one and never expire.

  it('rejects a default_action naming an option that is not marked reversible', () => {
    expect(() => NewCheckpointInputSchema.parse({ ...valid, default_action: 'leave' })).toThrow(
      /reversible/i,
    );
  });

  it('rejects a default_action naming an option marked irreversible', () => {
    const options = [valid.options[0], { ...valid.options[1], reversible: false }];
    expect(() =>
      NewCheckpointInputSchema.parse({ ...valid, options, default_action: 'leave' }),
    ).toThrow(/reversible/i);
  });

  it('rejects a null default_action when a reversible option exists', () => {
    const options = [valid.options[0], { ...valid.options[1], reversible: true }];
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).toThrow(
      /default_action.*leave|leave.*default/i,
    );
  });

  it('accepts a null default_action when no option is reversible', () => {
    // §9.5's own case: every option is irreversible, so the checkpoint has
    // no safe default, never expires, and the task stays parked.
    const options = valid.options.map((option) => ({ ...option, reversible: false }));
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options })).not.toThrow();
  });

  it('an option that states nothing is not treated as reversible', () => {
    // Fail closed: silence is not a promise that something can be undone.
    // It only ever costs an expiry the author did not ask for.
    expect(() => NewCheckpointInputSchema.parse(valid)).not.toThrow();
  });

  it('rejects a decision with no options — §9.2 allows that only for information', () => {
    expect(() => NewCheckpointInputSchema.parse({ ...valid, options: null })).toThrow(
      /must offer options/i,
    );
  });

  it('accepts an information checkpoint with no options', () => {
    expect(() =>
      NewCheckpointInputSchema.parse({
        type: 'information',
        urgency: 'whenever',
        title: 'Free quota exhausted',
        context: 'This engine has used up its free allowance for now.',
        options: null,
      }),
    ).not.toThrow();
  });

  it('rejects a permission checkpoint with no tool_call_id', () => {
    expect(() =>
      NewCheckpointInputSchema.parse({
        ...valid,
        type: 'permission',
        urgency: 'blocking',
        tool_name: 'Bash',
      }),
    ).toThrow(/tool_call_id/);
  });

  it('accepts a permission checkpoint carrying its tool identity', () => {
    expect(() =>
      NewCheckpointInputSchema.parse({
        ...valid,
        type: 'permission',
        urgency: 'blocking',
        tool_call_id: 'call-1',
        tool_name: 'Bash',
      }),
    ).not.toThrow();
  });

  it('has no expires_at in its input shape at all — the deadline is derived, never supplied', () => {
    // Zod objects strip unknown keys rather than rejecting them, so the
    // assertion is that the value does not survive: a caller who thinks it
    // is setting an expiry here is not.
    const parsed = NewCheckpointInputSchema.parse({
      ...valid,
      expires_at: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed).not.toHaveProperty('expires_at');
  });
});
