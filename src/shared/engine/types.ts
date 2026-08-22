import type { Autonomy } from '../models/enums';
import type { Employee } from '../models/employee';
import type { Role } from '../models/role';
import type { Task } from '../models/task';
import type { ControlChannelDescriptor, SecretBroker, ToolServerDescriptor } from './seams';

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
}
