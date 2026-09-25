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
import { getConversationById } from '../db/repositories/conversations';
import type { Conversation } from '../../shared/models/conversation';
import {
  companyConversation,
  conversationForProject,
  conversationOfOutboxMessage,
} from './directorConversation';
import { classifyIntent, type Intent } from './classifyIntent';
import { getDirectorState, transitionDirectorState } from './directorState';
import { assembleDirectorContext, type AssembledDirectorContext } from './assembleDirectorContext';
import type { Supervisor } from '../engine/supervisor';
import type { Employee } from '../../shared/models/employee';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import { appendChatMessage } from '../chat/appendMessage';
import { directorBudgetExhausted } from '../cost/budgetEnforcement';
import {
  setConversationDirectorSessionId,
  setConversationSummary,
} from '../db/repositories/conversations';
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
  /** True while a compaction turn runs: its words are a summary for Bureau,
   *  not a reply for the user, so the chat producer stays out of it. */
  isCompacting(): boolean;
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
  /** So compaction's one chat line reaches an open window (§J.4's push). */
  readonly chatBroadcaster?: ChatBroadcaster;
}

/** M11 row S1-18: what the compaction turn asks for. Its reply is stored,
 *  not shown, and seeds the fresh session. */
const COMPACTION_PROMPT =
  'Bureau is about to move you to a fresh session so your context stays focused. Write a ' +
  'structured summary of this conversation so far, for your own use in that session. Use ' +
  'these headings: Goal; What the user has told you; Decisions made; Open questions; Current ' +
  'state of the work; Next steps. Keep every fact you would need and nothing you would not. ' +
  'Reply with the summary only. The user will not see it. Do not call any tools.';

/** The one plain line the chat gets (§8.0.1: "The user is told in one line"). */
const COMPACTION_NOTICE =
  'I condensed our conversation so far into a summary to keep my working memory focused. ' +
  'Nothing you told me was dropped from it.';

const INTENT_WORDS: Readonly<Record<Intent, string>> = {
  new_work: 'new work',
  question: 'a question',
  answer: 'an answer to your questions',
  chat: 'conversation',
};

/** Which trigger an outbox message is (§26.1), and whose conversation it
 *  belongs to (M11 S2-1a). */
export function triggerForOutboxMessage(
  db: Database.Database,
  message: OutboxMessage,
): DirectorTrigger {
  const conversationId = conversationOfOutboxMessage(db, message)?.id ?? null;
  if (message.from_addr === 'user' && message.kind !== 'answer') {
    return {
      conversationId,
      kind: 'user_message',
      key: `message:${message.id}`,
      text: `The user wrote:\n\n${message.body ?? ''}`,
      userText: message.body ?? '',
      messageId: message.id,
    };
  }
  return {
    conversationId,
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

  const withIntent = async (
    turn: DirectorTurn,
    conversation: Conversation | null,
  ): Promise<string> => {
    const userText = turn.triggers
      .filter((t) => t.kind === 'user_message')
      .map((t) => t.userText ?? '')
      .join('\n\n');
    if (userText.length === 0) return turn.text;
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

  const writeDirectorContext = (
    directorId: string,
    conversationId: string | null,
  ): AssembledDirectorContext | null => {
    if (deps.baseDir === undefined || deps.bundledPacksDir === undefined) return null;
    if (conversationId === null) return null;
    const assembled = assembleDirectorContext(
      { db, baseDir: deps.baseDir, bundledPacksDir: deps.bundledPacksDir },
      { conversationId },
    );
    const stateDir = getEmployeeStateDir(deps.baseDir, directorId);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, DIRECTOR_CONTEXT_FILE), assembled.text, 'utf8');
    return assembled;
  };

  // ---- compaction (M11 row S1-18, §8.0.1) ----

  /** Set while a compaction turn runs; its prose is collected here, not
   *  streamed to the chat. */
  let compacting: {
    text: string;
    failed: boolean;
    done: () => void;
  } | null = null;
  /**
   * M11 S2-1a: the conversation whose engine session the Director's adapter
   * holds. Each conversation has its own (`conversations.director_session_id`);
   * a turn in another one switches first, and every session the engine
   * reports is recorded on the conversation it belongs to. `null` at start,
   * so the first turn always switches to its conversation's own session.
   */
  let sessionConversationId: string | null = null;

  const turnsSinceCompaction = (directorId: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM events
            WHERE type = 'employee.idle' AND employee_id = ?
              AND json_extract(payload, '$.reason') = 'turn_completed'
              AND seq > COALESCE((SELECT MAX(seq) FROM events WHERE type = 'director.context_compacted'), 0)`,
        )
        .get(directorId) as { n: number }
    ).n;

  /**
   * One compaction: a turn on the OLD session asks for a structured summary;
   * its prose is collected (never shown); then, if one came back, the summary
   * is written and the session forgotten in one transaction, with one
   * `director.context_compacted` after, and one plain line in the chat. A
   * turn that fails or says nothing changes nothing.
   */
  const compact = async (
    director: Employee,
    supervisor: Supervisor,
    conversationId: string,
    reason: 'turns' | 'context_full',
  ): Promise<void> => {
    const finished = new Promise<void>((resolve) => {
      compacting = { text: '', failed: false, done: resolve };
    });
    await supervisor.deliverDirectorTurn(COMPACTION_PROMPT, [], conversationId);
    await finished;
    const result = compacting as { text: string; failed: boolean } | null;
    compacting = null;
    const summary = result?.text.trim() ?? '';
    if (result === null || result.failed || summary.length === 0) return;

    const turns = turnsSinceCompaction(director.id);
    let previousSessionId: string | null = null;
    db.transaction(() => {
      setConversationSummary(db, conversationId, summary);
      previousSessionId = supervisor.startFreshSession();
    })();
    activityLog.logEvent({
      actor: 'system',
      type: 'director.context_compacted',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: director.id,
      checkpoint_id: null,
      payload: { conversationId, reason, turns, summaryChars: summary.length, previousSessionId },
    });
    appendChatMessage(
      { db, activityLog, ...(deps.chatBroadcaster ? { broadcaster: deps.chatBroadcaster } : {}) },
      {
        conversationId,
        author: 'system',
        kind: 'text',
        body: COMPACTION_NOTICE,
        payload: null,
      },
    );
  };

  // ---- the reserve (M11 row S1-19, §8.0) ----

  /** One notice per exhaustion: set when it is posted, cleared once a turn
   *  is spent again. */
  let exhaustionNoticePosted = false;

  /**
   * §8.0: with the Director's own budget gone, no turn is spawned — a turn
   * is money — and the chat says so in one plain `system` `error` message
   * carrying the `raise_budget` remedy, written here, with no model call.
   */
  const postExhaustionNotice = (
    level: 'project' | 'globalDaily',
    conversation: Conversation | null,
  ): void => {
    if (exhaustionNoticePosted) return;
    if (conversation === null) return;
    exhaustionNoticePosted = true;
    const explanation =
      level === 'project'
        ? "This project's budget is fully spent, including the reserve kept for me, so I can't take another turn. Raise the project budget and I'll pick up your message where it is."
        : "Today's budget is fully spent, including the reserve kept for me, so I can't take another turn. Raise the daily budget and I'll pick up your message where it is.";
    appendChatMessage(
      { db, activityLog, ...(deps.chatBroadcaster ? { broadcaster: deps.chatBroadcaster } : {}) },
      {
        conversationId: conversation.id,
        ...(conversation.project_id ? { projectId: conversation.project_id } : {}),
        author: 'system',
        kind: 'error',
        body: explanation,
        payload: {
          code: 'director_budget_exhausted',
          explanation,
          remedy: { kind: 'raise_budget', targetId: null },
          technical: null,
        },
      },
    );
  };

  const deliverTurn = async (turn: DirectorTurn): Promise<void | 'deferred'> => {
    const director = getDirectorEmployee(db);
    const supervisor = director === null ? undefined : supervisorRegistry.get(director.id);
    if (director === null || supervisor === undefined) {
      throw new Error('the Director is not running');
    }
    // M11 S2-1a: the one conversation this turn belongs to, used by every
    // step below. `null` is the company conversation.
    const conversation =
      turn.conversationId === null
        ? companyConversation(db)
        : getConversationById(db, turn.conversationId);
    const exhausted = directorBudgetExhausted(db, conversation?.project_id ?? null);
    if (exhausted !== null) {
      postExhaustionNotice(exhausted, conversation);
      return 'deferred';
    }
    exhaustionNoticePosted = false;
    const messageIds = turn.triggers.flatMap((t) => (t.messageId ? [t.messageId] : []));
    // M11 row S1-16: a turn the user started is classified first, and new
    // work moves the conversation into intake (A.3) — committed, with its
    // event, before the turn is sent (invariant #3).
    const text = await withIntent(turn, conversation);
    // M11 S2-1a: this conversation's own engine session, before anything
    // runs on it — compaction included, which summarises this conversation.
    if (conversation !== null && sessionConversationId !== conversation.id) {
      await supervisor.switchDirectorSession(
        getConversationById(db, conversation.id)?.director_session_id ?? null,
      );
      sessionConversationId = conversation.id;
    }
    // M11 context assembly (§8.0.1): what this turn is given, written where
    // the adapter hands it to the CLI. After intent, so a move into intake
    // is already in it.
    const assembled = writeDirectorContext(director.id, conversation?.id ?? null);
    // M11 row S1-18: compact first when it is due — after
    // `director.compactAfterTurns` turns, or when the recent conversation no
    // longer fits the budget — then give the fresh session its context.
    if (assembled !== null && conversation !== null) {
      const reason =
        turnsSinceCompaction(director.id) >= getSetting(db, 'director.compactAfterTurns')
          ? 'turns'
          : assembled.dropped.includes('conversation')
            ? 'context_full'
            : null;
      if (reason !== null) {
        await compact(director, supervisor, conversation.id, reason);
        writeDirectorContext(director.id, conversation.id);
      }
    }
    // §9.7's order, as the router's: send, then mark. A crash between the
    // two redelivers, which is safe; marking first could lose a message.
    await supervisor.deliverDirectorTurn(text, messageIds, conversation?.id ?? null);
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
      queue.offer(triggerForOutboxMessage(db, message));
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
        conversationId: conversationForProject(db, checkpoint.project_id)?.id ?? null,
        text: `A blocking checkpoint was answered: "${checkpoint.title}". Work that was waiting on it can continue.`,
      });
    },
    noteDirectorEvent: (event) => {
      // M11 row S1-18: the compaction turn's words are collected, and its
      // end releases the turn waiting behind it.
      if (compacting !== null) {
        if (event.t === 'text.delta') compacting.text += event.text;
        // The turn is over when the process is: `finished` (or a scripted
        // `idle`), never `turn.completed`, which comes before the exit.
        if (event.t === 'finished' || event.t === 'idle') {
          if (event.t === 'finished' && event.reason !== 'completed') compacting.failed = true;
          const done = compacting.done;
          // After the Supervisor has acted on the event, so it is idle.
          clock.setTimeout(done, 0);
        }
        return;
      }
      // M11 S2-1a: the session the engine reports belongs to the
      // conversation it was run for — after compaction too, where it is the
      // fresh one. Recorded only when it changed.
      if (event.t === 'session.started' && event.sessionId !== null && sessionConversationId) {
        const current = getConversationById(db, sessionConversationId);
        if (current !== null && current.director_session_id !== event.sessionId) {
          setConversationDirectorSessionId(db, sessionConversationId, event.sessionId);
        }
      }
      // After the Supervisor has acted on the event, not before: the
      // observer runs first, so the idle state is set a moment later.
      if (event.t === 'finished' || event.t === 'idle' || event.t === 'turn.completed') {
        clock.setTimeout(() => queue.pump(), 0);
      }
    },
    isCompacting: () => compacting !== null,
    stop: () => {
      heartbeat.stop();
      queue.stop();
    },
  };
}
