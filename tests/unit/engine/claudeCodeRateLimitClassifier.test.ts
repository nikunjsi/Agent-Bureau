import { describe, expect, it } from 'vitest';
import { classifyRateLimitMessage, streamJsonEventToAgentEvents, type StreamJsonState } from '../../../src/main/engine/claudeCodeStreamJson';

describe('classifyRateLimitMessage (§24.3, item 9)', () => {
  it('classifies clear per-day/quota-exhaustion language', () => {
    expect(classifyRateLimitMessage('You have exceeded your daily usage limit.')).toBe('per_day');
    expect(classifyRateLimitMessage('Daily limit reached — try again tomorrow.')).toBe('per_day');
    expect(classifyRateLimitMessage('Monthly quota exceeded for this account.')).toBe('per_day');
  });

  it('classifies clear per-minute/transient language', () => {
    expect(classifyRateLimitMessage('Rate limit exceeded, please retry.')).toBe('per_minute');
    expect(classifyRateLimitMessage('429 Too Many Requests')).toBe('per_minute');
    expect(classifyRateLimitMessage('The API is currently overloaded.')).toBe('per_minute');
  });

  it('defaults ambiguous rate/limit/quota language to per_minute (the recoverable direction — an explicit correction during this session\'s own review)', () => {
    // Contains "limit" but matches neither bucket's specific patterns.
    expect(classifyRateLimitMessage('A limit was reached for this request.')).toBe('per_minute');
    expect(classifyRateLimitMessage('quota check failed')).toBe('per_minute');
  });

  it('returns null for a genuine unrelated error — never misrouted through the rate-limit path', () => {
    expect(classifyRateLimitMessage('Permission denied: cannot write to this file.')).toBeNull();
    expect(classifyRateLimitMessage('Invalid model identifier.')).toBeNull();
    expect(classifyRateLimitMessage('')).toBeNull();
  });
});

describe('streamJsonEventToAgentEvents — result event rate-limit detection', () => {
  function freshState(): StreamJsonState {
    return { sessionId: null, turnIndex: 0, sawTextDeltaThisTurn: false };
  }

  it('emits rate_limited instead of turn.completed when is_error and the message is rate-limit-shaped', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      { type: 'result', is_error: true, result: 'Rate limit exceeded, please retry.' },
      state,
    );
    expect(events).toEqual([{ t: 'rate_limited', classification: 'per_minute', retryAfterMs: null }]);
    // Does not advance turnIndex — no real turn completed.
    expect(state.turnIndex).toBe(0);
  });

  it('emits a per_day rate_limited event for quota-exhaustion language', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      { type: 'result', is_error: true, result: "You've exceeded your daily usage limit." },
      state,
    );
    expect(events).toEqual([{ t: 'rate_limited', classification: 'per_day', retryAfterMs: null }]);
  });

  it('a non-rate-limit is_error result falls through to the existing turn.completed path, unchanged', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      { type: 'result', is_error: true, result: 'Invalid model identifier.', total_cost_usd: 0, usage: null },
      state,
    );
    expect(events).toEqual([{ t: 'turn.completed', turnIndex: 0, usage: null }]);
    expect(state.turnIndex).toBe(1); // the existing path's own increment, untouched
  });

  it('a genuinely successful result (is_error false/absent) is completely unaffected by this session\'s change', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      {
        type: 'result',
        total_cost_usd: 0.01,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model: 'claude-sonnet-5',
      },
      state,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.t).toBe('turn.completed');
  });
});
