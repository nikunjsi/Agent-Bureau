import { useEffect, useState } from 'react';
import { ErrorNotice, type NoticeError } from './ErrorNotice';

/**
 * §22.4's own bullet: *"Settings offers 'Add a key for small helper tasks
 * (optional — a few cents a month)' with an honest note on what improves."*
 * (X-20.)
 *
 * The seams for this have existed since M6 — `settings.setSecret`,
 * `clearSecret` and `getSecretsStatus`, the last of which returns Bureau's
 * real honest note rather than a paraphrase — and nothing in the renderer
 * called any of them, so the key could only be set by a developer. A feature
 * documented as optional and reachable by nobody is not optional.
 *
 * **The value is write-only** (§11.4). Nothing reads a secret back over IPC,
 * so this shows *whether* a key is stored and when it was set, never the key.
 * The field clears itself after a save for the same reason: a key left
 * sitting in a text box is a key on screen.
 */
export const HELPER_KEY_NAME = 'oneshot.apiKey';

export interface SecretStatus {
  readonly key: string;
  readonly provider: string | null;
  readonly lastSetAt: string | null;
}

/** The copy, in one place so a test can assert §22.4's sentence exactly. */
export const HELPER_KEY_PROMPT =
  'Add a key for small helper tasks (optional — a few cents a month)';
export const HELPER_KEY_EXPLANATION =
  'Bureau works without this. With a key, it can double-check whether a question has already been ' +
  'answered before asking you again, and rewrite an unfamiliar error into plain language. Without ' +
  'one, it falls back to keyword matching and shows the error as it came.';

export function HelperKeyStatus({
  status,
  note,
}: {
  status: SecretStatus | null;
  note: string;
}): React.JSX.Element {
  return (
    <>
      <p className="text-sm text-bureau-text">{HELPER_KEY_PROMPT}</p>
      <p className="mt-1 text-xs text-bureau-text-muted">{HELPER_KEY_EXPLANATION}</p>
      <p className="mt-1 text-xs text-bureau-text-muted">
        {status === null || status.lastSetAt === null
          ? 'No key stored.'
          : `A key is stored (set ${status.lastSetAt.slice(0, 10)}). Bureau never shows it again.`}
      </p>
      <p className="mt-1 text-xs text-bureau-text-muted">{note}</p>
    </>
  );
}

export function HelperKeyField(): React.JSX.Element {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeError | null>(null);

  const reload = async (): Promise<void> => {
    const result = await window.bureau.settings.getSecretsStatus({});
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStatus(result.data.items.find((item) => item.key === HELPER_KEY_NAME) ?? null);
    setNote(result.data.note);
  };

  useEffect(() => {
    void reload();
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.settings.setSecret({ key: HELPER_KEY_NAME, value });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setValue('');
    setError(null);
    await reload();
  };

  const clear = async (): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.settings.clearSecret({ key: HELPER_KEY_NAME });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await reload();
  };

  return (
    <div className="py-2">
      <HelperKeyStatus status={status} note={note} />
      {error !== null && <ErrorNotice error={error} />}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor="helper-key" className="sr-only">
          {HELPER_KEY_PROMPT}
        </label>
        <input
          id="helper-key"
          type="password"
          value={value}
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Paste a key"
          className="min-w-48 flex-1 rounded border border-bureau-border bg-bureau-bg px-2 py-1 text-sm"
        />
        <button
          type="button"
          disabled={busy || value.trim() === ''}
          onClick={() => void save()}
          className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          Save key
        </button>
        {status?.lastSetAt != null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear()}
            className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Remove key
          </button>
        )}
      </div>
    </div>
  );
}
