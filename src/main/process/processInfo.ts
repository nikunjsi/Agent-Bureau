import { runWindowsPowerShellSync } from './windowsPowerShell';

/**
 * What a start-time read can tell us. Three answers, never two (M11
 * S1-21).
 *
 * This used to be `string | null`, with `null` documented as "the process
 * doesn't exist (already dead — not an orphan, nothing to do)". Every way
 * of failing to read also produced `null`, so "I could not tell" arrived
 * at `sweepOrphans` wearing the word "dead". When the parent's
 * `PSModulePath` shadowed `Get-Process` (see `windowsPowerShell.ts`), a
 * **live** orphan was reported dead: never killed, no
 * `employee.orphan_killed`, no secret revocation, and no trace of any of
 * it.
 *
 * `unreadable` is not a softer `not_found`. It is a different fact, and
 * §4.4's guard needs it: a PID that could not be verified must never be
 * killed — PIDs are reused and the kill is irreversible — and must never
 * be passed over in silence either.
 */
export type ProcessStartTimeRead =
  /** The process exists; `startedAt` is its start time in §5.0's ISO-8601 form. */
  | { readonly kind: 'alive'; readonly startedAt: string }
  /** The read succeeded and the process is not there. */
  | { readonly kind: 'not_found' }
  /** The read itself failed. Says nothing about whether the process exists. */
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Reads a running process's start time, to guard against PID reuse
 * (§4.4 — "check whether that PID is alive **and** its start time matches
 * `process_start_time`"). Node has no cross-process start-time API, so
 * this shells out to PowerShell, which is already a documented dependency
 * of this project's toolchain (CONTRIBUTING.md).
 *
 * Through `windowsPowerShell.ts` — absolute path, explicit `PSModulePath`
 * — never a bare `powershell.exe` off PATH (M11 S1-21).
 *
 * `env` is injectable so a test can reproduce the shadowed-module failure
 * for real, rather than mocking the thing under test.
 */
export function getProcessStartTime(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): ProcessStartTimeRead {
  let output: string;
  try {
    // The three answers are told apart **in PowerShell**, by a word, and
    // the script always exits 0.
    //
    // Not by exit code or by empty output, which is what this used to do
    // and why the two got conflated. `Get-Process` on an absent PID sets
    // `$?` false even under `-ErrorAction SilentlyContinue`, so
    // `powershell.exe` exits 1 and `execFileSync` throws — identically to
    // a PowerShell that could not load the module at all. Measured on the
    // dev box: with the old script a freshly-killed process and a
    // shadowed `Get-Process` produced the same throw.
    //
    // Explicit UTC + 3-digit-ms + literal 'Z' matches §5.0's ISO-8601
    // convention; PowerShell's built-in 'o' format is local time with a
    // numeric offset and 7 fractional digits, which matches nothing else
    // in the schema.
    output = runWindowsPowerShellSync(
      `$ErrorActionPreference = 'Stop'; ` +
        `try { $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
        `if ($p) { 'ALIVE ' + $p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') } ` +
        `else { 'NOTFOUND' } } ` +
        `catch { 'UNREADABLE ' + $_.Exception.Message }; exit 0`,
      env,
    );
  } catch (err) {
    // The spawn itself failed — no PowerShell, no permission. Still a
    // "could not tell", never a "dead".
    return { kind: 'unreadable', reason: describeReadFailure(err) };
  }
  if (output.startsWith('ALIVE ')) return { kind: 'alive', startedAt: output.slice(6).trim() };
  if (output === 'NOTFOUND') return { kind: 'not_found' };
  // Includes the shadowed-module case, and anything unrecognised: an
  // answer this function cannot read is never reported as a dead process
  // (invariant #6).
  return {
    kind: 'unreadable',
    reason: output.startsWith('UNREADABLE ')
      ? oneLine(output.slice(11))
      : `unrecognised reply from Get-Process: ${oneLine(output) || '(empty)'}`,
  };
}

/** PowerShell's own words, on one line — the caller logs this, and a CI
 *  log is where it will be read. A process listing carries no secret. */
function describeReadFailure(err: unknown): string {
  const stderr = (err as { stderr?: unknown } | null)?.stderr;
  const text =
    typeof stderr === 'string' && stderr.trim().length > 0
      ? stderr
      : err instanceof Error
        ? err.message
        : String(err);
  return oneLine(text);
}

/** One log line. A process listing carries no secret. */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}…` : collapsed;
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
