import type { AgentEvent } from '../../shared/engine/events';

/** Carried across one adapter's lifetime — a stream-json event only ever gives fragments; state ties them together into complete AgentEvents. */
export interface StreamJsonState {
  sessionId: string | null;
  turnIndex: number;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  is_error?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function contentBlocks(message: unknown): ContentBlock[] {
  const record = asRecord(message);
  const content = record?.['content'];
  return Array.isArray(content) ? (content as ContentBlock[]) : [];
}

/** Renders whatever a tool_result's `content` field holds into a short, single-line excerpt — it can be a string or a content-block array, per the docs. */
function excerptOf(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 200);
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join(' ')
      .trim();
    return text.slice(0, 200);
  }
  return '';
}

/**
 * §7.6 trap #1's other half: turns one parsed stream-json line into zero or
 * more normalised AgentEvents. Deliberately defensive — an unrecognised
 * `type`/`subtype`/content-block shape is skipped, never thrown, since a
 * drifted or undocumented field here should degrade to "fewer events",
 * not crash the whole adapter (§7.8 test 10 — version drift — is the
 * structured mechanism for the "this looks different than expected" case;
 * this function's job is just to not fall over when it happens).
 *
 * Confirmed shapes only (M3 session 2 research): top-level `type` ∈
 * `system|assistant|user|result|stream_event`; `tool_use`/`tool_result`
 * are content blocks *inside* `assistant`/`user` messages, not top-level
 * types. `stream_event` wraps a partial SDK event; only `text_delta` was
 * directly confirmed — `thinking_delta` is handled defensively (the
 * obvious sibling, given Claude's known extended-thinking streaming) but
 * not independently confirmed against the docs this session.
 */
export function streamJsonEventToAgentEvents(raw: unknown, state: StreamJsonState): AgentEvent[] {
  const record = asRecord(raw);
  if (!record) return [];
  const type = asString(record['type']);

  switch (type) {
    case 'system': {
      if (asString(record['subtype']) !== 'init') return [];
      const sessionId = asString(record['session_id']);
      if (sessionId) state.sessionId = sessionId;
      const model = asString(record['model']);
      return [
        { t: 'session.started', sessionId: state.sessionId, engineVersion: '', model },
        { t: 'turn.started', turnIndex: state.turnIndex },
      ];
    }

    case 'stream_event': {
      const event = asRecord(record['event']);
      const delta = asRecord(event?.['delta']);
      const deltaType = asString(delta?.['type']);
      if (deltaType === 'text_delta') {
        const text = asString(delta?.['text']);
        return text !== null ? [{ t: 'text.delta', text }] : [];
      }
      if (deltaType === 'thinking_delta') {
        const text = asString(delta?.['thinking']) ?? asString(delta?.['text']);
        return text !== null ? [{ t: 'thinking.delta', text }] : [];
      }
      return [];
    }

    case 'assistant': {
      const events: AgentEvent[] = [];
      for (const block of contentBlocks(record['message'])) {
        if (block.type === 'tool_use') {
          const callId = asString(block.id);
          const tool = asString(block.name);
          if (callId && tool) {
            events.push({
              t: 'tool.requested',
              callId,
              tool,
              rawTool: tool,
              args: block.input ?? {},
              preview: JSON.stringify(block.input ?? {}).slice(0, 200),
            });
          }
        }
      }
      return events;
    }

    case 'user': {
      const events: AgentEvent[] = [];
      for (const block of contentBlocks(record['message'])) {
        if (block.type === 'tool_result') {
          const callId = asString(block.tool_use_id);
          if (callId) {
            events.push({
              t: 'tool.completed',
              callId,
              ok: block.is_error !== true,
              excerpt: excerptOf(block.content),
              ms: 0, // not reported at this layer
            });
          }
        }
      }
      return events;
    }

    case 'result': {
      const totalCostUsd = record['total_cost_usd'];
      const usageRecord = asRecord(record['usage']);
      const costUsdMicros = typeof totalCostUsd === 'number' ? Math.round(totalCostUsd * 1_000_000) : null;
      const event: AgentEvent = {
        t: 'turn.completed',
        turnIndex: state.turnIndex,
        usage: usageRecord
          ? {
              tokensIn: typeof usageRecord['input_tokens'] === 'number' ? usageRecord['input_tokens'] : 0,
              tokensOut: typeof usageRecord['output_tokens'] === 'number' ? usageRecord['output_tokens'] : 0,
              tokensCacheRead:
                typeof usageRecord['cache_read_input_tokens'] === 'number' ? usageRecord['cache_read_input_tokens'] : 0,
              tokensCacheWrite:
                typeof usageRecord['cache_creation_input_tokens'] === 'number'
                  ? usageRecord['cache_creation_input_tokens']
                  : 0,
              model: asString(record['model']),
              costUsdMicros,
            }
          : null,
      };
      state.turnIndex += 1;
      return [event];
    }

    default:
      return [];
  }
}
