import type { Usage } from './types';

/** §7.1.1 — what `send()` is delivering, so turn-boundary discipline (§7.4) can decide how urgently. */
export type SendKind =
  | 'task' // the initial task instruction
  | 'message' // a handoff or answer from another employee / the Director
  | 'answer' // a checkpoint answer being injected
  | 'steer' // circuit-breaker corrective message
  | 'user'; // direct user input via "take control"

/**
 * §7.2 — the one normalised event stream everything above the adapter
 * consumes. `raw` is deliberately separate from `text.delta`: the terminal
 * wants ANSI intact, the activity log and the Director want clean text.
 * Conflating them gives you either an ugly terminal or a log full of
 * escape codes.
 */
export type AgentEvent =
  | { t: 'session.started'; sessionId: string | null; engineVersion: string; model: string | null }
  | { t: 'turn.started'; turnIndex: number }
  | { t: 'text.delta'; text: string } // clean semantic text
  | { t: 'thinking.delta'; text: string } // if exposed separately
  | {
      t: 'tool.requested';
      callId: string;
      tool: string;
      rawTool: string;
      args: unknown;
      preview: string;
    }
  | { t: 'tool.completed'; callId: string; ok: boolean; excerpt: string; ms: number }
  | { t: 'turn.completed'; turnIndex: number; usage: Usage | null }
  | { t: 'idle' } // at a prompt; safe to inject
  | {
      t: 'finished';
      reason: 'completed' | 'max_turns' | 'error' | 'interrupted';
      summary: string | null;
    }
  | { t: 'raw'; data: Buffer }; // verbatim bytes for xterm.js
