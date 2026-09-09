import { useEffect, useRef, useState } from 'react';
import { SLASH_COMMANDS } from '../../../../shared/chat/slashCommands';

/**
 * §14.2's composer: "multiline, `Enter` sends / `Shift+Enter` newline, file
 * attach (path reference into the conversation), slash commands, and a
 * typing indicator while the Director is composing."
 *
 * Four of those five are here. **The typing indicator is not, because it
 * already exists and is real**: `MessageRow` renders "typing…" from
 * `status === 'streaming'`, which a live `ChatStream` writes before the
 * first token. Building a second one here — a spinner between pressing
 * Enter and the Director's row appearing — would be an animation with no
 * state behind it, which is exactly the thing not to build.
 *
 * ## Nothing here is authoritative (invariant #11)
 *
 * There is no optimistic append. Pressing Enter calls `chat.send` and
 * waits; the message appears because the Core wrote it and pushed it back,
 * like every other message. The composer clears only once that has
 * happened — a cleared box with nothing on screen is how a user loses a
 * paragraph they typed.
 *
 * ## The attach field, and where the real check lives
 *
 * This offers a path field, not a file picker, for a specific reason
 * recorded in NEXT-VERSION: Electron 43 removed `File.path`, so a real
 * picker needs either `webUtils` in the preload or a `system.pickFile`
 * method, and §17.1's surface is fixed. M13 has to add one for its
 * home-folder step.
 *
 * **This component validates nothing.** The path goes to the main process
 * exactly as typed and is confined there (`src/main/chat/attachments.ts`),
 * and the *security* answer is neither of those — it is the read-time
 * policy deny proven by S2. A renderer-side check on a main-process
 * invariant is not a guard (standing rule 2).
 */
export interface ComposerProps {
  conversationId: string;
  /** True while a reply is streaming into this conversation — the Stop
   * button's only reason to exist (§28 M9 item 3). Derived from real
   * message state by the view above, not tracked here. */
  streaming: boolean;
  /** Prefilled by Discuss/Edit on a brief or plan card, with the card as
   * context. A change to this replaces whatever is in the box, so the
   * caller only bumps it on a real user action. */
  draft: { text: string; token: number } | null;
  onSent: () => void;
}

export function Composer({
  conversationId,
  streaming,
  draft,
  onSent,
}: ComposerProps): React.JSX.Element {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachPath, setAttachPath] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastDraftToken = useRef<number | null>(null);

  // A card's Discuss/Edit button fills the box and focuses it. Keyed on a
  // token rather than the text, so pressing Discuss twice with the same
  // card still refills a box the user has since emptied.
  useEffect(() => {
    if (draft === null || draft.token === lastDraftToken.current) return;
    lastDraftToken.current = draft.token;
    setText(draft.text);
    textareaRef.current?.focus();
  }, [draft]);

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (body === '' || sending) return;
    setSending(true);
    setError(null);
    const result = await window.bureau.chat.send({ conversationId, body, attachments });
    setSending(false);
    if (!result.ok) {
      // §14.6: the Core's message is already written for a person. The box
      // keeps its contents — a refused send must not eat what was typed.
      setError(result.error.message);
      return;
    }
    setText('');
    setAttachments([]);
    setAttachPath('');
    setAttachOpen(false);
    onSent();
  };

  const stop = async (): Promise<void> => {
    const result = await window.bureau.chat.stop({ conversationId });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    if (!result.data.stopped) {
      // A real outcome, not a failure: the reply had already finished, or
      // another window stopped it first.
      setError('There was nothing left to stop — that reply had already finished.');
    }
  };

  const addAttachment = (): void => {
    const path = attachPath.trim();
    if (path === '') return;
    if (attachments.includes(path)) {
      setAttachPath('');
      return;
    }
    setAttachments([...attachments, path]);
    setAttachPath('');
  };

  return (
    <div className="border-t border-bureau-border p-2">
      {error !== null && (
        <p
          role="alert"
          className="mb-2 flex items-start gap-1.5 rounded border border-bureau-error/50 bg-bureau-error/10 px-2 py-1 text-sm text-bureau-error"
        >
          {/* Icon plus words, never colour alone (§14.7). */}
          <span aria-hidden="true">⚠</span>
          <span>{error}</span>
        </p>
      )}

      {attachments.length > 0 && (
        <ul aria-label="Attached files" className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((path) => (
            <li
              key={path}
              className="flex items-center gap-1.5 rounded border border-bureau-border bg-bureau-bg-elevated px-2 py-0.5 text-xs"
            >
              <span aria-hidden="true">📎</span>
              <span className="max-w-xs truncate" title={path}>
                {path}
              </span>
              <button
                type="button"
                aria-label={`Remove attachment ${path}`}
                onClick={() => setAttachments(attachments.filter((p) => p !== path))}
                className="rounded px-1 text-bureau-text-muted hover:text-bureau-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {attachOpen && (
        <div className="mb-2">
          <label htmlFor="composer-attach" className="text-xs text-bureau-text-muted">
            Full path to a file inside your Bureau workspace. Bureau never reads anything outside
            it.
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="composer-attach"
              value={attachPath}
              onChange={(event) => setAttachPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addAttachment();
                }
              }}
              placeholder="E:\Bureau\my-project\notes.md"
              className="min-w-0 flex-1 rounded border border-bureau-border bg-bureau-bg px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            />
            <button
              type="button"
              onClick={addAttachment}
              className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            >
              {/* Not "Attach": the control that opens this panel is already
                  called that, and two buttons with one accessible name is
                  ambiguous to a screen reader before it is ambiguous to a
                  test. */}
              Add file
            </button>
          </div>
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          aria-label="Message the Director"
          placeholder="Describe what you want built…"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // §14.2, exactly: Enter sends, Shift+Enter is a newline. IME
            // composition is excluded — pressing Enter to accept a
            // candidate in a Japanese or Chinese input method must not
            // send the half-finished sentence.
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          className="min-h-16 min-w-0 flex-1 resize-y rounded border border-bureau-border bg-bureau-bg px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        />
        <div className="flex flex-col gap-1">
          {streaming ? (
            <button
              type="button"
              onClick={() => void stop()}
              className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              disabled={sending || text.trim() === ''}
              onClick={() => void send()}
              className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          )}
          <button
            type="button"
            aria-expanded={attachOpen}
            onClick={() => setAttachOpen(!attachOpen)}
            className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Attach
          </button>
        </div>
      </div>

      <p className="mt-1 text-xs text-bureau-text-muted">
        Enter sends · Shift+Enter for a new line · commands:{' '}
        {SLASH_COMMANDS.map((name) => `/${name}`).join(', ')} — type <code>/help</code> for what
        they do.
      </p>
    </div>
  );
}
