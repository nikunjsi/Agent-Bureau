import type { Checkpoint } from '../../../../shared/models/checkpoint';

/**
 * §14.4's keyboard, as a pure function (X-16).
 *
 * The view owns focus, state and the IPC call; this owns the rules, so each
 * one can be stated and tested on its own rather than through a rendered
 * DOM. The rules are §14.4's — "`J`/`K` to move, `1`–`9` to choose an option,
 * `Enter` to confirm" — plus §9.1's "answered with a single keypress" for a
 * `permission` checkpoint, which is the one place a number commits rather
 * than marks: the agent is held while the user decides, and a confirm
 * keystroke is latency on a decision already made.
 */
export type CheckpointKeyIntent =
  | { readonly kind: 'move'; readonly to: number }
  | { readonly kind: 'mark'; readonly optionId: string }
  | { readonly kind: 'answer'; readonly optionId: string }
  | { readonly kind: 'permission'; readonly allow: boolean };

export interface CheckpointKeyState {
  readonly checkpoint: Checkpoint;
  /** Where the cursor is, and how far it may go. */
  readonly cursor: number;
  readonly count: number;
  /** The option `1`–`9` marked, awaiting `Enter`. */
  readonly markedOptionId: string | null;
}

export interface CheckpointKeyEvent {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

export function resolveCheckpointKey(
  event: CheckpointKeyEvent,
  state: CheckpointKeyState,
): CheckpointKeyIntent | null {
  // A modifier means the keystroke belongs to the app or the OS — Ctrl+J is
  // not "move down", and answering someone's question on a mis-typed
  // shortcut is the failure this guard exists for.
  if (event.ctrlKey === true || event.altKey === true || event.metaKey === true) return null;

  const clamp = (index: number): number =>
    Math.min(Math.max(index, 0), Math.max(state.count - 1, 0));

  switch (event.key) {
    case 'j':
    case 'J':
    case 'ArrowDown':
      return { kind: 'move', to: clamp(state.cursor + 1) };
    case 'k':
    case 'K':
    case 'ArrowUp':
      return { kind: 'move', to: clamp(state.cursor - 1) };
    case 'Enter':
      return state.markedOptionId === null
        ? null
        : { kind: 'answer', optionId: state.markedOptionId };
    default:
      break;
  }

  if (!/^[1-9]$/.test(event.key)) return null;
  const option = (state.checkpoint.options ?? [])[Number(event.key) - 1];
  if (option === undefined) return null;

  if (state.checkpoint.type === 'permission') {
    // The verdict comes from the option's own id, not its position: a card
    // that ever renders them the other way round must not invert an answer.
    return { kind: 'permission', allow: option.id === 'allow_once' };
  }
  return { kind: 'mark', optionId: option.id };
}
