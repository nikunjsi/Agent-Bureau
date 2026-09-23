import { getProcessStartTime } from '../../src/main/process/processInfo';

/**
 * The start time of a process a test has just spawned and believes is
 * alive. Throws if the read says anything else — including `unreadable`,
 * which is the whole point of M11 S1-21: a fixture that quietly accepted
 * "I could not tell" as "dead" is how a live orphan went unswept in
 * production, and a fixture that accepts it here would seed the row with
 * `undefined` and test nothing.
 */
export function startTimeOfLiveProcess(pid: number): string {
  const read = getProcessStartTime(pid);
  if (read.kind !== 'alive') {
    throw new Error(
      `expected PID ${pid} to be alive and readable, got ${read.kind}` +
        (read.kind === 'unreadable' ? `: ${read.reason}` : ''),
    );
  }
  return read.startedAt;
}

/** True only when the read succeeded AND found nothing — never when the
 *  read itself failed. */
export function processIsConfirmedGone(pid: number): boolean {
  return getProcessStartTime(pid).kind === 'not_found';
}
