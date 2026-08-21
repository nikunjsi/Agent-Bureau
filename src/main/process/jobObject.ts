import { initJob, assignProcess } from '@bureau/job-object';

let initialized = false;

/**
 * Creates the process-wide Windows Job Object (idempotent). Call once,
 * early in startup, before any child process is spawned. See §4.4.
 */
export function ensureJobObject(): void {
  if (initialized) return;
  initJob();
  initialized = true;
}

/**
 * Assigns `pid` to Bureau's Job Object, so it (and anything it spawns) is
 * killed automatically if Bureau's own process dies for any reason.
 */
export function containProcess(pid: number): void {
  if (!initialized) {
    throw new Error('containProcess called before ensureJobObject()');
  }
  assignProcess(pid);
}
