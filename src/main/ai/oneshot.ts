import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { retrieveSecret, type SafeStorageLike } from '../secrets/secretStore';
import { insertUsage } from '../db/repositories/usage';
import { globalSecretRegistry, type SecretRegistry } from '../secrets/redactor';

/**
 * §22.4's one-shot client. Small and boring on purpose.
 *
 * ## `provider: 'none'` is the NORMAL case, not the error case
 *
 * §22.4 states the credential problem plainly: `engines.oneshotProvider`
 * defaults to "same as the main engine", and that default **fails** in the
 * two configurations this product recommends most — a subscription login
 * and a free CLI login both hold OAuth credentials *inside the agent CLI*,
 * which Bureau cannot use for a raw HTTP call.
 *
 * So `'none'` is a first-class branch that returns a well-formed
 * "unavailable" result, never a thrown error. Every caller must have a
 * working fallback (§22.4 tabulates all four), and **no feature may depend
 * on this.**
 *
 * ## Budget exhaustion does NOT block a one-shot call
 *
 * This inverts the rule M6 built everywhere else, and §22.4 says why:
 * one-shot calls "are how the app explains that the budget is exhausted,
 * and the reserve covers them". Blocking them would leave the user with an
 * app that has run out of money and cannot say so. There is deliberately
 * no budget check in this file — its absence is the feature, and there is
 * a test that proves a call still runs with the budget blown.
 *
 * ## `secretKey` is a NAME
 *
 * The key name in `secrets_meta`, resolved through `retrieveSecret` at
 * call time. A value never appears in a config object.
 */

export type OneShotProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible' | 'none';

export interface OneShotConfig {
  readonly provider: OneShotProvider;
  /** For local or OpenAI-compatible endpoints. */
  readonly baseUrl?: string;
  /** Key NAME in `secrets_meta`, never a value. */
  readonly secretKey: string;
  /** Resolved from `engines.modelTiers['fast']`. */
  readonly model: string;
  readonly timeoutMs?: number;
  /** These calls are never critical (§22.4). */
  readonly maxRetries?: number;
}

export const ONESHOT_DEFAULT_TIMEOUT_MS = 15_000;
export const ONESHOT_DEFAULT_MAX_RETRIES = 1;

export interface OneShotRequest {
  readonly system?: string;
  readonly prompt: string;
  readonly maxTokens?: number;
}

/**
 * Deliberately a discriminated result, not a thrown error.
 *
 * Every caller has a fallback by contract, and a fallback is a normal
 * branch — making the caller write `try/catch` around its own normal path
 * would invert that. `reason` distinguishes "no provider configured" from
 * "the call failed", because a caller may want to say something different
 * about a missing key than about a timeout.
 */
export type OneShotResult =
  | { readonly ok: true; readonly text: string; readonly usage: OneShotUsage }
  | {
      readonly ok: false;
      readonly reason: 'no_provider' | 'no_key' | 'timeout' | 'error';
      readonly detail: string;
    };

export interface OneShotUsage {
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly model: string;
}

export interface OneShotDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly config: OneShotConfig;
  /** Attribution for the spend (§22.4). Null when no project is active,
   * in which case it draws on the Director reserve. */
  readonly projectId?: string | null;
  /** Injectable for tests, same reason `secretStore`'s own functions take
   * one — a plain-Node test run has no live `electron` module. */
  readonly safeStorage?: SafeStorageLike | (() => Promise<SafeStorageLike>);
  readonly secretRegistry?: SecretRegistry;
  /** Injectable so tests can drive a real loopback server. */
  readonly fetchImpl?: typeof fetch;
}

interface ProviderCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function buildCall(config: OneShotConfig, request: OneShotRequest, apiKey: string): ProviderCall {
  const maxTokens = request.maxTokens ?? 512;

  if (config.provider === 'anthropic') {
    return {
      url: `${config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model: config.model,
        max_tokens: maxTokens,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: [{ role: 'user', content: request.prompt }],
      },
    };
  }

  if (config.provider === 'google') {
    const base = config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    return {
      url: `${base}/v1beta/models/${config.model}:generateContent`,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: {
        contents: [{ parts: [{ text: request.prompt }] }],
        ...(request.system === undefined
          ? {}
          : { systemInstruction: { parts: [{ text: request.system }] } }),
        generationConfig: { maxOutputTokens: maxTokens },
      },
    };
  }

  // `openai` and `openai-compatible` share a wire format — the difference
  // is only which host answers, which is exactly what `baseUrl` is for.
  return {
    url: `${config.baseUrl ?? 'https://api.openai.com'}/v1/chat/completions`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: {
      model: config.model,
      max_tokens: maxTokens,
      messages: [
        ...(request.system === undefined ? [] : [{ role: 'system', content: request.system }]),
        { role: 'user', content: request.prompt },
      ],
    },
  };
}

interface ParsedResponse {
  readonly text: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
}

function parseResponse(provider: OneShotProvider, payload: unknown): ParsedResponse {
  const body = payload as Record<string, unknown>;

  if (provider === 'anthropic') {
    const content = (body['content'] as { type?: string; text?: string }[] | undefined) ?? [];
    const usage =
      (body['usage'] as { input_tokens?: number; output_tokens?: number } | undefined) ?? {};
    return {
      text: content.map((part) => part.text ?? '').join(''),
      tokensIn: usage.input_tokens ?? null,
      tokensOut: usage.output_tokens ?? null,
    };
  }

  if (provider === 'google') {
    const candidates =
      (body['candidates'] as { content?: { parts?: { text?: string }[] } }[] | undefined) ?? [];
    const usage =
      (body['usageMetadata'] as
        { promptTokenCount?: number; candidatesTokenCount?: number } | undefined) ?? {};
    return {
      text: (candidates[0]?.content?.parts ?? []).map((p) => p.text ?? '').join(''),
      tokensIn: usage.promptTokenCount ?? null,
      tokensOut: usage.candidatesTokenCount ?? null,
    };
  }

  const choices = (body['choices'] as { message?: { content?: string } }[] | undefined) ?? [];
  const usage =
    (body['usage'] as { prompt_tokens?: number; completion_tokens?: number } | undefined) ?? {};
  return {
    text: choices[0]?.message?.content ?? '',
    tokensIn: usage.prompt_tokens ?? null,
    tokensOut: usage.completion_tokens ?? null,
  };
}

/**
 * Runs one small call, or explains why it cannot.
 *
 * Never throws: a caller with a fallback should not have to wrap its own
 * normal path in `try/catch`.
 */
export async function runOneShot(
  deps: OneShotDeps,
  request: OneShotRequest,
): Promise<OneShotResult> {
  const { db, config } = deps;

  // The normal case in the two configurations this product recommends
  // most. Not an error — a caller reading this takes its fallback.
  if (config.provider === 'none') {
    return { ok: false, reason: 'no_provider', detail: 'No one-shot provider is configured.' };
  }

  const apiKey = deps.safeStorage
    ? await retrieveSecret(db, config.secretKey, deps.safeStorage)
    : await retrieveSecret(db, config.secretKey);
  if (apiKey === null) {
    return {
      ok: false,
      reason: 'no_key',
      detail: `No stored key named "${config.secretKey}". Settings can add one for small helper tasks.`,
    };
  }
  // The moment a real key is in hand it becomes redactable everywhere —
  // §11.4's choke point, the same discipline `secretBroker` follows.
  (deps.secretRegistry ?? globalSecretRegistry).register([apiKey]);

  const timeoutMs = config.timeoutMs ?? ONESHOT_DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? ONESHOT_DEFAULT_MAX_RETRIES;
  const doFetch = deps.fetchImpl ?? fetch;
  const call = buildCall(config, request, apiKey);

  let lastDetail = 'unknown error';
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(call.url, {
        method: 'POST',
        headers: call.headers,
        body: JSON.stringify(call.body),
        signal: controller.signal,
      });
      if (!response.ok) {
        lastDetail = `HTTP ${response.status}`;
        continue;
      }
      const parsed = parseResponse(config.provider, await response.json());
      const usage: OneShotUsage = {
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        model: config.model,
      };
      recordOneShotUsage(deps, usage);
      return { ok: true, text: parsed.text, usage };
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      lastDetail = aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      if (aborted && attempt === maxRetries) {
        return { ok: false, reason: 'timeout', detail: lastDetail };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, reason: 'error', detail: lastDetail };
}

/**
 * §22.4's cost recording. One-shot spend is real and must be visible.
 *
 * `employee_id`, `task_id` and `turn_index` are all NULL — a one-shot call
 * has none of them, and those columns were made nullable for exactly this
 * (no migration needed). Spend attributes to the current project, or to
 * the Director reserve when none is active.
 */
function recordOneShotUsage(deps: OneShotDeps, usage: OneShotUsage): void {
  insertUsage(
    deps.db,
    {
      employee_id: null,
      task_id: null,
      turn_index: null,
      engine: deps.config.provider,
      model: usage.model,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      source: 'oneshot',
    },
    { projectId: deps.projectId ?? null },
  );

  deps.activityLog.logEvent({
    actor: 'system',
    type: 'cost.oneshot_recorded',
    severity: 'info',
    project_id: deps.projectId ?? null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      provider: deps.config.provider,
      model: usage.model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      // No project means the Director reserve covers it (§8.0/§22.4) —
      // recorded so "what paid for this" is answerable.
      againstDirectorReserve: (deps.projectId ?? null) === null,
    },
  });
}
