import { useCallback, useState } from 'react';
import { useBureauStore } from '../../store/bureauStore';
import type { Checkpoint } from '../../../../shared/models/checkpoint';

export interface CheckpointAnswerInput {
  optionId?: string;
  freeText?: string;
}

export interface CheckpointAnswering {
  /** The checkpoint currently being submitted, for the card's disabled state. */
  readonly submittingId: string | null;
  readonly error: { message: string } | null;
  readonly answer: (checkpoint: Checkpoint, input: CheckpointAnswerInput) => Promise<void>;
  readonly answerPermission: (checkpoint: Checkpoint, allow: boolean) => Promise<void>;
}

/**
 * Answering a checkpoint from a surface, in **one** place.
 *
 * §9.4 gives a pending checkpoint four surfaces "all reflecting one piece of
 * state", and two of them can now answer: the chat card and the Checkpoints
 * view (X-16). This lived inline in `ChatView` while there was one; a second
 * copy would be two definitions of what answering does — including whether
 * the held agent's fate is reported, which is the part a copy forgets.
 *
 * **It never removes anything from the pending list.** The Core emits
 * `checkpoint.answered`, which pushes a fresh `checkpoints` slice, and the
 * card goes because the checkpoint is no longer pending. What this does add
 * is the session record §14.4 asks for, and only after the Core said yes.
 */
export function useCheckpointAnswering(): CheckpointAnswering {
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const recordAnswered = useBureauStore((state) => state.recordAnsweredCheckpoint);

  const answer = useCallback(
    async (checkpoint: Checkpoint, input: CheckpointAnswerInput): Promise<void> => {
      setSubmittingId(checkpoint.id);
      setError(null);
      const result = await window.bureau.checkpoints.answer({ id: checkpoint.id, ...input });
      setSubmittingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const chosen = (checkpoint.options ?? []).find((option) => option.id === input.optionId);
      recordAnswered({
        id: checkpoint.id,
        title: checkpoint.title,
        decision: chosen?.label ?? input.freeText ?? 'Answered',
      });
    },
    [recordAnswered],
  );

  const answerPermission = useCallback(
    async (checkpoint: Checkpoint, allow: boolean): Promise<void> => {
      setSubmittingId(checkpoint.id);
      setError(null);
      const result = await window.bureau.checkpoints.answerPermission({
        id: checkpoint.id,
        allow,
      });
      setSubmittingId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      recordAnswered({
        id: checkpoint.id,
        title: checkpoint.title,
        decision: allow ? 'Allowed once' : 'Denied',
      });
      if (!result.data.holdReleased) {
        // A real outcome, and one the user has to be told about: the answer
        // was recorded, but the agent had already stopped waiting.
        setError({
          message: 'Your answer was recorded, but the employee had already stopped waiting for it.',
        });
      }
    },
    [recordAnswered],
  );

  return { submittingId, error, answer, answerPermission };
}
