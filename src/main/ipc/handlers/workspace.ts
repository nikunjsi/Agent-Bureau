import { stub, type Handler } from './types';

// §28 M14 item 2's Inspector "Files with diffs" tab. Tagged M5 until AUDIT
// M0–M2 #25: M5 built the worktrees and git plumbing these would read, and
// shipped without these surfaces, so the stubs were telling users a
// feature belonged to a milestone already behind them.
export const workspaceHandlers: Record<string, Handler> = {
  diffForTask: stub('M14'),
  diffForEmployee: stub('M14'),
  fileTree: stub('M14'),
};
