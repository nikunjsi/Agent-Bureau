import { describe, expect, it } from 'vitest';
import { streamJsonEventToAgentEvents, type StreamJsonState } from '../../../src/main/engine/claudeCodeStreamJson';

function freshState(): StreamJsonState {
  return { sessionId: null, turnIndex: 0, sawTextDeltaThisTurn: false };
}

describe('streamJsonEventToAgentEvents (§7.6, confirmed shapes only)', () => {
  it('system/init emits session.started + turn.started, capturing the session id', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      { type: 'system', subtype: 'init', session_id: 's-123', model: 'claude-sonnet-5' },
      state,
    );
    expect(events).toEqual([
      { t: 'session.started', sessionId: 's-123', engineVersion: '', model: 'claude-sonnet-5' },
      { t: 'turn.started', turnIndex: 0 },
    ]);
    expect(state.sessionId).toBe('s-123');
  });

  it('a non-init system event produces nothing', () => {
    expect(streamJsonEventToAgentEvents({ type: 'system', subtype: 'api_retry' }, freshState())).toEqual([]);
  });

  it('stream_event text_delta maps to text.delta', () => {
    const events = streamJsonEventToAgentEvents(
      { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'hello' } } },
      freshState(),
    );
    expect(events).toEqual([{ t: 'text.delta', text: 'hello' }]);
  });

  it('an unrecognised stream_event delta type is skipped, not thrown', () => {
    expect(() =>
      streamJsonEventToAgentEvents(
        { type: 'stream_event', event: { delta: { type: 'some_future_delta_type', blob: 42 } } },
        freshState(),
      ),
    ).not.toThrow();
    expect(
      streamJsonEventToAgentEvents(
        { type: 'stream_event', event: { delta: { type: 'some_future_delta_type' } } },
        freshState(),
      ),
    ).toEqual([]);
  });

  it('assistant message tool_use content block maps to tool.requested', () => {
    const state = freshState();
    state.sawTextDeltaThisTurn = true; // the normal case: text already streamed via stream_event
    const events = streamJsonEventToAgentEvents(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking about it' }, // not re-emitted — already streamed via stream_event
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'echo hi' } },
          ],
        },
      },
      state,
    );
    expect(events).toEqual([
      {
        t: 'tool.requested',
        callId: 'toolu_01',
        tool: 'Bash',
        rawTool: 'Bash',
        args: { command: 'echo hi' },
        preview: JSON.stringify({ command: 'echo hi' }),
      },
    ]);
  });

  it('a real, confirmed gap this session found: an assistant message with NO prior stream_event delta this turn falls back to emitting its own text block — an immediate error response (no partial streaming at all) was observed to take exactly this shape', () => {
    // freshState() has sawTextDeltaThisTurn: false — the exact condition
    // that silently dropped this text before the fix.
    const events = streamJsonEventToAgentEvents(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      },
      freshState(),
    );
    expect(events).toEqual([{ t: 'text.delta', text: 'Not logged in · Please run /login' }]);
  });

  it('the fallback text block and a tool_use in the same no-deltas-seen message both come through', () => {
    const events = streamJsonEventToAgentEvents(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'no streaming happened this turn' },
            { type: 'tool_use', id: 'toolu_02', name: 'Read', input: { path: 'x.txt' } },
          ],
        },
      },
      freshState(),
    );
    expect(events).toEqual([
      { t: 'text.delta', text: 'no streaming happened this turn' },
      {
        t: 'tool.requested',
        callId: 'toolu_02',
        tool: 'Read',
        rawTool: 'Read',
        args: { path: 'x.txt' },
        preview: JSON.stringify({ path: 'x.txt' }),
      },
    ]);
  });

  it('user message tool_result content block maps to tool.completed', () => {
    const events = streamJsonEventToAgentEvents(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: 'hi\n', is_error: false }],
        },
      },
      freshState(),
    );
    expect(events).toEqual([{ t: 'tool.completed', callId: 'toolu_01', ok: true, excerpt: 'hi\n', ms: 0 }]);
  });

  it('a tool_result with is_error:true maps to ok:false', () => {
    const events = streamJsonEventToAgentEvents(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'boom', is_error: true }] },
      },
      freshState(),
    );
    expect(events).toEqual([{ t: 'tool.completed', callId: 'toolu_02', ok: false, excerpt: 'boom', ms: 0 }]);
  });

  it('result maps to turn.completed with usage, and advances turnIndex', () => {
    const state = freshState();
    const events = streamJsonEventToAgentEvents(
      {
        type: 'result',
        model: 'claude-sonnet-5',
        total_cost_usd: 0.001234,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      state,
    );
    expect(events).toEqual([
      {
        t: 'turn.completed',
        turnIndex: 0,
        usage: {
          tokensIn: 10,
          tokensOut: 5,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          model: 'claude-sonnet-5',
          costUsdMicros: 1234,
        },
      },
    ]);
    expect(state.turnIndex).toBe(1);
  });

  it('result with no usage reported still emits turn.completed, with usage:null', () => {
    const events = streamJsonEventToAgentEvents({ type: 'result' }, freshState());
    expect(events).toEqual([{ t: 'turn.completed', turnIndex: 0, usage: null }]);
  });

  it('a completely unrecognised top-level type produces nothing, never throws', () => {
    expect(() => streamJsonEventToAgentEvents({ type: 'some_future_type' }, freshState())).not.toThrow();
    expect(streamJsonEventToAgentEvents({ type: 'some_future_type' }, freshState())).toEqual([]);
  });

  it('malformed / non-object input produces nothing, never throws', () => {
    expect(streamJsonEventToAgentEvents(null, freshState())).toEqual([]);
    expect(streamJsonEventToAgentEvents('a string', freshState())).toEqual([]);
    expect(streamJsonEventToAgentEvents(42, freshState())).toEqual([]);
    expect(streamJsonEventToAgentEvents(undefined, freshState())).toEqual([]);
  });
});
