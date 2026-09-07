import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { CheckpointSchema, type Checkpoint } from '../../shared/models/checkpoint';
import type { CheckpointType } from '../../shared/models/enums';
import { toFtsQuery } from '../memory/searchMemory';
import { diceSimilarity } from './similarity';
import { runOneShot, type OneShotConfig } from '../ai/oneshot';
import { resolveOneShotConfig } from '../ai/oneshotConfig';
import type { SafeStorageLike } from '../secrets/secretStore';

/**
 * CLAUDE.md invariant #9 — "never ask a question that memory, the brief,
 * or the workspace already answers" — made mechanical for the part of it
 * M8 owns. §9.2: "Checkpoint creation runs a duplicate-check against
 * answered checkpoints in the same project first."
 *
 * ## Which types this applies to, and why it is narrower than §9.2's text
 *
 * §9.2 says "checkpoints", unqualified. Applied literally that suppresses
 * things that legitimately recur: a second merge conflict in the same
 * files is a second real event; a budget question answered last week is
 * genuinely askable again today; a `permission` checkpoint authorises one
 * specific in-flight tool call and a prior answer cannot stand in for it.
 * Suppressing a real question is the exact failure this whole milestone
 * exists to prevent, so the rule is scoped to the two types whose answers
 * are **durable facts about the project** rather than authorisations of a
 * moment:
 *
 *   - `decision`    — "we chose Postgres". §12.5's decision log is built
 *                     from precisely these, and the log existing is what
 *                     makes re-asking indefensible.
 *   - `information` — "staging is at this URL". Something only the user
 *                     knows, which does not stop being true.
 *
 * `approval`, `review` and `blocker` are moments. `permission` is a moment
 * by definition. This narrowing is a judgment call, not an oversight, and
 * it is recorded in PROGRESS.md as one.
 *
 * ## FTS narrows, Dice decides, the one-shot only breaks ties
 *
 * §28's M8 item 3: "FTS first, one-shot call only on a near-miss." The FTS
 * index (migration 0009) finds the handful of answered rows worth looking
 * at without scanning the table; `diceSimilarity` makes the call on a
 * bounded 0..1 scale (see similarity.ts for why not bm25); and only the
 * genuinely ambiguous middle band spends money.
 *
 * ## With no provider — the normal case — the near-miss band CREATES
 *
 * §22.4's fallback table for this exact feature reads: "FTS similarity
 * threshold alone — slightly more duplicates, never a blocker." So an
 * unresolved near-miss resolves to **not a duplicate**, and the checkpoint
 * is raised. That is the safe direction and it is not arbitrary: asking
 * one extra question wastes a moment of the user's attention and is
 * recoverable; suppressing a real one silently strands a task. This is the
 * primary path — `provider: 'none'` is what a subscription or free-CLI
 * login produces — and it is tested as the primary path.
 */

/** At or above: the same question, decided on FTS + Dice alone. */
export const DUPLICATE_THRESHOLD = 0.75;
/** At or above (and below DUPLICATE_THRESHOLD): a near-miss. */
export const NEAR_MISS_THRESHOLD = 0.45;

/** How many FTS candidates to score. Enough to cover a real project's
 * answered decisions on the same subject; small enough that scoring is
 * free. The FTS `rank` ordering decides which ones survive the cut, which
 * is the one thing bm25 IS reliable for — relative order within a query. */
const CANDIDATE_LIMIT = 10;

const DEDUPLICATED_TYPES: ReadonlySet<CheckpointType> = new Set<CheckpointType>([
  'decision',
  'information',
]);

export interface DuplicateCandidate {
  readonly project_id: string | null;
  readonly type: CheckpointType;
  readonly title: string;
  readonly context: string;
}

export type DuplicateResult =
  | {
      readonly kind: 'none';
      readonly reason:
        | 'type_not_deduplicated'
        | 'no_project'
        | 'no_candidates'
        | 'below_threshold'
        | 'near_miss_unconfirmed';
    }
  | {
      readonly kind: 'duplicate';
      readonly checkpoint: Checkpoint;
      readonly similarity: number;
      readonly decidedBy: 'fts' | 'oneshot';
    };

export interface DuplicateDetectionDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  /** Injectable so a test can drive a real loopback provider; resolved
   * from settings otherwise. */
  readonly oneShotConfig?: OneShotConfig;
  readonly fetchImpl?: typeof fetch;
  /** Same seam `runOneShot` already exposes, threaded through for the
   * same reason: a plain-Node test run has no live `electron` module, and
   * without this the near-miss confirmation could only ever be observed
   * taking its `no_key` fallback — the DUPLICATE branch would be
   * unreachable from any test. */
  readonly safeStorage?: SafeStorageLike | (() => Promise<SafeStorageLike>);
}

interface ScoredCandidate {
  readonly checkpoint: Checkpoint;
  readonly similarity: number;
}

export async function findDuplicateCheckpoint(
  deps: DuplicateDetectionDeps,
  candidate: DuplicateCandidate,
): Promise<DuplicateResult> {
  if (!DEDUPLICATED_TYPES.has(candidate.type)) {
    return { kind: 'none', reason: 'type_not_deduplicated' };
  }
  // "in the same project" is load-bearing, not incidental: two projects
  // may well face the same question and reach opposite answers.
  if (candidate.project_id === null) {
    return { kind: 'none', reason: 'no_project' };
  }

  const scored = scoreCandidates(deps.db, candidate);
  if (scored.length === 0) return { kind: 'none', reason: 'no_candidates' };

  const best = scored[0] as ScoredCandidate;

  if (best.similarity >= DUPLICATE_THRESHOLD) {
    return {
      kind: 'duplicate',
      checkpoint: best.checkpoint,
      similarity: best.similarity,
      decidedBy: 'fts',
    };
  }
  if (best.similarity < NEAR_MISS_THRESHOLD) {
    return { kind: 'none', reason: 'below_threshold' };
  }

  // The near-miss band, and the only place this feature ever spends money.
  const confirmed = await confirmNearMiss(deps, candidate, best);
  return confirmed
    ? {
        kind: 'duplicate',
        checkpoint: best.checkpoint,
        similarity: best.similarity,
        decidedBy: 'oneshot',
      }
    : { kind: 'none', reason: 'near_miss_unconfirmed' };
}

/**
 * FTS narrowing, then scoring. `toFtsQuery` is imported from the memory
 * layer rather than re-written here: FTS5's MATCH argument is a query
 * LANGUAGE, and a checkpoint title containing `-`, `"`, `*` or the literal
 * word `NEAR` is otherwise either a syntax error or, worse, a silently
 * different query. That function already quotes every token and ORs them.
 */
function scoreCandidates(db: Database.Database, candidate: DuplicateCandidate): ScoredCandidate[] {
  const ftsQuery = toFtsQuery(`${candidate.title} ${candidate.context}`);
  if (ftsQuery === null) return [];

  const rows = db
    .prepare(
      `SELECT c.* FROM checkpoints_fts f
         JOIN checkpoints c ON c.id = f.checkpoint_id
        WHERE checkpoints_fts MATCH @query
          AND c.project_id = @projectId
          AND c.type = @type
          AND c.status IN ('answered', 'auto_resolved')
        ORDER BY rank
        LIMIT @limit`,
    )
    .all({
      query: ftsQuery,
      projectId: candidate.project_id,
      type: candidate.type,
      limit: CANDIDATE_LIMIT,
    });

  const candidateText = `${candidate.title} ${candidate.context}`;
  return rows
    .map((row) => {
      const checkpoint = CheckpointSchema.parse(row);
      return {
        checkpoint,
        similarity: diceSimilarity(candidateText, `${checkpoint.title} ${checkpoint.context}`),
      };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * The one-shot half. Returns `false` — "not a duplicate, raise it" — for
 * every non-success outcome, including no provider, no key, a timeout and
 * a reply that is not a clean yes. §22.4 requires the fallback to work,
 * and this is it: no branch of this function can block a checkpoint from
 * being raised because a helper call failed.
 */
async function confirmNearMiss(
  deps: DuplicateDetectionDeps,
  candidate: DuplicateCandidate,
  best: ScoredCandidate,
): Promise<boolean> {
  const config = deps.oneShotConfig ?? resolveOneShotConfig(deps.db);
  if (config.provider === 'none') return false;

  const answered = best.checkpoint.answer;
  const result = await runOneShot(
    {
      db: deps.db,
      activityLog: deps.activityLog,
      config,
      projectId: candidate.project_id,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      ...(deps.safeStorage === undefined ? {} : { safeStorage: deps.safeStorage }),
    },
    {
      system:
        'You decide whether a new question has already been answered. Reply with exactly one word: DUPLICATE or DISTINCT. If you are unsure, reply DISTINCT.',
      prompt: [
        'A question was already asked and answered on this project:',
        `  Question: ${best.checkpoint.title}`,
        `  Details:  ${best.checkpoint.context}`,
        `  Answer:   ${answered?.optionId ?? ''} ${answered?.freeText ?? ''}`.trimEnd(),
        '',
        'A new question is about to be asked:',
        `  Question: ${candidate.title}`,
        `  Details:  ${candidate.context}`,
        '',
        'Does the existing answer already answer the new question?',
      ].join('\n'),
      maxTokens: 8,
    },
  );

  if (!result.ok) return false;
  return result.text.trim().toUpperCase().startsWith('DUPLICATE');
}
