/**
 * §7.9: "bureau_report_status ... Rate-limited to 1/3 s." That rate is
 * documented as a tool-level rule for the agent to follow; §7.10's own
 * build list requires enforcing it *server-side* too, since bureau-tools
 * runs as a child of the agent CLI, not a process the Core fully
 * controls (§7.9: "its stdio pipe is not an authentication boundary" —
 * the same reasoning extends to trusting it to rate-limit itself
 * honestly). Keyed by employeeId+toolName so one employee hammering one
 * tool doesn't affect another employee, or that employee's other tools.
 */
export class RateLimiter {
  private readonly lastCallAtMs = new Map<string, number>();

  constructor(private readonly windowsMsByToolName: Readonly<Record<string, number>>) {}

  /** True if this call is allowed (and records it as having happened); false if it arrived inside the configured window for this tool. A tool with no configured window is never rate-limited. */
  checkAndRecord(employeeId: string, toolName: string, now: number = Date.now()): boolean {
    const windowMs = this.windowsMsByToolName[toolName];
    if (windowMs === undefined) return true;
    const key = `${employeeId}:${toolName}`;
    const last = this.lastCallAtMs.get(key);
    if (last !== undefined && now - last < windowMs) return false;
    this.lastCallAtMs.set(key, now);
    return true;
  }
}
