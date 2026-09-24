import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import { renderOutboxMessage } from '../engine/supervisor';
import { getDirectorEmployee } from '../db/repositories/employees';
import { markMessageDelivered } from '../db/repositories/messages';
import { getSetting } from '../db/repositories/settings';
import { nowIso } from '../../shared/models/ids';
import type { OutboxMessage } from '../../shared/models/message';
import type { Checkpoint } from '../../shared/models/checkpoint';
import type { AgentEvent } from '../../shared/engine/events';
import type { PricingTable } from '../../shared/models/pricing';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { classifyIntent, type Intent } from './classifyIntent';
import { getDirectorState, transitionDirectorState } from './directorState';
import { assembleDirectorContext } from './assembleDirectorContext';
import { DIRECTOR_CONTEXT_FILE } from '../../shared/engine/directorContextFile';
import { getEmployeeStateDir } from '../db/paths';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DirectorTriggerQueue,
  realTriggerClock,
  startDirectorHeartbeat,
  type DirectorTrigger,
  type DirectorTurn,
  type TriggerClock,
} from './triggerQueue';

/**
 * The trigger queue as the running app uses it (M11 row S1-15): what a turn
 * is delivered through, what counts as idle, what the heartbeat counts as
 * news, and how each producer describes its trigger. `triggerQueue.ts` holds
 * the rules; this holds the wiring, so the rules stay testable on a fake
 * clock and this stays thin.
 *
 * Producers wired in §S1: a user's chat message and a Director-addressed
 * message (both through the message router), an answered blocking
 * checkpoint (`checkpoints.answer`), and the heartbeat. The restart report
 * is S1-20's, and §S2/§S3 rows add theirs.
 */
export interface DirectorTriggers {
  readonly queue: DirectorTriggerQueue;
  /** The router's delivery to the Director. Offering the same message on
   *  every tick until it is delivered is expected; it is one trigger. */
  offerOutboxMessage(message: OutboxMessage): void;
  /** `checkpoints.answer`, for a blocking checkpoint. */
  offerCheckpointAnswered(checkpoint: Checkpoint): void;
  /** Fed every Director event; a turn ending is when the next may go. */
  noteDirectorEvent(event: AgentEvent): void;
  stop(): void;
}

export interface DirectorTriggersDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly supervisorRegistry: SupervisorRegistry;
  readonly clock?: TriggerClock;
  /** §11.5.1's rates, so intent classification's one-shot cost is real. */
  readonly pricing?: PricingTable;
  /** Electron's userData and the bundled packs root: where the Director's
   *  prompt and state live. Without both, no context is written (§8.0.1). */
  readonly baseDir?: string;
  readonly bundledPacksDir?: string;
}

const INTENT_WORDS: Readonly<Record<Intent, string>> = {
  new_work: 'new work',
  question: 'a question',
  answer: 'an answer to your questions',
  chat: 'conversation',
};

/** Which trigger an outbox message is (§26.1). */
export function triggerForOutboxMessage(message: OutboxMessage): DirectorTrigger {
  if (message.from_addr === 'user' && message.kind !== 'answer') {
    return {
      kind: 'user_message',
      key: `message:${message.id}`,
      text: `The user wrote:\n\n${message.body ?? ''}`,
      userText: message.body ?? '',
      messageId: message.id,
    };
  }
  return {
    // An answer to a checkpoint the Director raised is something it is
    // waiting on; an employee's question coalesces with other news.
    kind:
      message.kind === 'answer'
        ? 'checkpoint_answered'
        : message.kind === 'question'
          ? 'ask_director'
          : 'employee_message',
    key: `message:${message.id}`,
    text: renderOutboxMessage(message),
    messageId: message.id,
  };
}

/**
 * The newest event that is news to the Director, for the heartbeat. Its own
 * work (anything carrying its employee id), its own state changes, and the
 * chat and message traffic it takes part in are excluded — each of those
 * either is the Director or reaches it as a trigger of its own. Without
 * this, every turn would be the reason for the next heartbeat.
 */
export function latestNewsSeq(db: Database.Database, directorId: string | null): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(seq), 0) AS seq FROM events
        WHERE (employee_id IS NULL OR employee_id != ?)
          AND type NOT LIKE 'chat.%'
          AND type NOT LIKE 'director.%'
          AND type NOT LIKE 'message.%'`,
    )
    .get(directorId ?? '') as { seq: number };
  return row.seq;
}

export function createDirectorTriggers(deps: DirectorTriggersDeps): DirectorTriggers {
  const { db, activityLog, supervisorRegistry } = deps;
  const clock = deps.clock ?? realTriggerClock;
  const directorSupervisor = () => {
    const director = getDirectorEmployee(db);
    return director === null ? undefined : supervisorRegistry.get(director.id);
  };

  const withIntent = async (turn: DirectorTurn): Promise<string> => {
    const userText = turn.triggers
      .filter((t) => t.kind === 'user_message')
      .map((t) => t.userText ?? '')
      .join('\n\n');
    if (userText.length === 0) return turn.text;
    const conversation = resolveConversationForDelivery(db, null);
    const state = conversation === null ? 'IDLE' : getDirectorState(db, conversation.id).state;
    const { intent } = await classifyIntent(
      {
        db,
        activityLog,
        projectId: conversation?.project_id ?? null,
        ...(deps.pricing === undefined ? {} : { pricing: deps.pricing }),
      },
      { text: userText, awaitingAnswer: state === 'INTAKE' },
    );
    if (intent === 'new_work' && conversation !== null && state === 'IDLE') {
      transitionDirectorState(db, activityLog, conversation.id, 'INTAKE', {
        trigger: 'new_project',
      });
    }
    return `${turn.text}\n\n(Bureau read this message as: ${INTENT_WORDS[intent]}.)`;
  };

  const writeDirectorContext = (directorId: string): void => {
    if (deps.baseDir === undefined || deps.bundledPacksDir === undefined) return;
    const conversation = resolveConversationForDelivery(db, null);
    if (conversation === null) return;
    const assembled = assembleDirectorContext(
      { db, baseDir: deps.baseDir, bundledPacksDir: deps.bundledPacksDir },
      { conversationId: conversation.id },
    );
    const stateDir = getEmployeeStateDir(deps.baseDir, directorId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, DIRECTOR_CONTEXT_FILE), assembled.text, 'utf8');
  };

  const deliverTurn = async (turn: DirectorTurn): Promise<void> => {
    const director = getDirectorEmployee(db);
    const supervisor = director === null ? undefined : supervisorRegistry.get(director.id);
    if (director === null || supervisor === undefined) {
      throw new Error('the Director is not running');
    }
    const messageIds = turn.triggers.flatMap((t) => (t.messageId ? [t.messageId] : []));
    // M11 row S1-16: a turn the user started is classified first, and new
    // work moves the conversation into intake (A.3) — committed, with its
    // event, before the turn is sent (invariant #3).
    const text = await withIntent(turn);
    // M11 context assembly (§8.0.1): what this turn is given, written where
    // the adapter hands it to the CLI. After intent, so a move into intake
    // is already in it.
    writeDirectorContext(director.id);
    // §9.7's order, as the router's: send, then mark. A crash between the
    // two redelivers, which is safe; marking first could lose a message.
    await supervisor.deliverDirectorTurn(text, messageIds);
    const at = nowIso();
    for (const trigger of turn.triggers) {
      if (!trigger.messageId) continue;
      markMessageDelivered(db, trigger.messageId, director.id, at);
      activityLog.logEvent({
        actor: 'system',
        type: 'message.delivered',
        severity: 'info',
        project_id: null,
        task_id: null,
        employee_id: director.id,
        checkpoint_id: null,
        payload: { messageId: trigger.messageId, to: 'director', trigger: trigger.kind },
      });
    }
  };

  const queue = new DirectorTriggerQueue({
    clock,
    coalesceWindowMs: () => getSetting(db, 'director.coalesceWindowSeconds') * 1000,
    isDirectorIdle: () => directorSupervisor()?.currentState === 'idle',
    deliverTurn,
  });

  const heartbeat = startDirectorHeartbeat({
    clock,
    intervalMs: () => getSetting(db, 'reporting.heartbeatMinutes') * 60_000,
    latestEventSeq: () => latestNewsSeq(db, getDirectorEmployee(db)?.id ?? null),
    queue,
  });

  return {
    queue,
    offerOutboxMessage: (message) => {
      queue.offer(triggerForOutboxMessage(message));
    },
    offerCheckpointAnswered: (checkpoint) => {
      if (checkpoint.urgency !== 'blocking') return;
      // The Director's own checkpoint reaches it as the answer message.
      if (
        checkpoint.employee_id !== null &&
        checkpoint.employee_id === getDirectorEmployee(db)?.id
      ) {
        return;
      }
      queue.offer({
        kind: 'checkpoint_answered',
        key: `checkpoint:${checkpoint.id}`,
        text: `A blocking checkpoint was answered: "${checkpoint.title}". Work that was waiting on it can continue.`,
      });
    },
    noteDirectorEvent: (event) => {
      // After the Supervisor has acted on the event, not before: the
      // observer runs first, so the idle state is set a moment later.
      if (event.t === 'finished' || event.t === 'idle' || event.t === 'turn.completed') {
        clock.setTimeout(() => queue.pump(), 0);
      }
    },
    stop: () => {
      heartbeat.stop();
      queue.stop();
    },
  };
}
