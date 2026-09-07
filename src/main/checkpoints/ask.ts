import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { blockTaskForCheckpoint } from './taskBlocking';
import { findDuplicateCheckpoint, type DuplicateDetectionDeps } from './duplicateDetection';
import type { Checkpoint, NewCheckpointInput } from '../../shared/models/checkpoint';

/**
 * The **question** path: ask the user something, unless the project
 * already answered it.
 *
 * ## Why this is a layer above `insertCheckpoint` rather than inside it
 *
 * `insertCheckpoint` is the one door for *creating a row*, and everything
 * that must hold for every row lives there — validation, the derived
 * expiry, the `checkpoint.raised` event. Duplicate detection is
 * deliberately NOT one of those things, for two reasons:
 *
 *   1. **It is async.** A near-miss may make a one-shot HTTP call. The
 *      repository layer is synchronous throughout, and three of the five
 *      creation paths (`Supervisor`'s budget, quota and breaker branches)
 *      run inside synchronous event handling. Making the one door async to
 *      serve two callers would ripple through code that has nothing to do
 *      with checkpoints.
 *   2. **It is wrong for the system paths.** A second merge conflict is a
 *      second real event, and a budget exhausted again next week is a real
 *      question again. `duplicateDetection.ts` already refuses those by
 *      type; routing them through here as well would be a second, weaker
 *      statement of the same rule.
 *
 * So: the four system paths call `insertCheckpoint` directly and
 * deliberately. Agent- and Director-raised **questions** come through
 * here.
 */

export interface AskCheckpointDeps extends DuplicateDetectionDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
}

export interface AskCheckpointInput extends NewCheckpointInput {
  /**
   * When set (and the checkpoint is created rather than deduplicated), the
   * task is blocked on this checkpoint. Deliberately explicit rather than
   * derived from `task_id` + urgency: whether the raiser's *work* stops is
   * the raiser's statement about its own situation, and inferring it would
   * silently park tasks whose agent was only asking a side question.
   */
  readonly blocksTask?: boolean;
}

export type AskCheckpointResult =
  | { readonly kind: 'created'; readonly checkpoint: Checkpoint }
  | {
      readonly kind: 'duplicate';
      /** The already-answered checkpoint. Its `answer` is the whole point:
       * the caller hands it straight back to the agent, so an employee that
       * would have waited on a question instead receives the decision the
       * project already made. That is what turns CLAUDE.md invariant #9
       * from a slogan into behaviour. */
      readonly checkpoint: Checkpoint;
      readonly similarity: number;
      readonly decidedBy: 'fts' | 'oneshot';
    };

export async function askCheckpoint(
  deps: AskCheckpointDeps,
  input: AskCheckpointInput,
): Promise<AskCheckpointResult> {
  const duplicate = await findDuplicateCheckpoint(deps, {
    project_id: input.project_id ?? null,
    type: input.type,
    title: input.title,
    context: input.context,
  });

  if (duplicate.kind === 'duplicate') {
    // Nothing is created and nothing is emitted. No state changed, so
    // invariant #3 has nothing to record — the tool call itself is
    // already logged by the control channel, and inventing a
    // `checkpoint.suppressed` event for a row that does not exist would
    // add taxonomy for a non-event.
    return {
      kind: 'duplicate',
      checkpoint: duplicate.checkpoint,
      similarity: duplicate.similarity,
      decidedBy: duplicate.decidedBy,
    };
  }

  const { blocksTask, ...checkpointInput } = input;
  const checkpoint = insertCheckpoint(deps.db, deps.activityLog, checkpointInput);

  if (blocksTask === true && checkpoint.task_id !== null) {
    blockTaskForCheckpoint(deps.db, deps.activityLog, {
      taskId: checkpoint.task_id,
      checkpointId: checkpoint.id,
      detail: checkpoint.title,
      employeeId: checkpoint.employee_id,
    });
  }

  return { kind: 'created', checkpoint };
}
