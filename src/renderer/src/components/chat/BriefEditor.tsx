import { useEffect, useRef, useState } from 'react';

/**
 * §28 M9 item 4: "Edit opens the markdown in an editor and saves a new
 * version."
 *
 * A plain textarea, and that is the whole of it — the brief's own
 * `markdown` column is what the user reads and what they edit, and a
 * syntax-highlighting editor would be a dependency for a document people
 * change two paragraphs of. What matters is that saving writes a **new
 * version** rather than overwriting the one already shown, and that half
 * is the Core's (`brief.saveEdit`).
 *
 * The dialog traps focus the simple way a dialog must: focus moves in on
 * open, Escape closes, and the backdrop is not clickable-to-dismiss —
 * losing an edit to a stray click is worse than one extra keystroke.
 */
export interface BriefEditorProps {
  briefId: string;
  initialMarkdown: string;
  onClose: () => void;
  onSaved: () => void;
}

export function BriefEditor({
  briefId,
  initialMarkdown,
  onClose,
  onSaved,
}: BriefEditorProps): React.JSX.Element {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const result = await window.bureau.brief.saveEdit({ id: briefId, markdown });
    setSaving(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onSaved();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit the brief"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4"
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col rounded-md border border-bureau-border bg-bureau-bg p-3">
        <h2 className="mb-1 text-sm font-semibold text-bureau-text">Edit the brief</h2>
        <p className="mb-2 text-xs text-bureau-text-muted">
          Saving creates a new version awaiting your approval. The version you are editing is kept.
        </p>
        {error !== null && (
          <p
            role="alert"
            className="mb-2 flex items-start gap-1.5 rounded border border-bureau-error/50 bg-bureau-error/10 px-2 py-1 text-sm text-bureau-error"
          >
            <span aria-hidden="true">⚠</span>
            <span>{error}</span>
          </p>
        )}
        <textarea
          ref={textareaRef}
          value={markdown}
          aria-label="Brief markdown"
          onChange={(event) => setMarkdown(event.target.value)}
          className="min-h-64 flex-1 resize-y rounded border border-bureau-border bg-bureau-bg px-2 py-1 font-mono text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        />
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-bureau-border px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving || markdown === initialMarkdown}
            onClick={() => void save()}
            className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
          >
            {saving ? 'Saving…' : 'Save as a new version'}
          </button>
        </div>
      </div>
    </div>
  );
}
