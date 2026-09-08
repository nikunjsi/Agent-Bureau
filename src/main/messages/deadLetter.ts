import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { insertCheckpoint } from '../db/repositories/checkpoints';
import { markMessageDeadLettered } from '../db/repositories/messages';
import { getEmployeeById } from '../db/repositories/employees';
import { getTaskById } from '../db/repositories/tasks';
import { describeAddress, parseMessageAddress } from './addressing';
import type { OutboxMessage } from '../../shared/models/message';
import type { Checkpoint } from '../../shared/models/checkpoint';

/**
 * §9.7's dead letter, and the one place a message reaches it.
 *
 * Two roads arrive here and they are genuinely different:
 *
 *   1. **Exhausted retries** — `adapter.send()` threw six times across
 *      §9.7's ladder (5s → 30s → 2m → 10m → 30m).
 *   2. **A structurally undeliverable address** — an employee that does not
 *      exist, one that has been fired, an unknown role, an address that
 *      parses to nothing. No amount of waiting fixes any of these, so
 *      running the ladder first would only delay the checkpoint by 43
 *      minutes.
 *
 * Both end in the same state and the same event, in one function, so
 * "what happens to a dead-lettered message" cannot drift between them.
 *
 * ## Why a question gets a checkpoint and a status update does not
 *
 * §9.7: "If `kind = 'question'`, also raises a `blocker` checkpoint — a
 * question that silently disappeared is the worst possible outcome." A
 * `status` or `finding` message that never lands is a lost notification; a
 * question that never lands is an employee waiting forever for an answer
 * nobody knows it needs.
 */

export interface DeadLetterDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
}

export interface DeadLetterResult {
  readonly messageId: string;
  /** Null unless `kind === 'question'`. */
  readonly blockerCheckpoint: Checkpoint | null;
}

export function deadLetterMessage(
  deps: DeadLetterDeps,
  message: OutboxMessage,
  reason: string,
): DeadLetterResult {
  // The state change is committed before the side effects it causes
  // (invariant #3): the row is dead-lettered, then its event, then the
  // checkpoint — which emits its own `checkpoint.raised` from inside
  // `insertCheckpoint`, session 1's one door.
  markMessageDeadLettered(deps.db, message.id, message.attempts);

  deps.activityLog.logEvent({
    actor: 'system',
    type: 'message.dead_lettered',
    severity: 'warn',
    project_id: null,
    task_id: message.task_id,
    employee_id: message.resolved_employee_id,
    checkpoint_id: null,
    payload: {
      messageId: message.id,
      to: message.to_addr,
      from: message.from_addr,
      kind: message.kind,
      attempts: message.attempts,
      reason,
    },
  });

  if (message.kind !== 'question') return { messageId: message.id, blockerCheckpoint: null };

  return {
    messageId: message.id,
    blockerCheckpoint: raiseUndeliveredQuestionCheckpoint(deps, message, reason),
  };
}

/**
 * ## Addressed to the SENDER, not to the unreachable target
 *
 * The employee waiting is the one that asked. Addressing the checkpoint to
 * them is not a presentation choice — it is what makes both options honest
 * with no new machinery, because session 1's `answerCheckpoint` already
 * routes an answer back to `checkpoint.employee_id` through this same
 * outbox. So "you answer instead" genuinely reaches the asker, and "drop
 * it" genuinely tells them.
 *
 * ## No `default_action`, therefore no `expires_at`
 *
 * `computeExpiresAt` returns null when there is no safe default, so this
 * checkpoint cannot be selected by the timeout sweep at all — invariant #7
 * holding structurally rather than by a check somebody has to remember. And
 * it is the right answer on its own terms: a question that already went
 * missing once must never be resolved a second time by a clock.
 */
function raiseUndeliveredQuestionCheckpoint(
  deps: DeadLetterDeps,
  message: OutboxMessage,
  reason: string,
): Checkpoint {
  const target = describeAddress(parseMessageAddress(message.to_addr));
  const sender = getEmployeeById(deps.db, message.from_addr);
  const senderName = sender?.name ?? 'An employee';
  const task = message.task_id === null ? null : getTaskById(deps.db, message.task_id);

  return insertCheckpoint(deps.db, deps.activityLog, {
    project_id: task?.project_id ?? null,
    task_id: message.task_id,
    employee_id: sender?.id ?? null,
    type: 'blocker',
    urgency: 'blocking',
    title: `${senderName} asked a question that could not be delivered`,
    context:
      `${senderName} sent a question to ${target}, and it could not be delivered ` +
      `(${reason}). Bureau has stopped trying. Nobody is going to answer it unless ` +
      `you do, and ${senderName} is waiting on it.`,
    preview: {
      kind: 'undelivered_message',
      to: message.to_addr,
      subject: message.subject,
      body: message.body,
    },
    options: [
      {
        id: 'answer_here',
        label: 'Answer it yourself',
        detail: 'Write the answer below instead of waiting for whoever it was addressed to.',
        consequence: `Your answer is delivered to ${senderName}, who continues from there.`,
        recommended: true,
      },
      {
        id: 'drop',
        label: 'Drop the question',
        detail: 'Nobody answers it.',
        consequence: `${senderName} is told the question was dropped and stays blocked until you give them something else to do.`,
      },
    ],
    // Deliberately null. See this function's own comment: no safe default
    // means no expiry, which means this can never be auto-resolved.
    default_action: null,
  });
}
