import type Database from 'better-sqlite3';
import { listPendingCheckpoints } from '../db/repositories/checkpoints';
import { getSetting } from '../db/repositories/settings';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { appendChatMessage } from '../chat/appendMessage';
import { groupPendingCheckpoints } from './batching';
import type { Checkpoint } from '../../shared/models/checkpoint';
import type { ActivityLog } from '../db/activityLog';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';

/**
 * §9.4 — surfacing. "A pending checkpoint appears in **four** places, all
 * reflecting one piece of state."
 *
 * Two of the four are still not this module's: the Checkpoints view badge
 * (M9/M14) and the floor signal (M12). The desktop notification was the
 * first one that could be real, and **surface 1 — the chat card — joined
 * it at pre-M11 X-9's neighbour X-11**: `MessageRow.tsx` had rendered a
 * `checkpoint` message since M9, and nothing in the Core had ever written
 * one, so §9.4's *primary* surface was reachable only from an e2e seed.
 * Both live here, so one module owns "how a pending checkpoint reaches a
 * human".
 *
 * ## Which checkpoints get a card, and which wait
 *
 * Only `grouped.immediate` — `blocking` and every `permission` (§9.3: those
 * are never batched). §9.3 says the rest are "grouped by the Director into
 * one message", and the Director is M11: writing a card per checkpoint for
 * them now would be the Director's message, sent by the wrong author, and
 * would have to be unpicked when the real one arrives. A checkpoint inside
 * its window is therefore announced by nothing yet, which is the state
 * §9.3 describes rather than a gap this module should fill.
 *
 * ## "One piece of state" is satisfied by sharing the function, not by
 * agreeing
 *
 * This calls `listPendingCheckpoints` — the exact function the
 * `checkpoints.listPending` IPC handler calls. Two queries that return the
 * same rows today are two definitions of "pending" that are free to drift;
 * one function cannot. That is the whole content of §9.4's "all reflecting
 * one piece of state" as far as M8 can honour it.
 *
 * ## Batching gets its first caller
 *
 * `groupPendingCheckpoints` (§9.3) has been written, pure and tested, with
 * nothing calling it since session 1. This is it. §9.3's grouping is
 * ultimately "done by the Director into one message" — the Director is M11
 * and the message is M9 — so what this module consumes today is the
 * grouping's *decision*: which checkpoints are surfaceable now, and which
 * are still inside their window.
 *
 * ## The grace does NOT gate this
 *
 * `resolveExpiredCheckpoints` suppresses auto-resolution for
 * `checkpoints.postRestartGraceMinutes` after a restart. That grace exists
 * to stop Bureau **applying a decision** on the user's behalf while they
 * were away — §9.6's own next sentence is that the Director "surfaces them
 * in its restart report instead", so surfacing during the grace is exactly
 * what should happen. A user who opens the app to a backlog and hears
 * nothing about it for ten minutes is the failure the grace was written to
 * prevent, arriving by another route. Surfacing runs every tick, including
 * inside the grace window, and `checkpointsTick.ts` calls the two
 * independently for this reason.
 */

/** The seam. `electron`'s `Notification` and `BrowserWindow` cannot be
 *  imported by anything the vitest suites load, and this module is loaded
 *  by them — so the Electron half lives in `desktopNotifier.ts` behind
 *  this interface, and is proven separately inside the real packaged app
 *  (`smoketest/notifications.ts`). */
export interface CheckpointNotifier {
  isAnyWindowFocused(): boolean;
  notify(input: { readonly title: string; readonly body: string }): void;
}

export type NotificationSkipReason =
  /** §9.4: "if the window is unfocused **and** urgency is `blocking`." */
  | 'not_blocking'
  | 'window_focused'
  /** `general.notifications` — the user's own switch. */
  | 'notifications_disabled'
  /** Already announced by an earlier pass; see `notified` below. */
  | 'already_notified'
  /** Its batch window has not closed (§9.3). */
  | 'still_batching';

export interface SurfacingReport {
  /** Surfaced on their own, now: `blocking` and every `permission`. */
  readonly immediate: string[];
  /** Groups of two or more whose window has closed. */
  readonly batches: string[][];
  /** Closed windows holding exactly one. */
  readonly settled: string[];
  /** Windows still open — nothing to do yet. */
  readonly waiting: string[];
  /** Checkpoint ids a desktop notification actually fired for. */
  readonly notified: string[];
  readonly skipped: { readonly id: string; readonly reason: NotificationSkipReason }[];
  /** Checkpoint ids this pass wrote a chat card for (X-11). */
  readonly chatted: string[];
}

/**
 * What writing surface 1 needs. Required rather than optional: a surfacer
 * built without it would notify and quietly never write the card, which is
 * the state X-11 found and is indistinguishable from working.
 */
export interface CheckpointChatDeps {
  readonly activityLog: ActivityLog;
  /** Absent in tests; the app passes the one instance every writer shares. */
  readonly broadcaster?: ChatBroadcaster;
}

export interface SurfacingOptions {
  readonly notifier: CheckpointNotifier;
  /** Epoch ms. Injected, so a batch window can be driven at real instants. */
  readonly nowMs: number;
}

/**
 * Holds the one piece of state surfacing needs that the database does not
 * already have: which pending checkpoints have already been announced.
 *
 * In memory, and deliberately session-local. A restart re-announces
 * whatever is still pending, which is the right direction — the alternative
 * is a user who closes the laptop on an unanswered blocking question and is
 * never told about it again. Pruned against the live pending set on every
 * pass, so it cannot grow past what is actually outstanding.
 */
export class CheckpointSurfacer {
  private readonly notified = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly chat: CheckpointChatDeps,
  ) {}

  surface(options: SurfacingOptions): SurfacingReport {
    const pending = listPendingCheckpoints(this.db);
    this.prune(pending);

    const grouped = groupPendingCheckpoints(pending, {
      batchWindowSeconds: getSetting(this.db, 'checkpoints.batchWindowSeconds'),
      nowMs: options.nowMs,
    });

    const notified: string[] = [];
    const skipped: { id: string; reason: NotificationSkipReason }[] = [];
    const notificationsEnabled = getSetting(this.db, 'general.notifications');
    // Read ONCE per pass, not per checkpoint: focus can genuinely change
    // mid-loop, and half a batch notifying is worse than either outcome.
    const focused = options.notifier.isAnyWindowFocused();

    for (const checkpoint of grouped.waiting) {
      skipped.push({ id: checkpoint.id, reason: 'still_batching' });
    }

    // Surface 1 first: the card is where the question is answered, and the
    // toast only points at it. A notification for a checkpoint the chat has
    // not been told about yet would send the user somewhere empty.
    const chatted: string[] = [];
    for (const checkpoint of grouped.immediate) {
      if (this.writeChatCard(checkpoint)) chatted.push(checkpoint.id);
    }

    const surfaceable = [...grouped.immediate, ...grouped.batches.flat(), ...grouped.settled];
    for (const checkpoint of surfaceable) {
      const reason = this.skipReason(checkpoint, { notificationsEnabled, focused });
      if (reason !== null) {
        skipped.push({ id: checkpoint.id, reason });
        continue;
      }
      this.notified.add(checkpoint.id);
      options.notifier.notify({
        title: checkpoint.title,
        // §9.2's own rule about non-experts applies to the toast too: the
        // context sentence is what makes a notification worth reading.
        body: checkpoint.context,
      });
      notified.push(checkpoint.id);
    }

    return {
      immediate: grouped.immediate.map(idOf),
      batches: grouped.batches.map((batch) => batch.map(idOf)),
      settled: grouped.settled.map(idOf),
      waiting: grouped.waiting.map(idOf),
      notified,
      skipped,
      chatted,
    };
  }

  /**
   * Writes §9.4's surface 1 for one checkpoint, and says whether it wrote.
   *
   * **Idempotent against the database, not against a set in memory.** The
   * notified set above can be session-local because re-announcing an
   * unanswered question after a restart is the right direction; a second
   * card is not — it would be a duplicate in the transcript that outlives
   * the process that wrote it. So the check is a query on the row's own
   * `checkpoint_id`, which is true across restarts and across whoever else
   * writes one later (the Director, M11).
   *
   * A company with no conversation yet writes nothing: that is the
   * first-run window before the Director exists, and the checkpoint is
   * still pending, so the next tick with a conversation picks it up.
   */
  private writeChatCard(checkpoint: Checkpoint): boolean {
    const existing = this.db
      .prepare(
        "SELECT 1 FROM conversation_messages WHERE checkpoint_id = ? AND kind = 'checkpoint' LIMIT 1",
      )
      .get(checkpoint.id);
    if (existing !== undefined) return false;

    const conversation = resolveConversationForDelivery(this.db, checkpoint.project_id);
    if (conversation === null) return false;

    appendChatMessage(
      {
        db: this.db,
        activityLog: this.chat.activityLog,
        // `exactOptionalPropertyTypes`: an absent broadcaster and one set to
        // `undefined` are different types, and `appendChatMessage` defaults
        // the absent one to the no-op.
        ...(this.chat.broadcaster === undefined ? {} : { broadcaster: this.chat.broadcaster }),
      },
      {
        conversationId: conversation.id,
        projectId: checkpoint.project_id,
        author: 'director',
        kind: 'checkpoint',
        // The card itself renders from the `checkpoints` row (§9.4's "one
        // piece of state"). This body is what the transcript keeps once the
        // checkpoint is no longer pending and `AnsweredCheckpointNote`
        // replaces the card — so it is the question, not "a decision is
        // waiting", which would read as nonsense a week later.
        body: checkpoint.title,
        checkpointId: checkpoint.id,
      },
    );
    return true;
  }

  /** Null means "notify". The order is the order §9.4 states the rule in. */
  private skipReason(
    checkpoint: Checkpoint,
    state: { notificationsEnabled: boolean; focused: boolean },
  ): NotificationSkipReason | null {
    if (checkpoint.urgency !== 'blocking') return 'not_blocking';
    if (state.focused) return 'window_focused';
    if (!state.notificationsEnabled) return 'notifications_disabled';
    if (this.notified.has(checkpoint.id)) return 'already_notified';
    return null;
  }

  private prune(pending: readonly Checkpoint[]): void {
    const live = new Set(pending.map(idOf));
    for (const id of this.notified) {
      if (!live.has(id)) this.notified.delete(id);
    }
  }
}

function idOf(checkpoint: Checkpoint): string {
  return checkpoint.id;
}
