import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { runOneShot, type OneShotConfig } from '../ai/oneshot';
import { resolveOneShotConfig } from '../ai/oneshotConfig';
import type { SafeStorageLike } from '../secrets/secretStore';
import type { PricingTable } from '../../shared/models/pricing';

/**
 * **Intent classification** (M11 row S1-16, §22.2, §22.4). The ONLY place a
 * user message's intent is decided (standing rule 6).
 *
 * §22.2: a one-shot call on the `fast` tier, because using the Director's
 * whole context to ask "is this new work?" would cost a hundred times more
 * per message. §22.4: when no provider resolves — the normal case, since
 * the provider is stored unset — keyword and structure rules decide instead,
 * and no feature may depend on the call. **Ambiguity is "chat"**: the
 * Director decides inside its own turn, which is the safe side, because a
 * misread "new work" starts an intake the user did not ask for.
 *
 * Its cost is recorded by `runOneShot` itself (X-22): a usage row with
 * `source: 'oneshot'` and one `cost.oneshot_recorded`.
 */
export type Intent = 'new_work' | 'question' | 'answer' | 'chat';

export interface IntentResult {
  readonly intent: Intent;
  readonly decidedBy: 'oneshot' | 'rules';
}

export interface IntentDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  /** Resolved from settings when omitted; injectable so a test can drive a
   *  real loopback provider, as `duplicateDetection.ts` does. */
  readonly oneShotConfig?: OneShotConfig;
  readonly projectId?: string | null;
  readonly pricing?: PricingTable;
  readonly fetchImpl?: typeof fetch;
  readonly safeStorage?: SafeStorageLike | (() => Promise<SafeStorageLike>);
}

export interface IntentInput {
  readonly text: string;
  /** The Director is waiting on its own questions (intake), so a reply is
   *  most likely the answer — §22.4's "answers an outstanding question". */
  readonly awaitingAnswer: boolean;
}

const WORK_VERBS =
  /\b(build|make|create|write|design|develop|set up|setup|implement|draft|generate|produce|prepare|research|analy[sz]e|plan out|put together|code|program)\b/i;
const ARTIFACTS =
  /\b(app|application|website|site|web ?page|page|tool|script|program|report|document|doc|essay|article|guide|api|dashboard|game|bot|plugin|extension|service|database|spreadsheet|presentation|deck|slides|cli|library|feature|blog|landing|prototype|mvp|study|analysis|plan|proposal|book|course|newsletter|form|system|platform)\b/i;
// A question word opens a question. An auxiliary does only when a subject
// follows it: "do you have…" asks, "do the thing" tells.
const QUESTION_START =
  /^(?:(?:what|what's|whats|how|why|when|where|who|which)\b|(?:can|could|would|should|is|are|do|does|did|will|have|has)\s+(?:you|i|we|it|they|he|she|this|that|there)\b)/i;

/**
 * §22.4's fallback: "does the message describe work, contain a verb plus an
 * artifact, or answer an outstanding question?" A work verb alone ("make it
 * nicer") or an artifact alone is not enough — that is ambiguity, and
 * ambiguity is chat.
 */
export function classifyIntentByRules(text: string, awaitingAnswer: boolean): Intent {
  const trimmed = text.trim();
  if (WORK_VERBS.test(trimmed) && ARTIFACTS.test(trimmed)) return 'new_work';
  if (awaitingAnswer) return 'answer';
  if (trimmed.endsWith('?') || QUESTION_START.test(trimmed)) return 'question';
  return 'chat';
}

const ONESHOT_WORDS: Readonly<Record<string, Intent>> = {
  NEW_WORK: 'new_work',
  QUESTION: 'question',
  ANSWER: 'answer',
  CHAT: 'chat',
};

export async function classifyIntent(deps: IntentDeps, input: IntentInput): Promise<IntentResult> {
  const config = deps.oneShotConfig ?? resolveOneShotConfig(deps.db);
  if (config.provider !== 'none') {
    const result = await runOneShot(
      {
        db: deps.db,
        activityLog: deps.activityLog,
        config,
        projectId: deps.projectId ?? null,
        ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        ...(deps.safeStorage === undefined ? {} : { safeStorage: deps.safeStorage }),
      },
      {
        system:
          'You classify one message a person sent to the manager of a small team. Reply with ' +
          'exactly one word: NEW_WORK (they describe something new to be built or produced), ' +
          'QUESTION (they ask something), ANSWER (they answer a question they were asked), or ' +
          'CHAT (anything else). If you are unsure, reply CHAT.',
        prompt: [
          input.awaitingAnswer
            ? 'The manager is waiting for answers to questions it asked this person.'
            : 'The manager has not asked this person anything.',
          '',
          'Message:',
          input.text,
        ].join('\n'),
        maxTokens: 8,
      },
    );
    if (result.ok) {
      const word = result.text.trim().toUpperCase();
      return { intent: ONESHOT_WORDS[word] ?? 'chat', decidedBy: 'oneshot' };
    }
    // Any failure — no key, timeout, an error — takes the rules (§22.4).
  }
  return { intent: classifyIntentByRules(input.text, input.awaitingAnswer), decidedBy: 'rules' };
}
