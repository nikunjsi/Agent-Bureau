/**
 * Create (idempotently) the process-wide Windows Job Object with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set. Must succeed before assignProcess
 * is called. Throws on failure.
 */
export function initJob(): boolean;

/**
 * Assign the process identified by `pid` to the job created by initJob().
 * Job membership propagates to that process's future children. Throws on
 * failure (e.g. the pid does not exist or access is denied).
 */
export function assignProcess(pid: number): boolean;
