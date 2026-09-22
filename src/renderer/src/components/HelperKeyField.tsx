import { useCallback, useEffect, useState } from 'react';
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

/**
 * M11 S1-5: the key E-4 makes Bureau's primary sign-in. Employees and the
 * Director run through the engine CLI, and the Core's secret broker injects
 * this key into each spawn. The same write-only field as the helper key,
 * with its own copy. The name must be the one the broker reads, which a
 * test asserts.
 */
export const ANTHROPIC_KEY_NAME = 'anthropic_api_key';
export const ANTHROPIC_KEY_PROMPT = 'Anthropic API key';
export const ANTHROPIC_KEY_EXPLANATION =
  'Bureau runs Claude with this key. Anthropic bills its use to your account, and ' +
  "Bureau's budgets cap how much of it Bureau may spend.";

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

export function SecretKeyStatus({
  prompt,
  explanation,
  status,
  note,
}: {
  prompt: string;
  explanation: string;
  status: SecretStatus | null;
  note: string;
}): React.JSX.Element {
  return (
    <>
      <p className="text-sm text-bureau-text">{prompt}</p>
      <p className="mt-1 text-xs text-bureau-text-muted">{explanation}</p>
      <p className="mt-1 text-xs text-bureau-text-muted">
        {status === null || status.lastSetAt === null
          ? 'No key stored.'
          : `A key is stored (set ${status.lastSetAt.slice(0, 10)}). Bureau never shows it again.`}
      </p>
      <p className="mt-1 text-xs text-bureau-text-muted">{note}</p>
    </>
  );
}

export function HelperKeyStatus({
  status,
  note,
}: {
  status: SecretStatus | null;
  note: string;
}): React.JSX.Element {
  return (
    <SecretKeyStatus
      prompt={HELPER_KEY_PROMPT}
      explanation={HELPER_KEY_EXPLANATION}
      status={status}
      note={note}
    />
  );
}

/** One write-only secret: status, a password input, Save and Remove. */
function SecretKeyField({
  secretKey,
  prompt,
  explanation,
  inputId,
}: {
  secretKey: typeof HELPER_KEY_NAME | typeof ANTHROPIC_KEY_NAME;
  prompt: string;
  explanation: string;
  inputId: string;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [status, setStatus] = useState<SecretStatus | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<NoticeError | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.bureau.settings.getSecretsStatus({});
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStatus(result.data.items.find((item) => item.key === secretKey) ?? null);
    setNote(result.data.note);
  }, [secretKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.settings.setSecret({ key: secretKey, value });
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
    const result = await window.bureau.settings.clearSecret({ key: secretKey });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await reload();
  };

  return (
    <div className="py-2">
      <SecretKeyStatus prompt={prompt} explanation={explanation} status={status} note={note} />
      {error !== null && <ErrorNotice error={error} />}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor={inputId} className="sr-only">
          {prompt}
        </label>
        <input
          id={inputId}
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

export function HelperKeyField(): React.JSX.Element {
  return (
    <SecretKeyField
      secretKey={HELPER_KEY_NAME}
      prompt={HELPER_KEY_PROMPT}
      explanation={HELPER_KEY_EXPLANATION}
      inputId="helper-key"
    />
  );
}

export function AnthropicKeyField(): React.JSX.Element {
  return (
    <SecretKeyField
      secretKey={ANTHROPIC_KEY_NAME}
      prompt={ANTHROPIC_KEY_PROMPT}
      explanation={ANTHROPIC_KEY_EXPLANATION}
      inputId="anthropic-key"
    />
  );
}
