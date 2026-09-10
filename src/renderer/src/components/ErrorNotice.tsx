import { useBureauStore } from '../store/bureauStore';
import type { IpcError, IpcErrorAction } from '../../../shared/ipc/envelope';

/**
 * AUDIT M0–M2 #16 — §14.6: *"Every error surfaced to the user MUST have:
 * what happened in plain language, why, and a concrete next action (a
 * button where possible)."*
 *
 * `IpcErrorAction` has been a fully-modelled five-variant union since M2,
 * with a comment explaining that a bare string "would leave `action`
 * vestigial". It was vestigial anyway — not because no handler set it (six
 * did) but because **`error.action` appeared nowhere in `src/renderer` at
 * all**, so every one of those actions was computed, validated, sent over
 * the bridge and dropped. Seventeen call sites rendered `error.message` as
 * bare text.
 *
 * This component exists so that stops being per-call-site diligence. A new
 * error path renders `<ErrorNotice error={...} />` and gets the button by
 * default; `errorNoticeIsTheOnlyRenderer.test.ts` fails if one goes back
 * to rendering `.message` itself. That guard is the part that stops this
 * regressing — the union was correct and unused for nine milestones, and
 * nothing would have noticed for nine more.
 *
 * ## The boundary this is careful about
 *
 * The Core sends `action.type` — a **domain** statement about what needs
 * to happen. Every word below, and where the button sits, is this file's
 * choice. M9's `remedy.kind` is the precedent, and M9 removed two
 * presentation fields from an error payload for exactly this reason: the
 * UI is provisional and expected to be redesigned, so the Core must not
 * describe how anything looks.
 */

/**
 * What this needs to render: the two parts of §14.6 that are facts. `code`
 * is deliberately not among them — it is the Core's vocabulary for
 * *classifying* a failure, not for describing one, and a renderer
 * branching on it would be re-deciding something the Core already decided
 * when it chose the message and the action.
 *
 * A full `IpcError` satisfies it, and so does a message the renderer wrote
 * itself for something that never crossed IPC (`Composer`'s "there was
 * nothing left to stop", `PausedBanner`'s roll-up of several failures).
 */
export type NoticeError = Pick<IpcError, 'message'> & {
  // `| undefined` explicitly, because `exactOptionalPropertyTypes` is on
  // and a real `IpcError` (whose `action` is `T | undefined`) must be
  // assignable to this without a cast at all seventeen call sites.
  readonly action?: IpcErrorAction | undefined;
};

export interface ErrorNoticeProps {
  readonly error: NoticeError;
  /**
   * What "try again" means here. Only the call site knows, so a `retry`
   * action with no handler renders **no button** rather than a dead one —
   * a button that does nothing is worse than an honest absence, and this
   * is the same argument `openInShell` makes for offering none at all.
   */
  readonly onRetry?: () => void;
  /**
   * Who or what this failure is about, when one screen shows several at
   * once — `PausedBanner` resuming four employees and two refusing.
   *
   * A prop rather than the caller pasting it into `message`, and that is
   * not fussiness: composing several errors into one string is how the
   * per-error `action` gets lost, which is the entire finding. One notice
   * per failure, each keeping its own next action.
   */
  readonly about?: string;
  /** Extra classes for the caller's layout. Presentation only. */
  readonly className?: string;
}

export function ErrorNotice({
  error,
  onRetry,
  about,
  className,
}: ErrorNoticeProps): React.JSX.Element {
  const setSettingsOpen = useBureauStore((state) => state.setSettingsOpen);

  const action = error.action;
  let button: React.JSX.Element | null = null;

  if (action !== undefined) {
    switch (action.type) {
      case 'retry':
        // Only when the caller said what retrying does.
        if (onRetry !== undefined) button = <NoticeButton onClick={onRetry} label="Try again" />;
        break;
      case 'open_settings':
        button = <NoticeButton onClick={() => setSettingsOpen(true)} label="Open settings" />;
        break;
      case 'open_url':
        button = (
          <NoticeButton
            onClick={() => void window.bureau.system.openExternal({ url: action.url })}
            label="Open the page"
          />
        );
        break;
      case 'restart':
        button = (
          <NoticeButton
            onClick={() => void window.bureau.system.restart({})}
            label="Restart Bureau"
          />
        );
        break;
      case 'contact_support':
        // The concrete thing a person can do about a bug in Bureau is get
        // hold of what happened, so this opens the log rather than naming
        // a support address Bureau does not have. `contact_support` is the
        // Core saying "this one is ours, not yours" — the wording and the
        // destination are this file's reading of that.
        button = (
          <NoticeButton
            onClick={() => void window.bureau.activity.openRawLog({})}
            label="Open the log"
          />
        );
        break;
    }
  }

  return (
    <div
      role="alert"
      className={`flex items-start gap-1.5 rounded border border-bureau-error/50 bg-bureau-error/10 px-2 py-1 text-sm text-bureau-error ${className ?? ''}`}
    >
      {/* Icon plus words, never colour alone (§14.7). */}
      <span aria-hidden="true">⚠</span>
      <span className="min-w-0 flex-1">
        {about !== undefined && <span className="font-medium">{about}: </span>}
        {error.message}
      </span>
      {button}
    </div>
  );
}

function NoticeButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded border border-bureau-error/50 px-1.5 py-0.5 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
    >
      {label}
    </button>
  );
}
