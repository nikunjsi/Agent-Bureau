import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { getSetting } from '../db/repositories/settings';
import {
  attachProposalToCheckpoint,
  casProposalResolved,
  findOpenReviewCheckpointId,
  insertMemoryProposal,
  listExpiredPendingProposals,
  listPendingProposalsForCheckpoint,
} from '../db/repositories/memoryProposals';
import { titleFromMarkdown, writeMemory } from './memoryStore';
import {
  describeMemoryTargetRefusal,
  memoryScopeRequiresApproval,
  resolveMemoryTarget,
  type MemoryTargetRequest,
} from './memoryTarget';
import { getMemoryRowByPath } from './memoryStore';
import type { MemoryProposal, MemoryProposalDecision } from '../../shared/models/memoryProposal';

/**
 * §12.4 — "Employees *propose* memory writes. Writes to `employee/` are
 * free. Writes to `company/` and `project/` require approval, surfaced as
 * low-urgency `whenever` checkpoints."
 *
 * ## §9.5 says `whenever` checkpoints never expire. This does not break that
 *
 * §12.4 introduces itself as the exception: *"Because `whenever` checkpoints
 * never expire (§9.5), these would otherwise accumulate forever. So memory
 * proposals are the one exception: batched into a single 'review N proposed
 * notes' checkpoint … and auto-rejected-with-record after
 * `retention.memoryProposalDays`."*
 *
 * **The mechanism built here is not actually an exception, and that is the
 * part worth reading before changing anything.** The review checkpoint is
 * `whenever`, so `computeExpiresAt` gives it `expires_at = null` and it
 * genuinely never expires — §9.5 holds, untouched, structurally. What
 * expires is each **proposal**, on its own clock, and the checkpoint is
 * resolved as a *consequence* of its last pending item going. The queue
 * still cannot grow unbounded, and no `whenever` checkpoint was ever put on
 * a timer to achieve it.
 *
 * So: if you are here because this looked like a violation of §9.5, it is
 * not, and the thing that would make it one is giving the review checkpoint
 * an `expires_at`.
 *
 * ## Ordering on accept, which looks like it inverts invariant #3
 *
 * Invariant #3 is "every state change is committed before the side effect".
 * Here the file write comes first:
 *
 *   1. the markdown file          — §12.1 layer 1, the source of truth
 *   2. { index row + proposal CAS } in one transaction
 *   3. exactly one `memory.write_applied`
 *
 * §12.1 already settled which artifact is the commitment: *"the markdown
 * file is written first and the index row second, always … the reverse
 * would lose the knowledge itself."* Layer 1 IS the state change; the row is
 * a disposable index and the proposal row is bookkeeping about it. A crash
 * between 1 and 2 leaves the proposal pending with the file already
 * written, and re-accepting is a no-op (`writeMemory` is an upsert and
 * reports `changed: false`). The reverse order would record an acceptance
 * for knowledge that was never written down.
 *
 * The residual, stated rather than hidden: an accept interrupted between 1
 * and 2 leaves the file written and the proposal back in the review, so a
 * user who then *rejects* it finds the note already there. Recorded in
 * NEXT-VERSION §M.
 */

export type ProposeMemoryOutcome =
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      /** Free scope — written immediately, no review (§12.4). */
      readonly kind: 'applied';
      readonly path: string;
      readonly memoryId: string | null;
    }
  | {
      readonly kind: 'queued';
      readonly proposal: MemoryProposal;
      readonly checkpointId: string;
      /** How many notes that review is now holding. Derived, never stored. */
      readonly pendingCount: number;
    };

export interface MemoryProposalDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly baseDir: string;
}

export interface ProposeMemoryInput extends MemoryTargetRequest {
  readonly content: string;
  readonly rationale: string;
  /** `employee:<id>` | `director` | `user` — the activity log's actor shape. */
  readonly proposedBy: string;
  readonly projectId?: string | null;
  readonly phaseId?: string | null;
}

export function proposeMemoryWrite(
  deps: MemoryProposalDeps,
  input: ProposeMemoryInput,
): ProposeMemoryOutcome {
  // The guard, on the real path. See `memoryTarget.ts` for why it has to be
  // here and not in the policy evaluator (AUDIT #10).
  const target = resolveMemoryTarget(deps.baseDir, input);
  if (!target.ok) {
    return { kind: 'refused', reason: describeMemoryTargetRefusal(target.refusal) };
  }

  const title = titleFromMarkdown(input.content, target.location.fileName);

  if (!memoryScopeRequiresApproval(input.scope)) {
    // §12.4: an employee's own notes are theirs. No queue, no checkpoint.
    //
    // Read before the write, so the event can say which of the two things
    // actually happened. `writeMemory`'s own `changed` flag answers a
    // different question — whether the bytes moved — and reporting a first
    // write as "updated" would make the trail wrong in the one place it is
    // consulted to find out when a note came into existence.
    const existing = getMemoryRowByPath(deps.db, target.relativePath);
    const result = writeMemory(deps.db, {
      baseDir: deps.baseDir,
      ...target.location,
      title,
      body: input.content,
      source: 'observed',
    });
    const row = getMemoryRowByPath(deps.db, result.relativePath);
    deps.activityLog.logEvent({
      actor: input.proposedBy,
      type: 'memory.write_applied',
      severity: 'info',
      project_id: input.projectId ?? null,
      task_id: null,
      employee_id: input.employeeId ?? null,
      checkpoint_id: null,
      payload: {
        change: existing === null ? 'created' : result.changed ? 'updated' : 'unchanged',
        scope: input.scope,
        path: result.relativePath,
        memoryId: row?.id ?? null,
        gated: false,
      },
    });
    return { kind: 'applied', path: result.relativePath, memoryId: row?.id ?? null };
  }

  const projectId = input.projectId ?? null;
  const phaseId = input.phaseId ?? null;

  const proposal = insertMemoryProposal(deps.db, {
    scope: input.scope,
    scope_ref: target.location.scopeRef,
    path: target.relativePath,
    title,
    content: input.content,
    rationale: input.rationale,
    proposed_by: input.proposedBy,
    employee_id: input.employeeId ?? null,
    project_id: projectId,
    phase_id: phaseId,
  });

  const checkpointId = attachOrRaiseReview(deps, projectId, phaseId);
  attachProposalToCheckpoint(deps.db, proposal.id, checkpointId);

  // The row and its batch are committed above; the event follows the state
  // change, and there is exactly one of it (invariant #3). Raising the
  // review is `insertCheckpoint`'s own `checkpoint.raised` — a different
  // state change with its own event, not a second event for this one.
  deps.activityLog.logEvent({
    actor: input.proposedBy,
    type: 'memory.write_proposed',
    severity: 'info',
    project_id: projectId,
    task_id: null,
    employee_id: input.employeeId ?? null,
    checkpoint_id: checkpointId,
    payload: {
      proposalId: proposal.id,
      scope: input.scope,
      path: target.relativePath,
      rationale: input.rationale,
    },
  });

  return {
    kind: 'queued',
    proposal,
    checkpointId,
    pendingCount: listPendingProposalsForCheckpoint(deps.db, checkpointId).length,
  };
}

export const REVIEW_OPTION_IDS = {
  review: 'review_each',
  acceptAll: 'accept_all',
  rejectAll: 'reject_all',
} as const;

/**
 * §12.4's "batched into a single checkpoint … raised at most once per
 * phase". A pending review for this (project, phase) gains the proposal; if
 * there is none, one is raised.
 *
 * **The checkpoint stores no copy of the proposals**, deliberately. §12.4's
 * sentence is "review N proposed notes" and N grows as items attach — a
 * count baked into the title would be stale on the next proposal, and
 * keeping it fresh would mean mutating a pending checkpoint, which is a
 * state change owing an event for a number that can simply be derived. So
 * the count is a query (`listPendingProposalsForCheckpoint`) and the
 * sentence a person reads is the renderer's to form.
 */
function attachOrRaiseReview(
  deps: MemoryProposalDeps,
  projectId: string | null,
  phaseId: string | null,
): string {
  const open = findOpenReviewCheckpointId(deps.db, projectId, phaseId);
  if (open !== null) return open;

  const checkpoint = insertCheckpoint(deps.db, deps.activityLog, {
    project_id: projectId,
    task_id: null,
    // Deliberately null even when one employee proposed the first note: the
    // batch belongs to the phase, not to whoever happened to open it, and a
    // second employee's note joining would make an employee id a lie.
    employee_id: null,
    type: 'approval',
    // §12.4: "low-urgency `whenever` checkpoints". `computeExpiresAt`
    // therefore returns null for it — see this file's header for why that is
    // §9.5 holding rather than §9.5 being bent.
    urgency: 'whenever',
    title: 'Memory notes proposed for your review',
    context:
      'Your employees have proposed notes to add to Bureau’s memory. Accepting one means ' +
      'employees will read it on future tasks; rejecting one discards it. Notes proposed for ' +
      'an employee’s own notebook are not listed here — those need no approval.',
    options: [
      {
        id: REVIEW_OPTION_IDS.review,
        label: 'Decide each note',
        consequence:
          'Each note you accept is written to memory and read by employees on future tasks; ' +
          'each note you reject is discarded and recorded as rejected.',
        recommended: true,
        // Opens the per-note review, which writes whatever the user decides
        // there — not something a clock could apply on their behalf (X-9).
        reversible: false,
      },
      {
        id: REVIEW_OPTION_IDS.acceptAll,
        label: 'Accept all of them',
        consequence:
          'Every proposed note is written to memory exactly as written and read by employees ' +
          'on future tasks. You can edit or delete any of them afterwards.',
        // Editable afterwards, but employees may have read it by then, so it
        // is not undoable in the sense §9.2 means (X-9).
        reversible: false,
      },
      {
        id: REVIEW_OPTION_IDS.rejectAll,
        label: 'Reject all of them',
        consequence:
          'Nothing is written to memory. Each note is recorded as rejected, and an employee ' +
          'that still thinks it matters can propose it again.',
        // Nothing is written and it can be proposed again — the reversible
        // one, which is why it is the default below (X-9).
        reversible: true,
      },
    ],
    // Legal on a `whenever` checkpoint and never applied on a clock:
    // `computeExpiresAt` gives it no `expires_at`, so the sweep's query
    // cannot select it (`expiry.ts` — "a `whenever` checkpoint that DOES
    // have a safe default is legal and has no expiry at all"). It is here
    // because rejecting writes nothing and is the reversible answer, so the
    // safe option is stated rather than left for a reader to infer.
    default_action: REVIEW_OPTION_IDS.rejectAll,
    preview: null,
    status: 'pending',
    // All three are §5.1's "permission type only" columns. This is an
    // approval checkpoint, so they stay null — including args_preview, which
    // briefly held the first proposer's id here. Provenance belongs on the
    // proposal rows (proposed_by), which is also the only place that stays
    // true once a second employee's note joins the same review.
    tool_call_id: null,
    tool_name: null,
    args_preview: null,
  });

  return checkpoint.id;
}

// ---- resolution ----------------------------------------------------

export interface ResolveProposalsInput {
  readonly checkpointId: string;
  /** The option the person chose, or the one a system resolution applies. */
  readonly optionId: string | null;
  readonly itemDecisions: readonly MemoryProposalDecision[];
  readonly resolvedBy: string;
  readonly reason: string;
}

export interface ResolveProposalsResult {
  readonly applied: string[];
  readonly rejected: string[];
  /** Set when the answer named an option that needs per-item decisions and
   *  did not give one for every pending note. Nothing is resolved. */
  readonly incomplete: string[] | null;
}

/**
 * Applies one review's decisions. **One place decides accepted-or-rejected
 * for one proposal** — three option ids collapse into a single decision map
 * here rather than three code paths that each write files.
 */
export function resolveMemoryProposals(
  deps: MemoryProposalDeps,
  input: ResolveProposalsInput,
): ResolveProposalsResult {
  const pending = listPendingProposalsForCheckpoint(deps.db, input.checkpointId);
  if (pending.length === 0) return { applied: [], rejected: [], incomplete: null };

  const decisions = new Map<string, 'accept' | 'reject'>();

  if (input.optionId === REVIEW_OPTION_IDS.acceptAll) {
    for (const proposal of pending) decisions.set(proposal.id, 'accept');
  } else if (input.optionId === REVIEW_OPTION_IDS.review) {
    for (const decision of input.itemDecisions)
      decisions.set(decision.proposalId, decision.decision);
    // Exhaustive or nothing. A partial answer would leave notes in a review
    // the user believes they have finished, which is the state this batching
    // exists to prevent.
    const missing = pending.filter((proposal) => !decisions.has(proposal.id)).map((p) => p.id);
    if (missing.length > 0) return { applied: [], rejected: [], incomplete: missing };
  } else {
    // `reject_all`, and every other resolution — a free-text answer, a
    // system resolution. Rejecting writes nothing, so it is what an
    // unrecognised answer must mean (invariant #6, fail closed).
    for (const proposal of pending) decisions.set(proposal.id, 'reject');
  }

  const applied: string[] = [];
  const rejected: string[] = [];

  for (const proposal of pending) {
    const decision = decisions.get(proposal.id) ?? 'reject';
    if (decision === 'accept') {
      if (acceptProposal(deps, proposal, input.resolvedBy)) applied.push(proposal.id);
    } else if (rejectProposal(deps, proposal, input.resolvedBy, input.reason)) {
      rejected.push(proposal.id);
    }
  }

  return { applied, rejected, incomplete: null };
}

function acceptProposal(
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  resolvedBy: string,
): boolean {
  // 1. Layer 1 — the knowledge itself. See this file's header for why this
  //    comes before the bookkeeping rather than after it.
  const existing = getMemoryRowByPath(deps.db, proposal.path);
  const result = writeMemory(deps.db, {
    baseDir: deps.baseDir,
    scope: proposal.scope,
    scopeRef: proposal.scope_ref,
    fileName: proposal.path.split('/').slice(-1)[0] as string,
    title: proposal.title,
    body: proposal.content,
    source: 'observed',
  });

  const row = getMemoryRowByPath(deps.db, result.relativePath);

  // 2. The CAS gates everything below it: lose the race against the expiry
  //    sweep and this returns false, so no second event is emitted for a
  //    proposal somebody else already resolved.
  const won = casProposalResolved(deps.db, proposal.id, {
    status: 'accepted',
    reason: 'accepted',
    resolvedBy,
    appliedMemoryId: row?.id ?? null,
  });
  if (!won) return false;

  // 3. Exactly one event.
  deps.activityLog.logEvent({
    actor: resolvedBy,
    type: 'memory.write_applied',
    severity: 'info',
    project_id: proposal.project_id,
    task_id: null,
    employee_id: proposal.employee_id,
    checkpoint_id: proposal.checkpoint_id,
    payload: {
      change: existing === null ? 'created' : result.changed ? 'updated' : 'unchanged',
      scope: proposal.scope,
      path: result.relativePath,
      memoryId: row?.id ?? null,
      proposalId: proposal.id,
      gated: true,
    },
  });
  return true;
}

function rejectProposal(
  deps: MemoryProposalDeps,
  proposal: MemoryProposal,
  resolvedBy: string,
  reason: string,
): boolean {
  const expired = reason === 'expired';
  const won = casProposalResolved(deps.db, proposal.id, {
    status: expired ? 'expired' : 'rejected',
    reason,
    resolvedBy,
  });
  if (!won) return false;

  // §12.4: "auto-rejected-**with a record** … The rejection is recorded, not
  // silent." Both kinds of rejection get the same event; `reason`
  // distinguishes them, following §5.2's own convention rather than adding
  // taxonomy.
  deps.activityLog.logEvent({
    actor: resolvedBy,
    type: 'memory.write_rejected',
    severity: 'info',
    project_id: proposal.project_id,
    task_id: null,
    employee_id: proposal.employee_id,
    checkpoint_id: proposal.checkpoint_id,
    payload: {
      proposalId: proposal.id,
      scope: proposal.scope,
      path: proposal.path,
      reason,
    },
  });
  return true;
}

// ---- expiry --------------------------------------------------------

export interface ExpireProposalsResult {
  readonly expired: string[];
  /** Reviews resolved because their last pending note expired. */
  readonly closedCheckpoints: string[];
  /** How many the post-restart grace held back. */
  readonly suppressedByGrace: number;
}

/**
 * §12.4's `retention.memoryProposalDays` (default 14), swept on the existing
 * checkpoints tick.
 *
 * The post-restart grace applies, and it is not optional: closing a review
 * is resolving a checkpoint, and CLAUDE.md names *"do not auto-resolve
 * checkpoints in the first ten minutes after a restart"* as a trap in its
 * own right. A user who opens the app after a fortnight away must not watch
 * their review empty itself before they have read it. The grace is read from
 * `postRestartGraceState`, the same one place `resolveExpiredCheckpoints`
 * reads it.
 *
 * Closing the emptied review is the caller's, not this function's — see
 * `checkpointsTick.ts`. This returns which checkpoints are now empty so the
 * one place that answers checkpoints still does it.
 */
export function expireMemoryProposals(
  deps: MemoryProposalDeps,
  options: { readonly nowMs: number; readonly graceActive: boolean },
): ExpireProposalsResult {
  const days = getSetting(deps.db, 'retention.memoryProposalDays');
  const cutoff = new Date(options.nowMs - days * 86_400_000).toISOString();
  const due = listExpiredPendingProposals(deps.db, cutoff);

  if (options.graceActive) {
    // Nothing is resolved and nothing is emitted: not resolving is not a
    // state change. The count is still returned, so a restart report has
    // something real to say — the same shape `resolveExpiredCheckpoints`
    // uses for exactly the same reason.
    return { expired: [], closedCheckpoints: [], suppressedByGrace: due.length };
  }

  const expired: string[] = [];
  const touchedCheckpoints = new Set<string>();

  for (const proposal of due) {
    if (rejectProposal(deps, proposal, 'system:memory_proposal_expiry', 'expired')) {
      expired.push(proposal.id);
      if (proposal.checkpoint_id !== null) touchedCheckpoints.add(proposal.checkpoint_id);
    }
  }

  const closedCheckpoints = [...touchedCheckpoints].filter(
    (checkpointId) => listPendingProposalsForCheckpoint(deps.db, checkpointId).length === 0,
  );

  return { expired, closedCheckpoints, suppressedByGrace: 0 };
}
