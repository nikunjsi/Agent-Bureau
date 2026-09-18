import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBureauStore } from '../../store/bureauStore';
import { CheckpointCard } from '../chat/kinds';
import { useCheckpointAnswering } from './useCheckpointAnswering';
import { resolveCheckpointKey } from './keyboard';
import type { Checkpoint } from '../../../../shared/models/checkpoint';

/**
 * §14.4's Checkpoints view — "pending checkpoints, `blocking` first; same card
 * as in chat; keyboard-driven — `J`/`K` to move, `1`–`9` to choose an option,
 * `Enter` to confirm — because in practice these get processed in batches.
 * Answered checkpoints remain visible for the session with the decision
 * shown."
 *
 * It rendered a title and a context line in `created_at` order, with no card,
 * no ordering, no keyboard and no history (X-16). Every clause above is now
 * here, and the parts that are shared with chat are shared rather than
 * re-implemented: the card is `CheckpointCard`, and answering is
 * `useCheckpointAnswering`.
 *
 * The key rules themselves are `keyboard.ts` — pure, so each can be stated
 * and tested on its own, including §9.1's single-keypress permission answer.
 */
function urgencyRank(checkpoint: Checkpoint): number {
  // §14.4's "`blocking` first". Within a band, oldest first — the order they
  // arrived is the order they are answered, which is what makes a batch
  // predictable.
  switch (checkpoint.urgency) {
    case 'blocking':
      return 0;
    case 'soon':
      return 1;
    default:
      return 2;
  }
}

export function sortForReview(checkpoints: readonly Checkpoint[]): Checkpoint[] {
  return [...checkpoints].sort(
    (a, b) => urgencyRank(a) - urgencyRank(b) || a.created_at.localeCompare(b.created_at),
  );
}

export function CheckpointsTab(): React.JSX.Element {
  const pending = useBureauStore((state) => state.checkpoints);
  const answered = useBureauStore((state) => state.answeredCheckpoints);
  const { submittingId, error, answer, answerPermission } = useCheckpointAnswering();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [markedOptionId, setMarkedOptionId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const ordered = useMemo(() => sortForReview(pending), [pending]);
  // Clamp rather than reset: answering the third of five should leave the
  // cursor on the one that took its place, not send it back to the top.
  const cursor = Math.min(selectedIndex, Math.max(ordered.length - 1, 0));
  const current = ordered[cursor] ?? null;

  useEffect(() => {
    // A different checkpoint under the cursor means the mark belongs to a
    // question that is no longer on screen.
    setMarkedOptionId(null);
  }, [current?.id]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>): void => {
      if (current === null) return;
      const intent = resolveCheckpointKey(event, {
        checkpoint: current,
        cursor,
        count: ordered.length,
        markedOptionId,
      });
      if (intent === null) return;
      event.preventDefault();
      switch (intent.kind) {
        case 'move':
          setSelectedIndex(intent.to);
          return;
        case 'mark':
          setMarkedOptionId(intent.optionId);
          return;
        case 'answer':
          void answer(current, { optionId: intent.optionId });
          return;
        case 'permission':
          void answerPermission(current, intent.allow);
          return;
      }
    },
    [answer, answerPermission, cursor, current, markedOptionId, ordered.length],
  );

  if (ordered.length === 0 && answered.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1 p-8 text-center">
        <p className="font-medium text-bureau-text">Nothing needs your attention</p>
        <p className="max-w-sm text-sm text-bureau-text-muted">
          Pending decisions will show up here as they come in.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-2">
      <ul
        ref={listRef}
        aria-label="Pending checkpoints"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-bureau-accent"
      >
        {ordered.map((checkpoint, index) => (
          <li
            key={checkpoint.id}
            aria-current={index === cursor ? 'true' : undefined}
            className={
              index === cursor
                ? 'rounded border-l-2 border-bureau-accent pl-2'
                : 'rounded border-l-2 border-transparent pl-2'
            }
          >
            <CheckpointCard
              checkpoint={checkpoint}
              submitting={submittingId === checkpoint.id}
              error={submittingId === checkpoint.id ? error : null}
              onAnswer={(input) => void answer(checkpoint, input)}
              onAnswerPermission={(allow) => void answerPermission(checkpoint, allow)}
            />
            {index === cursor && markedOptionId !== null && (
              <p className="mt-1 text-xs text-bureau-text-muted">
                {`Press Enter to confirm: ${
                  (checkpoint.options ?? []).find((option) => option.id === markedOptionId)
                    ?.label ?? markedOptionId
                }`}
              </p>
            )}
          </li>
        ))}
      </ul>

      {ordered.length > 0 && (
        <p className="px-1 text-xs text-bureau-text-muted">
          J and K move · 1–9 choose · Enter confirms
        </p>
      )}

      {answered.length > 0 && (
        <section aria-label="Answered this session" className="border-t border-bureau-border pt-2">
          <h3 className="px-1 text-xs uppercase tracking-wide text-bureau-text-muted">
            Answered this session
          </h3>
          <ul className="flex flex-col gap-1 p-1">
            {answered.map((entry) => (
              <li key={entry.id} className="text-sm">
                <span className="text-bureau-text">{entry.title}</span>{' '}
                <span className="text-bureau-text-muted">— {entry.decision}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
