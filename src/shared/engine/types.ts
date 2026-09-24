import { UserFacingError } from '../errors/userFacing';
import type { Employee } from '../models/employee';
import type { Role } from '../models/role';
import type { Task } from '../models/task';
import type { ControlChannelDescriptor, SecretBroker, ToolServerDescriptor } from './seams';
import type { ToolClass } from '../policy/types';

/**
 * §7.8's two bounds. One constant was serving both jobs, and they want
 * different numbers — which is what produced five occurrences of the same
 * flake and four wrong diagnoses (`PROJECT-CHECKLIST.md`'s Known Issues row).
 *
 * **The liveness ceiling is the guard.** It exists only so `probe()` can
 * never hang, and it is deliberately far above anything measured: the cold
 * case (page cache churned, Defender scanning a 318.7 MB `claude.exe` on
 * first touch) ran 3875/3987/4372ms for a whole probe, and to 9846ms for a
 * SINGLE launch under Defender. 30s is not a prediction of the tail — it is
 * a number chosen to be *uninformative* about the tail, so that exceeding it
 * means "something is genuinely wrong" rather than "the machine was cold".
 * It is NOT a UX promise and no user-facing copy should quote it.
 */
export const PROBE_LIVENESS_CEILING_MS = 30_000;

/**
 * **The responsiveness budget is the promise**, and only for a caller with a
 * human waiting on the answer. Warm p50 is 1785ms and p99 2024ms over 148
 * samples, so 2.5s clears the entire warm population with margin — and a
 * cold probe deliberately does NOT fit, which is the point: the honest
 * answer to "a person is holding a settings toggle and the CLI is cold" is
 * `indeterminate`, not a fast lie in either direction.
 */
export const PROBE_RESPONSIVENESS_BUDGET_MS = 2_500;

/**
 * Did the probe actually find out?
 *
 * `probe()` used to collapse "it is not installed" onto "I could not find
 * out" — both reported `installed: false` — and that collapse *was* the
 * shipped bug. The probe cache is in-memory, so the first probe after every
 * Bureau restart is the one most likely to run cold, which makes it the one
 * most likely to have lied.
 *
 * **Fail closed in behaviour, honest in message.** An `indeterminate` result
 * still carries the pessimistic values (`installed: false`,
 * `authenticated: false`, `metered: true`), so every consumer — including
 * one written before this field existed — keeps taking the safe direction
 * unchanged (invariant #6, §24.5). What the field adds is the ability to
 * stop *claiming the CLI is absent*: "I could not check in time" and "it is
 * not there" lead a user to completely different actions.
 */
export type ProbeDetermination = 'determined' | 'indeterminate';

/**
 * Thrown by a caller that refuses to act on an `indeterminate` probe —
 * `Supervisor.assign()` today. A distinct type rather than a bare `Error`
 * because the whole point is that this is NOT "the engine is missing": a
 * caller catching it should say "could not check", offer a retry, and never
 * send the user off to reinstall something that is already installed.
 *
 * Lives beside the probe contract, not beside its one thrower, for the same
 * reason `ProbeDetermination` does — the next caller that has to refuse an
 * unverified engine should find this rather than invent a second spelling.
 */
export class EngineProbeIndeterminateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineProbeIndeterminateError';
  }
}

/**
 * P-2 (pre-M11, NEXT-VERSION §H.9): thrown by a caller that refuses to act on
 * a DETERMINED "not installed" — the probe looked, and the engine is not
 * there. The opposite claim to `EngineProbeIndeterminateError`, deliberately
 * a different type. A `UserFacingError`, because its sentence is written for
 * the person who has to install the engine (CLAUDE.md: translate, don't show
 * raw engine output).
 */
export class EngineNotInstalledError extends UserFacingError {}

/**
 * M11 S1-7, risk #34's decision E-4a: Bureau-driven runs use an API key,
 * and the subscription is for small manual checks only. Without a stored
 * key the CLI falls back to whatever subscription login its config
 * directory resolves — silently, and on the user's own account — which is
 * the case that decision rules out. So a real `claude-code` launch is
 * refused before it spawns, in words that name the field to fill in.
 */
export class EngineApiKeyRequiredError extends UserFacingError {}

/**
 * M11 hook liveness (§7.6): an engine whose policy gate is a hook launched,
 * but the hook never reached the control channel with this employee's
 * token. Registering a hook is not the same as the CLI running it — under
 * `--bare` it does not, and a `bureau_` tool call then changes Bureau's
 * state with no policy check at all. So the employee is refused before it
 * starts (invariant #6), in words a person can act on.
 */
export class EngineHookNotRunningError extends UserFacingError {}

/** What a caller tells `probe()` about its own deadline. See `budgetMs`. */
export interface ProbeOptions {
  /**
   * How long this caller is willing to wait, in ms. **Capped at
   * `PROBE_LIVENESS_CEILING_MS`** — a caller may ask for less than the
   * ceiling, never more, because "never hangs" is the adapter's own
   * guarantee and must not be defeatable from a call site.
   *
   * **Required** (pre-M11 D-1). It used to be optional, defaulting to the
   * ceiling, and the default was the wrong way round for the caller most
   * likely to omit it: a settings toggle with a person waiting on it would
   * hang for the full 30 s because it had not thought about a deadline.
   * "Did not think about it" is not a reason to wait longest; it is the
   * reason to make the call site say. A caller that genuinely wants the
   * ceiling passes `PROBE_LIVENESS_CEILING_MS`, which reads as a decision.
   */
  budgetMs: number;
}

/** §7.1.1 — installed? authenticated? which version? MUST NOT throw, MUST finish within its budget (§7.8). */
export interface ProbeResult {
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  binaryPath: string | null; // ABSOLUTE — see §15.4
  error: string | null;
  /**
   * Whether the probe reached a real answer at all. See
   * `ProbeDetermination` — an `indeterminate` result's other fields are
   * fail-closed defaults, NOT observations, and must never be reported to a
   * user as facts about their machine.
   */
  determination: ProbeDetermination;
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
  /**
   * Electron's `userData` root — where §12.1's memory tree lives.
   *
   * **This replaced `memoryPack: string` and `decisionLog: string` at M10,
   * and the reason is worth keeping.** Those two were caller-supplied
   * strings that nothing in `src/` ever read: a write-only *decision input*,
   * which is precisely the tell standing rule 6 names ("a write-only column
   * whose writer and reader are different subsystems means something else is
   * deciding instead"). Had they stayed, the Supervisor would have composed
   * a pack from the database while every caller also supplied one, and only
   * one of the two would win — the identical shape of the model-tier bug the
   * M7→M4 boundary check found.
   *
   * §12.3 says "on task assignment, **the supervisor** composes", so the
   * Supervisor composes, and what it needs from a caller is where the notes
   * are — not the notes.
   *
   * The decision log is not a separate field for the same reason:
   * `project/decisions.md` IS a pinned project memory note (§12.5 writes it
   * through `writeMemory`), so it arrives inside the pack. Each pack item
   * carries its `kind`, which is what lets Appendix B's two prompt slots be
   * filled from one composition rather than two derivations of one thing.
   */
  baseDir: string;
  toolServer: ToolServerDescriptor; // §7.9 — M4 placeholder until then
  controlChannel: ControlChannelDescriptor; // §7.10 — M4 placeholder until then
  broker: SecretBroker; // §11.4 — M6 placeholder until then
  /**
   * **Removed at pre-M11 D-4** (NEXT-VERSION §H.7, option 1): `EmployeeContext`
   * used to carry `effectiveAutonomy`. Every caller set it and nothing read
   * it — the real decision is made at policy-check time, where it has to be:
   * `contextBuilder` computes it from the persisted row and `policyEvaluator`
   * then applies §7.3’s ungateable-engine floor and §11.5’s breaker
   * constraint, neither of which is knowable at launch. A field on the spawn
   * context could only ever be a stale copy of an answer computed elsewhere,
   * and the hazard was a future caller believing that setting it did
   * something. If an adapter ever genuinely needs the level at launch, it
   * comes back with a reader.
   */
  /**
   * §7.5 — the concrete model id this employee's declared tier resolved
   * to, or `null` for "pass no model and let the engine choose its own".
   * Resolved by the Supervisor (`role.model_preference` +
   * `settings.engines.modelTiers`), never by an adapter: tiers are a
   * Bureau concept and adapters have no path to the settings DB.
   *
   * Required, not optional, on purpose (AUDIT #1): every spawn path is
   * forced by the type system to have decided a model, which is what
   * stopped being true when `costSafetyArgs()` hardcoded one.
   */
  modelId: string | null;
  /**
   * §11.5.1 — a per-TURN spend ceiling in micro-dollars, or `null` for
   * uncapped. This is a backstop, not the budget system: §11.5's four
   * levels are cumulative and enforced after each turn completes, so
   * nothing else bounds a single runaway turn. Set to the effective
   * per-task budget so the §11.5 levels always bind first.
   */
  turnBudgetCapUsdMicros: number | null;
}

/**
 * §7.1.1 — 'ask' is resolved to allow/deny by the Core (the policy engine,
 * M6) before ever reaching the adapter; the adapter only ever sees a final
 * verdict, never has to interpret 'ask' itself.
 */
export type PolicyVerdict =
  { effect: 'allow'; ruleId: string } | { effect: 'deny'; ruleId: string; reason: string };

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
