import type { ConversationMessage } from '../../shared/models/conversationMessage';

/**
 * How a persisted or updated chat message reaches open windows.
 *
 * A seam, for the same reason `CheckpointNotifier` (checkpoints/surfacing.ts)
 * is one: `electron` cannot be imported by anything the vitest suites load,
 * and they load this. The Electron half is `electronChatBroadcaster.ts` and
 * is exercised for real in the packaged app by the e2e specs.
 */
export interface ChatBroadcaster {
  /** A message was inserted or updated. Every call is a complete row — the
   * renderer replaces by id and never merges deltas of its own. */
  messageChanged(message: ConversationMessage): void;
}

/** For tests and for any Core path constructed without a live window layer
 * (the message is still persisted; only the push is skipped). */
export const noopChatBroadcaster: ChatBroadcaster = {
  messageChanged: () => {},
};
