import type { BrowserWindow } from 'electron';
import type { ConversationMessage } from '../../shared/models/conversationMessage';
import type { ChatBroadcaster } from './chatBroadcaster';
import { allKnownWindows } from '../windowRegistry';
import { hasChannels, nextSeqFor } from '../ipc/windowChannelSeq';
import { redactDeep } from '../secrets/redactor';

/**
 * The Electron half of `ChatBroadcaster` — §17.1's `on.chatMessage`.
 *
 * ## The envelope carries a sequence number, and why it is this one
 *
 * A pushed event can be missed. `stateDelta` has gap detection for exactly
 * that reason, and putting the product's primary surface on a channel
 * without it would trade the guarantee away at the worst possible place.
 * Two failures, neither self-healing:
 *
 *  - A missed **terminal flush** leaves a message rendering as mid-stream
 *    forever while the database says `complete`. That is worse than the
 *    `aborted` case M9 works hard to mark, because nothing marks it.
 *  - A missed **insert** leaves a message permanently absent from a
 *    conversation the user believes is whole.
 *
 * `conversation_messages.seq` — the obvious candidate — only sees the
 * second: an update does not advance a row's own sequence, so the column is
 * blind to the worse failure. A per-window **channel** sequence sees both,
 * and gives the renderer one recovery rule rather than two detectors for
 * one channel. So the column keeps meaning what §5.1 says it means, and
 * this envelope carries the sequence instead.
 *
 * Windows that have not finished loading are skipped for the same reason
 * `broadcastPatch` skips them: they have not hydrated, and the renderer
 * hydrates chat through `chat.listMessages` on load anyway.
 *
 * §11.4: chat bodies are agent-authored free text on an outbound path to
 * the renderer, so they get the same `redactDeep` treatment `stateDelta`
 * gives pushed rows.
 */
export function createElectronChatBroadcaster(
  windows: () => BrowserWindow[] = allKnownWindows,
): ChatBroadcaster {
  return {
    messageChanged(message: ConversationMessage): void {
      const redacted = redactDeep(message);
      for (const win of windows()) {
        if (win.isDestroyed() || !hasChannels(win)) continue;
        win.webContents.send('chatMessage', {
          seq: nextSeqFor(win, 'chatMessage'),
          message: redacted,
        });
      }
    },
  };
}
