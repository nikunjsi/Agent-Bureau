import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import { appendChatMessage } from '../chat/appendMessage';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { setDeliverableStatus } from '../db/repositories/deliverables';
import { getPhaseById, setPhaseStatus } from '../db/repositories/phases';
import { getProjectById } from '../db/repositories/projects';
import { getTaskById, insertTask } from '../db/repositories/tasks';
import { conversationForProject } from '../director/directorConversation';
import {
  getDirectorState,
  writeDirectorTransition,
  emitDirectorTransition,
} from '../director/directorState';
import type { WrittenDirectorTransition } from '../director/directorState';
import {
  emitProjectStageChanged,
  setProjectStageByDirector,
  writeUserProjectStage,
  type WrittenProjectStage,
} from './projectStage';
import { runGit, GitCommandError } from '../workspace/gitProcess';
import { getCheckedOutBranch, resolveRef } from '../workspace/gitWorktree';
import type { Phase } from '../../shared/models/phase';
import type { Task } from '../../shared/models/task';

/**
 * Phase review, and §10.6 rule 5 (M11 S3-5a; §8.6, `NEXT-VERSION` §D.2).
 *
 * - **A phase's last task done** → a `phase_review` Director trigger, not
 *   coalesced (§26.1: "a phase's last task completes → phase review | High |
 *   No").
 * - **`requestPhaseReview`** (`bureau_request_review`): the phase and the
 *   project go to review (§8 with A.3), the project's deliverables to
 *   `in_review`, and the review card is posted — what was built, what was
 *   verified, what was **not**, known issues.
 * - **`acceptPhase`** (`phases.accept`, the user's): the Core merges
 *   `bureau/phase/<n>` into `base_ref`, **the only write to it**, and never
 *   moves the branch under the user's own checkout. When `base_ref` is checked
 *   out in the project folder it is updated only if the folder is clean and
 *   the merge is a fast-forward (`git merge --ff-only`, which moves the files
 *   with it). When it is not checked out, the ref moves by compare-and-swap.
 *   Anything else — uncommitted changes, or `base_ref` with commits of its own
 *   since the phase began — raises a `blocker` checkpoint that says why, and
 *   nothing moves. Then the phase is done, and the next one starts (the loop
 *   wakes on `phase.accepted`).
 */

const TERMINAL = new Set(['done', 'cancelled', 'failed']);

/** Every task of the phase is finished (and it has at least one). */
export function isPhaseComplete(db: Database.Database, phaseId: string): boolean {
  const statuses = (
    db.prepare('SELECT status FROM tasks WHERE phase_id = ?').all(phaseId) as { status: string }[]
  ).map((row) => row.status);
  return statuses.length > 0 && statuses.every((status) => TERMINAL.has(status));
}

export interface PhaseWatcherDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly director?: {
    offerPhaseReview(input: { key: string; projectId: string; text: string }): void;
  };
}

export interface PhaseWatcher {
  stop(): void;
}

/** Watches for a phase's last task to finish, and asks for its review. */
export function createPhaseWatcher(deps: PhaseWatcherDeps): PhaseWatcher {
  const unsubscribe = deps.activityLog.onEvent((entry) => {
    if (entry.task_id === null) return;
    if (!['task.completed', 'task.cancelled', 'task.failed'].includes(entry.type)) return;
    const task = getTaskById(deps.db, entry.task_id);
    const phase = task?.phase_id ? getPhaseById(deps.db, task.phase_id) : null;
    if (task === null || phase === null || phase.status !== 'active') return;
    if (!isPhaseComplete(deps.db, phase.id)) return;
    const done = (
      deps.db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE phase_id = ? AND status = 'done'")
        .get(phase.id) as { n: number }
    ).n;
    deps.director?.offerPhaseReview({
      // Per finishing task, not per phase: a phase is reviewed again after
      // the user asks for changes, and the queue never re-sends a key.
      key: `phase-review:${phase.id}:${task.id}`,
      projectId: task.project_id,
      text:
        `Phase ${phase.ordinal}, "${phase.name}" (${phase.goal}), is finished: ${done} task` +
        `${done === 1 ? '' : 's'} done. Review it with the user: call bureau_request_review ` +
        `with phase_id "${phase.id}", what was built in plain words, what was verified, what ` +
        'was NOT verified (never leave it empty — say "nothing" only if that is true), and ' +
        'any known issues. The user then accepts the phase or asks for changes.',
    });
  });
  return { stop: unsubscribe };
}

export interface ReviewInput {
  readonly phaseId: string;
  readonly summary: string;
  readonly verified: readonly string[];
  readonly notVerified: readonly string[];
  readonly knownIssues: readonly string[];
}

export type RequestReviewResult =
  { readonly kind: 'requested' } | { readonly kind: 'refused'; readonly reason: string };

/** `bureau_request_review`: the phase, the project and its deliverables to
 *  review, and the card. The caller has checked the phase is the turn's
 *  project's. */
export function requestPhaseReview(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly broadcaster?: ChatBroadcaster;
  },
  input: ReviewInput,
): RequestReviewResult {
  const { db, activityLog } = deps;
  const phase = getPhaseById(db, input.phaseId);
  if (phase === null) return { kind: 'refused', reason: 'there is no such phase.' };
  if (phase.status !== 'active') {
    return { kind: 'refused', reason: `phase ${phase.ordinal} is ${phase.status}, not active.` };
  }
  if (!isPhaseComplete(db, phase.id)) {
    return {
      kind: 'refused',
      reason: `phase ${phase.ordinal} still has tasks open; review it when every task is finished.`,
    };
  }
  const projectId = projectOfPhase(db, phase);
  const conversation = conversationForProject(db, projectId);
  if (projectId === null || conversation === null) {
    return { kind: 'refused', reason: 'the phase belongs to no project with a conversation.' };
  }

  try {
    setProjectStageByDirector(
      { db, activityLog },
      {
        projectId,
        conversationId: conversation.id,
        to: 'review',
        reason: `Phase ${phase.ordinal} is finished and waits for the user's review.`,
      },
    );
  } catch (err) {
    return { kind: 'refused', reason: (err as Error).message };
  }

  const submitted = db.transaction(() => {
    setPhaseStatus(db, phase.id, 'review');
    const deliverables = db
      .prepare(
        "SELECT id FROM deliverables WHERE project_id = ? AND status IN ('draft', 'rejected')",
      )
      .all(projectId) as { id: string }[];
    for (const d of deliverables) setDeliverableStatus(db, d.id, 'in_review');
    return deliverables.map((d) => d.id);
  })();

  activityLog.logEvent({
    actor: 'director',
    type: 'phase.review_requested',
    severity: 'info',
    project_id: projectId,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      phaseId: phase.id,
      ordinal: phase.ordinal,
      summary: input.summary,
      verified: input.verified,
      notVerified: input.notVerified,
      knownIssues: input.knownIssues,
    },
  });
  for (const deliverableId of submitted) {
    activityLog.logEvent({
      actor: 'director',
      type: 'deliverable.submitted',
      severity: 'info',
      project_id: projectId,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { deliverableId, phaseId: phase.id },
    });
  }

  appendChatMessage(
    { db, activityLog, ...(deps.broadcaster ? { broadcaster: deps.broadcaster } : {}) },
    {
      conversationId: conversation.id,
      projectId,
      author: 'director',
      kind: 'summary',
      body: input.summary,
      payload: {
        phaseName: phase.name,
        phaseId: phase.id,
        verified: [...input.verified],
        notVerified: [...input.notVerified],
        knownIssues: [...input.knownIssues],
        deliverable: null,
      },
    },
  );
  return { kind: 'requested' };
}

export type AcceptPhaseResult =
  | {
      readonly kind: 'accepted';
      readonly baseRef: string;
      readonly commitSha: string;
      readonly last: boolean;
    }
  | { readonly kind: 'blocked'; readonly reason: string; readonly checkpointId: string }
  | { readonly kind: 'refused'; readonly reason: string };

/** `phases.accept`: rule 5, safely, then the phase is done. */
export async function acceptPhase(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly director?: {
      offerUserDecision?(decision: {
        readonly conversationId: string;
        readonly key: string;
        readonly text: string;
      }): void;
    };
  },
  phaseId: string,
): Promise<AcceptPhaseResult> {
  const { db, activityLog } = deps;
  const phase = getPhaseById(db, phaseId);
  if (phase === null) return { kind: 'refused', reason: 'That phase no longer exists.' };
  if (phase.status !== 'review') {
    return { kind: 'refused', reason: `That phase is ${phase.status}, not waiting for review.` };
  }
  const projectId = projectOfPhase(db, phase);
  const project = projectId === null ? null : getProjectById(db, projectId);
  if (project === null) return { kind: 'refused', reason: 'That phase belongs to no project.' };

  const branch = `bureau/phase/${phase.ordinal}`;
  const repo = project.path;
  const git = (args: string[], acceptExitCodes?: readonly number[]) =>
    runGit(args, { cwd: repo, repoKey: repo, ...(acceptExitCodes ? { acceptExitCodes } : {}) });

  const phaseSha = await resolveRef(repo, `refs/heads/${branch}`);
  const baseSha = await resolveRef(repo, `refs/heads/${project.base_ref}`);
  const ancestor = await git(['merge-base', '--is-ancestor', baseSha, phaseSha], [0, 1]);
  if (ancestor.exitCode !== 0) {
    return blocked(
      deps,
      project.id,
      `${project.base_ref} has new commits of its own since phase ${phase.ordinal} began, so ` +
        `merging the phase into it is not a simple fast-forward. Bureau does not merge into your ` +
        `branch on its own: nothing was moved.`,
    );
  }

  let checkedOut = false;
  try {
    checkedOut = (await getCheckedOutBranch(repo)) === project.base_ref;
  } catch (err) {
    if (!(err instanceof GitCommandError)) throw err;
  }
  if (checkedOut) {
    const status = await git(['status', '--porcelain']);
    if (status.stdout.trim() !== '') {
      return blocked(
        deps,
        project.id,
        `Your project folder has ${project.base_ref} checked out and uncommitted changes in it, ` +
          `so Bureau did not move ${project.base_ref} under you: nothing was moved. Commit or ` +
          'put those changes aside, then accept the phase again.',
      );
    }
    await git(['merge', '--ff-only', branch]);
  } else {
    await git([
      'update-ref',
      '-m',
      `bureau: accept phase ${phase.ordinal}`,
      `refs/heads/${project.base_ref}`,
      phaseSha,
      baseSha,
    ]);
  }

  const remaining = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM phases WHERE plan_id = ? AND ordinal > ? AND status NOT IN ('done', 'skipped')",
      )
      .get(phase.plan_id, phase.ordinal) as { n: number }
  ).n;
  const last = remaining === 0;
  const conversation = conversationForProject(db, project.id);
  let stage: WrittenProjectStage | null = null;
  const transitions: WrittenDirectorTransition[] = [];
  db.transaction(() => {
    setPhaseStatus(db, phase.id, 'done');
    if (project.stage === 'review') {
      stage = writeUserProjectStage(db, {
        projectId: project.id,
        to: last ? 'delivered' : 'executing',
        reason: `The user accepted phase ${phase.ordinal}.`,
      });
    }
    if (conversation !== null && getDirectorState(db, conversation.id).state === 'PHASE_REVIEW') {
      transitions.push(
        writeDirectorTransition(db, conversation.id, 'SUPERVISING', { trigger: 'phase_accepted' }),
      );
      if (last) {
        transitions.push(
          writeDirectorTransition(db, conversation.id, 'DELIVERING', {
            trigger: 'all_phases_done',
          }),
        );
      }
    }
  })();

  activityLog.logEvent({
    actor: 'system',
    type: 'git.merged',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      from: branch,
      into: project.base_ref,
      commitSha: phaseSha,
      fastForward: true,
      checkedOut,
    },
  });
  activityLog.logEvent({
    actor: 'user',
    type: 'phase.accepted',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      phaseId: phase.id,
      ordinal: phase.ordinal,
      mergedInto: project.base_ref,
      commitSha: phaseSha,
    },
  });
  if (stage !== null) emitProjectStageChanged(activityLog, 'user', stage);
  for (const transition of transitions) emitDirectorTransition(activityLog, transition);

  if (conversation !== null) {
    deps.director?.offerUserDecision?.({
      conversationId: conversation.id,
      key: `phase-accepted:${phase.id}`,
      text: last
        ? `The user accepted phase ${phase.ordinal}, "${phase.name}", the last one: its work is ` +
          `merged into ${project.base_ref}. Write the handover: what exists, how to run it, how ` +
          'it is structured, what to do next, and what was deliberately left out.'
        : `The user accepted phase ${phase.ordinal}, "${phase.name}": its work is merged into ` +
          `${project.base_ref}, and the next phase starts now.`,
    });
  }
  return { kind: 'accepted', baseRef: project.base_ref, commitSha: phaseSha, last };
}

function blocked(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  projectId: string,
  reason: string,
): AcceptPhaseResult {
  const checkpoint = insertCheckpoint(deps.db, deps.activityLog, {
    project_id: projectId,
    type: 'blocker',
    urgency: 'blocking',
    title: 'The phase could not be merged into your branch',
    context: reason,
    options: [
      {
        id: 'accept_again',
        label: 'I have sorted it out; accept the phase again',
        consequence: 'Bureau tries the merge again when you accept the phase.',
        reversible: true,
      },
      {
        id: 'leave_it',
        label: 'Leave it for now',
        consequence: 'The phase stays in review and your branch stays as it is.',
        reversible: true,
      },
    ],
    // The safe option: nothing moves, so a timeout applying it is harmless.
    default_action: 'leave_it',
  });
  return { kind: 'blocked', reason, checkpointId: checkpoint.id };
}

function projectOfPhase(db: Database.Database, phase: Phase): string | null {
  return (
    (
      db.prepare('SELECT project_id FROM plans WHERE id = ?').get(phase.plan_id) as
        { project_id: string } | undefined
    )?.project_id ?? null
  );
}

export type RequestChangesResult =
  | { readonly kind: 'queued'; readonly taskId: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * `phases.requestChanges` (M11 S3-5b, §8.6): *"Requests changes (free text →
 * becomes tasks in the current phase)."* One transaction: the user's words
 * become a task in the phase (with the skills and deliverable type of the
 * phase's own work, so whoever did it can pick it up), the phase is `active`
 * again, its deliverables go back to `draft`, the project back to
 * `executing`, and the Director to `SUPERVISING` (A.3's `changes_queued`).
 * Then one event each, and the Director is told. The loop assigns the task;
 * when it is done the phase watcher asks for the review again.
 */
export function requestPhaseChanges(
  deps: {
    readonly db: Database.Database;
    readonly activityLog: ActivityLog;
    readonly director?: {
      offerUserDecision?(decision: {
        readonly conversationId: string;
        readonly key: string;
        readonly text: string;
      }): void;
    };
  },
  input: { readonly phaseId: string; readonly feedback: string },
): RequestChangesResult {
  const { db, activityLog } = deps;
  const phase = getPhaseById(db, input.phaseId);
  if (phase === null) return { kind: 'refused', reason: 'That phase no longer exists.' };
  if (phase.status !== 'review') {
    return { kind: 'refused', reason: `That phase is ${phase.status}, not waiting for review.` };
  }
  const projectId = projectOfPhase(db, phase);
  const project = projectId === null ? null : getProjectById(db, projectId);
  if (project === null) return { kind: 'refused', reason: 'That phase belongs to no project.' };
  const model = db
    .prepare(
      "SELECT required_skills, deliverable_type FROM tasks WHERE phase_id = ? AND status = 'done' ORDER BY rowid LIMIT 1",
    )
    .get(phase.id) as { required_skills: string; deliverable_type: string | null } | undefined;
  const conversation = conversationForProject(db, project.id);
  const firstLine = input.feedback.split('\n')[0]!.trim();

  let stage: WrittenProjectStage | null = null;
  const transitions: WrittenDirectorTransition[] = [];
  const written = db.transaction(() => {
    const task = insertTask(db, {
      project_id: project.id,
      phase_id: phase.id,
      title: `Changes asked for: ${firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine}`,
      body: `The user reviewed phase ${phase.ordinal}, "${phase.name}", and asked for changes:\n\n${input.feedback}`,
      acceptance_criteria: [`The change the user asked for is made: ${input.feedback}`],
      required_skills: model ? (JSON.parse(model.required_skills) as string[]) : [],
      deliverable_type: (model?.deliverable_type ?? null) as Task['deliverable_type'],
    });
    setPhaseStatus(db, phase.id, 'active');
    const reopened = db
      .prepare("SELECT id FROM deliverables WHERE project_id = ? AND status = 'in_review'")
      .all(project.id) as { id: string }[];
    for (const d of reopened) setDeliverableStatus(db, d.id, 'draft');
    if (project.stage === 'review') {
      stage = writeUserProjectStage(db, {
        projectId: project.id,
        to: 'executing',
        reason: `The user asked for changes to phase ${phase.ordinal}.`,
      });
    }
    if (conversation !== null && getDirectorState(db, conversation.id).state === 'PHASE_REVIEW') {
      transitions.push(
        writeDirectorTransition(db, conversation.id, 'SUPERVISING', { trigger: 'changes_queued' }),
      );
    }
    return { task, reopened: reopened.map((d) => d.id) };
  })();

  activityLog.logEvent({
    actor: 'user',
    type: 'phase.changes_requested',
    severity: 'info',
    project_id: project.id,
    task_id: written.task.id,
    employee_id: null,
    checkpoint_id: null,
    payload: { phaseId: phase.id, ordinal: phase.ordinal, feedback: input.feedback },
  });
  activityLog.logEvent({
    actor: 'user',
    type: 'task.created',
    severity: 'info',
    project_id: project.id,
    task_id: written.task.id,
    employee_id: null,
    checkpoint_id: null,
    payload: { reason: 'changes_requested', phaseId: phase.id },
  });
  for (const deliverableId of written.reopened) {
    activityLog.logEvent({
      actor: 'user',
      type: 'deliverable.updated',
      severity: 'info',
      project_id: project.id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { deliverableId, status: 'draft', reason: 'changes_requested' },
    });
  }
  if (stage !== null) emitProjectStageChanged(activityLog, 'user', stage);
  for (const transition of transitions) emitDirectorTransition(activityLog, transition);

  if (conversation !== null) {
    deps.director?.offerUserDecision?.({
      conversationId: conversation.id,
      key: `phase-changes:${written.task.id}`,
      text:
        `The user asked for changes to phase ${phase.ordinal}, "${phase.name}": "${input.feedback}". ` +
        `Bureau queued it as ${written.task.display_key} in the phase, and it will be assigned. ` +
        'If it is really several changes, split it (send it back with bureau_reject_task and ' +
        'a follow-up for each part). The phase is reviewed again when its tasks are done.',
    });
  }
  return { kind: 'queued', taskId: written.task.id };
}
