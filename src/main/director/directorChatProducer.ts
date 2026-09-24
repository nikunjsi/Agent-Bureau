import type Database from 'better-sqlite3';
import type { AgentEvent } from '../../shared/engine/events';
import type { ChatStream, ChatStreamRegistry } from '../chat/chatStream';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { RedactionStream, type SecretRegistry } from '../secrets/redactor';

/**
 * The Director's producer (M11 row S1-13, `NEXT-VERSION` §K.1): its prose,
 * streamed into the active conversation through `ChatStreamRegistry`, the
 * one path `chat.stop` and shutdown already reach.
 *
 * **Prose only.** `text.delta` is what the Director says. A tool call's
 * arguments, its result, thinking and raw terminal bytes are its working,
 * and none of them is written to the chat (CLAUDE.md: translate, never show
 * raw engine output). A turn that says nothing writes no message. When the
 * prose resumes after a tool call, a paragraph break separates the two
 * halves, so "Let me check." and what it found do not run together.
 *
 * **Redacted on the way in.** The chat is an output path like the terminal
 * (§11.4), so each reply goes through its own `RedactionStream`, and the
 * held-back tail is flushed before the reply completes.
 *
 * **When a reply ends.** A real `claude -p` turn ends with `turn.completed`
 * and then `finished` when the process exits; a scripted one may end with
 * `idle`. Any of them completes the reply, except `finished` with an error,
 * which marks it interrupted — the state a crash mid-stream also lands in.
 * A reply the user stopped (`chat.stop`) stays stopped: the rest of that
 * turn's prose is dropped, not written as a second message.
 */
export interface DirectorChatProducerDeps {
  readonly db: Database.Database;
  readonly chatStreams: ChatStreamRegistry;
  readonly secretRegistry?: SecretRegistry;
}

export function createDirectorChatProducer(
  deps: DirectorChatProducerDeps,
): (event: AgentEvent) => void {
  let stream: ChatStream | null = null;
  let redaction: RedactionStream | null = null;
  let stoppedThisTurn = false;
  let breakBeforeNextText = false;

  function end(outcome: 'complete' | 'aborted'): void {
    if (stream !== null && redaction !== null && !stream.isEnded) {
      stream.append(redaction.flush());
      if (outcome === 'complete') stream.complete();
      else stream.abort('error');
    }
    stream = null;
    redaction = null;
    breakBeforeNextText = false;
  }

  function write(text: string): void {
    if (stoppedThisTurn) return;
    if (stream !== null && stream.isEnded) {
      // Stopped from the chat mid-turn: the user asked for silence.
      stoppedThisTurn = true;
      stream = null;
      redaction = null;
      return;
    }
    if (stream === null) {
      const conversation = resolveConversationForDelivery(deps.db, null);
      // No conversation yet means nowhere to speak; the words are dropped
      // rather than written into a conversation the user never opened.
      if (conversation === null) return;
      stream = deps.chatStreams.begin({
        conversationId: conversation.id,
        projectId: conversation.project_id,
        author: 'director',
      });
      redaction = new RedactionStream(deps.secretRegistry);
      breakBeforeNextText = false;
    }
    const safe = redaction!.feed(breakBeforeNextText ? `\n\n${text}` : text);
    breakBeforeNextText = false;
    stream.append(safe);
  }

  return (event) => {
    switch (event.t) {
      case 'turn.started':
        stoppedThisTurn = false;
        break;
      case 'text.delta':
        write(event.text);
        break;
      case 'tool.requested':
      case 'tool.completed':
        // Never written. Only noted, so the prose after it starts a new
        // paragraph.
        if (stream !== null) breakBeforeNextText = true;
        break;
      case 'turn.completed':
      case 'idle':
        end('complete');
        break;
      case 'finished':
        end(event.reason === 'error' ? 'aborted' : 'complete');
        break;
      default:
        break;
    }
  };
}
