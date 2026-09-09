import { nowIso } from '../../shared/models/ids';
import {
  getConversationMessageById,
  insertConversationMessage,
} from '../db/repositories/conversationMessages';
import type { ConversationMessage } from '../../shared/models/conversationMessage';
import type { ConversationMessageStatus } from '../../shared/models/enums';
import { broadcast, logPersisted, type ChatDeps } from './appendMessage';

/**
 * §5.1's "Streaming (MUST)", and §28 M9 item 2.
 *
 * > The row is inserted with `status='streaming'` before the first token,
 * > updated on a throttle (every ~500 ms) and once at completion — not per
 * > token, which would hammer the database. §4.4's "commit before acting"
 * > cannot apply token-by-token, and this is the documented exception.
 *
 * §14.2's reason for streaming at all is worth keeping in view while
 * reading the throttle: *"Long silences are worse than partial output."*
 * The throttle is the largest silence this is allowed to produce.
 *
 * ## Three states, one decision each, made here
 *
 * `streaming` -> `complete` (the generation ended normally), or
 * `streaming` -> `aborted` (it did not). **`aborted` has two causes and one
 * meaning**: `chat.stop` (this file) and a crash mid-stream (`reconcile()`
 * -> `abortStaleStreamingMessages`, M1). They deliberately produce the same
 * row state, so the renderer has one thing to render and a user has one
 * thing to understand — "this reply was interrupted" — rather than a
 * truncated message that reads as if it finished, which is the actual
 * failure mode being designed against.
 *
 * Nothing about "is this still streaming" is computed anywhere else. The
 * renderer reads `status`; it does not infer.
 */

/** §5.1's "~500 ms". */
const DEFAULT_FLUSH_INTERVAL_MS = 500;

export interface ChatStreamOptions {
  readonly conversationId: string;
  readonly projectId?: string | null;
  /** Streams are the Director speaking. Kept as a parameter rather than
   * hardcoded because §5.1's `author` column is the fact, not an
   * assumption this class gets to make. */
  readonly author?: 'director' | 'system';
  readonly flushIntervalMs?: number;
}

export type StreamEndReason = 'completed' | 'stopped_by_user' | 'error';

/**
 * One in-flight streamed message. Created through `ChatStreamRegistry`,
 * never directly — `chat.stop` has to be able to find it, and a stream
 * nobody can find is a stream nobody can stop.
 */
export class ChatStream {
  private buffer = '';
  private body = '';
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private ended = false;

  private constructor(
    private readonly deps: ChatDeps,
    readonly messageId: string,
    readonly conversationId: string,
    private readonly flushIntervalMs: number,
  ) {}

  static begin(deps: ChatDeps, options: ChatStreamOptions): ChatStream {
    const message = insertConversationMessage(deps.db, {
      conversation_id: options.conversationId,
      project_id: options.projectId ?? null,
      author: options.author ?? 'director',
      kind: 'text',
      body: '',
      payload: null,
      checkpoint_id: null,
      status: 'streaming',
    });
    // Two events, because two things happened: a row exists that did not
    // exist (`chat.message_persisted`, the same event any other message
    // gets), and a stream began (`chat.stream_started`). Invariant #3 is
    // "one event per state change", not "one event per function call".
    logPersisted(deps, message);
    deps.activityLog.logEvent({
      actor: 'system',
      type: 'chat.stream_started',
      severity: 'info',
      project_id: message.project_id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { messageId: message.id, conversationId: message.conversation_id },
    });
    broadcast(deps, message);
    return new ChatStream(
      deps,
      message.id,
      options.conversationId,
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
  }

  /**
   * Accumulate text. Writes are coalesced: the first delta after a quiet
   * period schedules a flush `flushIntervalMs` out, and every delta before
   * that flush joins it. So N deltas inside one window cost exactly one
   * UPDATE and one push, regardless of N.
   */
  append(text: string): void {
    if (this.ended || text.length === 0) return;
    this.buffer += text;
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush('streaming');
    }, this.flushIntervalMs);
    // A pending flush must never hold the process open — a stream that is
    // still buffering when the app quits is exactly the crash case
    // reconcile() already handles.
    this.flushTimer.unref?.();
  }

  /** The generation ended normally. */
  complete(): ConversationMessage | null {
    return this.end('complete', 'chat.stream_completed', { reason: 'completed' });
  }

  /**
   * The generation did not finish. `chat.stop` is the user-driven cause;
   * an engine error is the other. Both land on `aborted`, which is also
   * where a crashed stream lands after `reconcile()` — one state, one
   * rendering, three causes, distinguished in the event payload rather
   * than in the row (a row that distinguished them would invite the
   * renderer to render them differently, and "interrupted" is the whole
   * message a user needs).
   */
  abort(reason: StreamEndReason = 'stopped_by_user'): ConversationMessage | null {
    return this.end('aborted', 'chat.stream_aborted', { reason });
  }

  /** Test/diagnostic accessor — what has actually been written so far, as
   * distinct from what has been appended but not yet flushed. */
  get persistedBody(): string {
    return this.body;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private end(
    status: Extract<ConversationMessageStatus, 'complete' | 'aborted'>,
    eventType: 'chat.stream_completed' | 'chat.stream_aborted',
    payload: Record<string, unknown>,
  ): ConversationMessage | null {
    if (this.ended) return null;
    this.ended = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Whatever arrived is kept. An aborted reply showing the words it got
    // through is more useful than an empty one, and the marker — not the
    // emptiness — is what tells the user it was interrupted.
    const message = this.flush(status);
    if (message === null) return null;
    this.deps.activityLog.logEvent({
      actor: 'system',
      type: eventType,
      severity: 'info',
      project_id: message.project_id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { ...payload, messageId: message.id, conversationId: message.conversation_id },
    });
    broadcast(this.deps, message);
    return message;
  }

  /** The single UPDATE. Also the only place `updated_at` moves for a
   * streamed row, so "when did this last make progress" has one answer. */
  private flush(status: ConversationMessageStatus): ConversationMessage | null {
    this.body += this.buffer;
    this.buffer = '';
    this.deps.db
      .prepare('UPDATE conversation_messages SET body = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(this.body, status, nowIso(), this.messageId);
    const message = getConversationMessageById(this.deps.db, this.messageId);
    // A mid-stream flush is not a state change in §5.2's sense — the row
    // is still `streaming`, and the taxonomy has no "a bit more text
    // arrived" type. It gets a push and no event; the two state changes
    // (started, ended) get both.
    if (message !== null && status === 'streaming') broadcast(this.deps, message);
    return message;
  }
}

/**
 * Every live stream, by conversation. This is what `chat.stop` reaches
 * (§28 M9 item 3) and what shutdown drains.
 *
 * One stream per conversation, deliberately: two Director replies
 * streaming into the same conversation at once is not a state the product
 * has, and allowing it would make "stop this conversation" ambiguous.
 */
export class ChatStreamRegistry {
  private readonly live = new Map<string, ChatStream>();

  constructor(private readonly deps: ChatDeps) {}

  begin(options: ChatStreamOptions): ChatStream {
    const existing = this.live.get(options.conversationId);
    if (existing !== undefined && !existing.isEnded) {
      throw new Error(
        `a stream is already live in conversation ${options.conversationId} — stop it before starting another`,
      );
    }
    const stream = ChatStream.begin(this.deps, options);
    this.live.set(options.conversationId, stream);
    return stream;
  }

  get(conversationId: string): ChatStream | null {
    const stream = this.live.get(conversationId);
    return stream === undefined || stream.isEnded ? null : stream;
  }

  /**
   * `chat.stop`. Returns whether anything was actually stopped — the honest
   * answer matters here: two windows can both press stop, and the second
   * press must report that it stopped nothing rather than claiming a
   * success that did nothing (the same reasoning that gave
   * `answerPermission` its `holdReleased`).
   */
  stop(conversationId: string): boolean {
    const stream = this.get(conversationId);
    if (stream === null) return false;
    stream.abort('stopped_by_user');
    this.live.delete(conversationId);
    return true;
  }

  /** Shutdown. A stream still live when the app quits would otherwise be
   * left for `reconcile()` to abort on the next launch — which works, but
   * marks it as a crash when it was an orderly quit. */
  abortAll(reason: StreamEndReason = 'error'): number {
    let stopped = 0;
    for (const [conversationId, stream] of this.live) {
      if (stream.isEnded) continue;
      stream.abort(reason);
      this.live.delete(conversationId);
      stopped += 1;
    }
    return stopped;
  }
}
