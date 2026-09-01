/**
 * The M4/M6 seams §7.1.1's `EmployeeContext` requires. The types here are
 * part of the real contract (defined normatively, not provisionally) — only
 * the *implementations* below are placeholders, each tagged with the
 * milestone that replaces it. Anything that touches these before that
 * milestone lands is a bug, not an early integration.
 */

/**
 * §7.9 — the stdio MCP server descriptor the agent CLI spawns itself.
 * `env` (M4 session 2 addition — TRAP #2 from the session prompt):
 * BUREAU_CONTROL_FILE must reach bureau-tools explicitly, via the MCP
 * config's own `env` block, never by relying on inheritance through the
 * agent CLI (the middle process) — that assumes the CLI passes its own
 * full environment through to an MCP server child unmodified, which is
 * not documented behaviour to rely on. The hook config has no equivalent
 * env field (confirmed against the current docs), so bureau-hook's own
 * copy of the same variables genuinely does rely on inheritance through
 * the CLI's own spawn env instead — see buildLaunchSpec's own comment.
 */
export interface ToolServerDescriptor {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** §7.10 — the loopback control channel `bureau-hook`/`bureau-tools` call back into. */
export interface ControlChannelDescriptor {
  url: string;
  token: string;
}

/**
 * The only sanctioned path for a secret value to reach an employee's process
 * environment (§11.4: "injected into the employee process environment at
 * spawn and nowhere else"). `EngineAdapter.buildLaunchSpec` carries its own
 * "MUST NOT read secrets directly" rule specifically so there is exactly one
 * caller of this interface.
 *
 * **Settled M6 session 3** (previously an open question, flagged in
 * `claudeCodeAdapter.ts`'s own comment): `EngineAdapter.start()`/`send()`
 * take only `EmployeeContext`, never a supervisor-finalized `LaunchSpec`,
 * so the natural caller of both `buildLaunchSpec()` and this interface is
 * the adapter's own `deliver()` — the one place that actually knows when a
 * real spawn is about to happen (structured mode: every turn; PTY mode:
 * only the first). Both real adapters (`ClaudeCodeAdapter`,
 * `GenericPtyAdapter`) independently converged on exactly this shape
 * before this was ever settled explicitly — evidence the design is right,
 * not a coincidence to paper over. The supervisor is not a caller of this
 * interface at all; it only ever passes the broker through unread, as one
 * field of `EmployeeContext`. That keeps every line of credential-handling
 * code in one auditable place per adapter instead of duplicated — and
 * inevitably drifting — across a supervisor-side merge AND an
 * adapter-side one.
 */
export interface SecretBroker {
  /**
   * Resolves the concrete credentials this employee/engine needs at spawn.
   * `secretValues` is separate from `env` because the redactor (§11.4)
   * matches known secret *values* at its single output choke point — a bare
   * `Record<string,string>` gives it no way to tell a secret apart from an
   * innocuous value like a host URL, so it would have to guess. Every value
   * that should never appear in an event, transcript, or log belongs here,
   * exactly as issued.
   */
  resolveForSpawn(ctx: { employeeId: string; engineKey: string }): Promise<SpawnSecrets>;

  /**
   * Ends this employee's credentials. Short-lived, scoped credentials are
   * the reason to have a broker instead of a static env-var lookup at all —
   * something has to end them when the employee stops. Called on every stop
   * path (clean stop, fire, crash-reconcile), not only the happy path.
   */
  revokeForEmployee(employeeId: string): Promise<void>;
}

export interface SpawnSecrets {
  env: Record<string, string>;
  secretValues: string[];
}

// M4: the real tool server is `bureau-tools`, a stdio MCP server the agent
// CLI itself spawns from this descriptor (§7.9) — Bureau never launches it
// directly. `command` deliberately points at a path that cannot exist, so
// anything that actually tries to use this placeholder fails loudly instead
// of silently succeeding against nothing.
export const placeholderToolServer: ToolServerDescriptor = {
  command: '__bureau_tool_server_not_yet_implemented__',
  args: [],
  env: {},
};

// M4: the real control channel is a loopback HTTP server the Core binds at
// startup (§7.10 — 127.0.0.1:0, never 0.0.0.0). This placeholder reuses the
// spec's own "port 0 = unassigned" notation; no server is listening on it.
export const placeholderControlChannel: ControlChannelDescriptor = {
  url: 'http://127.0.0.1:0/not-yet-implemented',
  token: 'M4-placeholder-token',
};

// M6: the real broker reads Electron's safeStorage (§11.4) and resolves
// actual provider credentials, revoking them for real on employee stop.
// Until M6, every employee spawns with zero injected credentials — an
// engine requiring auth simply fails probe()/start(), which is the correct,
// honest behaviour for a subsystem that does not exist yet, not something
// to fake.
export const noopSecretBroker: SecretBroker = {
  async resolveForSpawn(): Promise<SpawnSecrets> {
    return { env: {}, secretValues: [] };
  },
  async revokeForEmployee(): Promise<void> {
    // no-op — see M6 note above.
  },
};
