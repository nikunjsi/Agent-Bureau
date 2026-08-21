import { execFileSync } from 'node:child_process';

/**
 * Reads a running process's start time, to guard against PID reuse
 * (§4.4 — "check whether that PID is alive **and** its start time matches
 * `process_start_time`"). Node has no cross-process start-time API, so
 * this shells out to PowerShell, which is already a documented dependency
 * of this project's toolchain (CONTRIBUTING.md).
 *
 * Returns `null` if the process doesn't exist (already dead — not an
 * orphan, nothing to do).
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Explicit UTC + 3-digit-ms + literal 'Z', matching §5.0's
        // ISO-8601 convention exactly — PowerShell's built-in 'o' format
        // uses *local* time with a numeric offset, not UTC, and 7
        // fractional digits, neither of which matches the rest of the
        // schema. The explicit $p/if-null check (rather than relying on
        // -ErrorAction against a null-valued expression, which still
        // throws a terminating error when you call .StartTime on it)
        // avoids printing a scary-looking PowerShell exception to stderr
        // for the very common "process doesn't exist" case.
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/** Best-effort forceful kill by PID. Never throws — killing an already-dead
 * process is not an error condition here. */
export function killProcess(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    // Already gone — fine.
  }
}
