import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { PolicyHoldRegistry } from '../controlChannel/policyHoldRegistry';
import { nowIso } from '../../shared/models/ids';
import { getCheckpointById, recordCheckpointAnswer } from '../db/repositories/checkpoints';
import { insertOutboxMessage } from '../db/repositories/messages';
import { unblockTaskForCheckpoint } from './taskBlocking';
import { appendDecisionLog } from './decisionLog';
import { listPendingProposalsForCheckpoint } from '../db/repositories/memoryProposals';
import { REVIEW_OPTION_IDS, resolveMemoryProposals } from '../memory/memoryProposals';
import type { MemoryProposalDecision } from '../../shared/models/memoryProposal';
import type {
  Checkpoint,
  CheckpointAnswer,
  CheckpointOption,
} from '../../shared/models/checkpoint';

/**
 * §9.6 — answering. The single place a checkpoint stops being pending.
 *
 * §9.6 names five things, and CLAUDE.md invariant #3 fixes their order
 * ("every state change is committed before the side effect"):
 *
 *   1. write the answer          — committed first, as a CAS
 *   2. emit `checkpoint.answered`
 *   3. unblock the dependent task
 *   4. get the decision to the employee's next turn
 *   5. write it to project memory when it has lasting relevance
 *
 * Two entry points share one private `recordAndEmit`, so the row write and
 * its event exist in exactly one place regardless of who resolved it: the
 * user through IPC, or a timeout applying the default.
 *
 * ## Delivery goes through the outbox, not through a live Supervisor
 *
 * The obvious implementation of step 4 is
 * `supervisorRegistry.get(id)?.send(...)` — and it is wrong in a way that
 * only shows up for the case that matters. §9.7 is explicit: a message to
 * an `off` employee is **held, not dropped**, and delivered when that
 * employee next starts. A direct call silently discards the answer to a
 * question that was raised precisely because it needed one, whenever the
 * employee happens to be off — which, for a `soon` or `whenever`
 * checkpoint answered hours later, is the normal case, not the edge one.
 *
 * So the durable `messages` outbox is the only delivery path, and §9.7's
 * own diagram says why that is not a compromise: "SQLite is the source of
 * truth, the signal is only a latency optimisation." Adding a
 * direct-injection fast path *as well* would put "has this been delivered"
 * in two places one milestone after standing rule 6 was earned.
 *
 * **The honest cost, stated rather than buried:** M8 session 1 writes the
 * row and nothing delivers it. The router is session 2 (§9.7). Until then
 * an answered decision reaches the employee late rather than never — the
 * row survives restarts, keeps its `pending` status, and the router picks
 * it up with no migration and no rework.
 *
 * ## `user.checkpoint_answered` is deliberately not emitted
 *
 * §5.2 lists both `checkpoint.answered` and `user.checkpoint_answered`.
 * Answering is ONE state change, and invariant #3 allows it exactly one
 * event. `checkpoint.answered` with `actor: 'user'` carries everything the
 * second type would have; emitting both would break the invariant to
 * satisfy a taxonomy. Flagged in PROGRESS.md rather than silently decided.
 */

export interface AnswerDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  /** Electron's `userData` root — where the decision log's markdown lives. */
  readonly baseDir: string;
}

/**
 * `'system'` is M10's, and it is deliberately not folded into `'timeout'`.
 *
 * §12.4's memory review is a `whenever` checkpoint, so it has
 * `expires_at = null` and **never times out** (§9.5 — see
 * `memoryProposals.ts` for why that is the invariant holding rather than
 * bending). What runs out is each *proposal*; the review is resolved as a
 * consequence of its last pending item going. Recording that as a timeout
 * would put a claim in the activity trail that is false about the one thing
 * a person opening that trail would be there to learn.
 *
 * So `'system'` shares `'timeout'`'s *status* (`auto_resolved` — nobody
 * answered) and differs in what it says about why.
 */
export type AnswerSource = 'user' | 'timeout' | 'system';

export interface AnswerCheckpointInput {
  readonly checkpointId: string;
  readonly optionId?: string | undefined;
  readonly freeText?: string | undefined;
  readonly source: AnswerSource;
  /** Required in practice for `source: 'system'` — a machine-readable reason
   *  that lands in the event payload and in `answered_by`. Ignored for the
   *  other two, whose reasons are structural. */
  readonly systemReason?: string | undefined;
  /**
   * §12.4's "accept/reject per item". Only meaningful for a checkpoint that
   * has memory proposals attached, and only consulted when the chosen option
   * asks for per-item decisions — see step 6.
   */
  readonly itemDecisions?: readonly MemoryProposalDecision[] | undefined;
}

export type AnswerCheckpointResult =
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'not_pending' | 'unknown_option' | 'no_answer_given';
    }
  | {
      /** §12.4 — the answer chose "decide each note" but did not decide every
       *  pending one. Nothing is written and the checkpoint stays pending:
       *  a partially-resolved review that the user believes they finished is
       *  the exact state batching exists to prevent. */
      readonly ok: false;
      readonly reason: 'incomplete_item_decisions';
      readonly undecidedProposalIds: string[];
    }
  | {
      readonly ok: true;
      readonly checkpoint: Checkpoint;
      readonly status: 'answered' | 'auto_resolved';
      /** Null when nothing was blocked on this checkpoint. */
      readonly unblockedTaskId: string | null;
      /** Null when the checkpoint has no employee to address (a budget or
       * merge-conflict checkpoint genuinely has none). */
      readonly queuedMessageId: string | null;
      /** The `project/decisions.md` path, when §12.5 applied. */
      readonly decisionLogPath: string | null;
      /** §12.4 — proposal ids written to memory / discarded by this answer. */
      readonly memoryProposalsApplied: string[];
      readonly memoryProposalsRejected: string[];
    };

export function answerCheckpoint(
  deps: AnswerDeps,
  input: AnswerCheckpointInput,
): AnswerCheckpointResult {
  const checkpoint = getCheckpointById(deps.db, input.checkpointId);
  if (checkpoint === null) return { ok: false, reason: 'not_found' };
  if (checkpoint.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const options = checkpoint.options ?? [];
  const chosen: CheckpointOption | null =
    input.optionId === undefined
      ? null
      : (options.find((option) => option.id === input.optionId) ?? null);

  if (input.optionId !== undefined && chosen === null) {
    return { ok: false, reason: 'unknown_option' };
  }
  // §9.2: "Free text is always accepted alongside the options" — alongside,
  // and also instead of. But an answer that is neither is not an answer,
  // and recording it would leave the checkpoint resolved with nothing in
  // it for anyone to act on. `information` checkpoints have no options at
  // all and are answered purely in free text, which this allows.
  const freeText = input.freeText?.trim() ?? '';
  if (chosen === null && freeText.length === 0) {
    return { ok: false, reason: 'no_answer_given' };
  }

  // ---- 0. §12.4's exhaustiveness check, BEFORE the CAS ---------------
  // A review answered with "decide each note" but missing a decision must
  // leave the checkpoint pending, so the person can finish. Checking after
  // the CAS would mean refusing an answer that had already been recorded.
  const pendingProposals = listPendingProposalsForCheckpoint(deps.db, checkpoint.id);
  if (pendingProposals.length > 0 && chosen?.id === REVIEW_OPTION_IDS.review) {
    const decided = new Set((input.itemDecisions ?? []).map((decision) => decision.proposalId));
    const undecided = pendingProposals
      .filter((proposal) => !decided.has(proposal.id))
      .map((proposal) => proposal.id);
    if (undecided.length > 0) {
      return {
        ok: false,
        reason: 'incomplete_item_decisions',
        undecidedProposalIds: undecided,
      };
    }
  }

  const status = input.source === 'user' ? 'answered' : 'auto_resolved';
  const answeredAt = nowIso();
  const answer: CheckpointAnswer = {
    ...(chosen === null ? {} : { optionId: chosen.id }),
    ...(freeText.length === 0 ? {} : { freeText }),
  };

  // ---- 1. the state change, as a CAS -------------------------------
  const won = recordCheckpointAnswer(deps.db, checkpoint.id, {
    status,
    answer,
    answeredBy: answeredByFor(input),
    answeredAt,
  });
  // Lost the race against the other resolver. Nothing below may run — the
  // winner already ran all of it, and repeating it would double the event,
  // the outbox row and the decision-log entry.
  if (!won) return { ok: false, reason: 'not_pending' };

  // ---- 2. exactly one event ----------------------------------------
  deps.activityLog.logEvent({
    actor: input.source === 'user' ? 'user' : 'system',
    type: input.source === 'user' ? 'checkpoint.answered' : 'checkpoint.auto_resolved',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: {
      type: checkpoint.type,
      optionId: chosen?.id ?? null,
      hasFreeText: freeText.length > 0,
      // `appliedDefault` is deliberately absent for `'system'`: no default
      // was applied on a clock. This checkpoint had no `expires_at` at all
      // (§9.5) — it was resolved because the thing it was reviewing ran out.
      // Saying otherwise would be a lie in the one place someone looks to
      // find out what happened.
      ...(input.source === 'timeout' ? { appliedDefault: checkpoint.default_action } : {}),
      ...(input.source === 'system' ? { reason: input.systemReason ?? 'system_resolved' } : {}),
    },
  });

  // ---- 3. unblock the dependent task -------------------------------
  let unblockedTaskId: string | null = null;
  if (checkpoint.task_id !== null) {
    const unblocked = unblockTaskForCheckpoint(deps.db, deps.activityLog, {
      taskId: checkpoint.task_id,
      checkpointId: checkpoint.id,
    });
    if (unblocked) unblockedTaskId = checkpoint.task_id;
  }

  // ---- 4. queue the decision for the employee's next turn ----------
  const queuedMessageId = queueDecisionForEmployee(
    deps,
    checkpoint,
    chosen,
    freeText,
    input.source,
  );

  // ---- 5. project memory, when the decision lasts ------------------
  let decisionLogPath: string | null = null;
  if (checkpoint.type === 'decision' && checkpoint.project_id !== null) {
    decisionLogPath = appendDecisionLog(deps.db, {
      baseDir: deps.baseDir,
      projectId: checkpoint.project_id,
      checkpoint,
      chosenOption: chosen,
      freeText: freeText.length === 0 ? null : freeText,
      byTimeout: input.source === 'timeout',
      answeredAtIso: answeredAt,
    }).absolutePath;
  }

  // ---- 6. §12.4's proposed notes, decided by this same answer -------
  //
  // Symmetrical with step 5, and here for the same reason: answering is one
  // act with several separable consequences, and `answerCheckpoint` is "the
  // single place a checkpoint stops being pending". A second entry point
  // that resolved a memory review would be a second door onto that, one
  // milestone after standing rule 6 was earned.
  //
  // The `resolveMemoryProposals` call cannot return `incomplete` here: step
  // 0 already refused that case before anything was written.
  let memoryProposalsApplied: string[] = [];
  let memoryProposalsRejected: string[] = [];
  if (pendingProposals.length > 0) {
    const resolved = resolveMemoryProposals(
      { db: deps.db, activityLog: deps.activityLog, baseDir: deps.baseDir },
      {
        checkpointId: checkpoint.id,
        optionId: chosen?.id ?? null,
        itemDecisions: input.itemDecisions ?? [],
        resolvedBy: answeredByFor(input),
        reason: input.source === 'system' ? (input.systemReason ?? 'system_resolved') : 'reviewed',
      },
    );
    memoryProposalsApplied = resolved.applied;
    memoryProposalsRejected = resolved.rejected;
  }

  return {
    ok: true,
    checkpoint: getCheckpointById(deps.db, checkpoint.id) as Checkpoint,
    status,
    unblockedTaskId,
    queuedMessageId,
    decisionLogPath,
    memoryProposalsApplied,
    memoryProposalsRejected,
  };
}

/** Who the row records as having answered. One derivation, three sources. */
function answeredByFor(input: AnswerCheckpointInput): string {
  switch (input.source) {
    case 'user':
      return 'user';
    case 'timeout':
      return 'system:timeout';
    case 'system':
      return `system:${input.systemReason ?? 'resolved'}`;
  }
}

/**
 * §9.7's outbox write. `idempotency_key` is derived from the checkpoint id
 * rather than minted fresh — the column is UNIQUE, and the derived key is
 * the second line of defence that makes a redelivered or replayed answer
 * collide instead of producing two messages saying the same thing (the
 * same reasoning `sendMessage`'s own handler follows).
 */
function queueDecisionForEmployee(
  deps: AnswerDeps,
  checkpoint: Checkpoint,
  chosen: CheckpointOption | null,
  freeText: string,
  source: AnswerSource,
): string | null {
  // No addressee. A budget, quota or merge-conflict checkpoint genuinely
  // has no employee behind it; the Director is not an addressable target
  // until M11. Reported in the result rather than silently skipped.
  if (checkpoint.employee_id === null) return null;

  const lines = [`Your checkpoint "${checkpoint.title}" has been answered.`];
  if (chosen !== null) {
    lines.push(`Decision: ${chosen.label}`);
    lines.push(`What this means: ${chosen.consequence}`);
  }
  if (freeText.length > 0) lines.push(`They also said: ${freeText}`);
  if (source === 'timeout') {
    lines.push('(Nobody answered in time, so the safe default was applied.)');
  } else if (source === 'system') {
    // Not "nobody answered in time" — this checkpoint had no deadline. It
    // was resolved because what it was about is no longer outstanding.
    lines.push('(Bureau resolved this itself: there was nothing left to decide.)');
  }
  lines.push('Continue from here.');

  const message = insertOutboxMessage(deps.db, {
    idempotency_key: `checkpoint-answer:${checkpoint.id}`,
    from_addr: 'user',
    to_addr: `employee:${checkpoint.employee_id}`,
    resolved_employee_id: checkpoint.employee_id,
    task_id: checkpoint.task_id,
    thread_id: checkpoint.id,
    kind: 'answer',
    // Above the default 50: an answer someone is blocked on outranks
    // ordinary handoffs in the router's `ORDER BY priority DESC`.
    priority: 80,
    subject: checkpoint.title,
    body: lines.join('\n'),
    status: 'pending',
    next_attempt_at: nowIso(),
  });

  deps.activityLog.logEvent({
    actor: 'system',
    type: 'message.sent',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: { messageId: message.id, kind: 'answer', to: message.to_addr },
  });

  return message.id;
}

// ---- permission ----------------------------------------------------

export interface AnswerPermissionDeps extends AnswerDeps {
  readonly policyHoldRegistry: PolicyHoldRegistry;
}

export type AnswerPermissionResult =
  | { readonly ok: false; readonly reason: 'not_found' | 'not_permission' | 'not_pending' }
  | {
      readonly ok: true;
      readonly allowed: boolean;
      /** False when no hold was still open — the agent gave up, died, or
       * the hold already timed out to deny. The answer is still recorded;
       * the user is told it arrived too late. */
      readonly holdReleased: boolean;
    };

/**
 * §9.1's `permission` answer — "answered with a single keypress".
 *
 * Shares steps 1 and 2 with `answerCheckpoint` and does none of 3–5, for
 * reasons rather than by omission: no task is blocked (the *agent* is held
 * inside a live HTTP request, not the task row); no outbox message is
 * needed because the HTTP response IS the delivery; and a one-off
 * allow/deny of a single tool call is not a durable project fact, so
 * §12.5 does not apply.
 *
 * The hold is M4's `PolicyHoldRegistry`, used unchanged. Its own doc
 * comment predicted this exact caller — "what a real checkpoint-answer
 * flow (M8) will call" — and **no second holding mechanism is built.**
 */
export function answerPermissionCheckpoint(
  deps: AnswerPermissionDeps,
  input: { readonly checkpointId: string; readonly allow: boolean },
): AnswerPermissionResult {
  const checkpoint = getCheckpointById(deps.db, input.checkpointId);
  if (checkpoint === null) return { ok: false, reason: 'not_found' };
  if (checkpoint.type !== 'permission') return { ok: false, reason: 'not_permission' };
  if (checkpoint.status !== 'pending') return { ok: false, reason: 'not_pending' };

  const optionId = input.allow ? 'allow_once' : 'deny';
  const won = recordCheckpointAnswer(deps.db, checkpoint.id, {
    status: 'answered',
    answer: { optionId },
    answeredBy: 'user',
  });
  if (!won) return { ok: false, reason: 'not_pending' };

  deps.activityLog.logEvent({
    actor: 'user',
    type: 'checkpoint.answered',
    severity: 'info',
    project_id: checkpoint.project_id,
    task_id: checkpoint.task_id,
    employee_id: checkpoint.employee_id,
    checkpoint_id: checkpoint.id,
    payload: { type: 'permission', optionId, tool: checkpoint.tool_name },
  });

  // The state change is committed above, before this side effect — the
  // ordering invariant #3 requires. `tool_call_id` is the hold's own key
  // (`callId`), which is why §9.1 makes it a required column and why the
  // schema now refuses a permission checkpoint without one.
  const holdReleased =
    checkpoint.tool_call_id !== null &&
    deps.policyHoldRegistry.resolve(checkpoint.tool_call_id, input.allow ? 'allow' : 'deny');

  return { ok: true, allowed: input.allow, holdReleased };
}
