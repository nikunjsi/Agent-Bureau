import { describe, expect, it } from 'vitest';
import { CHAT_PAYLOAD_SCHEMAS, parseChatPayload } from '../../../src/shared/models/chatPayloads';
import { ConversationMessageKindSchema } from '../../../src/shared/models/enums';

/**
 * §14.2's eight payload shapes.
 *
 * The idempotency case follows `tests/unit/models/jsonColumnRoundTrip.test.ts`
 * and exists for the same reason M8 session 2 found: `dispatchIpcCall`
 * re-validates a handler's output against the same schema that read the
 * row, so **parse-then-parse must be a no-op**. That was false for
 * `checkpoints.listPending` for a whole milestone, and every one of these
 * payloads travels the same path.
 */
describe('chat payloads (§14.2)', () => {
  it('has a schema for every kind, and only for the eight kinds', () => {
    // Not a restatement of the list: it reads the enum that the database
    // column and §5.1 both use, so a ninth kind added anywhere fails here.
    expect(Object.keys(CHAT_PAYLOAD_SCHEMAS).sort()).toEqual(
      [...ConversationMessageKindSchema.options].sort(),
    );
  });

  it('parsing an already-parsed payload returns the same thing (§17.2 output re-validation)', () => {
    const cases: {
      kind: 'brief' | 'plan' | 'report' | 'summary' | 'error' | 'question';
      input: unknown;
    }[] = [
      {
        kind: 'brief',
        input: {
          title: 'A website',
          goal: 'Sell things',
          scope: ['catalogue'],
          assumptions: ['payments are out of scope'],
        },
      },
      {
        kind: 'plan',
        input: {
          phases: [{ name: 'Phase one', tasks: [{ title: 'Set up' }] }],
          estimatedCostMicros: 1_500_000,
        },
      },
      { kind: 'report', input: { whatHappened: 'Built it', costMicros: null } },
      { kind: 'summary', input: { phaseName: 'Phase one' } },
      { kind: 'error', input: { code: 'engine_unreachable', explanation: 'The engine stopped.' } },
      { kind: 'question', input: { options: [{ id: 'a', label: 'Yes' }] } },
    ];

    for (const { kind, input } of cases) {
      const first = parseChatPayload(kind, input);
      expect(first.success, `${kind} failed to parse at all`).toBe(true);
      if (!first.success) continue;
      const second = parseChatPayload(kind, first.data);
      expect(second.success, `${kind} did not survive a second parse`).toBe(true);
      if (!second.success) continue;
      expect(second.data).toEqual(first.data);
    }
  });

  it('a report with no cost stays null rather than defaulting to zero', () => {
    // §11.5.1's trap lives or dies on this distinction: `null` is "the
    // engine does not report usage", and a schema that coerced it to 0
    // would make `$0.00` the honest rendering of a number nobody knows.
    const parsed = parseChatPayload('report', { whatHappened: 'Done' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.costMicros).toBeNull();
  });

  it('rejects an option list on a question that carries no options', () => {
    expect(parseChatPayload('question', { options: [] }).success).toBe(false);
  });

  it('rejects a remedy naming a UI destination rather than a domain action', () => {
    // The enum is deliberately domain-shaped. This asserts the boundary
    // the amendment asked for: the Core cannot express "open the settings
    // screen", only "the budget needs raising".
    expect(
      parseChatPayload('error', {
        code: 'over_budget',
        explanation: 'This project has spent its budget.',
        remedy: { kind: 'open_settings_tab' },
      }).success,
    ).toBe(false);
    expect(
      parseChatPayload('error', {
        code: 'over_budget',
        explanation: 'This project has spent its budget.',
        remedy: { kind: 'raise_budget' },
      }).success,
    ).toBe(true);
  });

  it('text and checkpoint carry no payload at all', () => {
    expect(parseChatPayload('text', null).success).toBe(true);
    expect(parseChatPayload('text', { anything: true }).success).toBe(false);
    // A checkpoint card renders from the checkpoints slice, not from a
    // copy in the message — §9.4's "one piece of state".
    expect(parseChatPayload('checkpoint', { options: [] }).success).toBe(false);
  });
});
