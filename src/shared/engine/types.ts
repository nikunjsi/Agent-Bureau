import type { Autonomy } from '../models/enums';
import type { Employee } from '../models/employee';
import type { Role } from '../models/role';
import type { Task } from '../models/task';
import type { ControlChannelDescriptor, SecretBroker, ToolServerDescriptor } from './seams';
import type { ToolClass } from '../policy/types';

/** §7.1.1 — installed? authenticated? which version? MUST NOT throw, MUST finish < 5s. */
export interface ProbeResult {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  binaryPath: string | null; // ABSOLUTE — see §15.4
  error: string | null;
  /** §24.5 — does further use of this engine cost the user money? An
   * adapter that cannot positively confirm otherwise MUST report true —
   * the safe direction (§24.5's own rule). Zero-cost-mode *enforcement*
   * reading this is M6's job; this field exists so a real value is
   * available once that's built, not because M3 enforces anything with it. */
  metered: boolean;
}

/** §7.1.1 — what buildLaunchSpec produces: argv, env, cwd, nothing more. */
export interface LaunchSpec {
  command: string; // absolute path
  args: string[];
  cwd: string;
  env: Record<string, string>; // nothing inherited except §7.6's minimal Windows base allowlist
  configFiles: Array<{ path: string; content: string }>; // written before spawn
}

/**
 * §7.1.1 — everything an adapter needs to build a launch spec and run a
 * turn. `worktreePath` is legitimately `''` for the Director (§8.0: no
 * worktree) — an unset `${worktree}` pattern variable matches nothing, per
 * §11.3, not everything.
 */
export interface EmployeeContext {
  employee: Employee;
  role: Role;
  task: Task | null;
  worktreePath: string;
  stateDir: string;
  memoryPack: string;
  decisionLog: string;
  toolServer: ToolServerDescriptor; // §7.9 — M4 placeholder until then
  controlChannel: ControlChannelDescriptor; // §7.10 — M4 placeholder until then
  broker: SecretBroker; // §11.4 — M6 placeholder until then
  effectiveAutonomy: Autonomy; // computed (§7.3), not persisted
}

/**
 * §7.1.1 — 'ask' is resolved to allow/deny by the Core (the policy engine,
 * M6) before ever reaching the adapter; the adapter only ever sees a final
 * verdict, never has to interpret 'ask' itself.
 */
export type PolicyVerdict =
  | { effect: 'allow'; ruleId: string }
  | { effect: 'deny'; ruleId: string; reason: string };

/** §7.1.1 — reported usage for one turn; `costUsdMicros` is null when the engine does not report usage. */
export interface Usage {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  model: string | null;
  costUsdMicros: number | null;
}

/** §7.1.1 — what this engine can actually do at this version. Never aspirational. */
export interface EngineCapabilities {
  structuredEvents: boolean; // native tool-call objects, not screen-scraping
  permissionCallback: boolean; // can we synchronously allow/deny in-process?
  hookInterception: boolean; // external hook mechanism available?
  sessionResume: boolean;
  interrupt: boolean;
  usageReporting: boolean; // does it report tokens/cost?
  mcpServers: boolean;
  modelSelection: boolean;
  maxContextTokens: number | null;
  /**
   * §24.4/§7.7.1 (M3 session 3 correction): NOT "does the engine cache" —
   * every real model API might, regardless of transport, which would make
   * this field true everywhere and useless. Means "does BUREAU assemble
   * this turn's request/prompt content itself, in a form it can keep
   * byte-stable across turns so the engine's own cache hits" — a property
   * of the transport, not the model. True for structured mode (Bureau
   * constructs the `-p` payload directly). False for PTY mode: Bureau
   * writes free-form text into a live interactive session it does not
   * assemble a request for — there is no byte-stable block on Bureau's
   * side to keep stable, regardless of what the engine itself might do
   * internally with its own context.
   */
  promptCaching: boolean;
  /**
   * §11.2: "Bureau gates the engine's named network tools — `WebFetch`,
   * `WebSearch`, and equivalents, declared per adapter in
   * `capabilities.networkTools`." The exact tool names this engine
   * exposes that count as network tools for autonomy-gating purposes —
   * NOT a claim about network egress in general (an employee with
   * `Bash(curl *)` reaches the network regardless; §11.2 states this
   * plainly and S15 deliberately does not assert zero egress).
   */
  networkTools: readonly string[];
  /**
   * §11.3: tool classes ("read"/"write"/"command"/"network"/"bureau"/
   * "other") "are declared by each adapter" — this engine's own tool
   * names mapped to §23.2's classes. `bureau` is never populated here
   * (checked centrally, cross-engine, in src/shared/policy/evaluator.ts's
   * `isBureauTool` — every engine reaches the same MCP tool server, §7.9).
   * A tool name absent from this map falls through to `other`, which
   * denies by default (§11.3) — not this map's job to be exhaustive over
   * every string an engine might ever emit, only over the ones §23.2
   * actually names.
   */
  toolClasses: Readonly<Record<string, ToolClass>>;
}
