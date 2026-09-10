import { useCallback, useEffect, useState } from 'react';
import type { Memory } from '../../../../shared/models/memory';
import type { MemoryProposal } from '../../../../shared/models/memoryProposal';
import type { MemoryScope } from '../../../../shared/models/enums';
import { useBureauStore } from '../../store/bureauStore';
import { Markdown } from '../chat/Markdown';
import { ErrorNotice, type NoticeError } from '../ErrorNotice';

/**
 * §14.9 — the memory view. §28's M10 item 5: "browse, edit, pin,
 * accept/reject proposals."
 *
 * ## Everything on this screen is the Core's fact, phrased here
 *
 * The Core returns rows: a note's `body` is markdown content, a proposal is
 * a row with a scope and a rationale, `semantic` is `'off'` or
 * `'unavailable'`. Every sentence a person reads — "3 notes proposed",
 * "pinned notes are read on every task", the warning before a full rebuild —
 * is written here, because how a fact reads is the renderer's decision.
 *
 * Two consequences of that worth naming, since both look like something
 * missing from the Core:
 *
 *  - **The proposal count is derived here**, from the proposals themselves.
 *    Nothing stores "N notes are awaiting review", precisely so the number
 *    cannot go stale as a fourth proposal joins a review already open.
 *  - **Accepting and rejecting go through `checkpoints.answer`**, not
 *    through a memory method. §12.4's review *is* a checkpoint, and
 *    `answerCheckpoint` is the single place a checkpoint stops being
 *    pending.
 *
 * ## No optimistic state
 *
 * Every mutation re-reads (invariant #11). A note this screen believes in
 * and the Core does not is data loss wearing a UI glitch's clothes — the
 * rule `bureauStore`'s chat slice already states, applying unchanged.
 */

const SCOPES: readonly { id: MemoryScope | 'all'; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'company', label: 'Company' },
  { id: 'project', label: 'Project' },
  { id: 'role', label: 'Roles' },
  { id: 'employee', label: 'Employees' },
  { id: 'user', label: 'About you' },
];

interface Loaded {
  readonly items: Memory[];
  readonly proposals: MemoryProposal[];
}

export function MemoryView(): React.JSX.Element {
  const hydrationEpoch = useBureauStore((state) => state.hydrationEpoch);
  const checkpoints = useBureauStore((state) => state.checkpoints);

  const [scope, setScope] = useState<MemoryScope | 'all'>('all');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<NoticeError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const result = await window.bureau.memory.list(scope === 'all' ? {} : { scope });
    if (result.ok) {
      setLoaded({ items: result.data.items, proposals: result.data.proposals });
      setError(null);
    } else {
      // §14.6 — plain language and a next action, never a bare code.
      setError(result.error);
    }
  }, [scope]);

  useEffect(() => {
    void reload();
  }, [reload, hydrationEpoch]);

  const selected = loaded?.items.find((item) => item.id === selectedId) ?? null;

  const save = async (note: Memory, body: string): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.memory.write({
      scope: note.scope,
      // The path the Core gave back, minus its scope segment — the same
      // shape the Core's own confinement expects. It is not reconstructed
      // from anything the user typed.
      path: note.path.split('/').slice(1).join('/'),
      body,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setDraft(null);
    setNotice('Saved. Employees will read this on their next task.');
    await reload();
  };

  const setPinned = async (note: Memory, pinned: boolean): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.memory.write({
      scope: note.scope,
      path: note.path.split('/').slice(1).join('/'),
      pinned,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await reload();
  };

  const remove = async (note: Memory): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.memory.remove({ id: note.id });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSelectedId(null);
    setNotice('Deleted. The markdown file is gone too — this is not undoable from here.');
    await reload();
  };

  const rebuild = async (full: boolean): Promise<void> => {
    setBusy(true);
    const result = await window.bureau.memory.reindex({ full });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // The Core reports what a rebuild cost; this is where that becomes a
    // sentence. §12.1 says losing pins on a full rebuild is "stated rather
    // than hidden", and a number nobody shows a person is hidden.
    setNotice(
      full
        ? `Rebuilt from your markdown files: ${result.data.indexed} notes. ` +
            `${result.data.pinsCleared} pin${result.data.pinsCleared === 1 ? '' : 's'} cleared — ` +
            'pinning lives only in Bureau, not in the files, so a full rebuild loses it.'
        : `Checked your markdown files: ${result.data.indexed} updated, ` +
            `${result.data.removed} removed. Pins kept.`,
    );
    await reload();
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3">
      <ProposalReviews
        proposals={loaded?.proposals ?? []}
        checkpointIds={new Set(checkpoints.map((checkpoint) => checkpoint.id))}
        busy={busy}
        onDone={async (message) => {
          setNotice(message);
          await reload();
        }}
        onError={setError}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="memory-scope" className="text-sm text-bureau-text-muted">
          Show
        </label>
        <select
          id="memory-scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value as MemoryScope | 'all');
            setSelectedId(null);
            setDraft(null);
          }}
          className="rounded border border-bureau-border bg-bureau-bg px-2 py-1 text-sm"
        >
          {SCOPES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void rebuild(false)}
          className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          Check for edits
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void rebuild(true)}
          // The consequence is in the accessible name as well as the
          // tooltip: a destructive-ish action must not rely on a hover.
          title="Rebuilds every note from your markdown files and clears all pins"
          aria-label="Rebuild from files — this clears every pin"
          className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
        >
          Rebuild from files
        </button>
      </div>

      {notice !== null && (
        <p role="status" className="text-sm text-bureau-text-muted">
          {notice}
        </p>
      )}
      {error !== null && <ErrorNotice error={error} />}

      {loaded === null ? (
        // Not "no notes yet" — an empty array before the first answer would
        // render a lie for a fraction of a second on every open.
        <p className="text-sm text-bureau-text-muted">Reading your notes…</p>
      ) : loaded.items.length === 0 ? (
        <EmptyMemory />
      ) : (
        <div className="flex min-h-0 flex-1 gap-3">
          <ul aria-label="Notes" className="w-1/3 min-w-48 overflow-auto">
            {loaded.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(item.id);
                    setDraft(null);
                  }}
                  aria-current={selectedId === item.id}
                  className={`w-full rounded px-2 py-1 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent ${
                    selectedId === item.id ? 'bg-bureau-bg-elevated font-medium' : ''
                  }`}
                >
                  {/* Icon plus label, never colour alone (§14.7). */}
                  {item.pinned && <span aria-hidden="true">📌 </span>}
                  {item.title}
                  {item.pinned && <span className="sr-only"> (pinned)</span>}
                  <span className="block font-mono text-xs text-bureau-text-muted">
                    {item.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0 flex-1 overflow-auto">
            {selected === null ? (
              <p className="text-sm text-bureau-text-muted">Choose a note to read it.</p>
            ) : (
              <article>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void setPinned(selected, !selected.pinned)}
                    className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
                  >
                    {selected.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setDraft(draft === null ? selected.body : null)}
                    className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
                  >
                    {draft === null ? 'Edit' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(selected)}
                    className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
                  >
                    Delete
                  </button>
                </div>
                <p className="mb-2 text-sm text-bureau-text-muted">
                  {selected.pinned
                    ? 'Pinned — employees read this on every task in scope.'
                    : 'Employees read this when it matches what they are working on.'}
                </p>
                {draft === null ? (
                  <Markdown source={selected.body} />
                ) : (
                  <div className="flex flex-col gap-2">
                    <textarea
                      aria-label={`Edit ${selected.title}`}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      rows={20}
                      className="w-full rounded border border-bureau-border bg-bureau-bg p-2 font-mono text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void save(selected, draft)}
                      className="self-start rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
                    >
                      Save
                    </button>
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyMemory(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="font-medium text-bureau-text">Bureau has not learned anything yet</p>
      <p className="max-w-sm text-sm text-bureau-text-muted">
        Decisions you make get written down here automatically, and your employees can propose notes
        of their own. Anything here is plain markdown on your disk — you can edit it in Bureau or in
        any text editor.
      </p>
    </div>
  );
}

/**
 * §12.4's batched review, per checkpoint. One block per open review, with
 * accept/reject per note and a single answer at the end — because that is
 * what the Core accepts: an answer that leaves a note undecided is refused
 * and nothing is written.
 */
function ProposalReviews({
  proposals,
  checkpointIds,
  busy,
  onDone,
  onError,
}: {
  proposals: MemoryProposal[];
  checkpointIds: Set<string>;
  busy: boolean;
  onDone: (message: string) => Promise<void>;
  onError: (error: NoticeError) => void;
}): React.JSX.Element | null {
  const [decisions, setDecisions] = useState<Record<string, 'accept' | 'reject'>>({});

  // Grouped by the review they belong to. A proposal whose checkpoint the
  // store does not know about is one whose review has already been answered
  // elsewhere; it is left out rather than shown as answerable.
  const byCheckpoint = new Map<string, MemoryProposal[]>();
  for (const proposal of proposals) {
    if (proposal.checkpoint_id === null || !checkpointIds.has(proposal.checkpoint_id)) continue;
    byCheckpoint.set(proposal.checkpoint_id, [
      ...(byCheckpoint.get(proposal.checkpoint_id) ?? []),
      proposal,
    ]);
  }
  if (byCheckpoint.size === 0) return null;

  const answer = async (
    checkpointId: string,
    items: MemoryProposal[],
    optionId: string,
  ): Promise<void> => {
    const result = await window.bureau.checkpoints.answer({
      id: checkpointId,
      optionId,
      ...(optionId === 'review_each'
        ? {
            itemDecisions: items.map((item) => ({
              proposalId: item.id,
              decision: decisions[item.id] ?? 'reject',
            })),
          }
        : {}),
    });
    if (!result.ok) {
      onError(result.error);
      return;
    }
    const { memoryProposalsApplied: applied, memoryProposalsRejected: rejected } = result.data;
    await onDone(
      `${applied.length} note${applied.length === 1 ? '' : 's'} added to memory, ` +
        `${rejected.length} discarded.`,
    );
  };

  return (
    <>
      {[...byCheckpoint.entries()].map(([checkpointId, items]) => {
        const undecided = items.filter((item) => decisions[item.id] === undefined).length;
        return (
          <section
            key={checkpointId}
            aria-label="Proposed notes"
            className="rounded border border-bureau-border p-3"
          >
            <h2 className="font-medium">
              {items.length} note{items.length === 1 ? '' : 's'} proposed for your memory
            </h2>
            <p className="mb-2 text-sm text-bureau-text-muted">
              Accepting a note means employees read it on future tasks. Rejecting one discards it.
            </p>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li key={item.id} className="rounded border border-bureau-border p-2">
                  <p className="font-mono text-xs text-bureau-text-muted">{item.path}</p>
                  <p className="text-sm italic text-bureau-text-muted">{item.rationale}</p>
                  <div className="my-1">
                    <Markdown source={item.content} />
                  </div>
                  <div className="flex gap-2" role="group" aria-label={`Decide ${item.title}`}>
                    {(['accept', 'reject'] as const).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        aria-pressed={decisions[item.id] === choice}
                        onClick={() => setDecisions({ ...decisions, [item.id]: choice })}
                        className={`rounded border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent ${
                          decisions[item.id] === choice
                            ? 'border-bureau-accent font-medium'
                            : 'border-bureau-border'
                        }`}
                      >
                        {/* aria-pressed carries the state; the check mark is
                            a second, non-colour signal (§14.7). */}
                        {decisions[item.id] === choice && <span aria-hidden="true">✓ </span>}
                        {choice === 'accept' ? 'Keep' : 'Discard'}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busy || undecided > 0}
                onClick={() => void answer(checkpointId, items, 'review_each')}
                className="rounded bg-bureau-accent px-3 py-1 text-sm text-bureau-accent-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                Apply my choices
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void answer(checkpointId, items, 'accept_all')}
                className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                Keep all
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void answer(checkpointId, items, 'reject_all')}
                className="rounded border border-bureau-border px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
              >
                Discard all
              </button>
              {undecided > 0 && (
                <span className="text-sm text-bureau-text-muted">
                  {undecided} still to decide before you can apply your choices.
                </span>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}
