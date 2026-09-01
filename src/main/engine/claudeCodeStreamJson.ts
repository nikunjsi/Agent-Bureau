import type { AgentEvent } from '../../shared/engine/events';

/**
 * §24.3/item 9 — pattern-based, against the CLI's own `result` string on an
 * `is_error: true` terminal message. `is_error`/`result` is the SAME
 * top-level shape `modelTiers.ts`'s `validateModelId` already confirmed
 * against real `--output-format json` output this session (single-shot and
 * streaming share one JSON schema family in this CLI) — this extends that
 * confirmed convention to a NEW purpose (rate-limit classification) rather
 * than inventing a new detection channel.
 *
 * **Flagged explicitly, not silently assumed accurate**: unlike
 * `validateModelId`'s shape (empirically captured this session), no real
 * 429/quota response was captured this session — deliberately exhausting a
 * real quota to capture one was out of scope. These patterns are inferred
 * from provider documentation and common CLI error phrasing, not evidence;
 * correct the specific patterns the first time a real one is captured,
 * rather than trusting this list indefinitely.
 */
export type RateLimitClassification = 'per_minute' | 'per_day';

const PER_DAY_PATTERNS: readonly RegExp[] = [
  /usage limit/i,
  /daily limit/i,
  /quota exceeded/i,
  /exceeded your (daily|usage) limit/i,
  /out of quota/i,
  /monthly limit/i,
  /weekly limit/i,
];

const PER_MINUTE_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /too many requests/i,
  /\b429\b/,
  /please retry/i,
  /overloaded/i,
  /try again in/i,
];

/** Matches SOME rate/quota-shaped language but not conclusively either
 * bucket above. */
const AMBIGUOUS_RATE_LIMIT_HINTS: readonly RegExp[] = [/rate/i, /\blimit\b/i, /quota/i];

/**
 * `null` — not rate-limit-shaped at all, a genuine other error (a bad tool
 * permission, a network failure, ...); the caller leaves it alone rather
 * than misrouting an unrelated failure through the rate-limit path.
 *
 * An ambiguous match (matches neither bucket's own specific patterns, but
 * DOES contain generic rate/limit/quota language) defaults to
 * `'per_minute'`, deliberately, per a correction during this session's own
 * review: the two misclassification directions have asymmetric cost.
 * Calling a real per-day exhaustion 'per_minute' costs exactly one wasted
 * backoff cycle (up to `engines.rateLimitMaxWaitMinutes`), after which the
 * existing max-wait escalation correctly reclassifies it as exhausted
 * anyway — self-correcting. The reverse — calling a transient blip
 * 'per_day' — parks a working employee for up to an hour with nothing to
 * correct it early. Pick the direction that recovers on its own.
 */
export function classifyRateLimitMessage(message: string): RateLimitClassification | null {
  if (PER_DAY_PATTERNS.some((p) => p.test(message))) return 'per_day';
  if (PER_MINUTE_PATTERNS.some((p) => p.test(message))) return 'per_minute';
  if (AMBIGUOUS_RATE_LIMIT_HINTS.some((p) => p.test(message))) return 'per_minute';
  return null;
}

/** Carried across one adapter's lifetime — a stream-json event only ever gives fragments; state ties them together into complete AgentEvents. */
export interface StreamJsonState {
  sessionId: string | null;
  turnIndex: number;
  /**
   * Whether any `stream_event` text_delta has fired for the *current*
   * turn. `assistant` messages don't re-emit their text as a fallback
   * text.delta when this is true (redundant with what already streamed) —
   * but when it's false, the full message's own text block is the *only*
   * place that text ever appears. Found for real, not hypothetically: an
   * immediate auth-error response emits `system/init` → `assistant` (full,
   * with the error text) → `result`, with no `stream_event` at all in
   * between — the naive "text always streams incrementally first"
   * assumption silently dropped that text entirely before this existed.
   */
  sawTextDeltaThisTurn: boolean;
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
      state.sawTextDeltaThisTurn = false;
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
        if (text === null) return [];
        state.sawTextDeltaThisTurn = true;
        return [{ t: 'text.delta', text }];
      }
      if (deltaType === 'thinking_delta') {
        const text = asString(delta?.['thinking']) ?? asString(delta?.['text']);
        return text !== null ? [{ t: 'thinking.delta', text }] : [];
      }
      return [];
    }

    case 'assistant': {
      const events: AgentEvent[] = [];
      if (!state.sawTextDeltaThisTurn) {
        // No incremental streaming happened this turn (an immediate error
        // response is the confirmed real case; there may be others) — the
        // full message's own text blocks are the only place this text
        // exists, so surface them now rather than silently dropping them.
        for (const block of contentBlocks(record['message'])) {
          if (block.type === 'text') {
            const text = asString(block.text);
            if (text) events.push({ t: 'text.delta', text });
          }
        }
      }
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
      // §24.3: detect a rate-limit/quota response BEFORE treating this as a
      // normal completed turn — `is_error`/`result` is the confirmed shape
      // (see classifyRateLimitMessage's own header comment). A non-rate-
      // limit error (`is_error: true` but no rate/quota language matched)
      // falls through to the unchanged path below, exactly as before this
      // session — is_error is not otherwise handled at this layer, a
      // separate, pre-existing gap outside item 9's own scope.
      if (record['is_error'] === true) {
        const message = asString(record['result']) ?? '';
        const classification = classifyRateLimitMessage(message);
        if (classification) {
          // Does not increment state.turnIndex — no turn genuinely
          // completed, so the next real attempt (a retry, or a fresh
          // send()) reuses the same index rather than skipping one.
          return [{ t: 'rate_limited', classification, retryAfterMs: null }];
        }
      }

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
