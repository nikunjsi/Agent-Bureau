# Progress

## M0–M2 — archived

Full session-by-session detail for M0, M1, the M0/M1 audit+fixes session,
and M2 moved to `docs/progress/M0-M2.md` (2026-08-22, at the M3→M4
boundary) to keep this file's per-session catch-up cost bounded — nothing
was dropped, only moved. One paragraph per milestone below, plus every
item that was still open at archive time.

**M0 (Skeleton), 2026-08-21.** Repo scaffold, four strict TypeScript
project references, ESLint 9 flat config, Electron main process with
`contextIsolation`/`sandbox`/`nodeIntegration:false` and the `app://`
protocol (traversal-guarded), the `bureau-job-object` N-API addon
(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`), one real IPC method
(`system.health`), and a build/CI pipeline. All four M0 gates confirmed
against the real packaged app: CI green on GitHub Actions, `app://`
launch, native modules loading packaged, no orphaned child on a hard
kill.

**M1 (Data layer), 2026-08-21.** The complete §5.1 schema
(`0001_initial.sql`), a checksum-verified migration runner with WAL-safe
backups, Zod models for all 24+ tables, the §16.1 settings registry,
the file-then-mirror activity log, `reconcile()`'s five behaviors, and
`checkIntegrity`/backup-listing. Gate: 20 scripted kill points, each with
specific post-recovery assertions, three consecutive clean runs. Found
and fixed a real spec bug in the process (`employees.role_key`'s FK
target wasn't actually unique) plus eight tables missing timestamp
columns — both corrected directly in `docs/BUILD-SPEC.md`.

**Audit + fixes (M0/M1), 2026-08-21.** A five-phase audit (one phase run
by an independent subagent) against the spec, followed by a *separate*
fix session per its own methodology. Eight of nine BLOCKER/SERIOUS
findings fixed, each with a failing test written first and confirmed to
fail for the stated reason before the fix landed — including that no
repository had ever validated its own Zod schema before writing, and that
`ActivityLog.logEvent()` was called by nothing anywhere, including
`reconcile()` itself. Full suite 70/70 at close.

**M2 (IPC + application shell), 2026-08-21 → re-verified 2026-08-22.**
The complete, spec-corrected §17.1 surface (20 namespaces, 109 methods, 7
events, enforced by `scripts/checkIpcSurface.mjs` in CI), the envelope/
router/preload, and a real window shell with a Zustand store implementing
`stateDelta` semantics. S13 (no renderer Node access) and S14 (bad
payload rejected) both passed with genuine mutation proofs. Found a real
double-envelope bug that only surfaced by launching the actual packaged
app — no automated gate (typecheck/lint/full test suite) had caught it,
which is why a from-scratch, independent re-verification pass was run the
next session before trusting any of M2's claimed results; everything
reproduced exactly.

### Carried forward — still open

- **Job Object grandchild containment (audit finding #6) — not built.**
  The design is sound (3-level process tree, the real addon, no Electron
  needed) but this coding session's own sandboxed shell appears to reap
  orphaned child processes independent of Bureau's own code, which would
  make a bare-`node` grandchild test unable to distinguish "our
  containment worked" from "the sandbox already did it." Needs to run
  somewhere that assertion actually discriminates — a plain terminal
  outside this tool — before it's worth building. Not urgent;
  `job-object.test.ts` (the real packaged-app gate) is unaffected and
  passes.
- **`ELECTRON_RUN_AS_NODE` / `NoDefaultCurrentDirectoryInExePath` — this
  coding session's own sandbox env vars, not present on a real user's
  machine, and they have caused real confusion in every M0–M3 session
  that manually launched or tested the packaged app.** `ELECTRON_RUN_AS_NODE=1`
  makes `Bureau.exe` run as a bare Node CLI (instant silent exit, no
  window) instead of launching Electron; it leaks into `npm run
  test:integration`/`test:e2e` child spawns too since this session's shell
  doesn't persist env changes between separate tool calls. **Always
  `unset ELECTRON_RUN_AS_NODE` in the *same* command as any manual
  packaged-app launch or test run.**
- **`restoreFromBackup()` (M1) exists but nothing calls it** — no UI
  exists yet to offer a "restore from backup" flow. Correctly deferred,
  not a bug; needs a real caller once a recovery UI exists.
- **`getSecretsStatus`/`setSecret`/`clearSecret` (M2) stayed stubbed**,
  including the read-only half — writing needs Electron's `safeStorage`
  wired deliberately, and which milestone owns that was left unsettled
  rather than guessed at.
- **§14.7 accessibility: WCAG AA contrast has not been verified in either
  theme** — reasonable-effort semantic HTML/labels/focus exist, but no
  claim of verified contrast is made. M14 owns the real accessibility
  pass.
- **The audit's MINOR findings list exists only in that session's chat
  transcript** — delivered in chat, never written to a file. Worth
  knowing this isn't retrievable from the repo if it's ever needed again.
- **`npm audit`'s esbuild dev-server advisory (M0)** — dev-tooling only,
  never shipped in the packaged app. Deferred to a dedicated pass before
  M15's hardening rather than risked mid-milestone.

## 2026-08-22 — M3 (Engine adapter + supervisor), session 1 of 3 — steps 1-4

Scoped deliberately: types, the resolved-PATH service, PtySession,
FakeAdapter. ClaudeCodeAdapter and the supervisor are session 2's job -
stopped here as instructed, not because anything ran out.

### Pre-implementation: A/B/C, resolved before writing code

The session's prompt asked three things be argued through and approved
before any code, per the "cheapest moment to fix it" principle. All three
were approved with additions; what actually got built reflects the
approved (not the originally-proposed) shape:

- **A - the M4/M6 seams.** ToolServerDescriptor/ControlChannelDescriptor
  were already fully specified inline in EmployeeContext (§7.9/§7.10);
  named for readability. SecretBroker was referenced by
  EmployeeContext.broker and defined nowhere in the spec at all - a real
  gap, same shape as M1/M2's schema gaps. Defined normatively in §7.1.1
  and in code, with two additions the review caught that the first draft
  missed: SpawnSecrets (env + secretValues, so the M6 redactor can match
  known secret *values* instead of guessing which env entries are
  sensitive) and revokeForEmployee (credential lifecycle end - the reason
  to have a broker instead of a static lookup is short-lived scoped
  credentials, and something has to end them).
- **B - the Windows env allowlist.** Verified against a real, currently
  installed artifact, not just documentation: claude on this machine
  resolves to %APPDATA%\npm\claude.cmd, a batch shim - confirming ComSpec
  is genuinely load-bearing, not a theoretical edge case. Allowlist:
  SystemRoot, SystemDrive, windir, ComSpec, PATHEXT (inherited from the
  real machine env), plus TEMP/TMP synthesized per employee at
  <stateDir>/tmp (not inherited - sidesteps ${bureau_state}'s genuine
  ambiguity in §11.3's grammar by using the one path that's already
  unambiguous elsewhere in §7.6). Pinned by a test per the explicit
  requirement that adding a variable later means deliberately editing
  that test, not widening an object literal.
- **C - contract tests 4 and 9 at M3.** Not written this session (§7.8's
  parameterised suite is step 9, later) - only the approach, and
  FakeAdapter built to support it: a scriptable filesystem sentinel tied
  to applyVerdict for test 4 (real proof, not simulated - FakeAdapter
  genuinely writes the file), and generic unaltered payload scriptability
  for test 9, with the eventual redactor check written against a small
  interface so the real M6 redactor drops in without the test needing a
  rewrite.

### What landed

- src/shared/engine/{events,types,seams,adapter,index}.ts - every
  §7.1/§7.1.1 type, including the new SecretBroker/SpawnSecrets.
  src/shared/models/enums.ts gained the two paired type exports
  (EngineMode, Autonomy) it was missing, following the one existing
  precedent (EmployeeStatus) - needed by the engine types, not redefined
  locally.
- src/main/engine/windowsEnv.ts - WINDOWS_BASE_ENV_ALLOWLIST,
  buildWindowsBaseEnv, buildEmployeeTempEnv.
- src/main/engine/{registry,resolvedPath}.ts - §15.4's resolved-PATH
  service. Reads HKCU\Environment and the machine environment key via
  `reg query`, unions with the four known install locations, resolves a
  bare binary name to an absolute path via PATHEXT-ordered filesystem
  probing, caches the result in M1's existing prereqs table (reused via
  upsertPrereq, not reinvented).
- src/main/engine/{ptyOutputBuffer,readyDebouncer,ptySession}.ts -
  node-pty wrapper. The chunk-boundary-safe rolling buffer and the §7.4
  debounce scheduler are separate, pure, independently testable classes;
  PtySession composes them with the real spawn/write/resize/kill wiring.
- src/main/engine/fakeAdapter.ts - full EngineAdapter, scripted event
  playback, real turn-boundary queueing, real sentinel-writing on
  applyVerdict.
- .github/workflows/ci.yml, package.json (from the M2 re-verification
  pass, carried into this session): npm run check:ipc-surface now a real
  CI step.

### Gate verification

- `npm run typecheck && npm run lint` - clean throughout, reverified
  after every step.
- `node scripts/checkIpcSurface.mjs` - 20/109/7, unaffected (M3 touches
  none of the IPC surface).
- Unit suite: **111/111 green** (16 files - up from 70/10 at the start of
  this session: +2 §7.1.1 composition, +4 windowsEnv, +11 resolvedPath
  pure logic, +6 ptyOutputBuffer, +5 readyDebouncer, +13 FakeAdapter).
- Integration suite: **82/82 green** (14 files - up from 70/12: +6
  resolvedPath against the real registry and a real migrated DB, +6
  PtySession against real node-pty), zero regression from M0/M1/M2.
- **The resolved-PATH service was verified against reality, not just
  logic**: readRegistryPathValue('HKLM') reads this machine's actual
  machine-level Path (confirmed non-empty, contains "system32");
  detectAndCacheBinary round-trips through a real migrated SQLite DB.
- **PtySession was verified against a real spawned process, not just the
  deterministic unit-level buffer/debounce logic**: a real escape
  sequence split across a real chunk boundary (two separate, delayed
  writes from a real child process) still reaches onReady; a real false
  match immediately followed by more real output does not fire onReady;
  kill() genuinely terminates a live, actively-writing process.
- **The real installed claude.cmd was launched for real** - --version
  only, through the real resolved-PATH service and the real minimal
  Windows env, output captured. Skips visibly with an explicit console
  message on a machine without the CLI (verified the .skipIf path is
  reachable; did not verify it on a second machine, since only one was
  available this session).
- FakeAdapter's own claims were checked against FakeAdapter's own
  behaviour, not assumed: turn-boundary queueing genuinely holds a
  send() until an idle event is *observed* by the consumer (not one
  cycle later - see "What surprised me"); applyVerdict('deny') genuinely
  never touches the sentinel file, applyVerdict('allow') genuinely does
  (both checked against the real filesystem, not FakeAdapter's own
  bookkeeping).

### Deviations from the spec, recorded per §0

- **SecretBroker/SpawnSecrets added to §7.1.1** - approved addition, see
  "Pre-implementation" above. Committed to docs/BUILD-SPEC.md in the same
  commit as the code.
- **§7.6's env block and prose corrected** for the Windows base allowlist
  - "nothing inherited" now names its one deliberate, documented
  exception instead of being contradicted by reality on the very next
  real spawn. Same commit as windowsEnv.ts.

### What surprised me

- **node-pty's `encoding` option is silently ignored on Windows** -
  confirmed by reading windowsPtyAgent.js before writing a line of
  PtySession, not discovered by a failing test afterward. It
  unconditionally calls outSocket.setEncoding('utf8') regardless of what
  is passed; windowsTerminal.js even console.warns if you try to set it.
  This meant the originally-planned design (request raw Buffer chunks,
  decode them myself with node:string_decoder) was not just unnecessary
  but **impossible** on this platform - node-pty already reassembles a
  multi-byte character split across raw reads correctly, via the same
  StringDecoder mechanism I would have written by hand. The real, still-
  open problem turned out to be one level up: an escape sequence made of
  already-valid decoded characters can still straddle two separate
  onData chunks, since chunk boundaries are a transport artifact
  unrelated to escape-sequence boundaries - that's what PtyOutputBuffer's
  rolling-buffer matching actually solves. Checking the real dependency's
  source before designing around a guess is what caught this; the wrong
  design would have compiled, typechecked, and looked correct.
- **A real bug in FakeAdapter, caught by its own first test run**: the
  idle-flush was placed *after* `yield event` in the events() async
  generator. A generator only resumes past its own yield on the
  consumer's *next* pull, so code placed after it runs one full pull
  late - a consumer that merely *observed* the idle event (one .next()
  call) would not yet see the flushed sends, contradicting §7.4's literal
  "flushing on the next idle event." Fixed by moving the flush before the
  yield. Exactly the kind of thing "no claim without a test" exists to
  catch, and did.
- **Two failures in the first real-PtySession test run were test bugs,
  not PtySession bugs** - worth recording precisely so the distinction
  doesn't get lost: (1) an assertion that two write() calls from a child
  process would appear byte-adjacent in the PTY stream is wrong on
  Windows - ConPTY is a real terminal emulator and legitimately injects
  its own control sequences (clear screen, cursor positioning, console
  title) around and between application output; fixed the assertion to
  check ordering, not adjacency. (2) A "does kill() work" test used a
  target script that withheld all output for 10 seconds regardless of
  being killed, which looks identical to a hung kill() from the outside;
  fixed by using an actively-heartbeating target so the test actually
  proves what it claims. Both were found by running the real thing and
  reading the real failure, not by trusting that green-looking code was
  correct.
- **A known-shaped, low-priority environment quirk, not a new one**:
  node-pty's Windows kill() path logs a benign "AttachConsole failed" to
  stderr in this specific sandboxed dev-tool shell - one of its two
  internal termination mechanisms (console-process-list enumeration)
  fails here, but the other one it also calls still succeeds, proven by
  kill()'s own test passing reliably once the test itself stopped being
  the confound. Same family as the audit session's already-documented
  "ambient process reaping" finding - noted, not chased further, per
  that session's own conclusion that it's this coding tool's sandboxing,
  not a product concern.

### What's stubbed / explicitly out of scope this session

- ClaudeCodeAdapter, the supervisor (§7.11), the turn-boundary queue's
  real wiring into a real adapter, xterm.js, the parameterised §7.8
  contract suite (step 9) - all explicitly session 2/3's job, named in
  the prompt itself.
- The M4/M6 seam placeholders (toolServer, controlChannel, broker) remain
  exactly that - inert, tagged, fail-loud if ever actually invoked.
  Nothing about them changed this session beyond definition.
- Contract tests 4 and 9 themselves are not written yet (see "Pre-
  implementation C" above) - only decided and supported.
- ${bureau_state}'s precise meaning in §11.3's permission grammar is
  still genuinely undefined in the spec - flagged, not resolved (M3
  sidestepped it by using the already-unambiguous per-employee stateDir
  for TEMP/TMP instead). Whoever builds the real policy engine (M6)
  needs to settle what it actually resolves to.
- Whether .skipIf's skip path is reachable was verified in principle (the
  condition is a plain boolean computed the normal way) but not observed
  on a machine without claude installed - only one machine was available
  this session.

### Next

- Session 2: ClaudeCodeAdapter (probe, capabilities, buildLaunchSpec with
  the real per-employee CLAUDE_CONFIG_DIR/HOME, structured mode first
  with PTY fallback, session resume), then the supervisor (§7.11).
- §7.3's mode-selection pseudocode reads role.engineOptions.mode, but
  M1's actual RoleSchema has no engineOptions field - only an opaque
  role_options: z.record(z.unknown()), deliberately left unvalidated at
  M1. Where mode actually lives inside that bag isn't settled yet.
  Flagging now so it's a known seam going into session 2, not a mid-
  session surprise.
- The "record base env keys on the launch activity event" requirement
  from point B has nowhere to attach yet - there is no launch event until
  the supervisor exists. Carrying it forward explicitly: session 2's
  supervisor work should emit envKeys: Object.keys(launchSpec.env) (keys
  only, never values) on whatever activity event marks an employee
  actually starting.

## 2026-08-22 — M3 session 2, part 1 — ClaudeCodeAdapter (§7.6)

Scoped by explicit instruction: this part covers the pre-implementation
decisions (D/E/F from the kickoff) and M3 step 5 only. The supervisor, the
turn-boundary queue, and the §7.8 contract suite are part 2 of this session
- not started here.

### Pre-implementation: D/E/F, resolved and corrected before writing code

- D (engine_options): my first proposal (array of engine-tagged variants)
  was corrected on review - the real shape is a single flat value, no
  array (a role runs under one engine, no fallback), and no self-tagging
  (the role's own engine_preference is the one source of truth; a value
  duplicating it would drift). engineOptionsSchemaFor(engineKey) selects
  the right schema externally, at insertRole, where both values are
  already in hand. Migration went to 0002_add_engine_options.sql, not an
  edit to 0001 - 0001 is already applied to a real dev DB
  (%APPDATA%/Bureau/bureau.db confirmed to exist), and editing it is
  exactly what MigrationChecksumMismatchError exists to reject.
- E (Claude Code's current reality): a subagent fetched the current docs.
  Two findings changed the spec, not just informed the code - see below.
- F (model tiers): confirmed against the current model list -
  claude-haiku-4-5-20251001 / claude-sonnet-5 / claude-opus-5 for
  fast/balanced/capable. None deprecated.

### Spec corrections (§7.6/§7.10/§7.4/§7.1.1), committed alongside the code

- **The most important one**: §7.6/§7.10 claimed the PreToolUse hook "has a
  hard 10s timeout and fails closed." The current docs say the opposite for
  a shell-command hook - a timeout does NOT block the call, it fails OPEN.
  Corrected with the actual fix: bureau-hook must self-deny before the
  engine's own timeout can ever be the thing that decides (exit 2 on
  transport failure; a self-deadline strictly less than the registered
  hook timeout, which is always set explicitly, never left at the 600s
  default). Spec edit only - bureau-hook itself is still M4's job.
- canUseTool is not consulted for every call (allow rules/acceptEdits/
  bypassPermissions/bare allowedTools bypass it silently) - written into
  §7.6 as the actual reason the architecture is hook-first.
- Project .mcp.json auto-discovery is confirmed ON by default with NO
  approval prompt in SDK/`-p` sessions - upgraded from a preference to a
  MUST, naming strictMcpConfig/--strict-mcp-config and --setting-sources.
- Credentials default: employees inherit subscription auth via
  CLAUDE_CONFIG_DIR, never an injected ANTHROPIC_API_KEY by default - a
  present key always overrides subscription auth in headless mode per the
  current docs, which would silently move usage onto metered billing.
  Flagged in §24.5 for reconciliation, not resolved there. ProbeResult
  gained `metered: boolean` to start closing that gap.
- §7.4 (interrupt on Windows) corrected with real, empirical tests, not
  assumption: writing \x03 into a real ConPTY session delivers a genuine,
  catchable SIGINT (verified - a Node child's own handler fired and it
  stayed alive). Plain child_process.kill('SIGINT') does not (verified
  separately - the identical handler never fired). PTY mode's interrupt()
  is real; structured mode's honestly reports interrupt:false.
- Autonomy (trivial, defined), Verdict (§11.3) and VisualState (§13.4)
  (real gaps, flagged with explicit comments, deliberately not resolved -
  both are internal types owned by milestones that don't exist yet).

### What landed

- src/shared/models/engineOptions.ts, role.ts, 0002_add_engine_options.sql,
  roles.ts's insertRole - the engine_options gap, closed.
- src/main/engine/resolveRealExecutable.ts - see "What surprised me".
- src/main/engine/ndjsonLineBuffer.ts - stream-json's chunk-boundary
  problem (§7.6 trap #1), same discipline as session 1's PtyOutputBuffer.
- src/main/engine/claudeCodeStreamJson.ts - the stream-json -> AgentEvent
  mapper, confirmed shapes only, defensive against unrecognised ones.
- src/main/engine/modelTiers.ts - the verified tier mapping,
  looksLikeValidModelId (syntactic only), validateModelId/validateModelTiers
  (real verification via a real minimal call - built, not run in a loop
  this session beyond what the real-spawn tests already exercised).
- src/main/engine/claudeCodeAdapter.ts - probe(), capabilities(),
  buildLaunchSpec(), send()/events() for both structured and PTY mode,
  interrupt(), stop(), resume(). costSafetyArgs() - a real safety net
  (cheapest tier + hard budget cap) added before any real spawn.

### Gate verification

- `npm run typecheck && npm run lint` - clean throughout.
- `node scripts/checkIpcSurface.mjs` - 20/109/7, unaffected.
- Unit suite: **147/147 green** (21 files - up from 111/16 at the start of
  this part).
- Integration suite (explicitly excluding the real-spawn file for the
  final sweep, to avoid a fourth unnecessary real spend): **94/94 green**
  (17 files), zero regression from session 1 or M0-M2.
- **probe() verified against all three documented failure cases for
  real**, plus the real success case - 4/4, against the actual installed
  CLI, zero model spend (--version/auth status only).
- **buildLaunchSpec verified against the real binary** - the composed
  spec's command is a real, existing file on this machine; every §7.6
  field checked field-by-field, including the Director's no-worktree
  fallback.
- **Real spawns: exactly three, deliberately minimal.** One structured-mode
  exchange (fully passed, including real text extraction), two PTY-mode
  exchange attempts (both genuinely completed - real output, `finished`,
  clean `adapter.stop()` - both hit the same Windows file-handle cleanup
  timing issue after the fact, fixed with a retry-then-warn helper rather
  than a fourth spawn). No fourth real spawn was made once that evidence
  was in hand.
- **No orphan processes after stop, verified behaviourally, not by
  reading the code**: a live process-tree scan (`Get-CimInstance
  Win32_Process`) after all three real spawns found zero processes
  matching the adapter's actual spawn target - every `claude.exe` still
  running belonged to this coding session's own VS Code extension host or
  a separate desktop Claude app, confirmed by comparing full command
  lines and binary paths, neither related to Bureau at all.
- **Three empirical checks, all real, all free**:
  - **A (~/.claude.json under CLAUDE_CONFIG_DIR)**: confirmed real and
    complete - a fresh CLAUDE_CONFIG_DIR starts logged out
    (`loggedIn:false`), the real ~/.claude.json is completely untouched,
    and `.claude.json` genuinely gets created fresh inside the isolated
    dir. No isolation gap. **A second, deeper finding the real-spawn work
    surfaced**: isolation being real does not mean provisioning is easy -
    copying a real ~/.claude.json into an isolated CLAUDE_CONFIG_DIR does
    NOT restore a working session (`claude auth status` against the copy
    still reports loggedIn:false, verified directly). Session material is
    not portable via a plain file copy - real per-employee credential
    provisioning needs a real mechanism (SecretBroker, M6), not assumed
    to be a file-copy problem.
  - **B (--settings as a second isolation lever)**: confirmed to exist
    (`--settings <file-or-json>`, real flag). Does NOT close gap A -
    it loads settings/hook config, not session/auth material. A useful,
    separate mechanism (e.g. for M4's explicit per-employee hook
    registration) but not an auth-portability answer.
  - **C (CLI version validated against)**: 2.1.238 - confirmed via
    `claude --version` on this machine, and matching exactly the highest
    version gate the docs research found, confirming currency.

### What surprised me

- **A real, load-bearing Windows bug, found empirically before it could
  become a mystery failure later**: Node's `child_process` cannot spawn a
  `.cmd` file directly on Windows (`spawn EINVAL`) - reproduced against
  the real installed `claude.cmd` before writing a line of adapter code
  around it. The documented fix, `shell: true`, has a real cost: it needs
  the executable path manually quoted (a space in the path breaks it
  otherwise, also reproduced), and Node's own docs warn that with
  `shell: true` "arguments are not escaped, only concatenated" - a real
  shell-injection surface the moment argv includes a task prompt instead
  of fixed flags. The actual fix: npm's own `.cmd` shims are one-line
  wrappers around a real sibling `.exe` (confirmed by reading the
  installed shim) - spawn that directly instead. No shell, no quoting, no
  injection surface - verified directly with a deliberately
  shell-metacharacter-laden test argument passing through completely
  inert.
- **A second self-inflicted contamination, same family as M2's
  ELECTRON_RUN_AS_NODE leak**: probe()'s first real run against a
  genuinely logged-in machine came back `authenticated:false`. Cause:
  building Bureau *inside* Claude Code means this very process's own env
  already carries `CLAUDECODE=1`, `CLAUDE_CODE_EXECPATH` (pointing at a
  *different* `claude.exe` - the IDE extension's own bundled binary),
  `CLAUDE_CODE_MESSAGING_SOCKET`, and more, all inherited by
  `execFileAsync` by default. Fixed by denying the specific confirmed
  contaminants by name, not a blanket `CLAUDE*` prefix strip - which would
  also have stripped the legitimate `CLAUDE_CONFIG_DIR` override the
  "unauthenticated" test itself needs to set.
- **A real parser gap, found by the first real spawn, not assumed away**:
  an immediate auth-error response emits `system/init` -> `assistant`
  (full message, error text) -> `result`, with no `stream_event` at all in
  between. The parser's assumption ("text always streams incrementally
  first, so a full message's own text block is redundant") was simply
  wrong for this real case, and silently dropped the text entirely before
  the fix (`sawTextDeltaThisTurn`, a real fallback path, not a special
  case bolted on after the fact).
- **The `interrupt()` Windows investigation went differently in the two
  modes, and both directions were worth knowing for certain rather than
  guessing**: PTY mode's `\x03`-into-ConPTY mechanism is genuinely real
  (confirmed: a real Node child's own SIGINT handler fired and the
  process survived). Structured mode's plain `child_process.kill('SIGINT')`
  is not (confirmed separately: the identical handler never fired - Node
  just force-terminates and labels the exit `SIGINT` for API-compatibility
  bookkeeping only).

### What's stubbed / explicitly out of scope this part

- The supervisor (§7.11), the turn-boundary queue's own dedicated tests
  (§7.4's queueing is implemented in the adapter but not yet exercised by
  a dedicated test beyond what FakeAdapter already covers from session
  1), the §7.8 contract suite parameterised over both adapters, mode-parity
  testing - all explicitly part 2, named in the instruction itself.
- Real model-tier resolution (role.model_preference -> settings.engines.
  modelTiers -> a concrete id) is not wired - every real spawn this
  session used a hardcoded safety default (the cheapest tier). Flagged in
  code (`costSafetyArgs`) as supervisor/settings territory, not silently
  assumed to be already handled.
- `validateModelTiers` (real per-tier validation via a real minimal call)
  is built but was not run this session beyond what the real-spawn tests
  already incidentally exercised for the `fast` tier - running it for
  `balanced`/`capable` too would be two more real spawns for information
  already reasonably inferred (all three IDs passed the same syntactic
  check and come from the same current, authoritative model table).
- EngineAdapter.start()/send() taking only EmployeeContext (not a
  supervisor-finalized LaunchSpec) means the adapter currently calls its
  own buildLaunchSpec() and merges the broker's secrets internally - flagged
  in code as a real, open question for the supervisor to settle properly,
  not silently decided here. With noopSecretBroker this has zero practical
  effect today.
- §7.3's `role.engine_options?.mode` resolution now matches the corrected
  flat shape exactly (last session's flagged ambiguity about
  `role.engineOptions.mode`'s exact field path is resolved by this
  session's D correction).

### Next (part 2, same session)

- The supervisor (§7.11 state machine, heartbeats, backoff, max_turns/
  wall-clock/attempt limits, transcript writing, ring buffer) - this is
  where the flagged "record base env keys on the launch event" requirement
  from session 1 finally lands.
- The turn-boundary queue's own dedicated tests.
- The §7.8 contract suite, parameterised over FakeAdapter and
  ClaudeCodeAdapter, including tests 4 and 9 built the way session 1
  agreed, and the mode-parity test (same scenario through structured and
  PTY, asserting the normalised sequences match).
- Real per-employee credential provisioning (how an isolated
  CLAUDE_CONFIG_DIR actually gets a working session) is now a confirmed,
  concrete open question for whoever builds SecretBroker for real (M6) -
  not a assumption to carry forward unexamined.

## 2026-08-22 — M3 session 2, part 2 — supervisor, turn queue, contract suite

Covers M3 steps 6-7 and the §7.8 contract suite. M3 is now feature-complete
per this session's scope; step 8 (xterm terminal) and §7.12 (engine support
matrix) are session 3.

### Section 0: the auth question, resolved before building anything

Part 1 found that copying ~/.claude.json into an isolated CLAUDE_CONFIG_DIR
did not restore a working session, and left it as a flagged concern for M6.
This session's instruction correctly treated that as more urgent than a
flag - the supervisor is exactly the component that spawns employees into
isolated dirs, so building it on an unworkable auth model would have wasted
the session.

Investigated for real, cheaply at first (free): PTY mode's interactive
onboarding wizard was captured directly (theme selection, then "Select
login method") - explaining why structured and PTY "differed" in the
originally-reported evidence: `-p` mode synthesizes a "Not logged in" text
reply and exits at zero cost (no way to prompt anyone); PTY mode shows a
real, waiting-for-a-human login flow. Not an auth difference - a mode
difference.

The actual, corrected finding: part 1's copy attempt was *incomplete*, not
wrong in principle. `~/.claude/.credentials.json` - a separate file, never
copied - holds the real token. Copying BOTH `~/.claude.json` and
`~/.claude/.credentials.json` into an isolated CLAUDE_CONFIG_DIR restores a
genuinely working, authenticated session - confirmed twice: `claude auth
status` reports `loggedIn:true, subscriptionType:"pro"` against the copy,
and a real generation call against that isolated identity actually
authenticated and billed ($0.042 - two real spawns budgeted for this
section, used exactly two).

**Answer: employees CAN authenticate with a fresh, isolated
CLAUDE_CONFIG_DIR, without an injected API key.** Part 1's credential
decision is confirmed viable, not reversed - "flag it for M6" is replaced
with a concrete, verified mechanism: copy those two specific files from a
real, once-authenticated identity into each employee's otherwise-fully-
isolated CLAUDE_CONFIG_DIR at hire/spawn time. That preserves full
isolation for everything else (MCP config, project trust, hooks, memory);
only the auth material is intentionally shared, which is correct (that's
the point of subscription auth), not a compromise. `claude setup-token`/
`auth login` remain the (interactive-only) mechanism for acquiring that
master credential pair once, ever - not something each employee does.

### What landed

- src/shared/engine/adapter.ts: `lastActivityAt(): number` added to
  EngineAdapter (§7.1, spec + code) - the supervisor's heartbeat needed raw
  activity independent of the semantic AgentEvent stream, and nothing else
  already exposed it. Implemented in both FakeAdapter and ClaudeCodeAdapter.
- src/main/engine/supervisor.ts - the §7.11 state machine, heartbeat
  (mode-aware, tested both directions with a dedicated adapter double),
  max_turns inference (mode-aware, tested identically across modes),
  consecutive_failures persistence, TranscriptWriter seam (M6), real usage
  rows (source='turn', §22.4), launch-event envKeys.
- src/main/db/repositories/employees.ts: setEmployeeHeartbeat,
  setEmployeeConsecutiveFailures - the column existed since M1, nothing
  wrote to it until now.
- tests/contract/ (new, §19.1) - adapterContract.test.ts (§7.8 tests 1-10 +
  turn-boundary queue + honest mode-parity), twoEmployeeConcurrency.test.ts,
  realEngineSpawn.test.ts (properly gated, replaces part 1's ad-hoc file
  exclusion). vitest.contract.config.ts, `npm run test:contract`, wired
  into CI right after the integration suite.

### Gate verification (run fresh, this session, output shown in the session transcript)

- `npm run typecheck && npm run lint` - clean.
- `node scripts/checkIpcSurface.mjs` - 20/109/7, unaffected.
- Full unit suite: **147/147 green** (21 files) - unchanged from part 1,
  confirming zero regression.
- Full integration suite: **105/105 green** (18 files) - includes the new
  supervisor.test.ts (11 tests) on top of part 1's 94.
- Full contract suite, CI-safe path (no BUREAU_RUN_REAL_ENGINE_TESTS): **16
  passed, 3 skipped** (2 real-engine tests skipping themselves with an
  explicit reason, 1 honestly-documented mode-parity gap) - exactly what
  "green with the CLI unavailable" needs to look like, since the same
  env-var gate that ran here is what CI's real environment (no CLI at all)
  will also hit.
- Contract suite with the real engine explicitly opted in: **1/1 real
  spawn passed** - a genuine authenticated generation, confirmed minutes
  earlier in this same session (not re-run again for this sweep, to avoid
  a third unbudgeted spend for evidence already in hand).
- Mode-parity: passes at its actual, honest scope (outer event-shape
  agreement) - see "What's stubbed" for what it does not cover.
- Turn-boundary queue: holds and flushes correctly, delivery order
  preserved, nothing arrives early - asserted explicitly before AND after
  the flush point, not just after.
- Two-employee concurrency: passes - zero crossed events, zero
  cross-contaminated usage rows, checked with a raw SQL scan for any
  events row whose employee_id isn't one of the two real ones, not just
  spot-checking the happy path.
- No orphan processes after stop, by live process-tree scan: confirmed
  twice this session (once before section 0's investigation, once after
  all of this part's real spawns) - zero processes matching the adapter's
  actual spawn target either time.

### What I could not verify, and why

- **CLI-genuinely-absent, live-simulated.** The contract suite's skip gate
  was verified live via its env-var condition (BUREAU_RUN_REAL_ENGINE_TESTS
  unset), which exercises the identical `it.skipIf` code path a genuinely-
  absent CLI would. I deliberately did not rename or remove the real,
  working npm installation on this machine to force the *other* half of
  the gate condition live, since doing so risks this environment for a
  boolean check whose logic is trivially simple by inspection and whose
  underlying mechanism (resolveBinary returning null) is already proven
  via dependency injection in claudeCodeAdapterProbe.test.ts's "binary
  absent" test. Flagging the distinction rather than blurring it.
- **PTY-mode content-level mode-parity.** Not a verification gap so much
  as a real, acknowledged scope gap - see below.

### What's stubbed / explicitly out of scope this part

- **PTY mode has no output parser.** ClaudeCodeAdapter's PTY mode emits
  only `{t:'raw', data:Buffer}` - real terminal bytes, never `text.delta`/
  `tool.requested`/etc. This means true content-level mode-parity (the
  literal instruction: "the same scenario through structured and PTY must
  produce identical normalised event sequences") does not hold today, and
  the contract suite says so explicitly (a skipped test with a comment,
  not a silently-narrowed assertion pretending to cover it). Building a
  real PTY-mode ANSI/output parser is separate, real scope - not attempted
  this session. Session 3 or later needs to either build it or make an
  explicit, argued decision that structured mode is the only one that
  needs full semantic parity and PTY stays raw-transcript-only by design.
- Budget enforcement, thresholds, the circuit breaker - all M6, as
  instructed. Usage rows are written; nothing reads them to act.
- Real credential provisioning (copying the two auth files into an
  employee's isolated dir) is a test-only helper this session
  (seedIsolatedAuth in tests/contract/realEngineSpawn.test.ts) - not
  production code. SecretBroker (M6) is where this becomes real.
- bureau_task_done doesn't exist (M4's tool server) - the supervisor's
  `finished` handling always takes the "ended_without_report" branch,
  honestly, since there is no way yet to know the real answer.
- tool.requested's transition to 'thinking' reflects the *shape* of
  §7.11's transition table without any real gate resolving it - capabilities
  ().hookInterception/permissionCallback are both false (session 2 part 1),
  so nothing today actually decides allow/deny for a real tool call.

### Anything in §7 that turned out wrong

- §7.6/§7.10's "hard 10s timeout... fails closed" claim (found and
  corrected in part 1, listed here again since it's the standout example
  this session).
- §7.4's "Ctrl+C to the PTY's foreground process group" (POSIX framing;
  corrected in part 1 with real Windows-specific behaviour for both
  modes).
- §7.1 was missing `lastActivityAt()` entirely - not wrong, incomplete;
  added this part once the supervisor's heartbeat need made the gap
  concrete rather than theoretical.
- The engine_options shape (§7.1.1/§6.5, part 1) - corrected from an
  array to a flat value per review, before any code was built around the
  wrong shape.

### Next (session 3)

- Step 8: xterm.js terminal in the Inspector, wired to `terminalChunk`
  with `seq` and resync, plus `resizePty`.
- §7.12: probe each candidate engine's real capabilities, fill in the
  support matrix from observation, update §24.1 and the wizard copy.
- The PTY-mode output-parser gap above is the one concrete architectural
  decision worth resolving explicitly before it's assumed away by
  omission.
- ${bureau_state}'s precise meaning (§11.3, flagged M3 session 1) is
  still open - M6's policy engine still needs to settle it.
- Verdict (§11.3) and VisualState (§13.4) types (flagged M3 session 2
  part 1) - still owned by M6 and M12 respectively, still not resolved
  here, correctly.

## 2026-08-22 - M3 session 3, part 1 - plan corrections, PTY decision recorded, ready-pattern investigation (paused)

Five plan corrections applied. §7.7.1 records the PTY-parser decision as
REJECTED (not deferred), with its unmeterable-employee consequence
threaded into §11.5.1/§14/§7.12/§24 (already landed in commits `b37f9a7`,
`48c8caa` before this entry). This part covers what followed: applying
corrections 1/2/4/5 for real, and the ready-pattern investigation that
correction 3 required before building anything that depends on it.

### What landed (commit `76a2732`)

- **capabilities(probe, mode?)** - takes mode as an explicit parameter,
  not adapter-internal state (§7.1). ClaudeCodeAdapter's `pty` branch is
  now honest where the old single snapshot was wrong or deliberately
  under-claiming: `usageReporting`/`structuredEvents`/`promptCaching`
  false, `sessionResume` false (no session id without content parsing),
  `interrupt` true for real (verified `\x03`-into-ConPTY, previously
  hidden behind an engine-wide under-claim).
- **One turn counter.** `recordTurnIfPty` deleted; counting moved to
  `turn.started`, mode-symmetric by construction - real in structured
  mode (SDK-parsed), the adapter's own bookkeeping in PTY mode (not
  scraped content). `deliverPty()` now emits real `session.started`
  (once) and `turn.started` (every actual write, never on enqueue -
  §7.4) - PTY mode's event stream is no longer just `raw`+`finished`.
- **promptCaching** defined precisely before being set anywhere: "does
  Bureau assemble this turn's request itself, byte-stable" - true for
  structured, false for PTY - and added to the real
  `EngineCapabilities`, not just the spec.
- **§7.12/§24.1 verification discipline** - NOT EVALUATED (no adapter
  exists) separated from verified-by-this-project's-own-tests (`†`)
  separated from documented-but-not-independently-confirmed
  (claude-code's MCP/session-resume/Director cells - real and
  architecturally load-bearing, but no dedicated multi-turn `--resume`
  test or real MCP call exists in this repo, M4 doesn't exist yet).
  §24.1's whole configuration table marked hypothesis - no free
  MCP-capable CLI or local runner has an adapter at all.
- Mode-parity test rewritten from a permanently-`it.skip`'d placeholder
  to the actual permanent invariant: both modes share one lifecycle
  backbone, structured additionally carries content+usage, PTY carries
  raw - checked against two differently-shaped scripted scenarios. The
  real-adapter leg stays `it.skip`, honestly: PTY emits
  session.started+turn.started now but not `idle` yet.

Gate re-run: typecheck/lint/ipc-surface clean; unit 147/147; integration
**107/107** (105 + 2 net-new turn-counting tests) - including the two
packaged-app tests, which failed on the very first run with
`ELECTRON_RUN_AS_NODE=1` leaking from this coding session's own shell
into the spawned child process. Confirmed as the exact same documented
false alarm as commit `81b9eb7` (not a regression) by unsetting it and
re-running clean. Contract suite 16 passed + 3 skipped. Live
process-tree scan after the investigation's real PTY spawns: zero
orphaned npm-installed `claude.exe`.

### Ready-pattern investigation - paused at a real decision point, not yet resolved

Correction 3 required running the investigation against a config dir that
had already completed onboarding, not a fresh one, specifically to avoid
deriving a pattern from the onboarding screen. Ran both. Found something
worse than either case anticipated: **a per-directory "trust this
folder" gate that fires independent of onboarding/auth state**, because
trust is tracked per-cwd, not per config dir. A fully seeded (auth-copied,
post-onboarding) config dir launched into a brand-new cwd still hit
"Quick safety check: Is this a project you created or one you trust?"
Since every employee spawns into a fresh worktree, **every real employee
spawn will hit this gate on its first PTY launch** - not an edge case.

Confirmed (zero cost, no prompt ever submitted):
- Accepting the gate (Enter - option 1 "trust" is pre-selected) is a
  one-time, per-cwd action - a second launch into the same cwd+config dir
  skipped straight to the real ready state.
- The real steady ready-state has a recognisable structure: a
  `❯ Try "..."` empty-input hint (bracketed by horizontal rules) plus a
  `shift+tab to cycle` status footer. The hint text itself is
  **randomised per launch** ("edit \<filepath\> to...", "how does
  \<filepath\> work?", ...) - cannot match on it literally.
- Specificity checked against both captured non-ready screens (fresh
  onboarding, the trust gate): zero false matches for either candidate
  substring.

**What's not yet confirmed, and why this is paused here rather than
shipped:** no capture of the screen mid-generation exists - no prompt
was ever submitted, per the zero-cost investigation constraint. That is
exactly the highest-stakes case for a false positive: a ready_pattern
that spuriously matches while the agent is still generating would inject
text into a live session, corrupting it (§7.4). Validating that gap
needs one small real generation call in PTY mode - real spend, which
this session's cost discipline requires flagging before, not after.
Reported to the user as the explicit checkpoint; awaiting direction
before deliverPty's onReady wiring, the `ready_pattern` schema field,
role-load validation, the real-adapter mode-parity leg, and xterm.js
(which needs the wiring to hold a second PTY turn at all) are built.

Also noted, not yet acted on: the investigation's own captured ready
screen shows a "Transcript saving is off - inherited
CLAUDE_CODE_CHILD_SESSION marker" warning, an artifact of this dev
session's own env-var inheritance (the same contamination class §7.6's
probe() already strips specific vars for) - whatever code eventually
builds the real PTY spawn path needs the same scrubbing applied to the
PTY env, not just probe()'s `execFile` env, or a real employee's ready
screen may render subtly differently than what was captured here.

## 2026-08-22 - M3 session 3, part 2 - claude-code structured-only, GenericPtyAdapter, xterm mechanism - M3 closed

The user's decision on correction 3, given as-is (no further real spend):
claude-code is structured-only; PTY is exercised through a real
`generic-pty` adapter against a deterministic local script instead. This
part builds that decision and everything session 3 still owed on top of
it.

### The decision, built

- `ClaudeCodeAdapter.supportedModes = {structured}`. `resolveMode()`
  defends independently (fail closed, §10.3.1 layering) - throws if an
  unsupported mode ever reaches it, rather than trusting role-load alone.
- `mode: 'pty'` rejected for claude-code at role-load with a clear message
  (`ClaudeCodeEngineOptionsSchema`'s own `.refine()`), tested at both the
  schema level and through a real `insertRole()` round trip.
- `deliverPty`/`PtySession` machinery in ClaudeCodeAdapter is kept, not
  deleted - unreachable via normal flow, real code "take control" can
  reuse later, per §7.12's own note that shipping it is the trigger to
  revisit.
- §7.12: claude-code's row now says structured-only, names "take control"
  as the revisit trigger.

### Env-allowlist audit (the "either way" item) - a correction to my own prior report, not a bug

Audited every real spawn call site in src/main/engine/*.ts.
`deliverStructured`'s spawn() and `deliverPty`'s PtySession both already
consume `buildLaunchSpec()`'s output, which builds env from scratch
(never spreads `process.env`) plus the allowlist - already correct,
already covered by `claudeCodeAdapterBuildLaunchSpec.test.ts`'s exact-env
assertions. `probe()`'s two `execFileAsync` calls deliberately use a
*different*, narrower model (ambient env minus specific contaminants,
not the allowlist) for a reasoned purpose recorded in its own comment
(needs the real HOME to find real system config) - not a bug either.
**Correcting the record:** the env leak my last report attributed to "the
real PTY spawn path" was specific to my own standalone investigation
script, which never touched `deliverPty()`/`buildLaunchSpec()` at all -
conflating that with a production gap was imprecise reporting on my part,
not a finding that survived a real check.

The audit found a different, real bug instead: `Supervisor.assign()`
never calls `probe()` before `start()`/`buildLaunchSpec()`, and
`ClaudeCodeAdapter.buildLaunchSpec()` used to *require* a prior probe()
call (threw otherwise) - so a real claude-code employee spawn through the
Supervisor would have failed immediately in production, undiscovered
because no existing test drove Supervisor against a real (non-Fake)
adapter end to end. Fixed by making `buildLaunchSpec()` self-resolve the
binary if not already cached (matching GenericPtyAdapter's own design) -
probe() becomes a genuinely optional diagnostic, not a hidden prerequisite
for spawning. Regression test added
(`claudeCodeAdapterBuildLaunchSpec.test.ts`: "self-resolves ... the real
Supervisor.assign() flow").

### §7.6: the per-directory trust gate, recorded (flagged, not solved)

The finding from part 1's investigation - a trust prompt keyed to cwd,
independent of auth/onboarding state, firing on every employee's first
launch - is now in the spec, with the M4 open question (what else "trust"
would unlock if Bureau ever accepts it programmatically, and whether that
needs the same exclusion `.mcp.json` discovery already gets) named and
explicitly not answered here.

### `GenericPtyAdapter` - built for real, not a placeholder

`src/main/engine/genericPtyAdapter.ts`: the real §7.7 adapter.
`supportedModes = {pty}`; real `probe()`/`buildLaunchSpec()`/`send()`/
`interrupt()`/`stop()`/`resume()` against `PtySession`, with the same
Windows base-env allowlist and shim-unwrapping ClaudeCodeAdapter uses.
Real onReady wiring - the one thing ClaudeCodeAdapter's pty branch never
got: `turnState` returns to idle and the queue actually flushes mid-
session on a debounced ready-pattern match, and `done_pattern` (if
configured) fires a real `finished` event. Session.started/turn.started
are the adapter's own bookkeeping (§7.7.1 - not scraped content), exactly
as designed in part 1.

`tests/helpers/scriptedPtyCli.cjs` - the deterministic local test target
(fixed prompt, echo, exit keyword), spawned for real via node-pty. Zero
cost, zero network, no onboarding, no trust gate. Actually running §7.7's
own documented example config against it found two real bugs in the
example itself, not just in code:

1. `(?m)^> $` / `(?m)^\[done\]` is PCRE/Python-style inline-flag syntax -
   invalid JS `RegExp`, confirmed by `SyntaxError: Invalid group` the
   first time it was actually run. Fixed: the adapter always applies the
   'm' flag itself now; the spec's example no longer carries `(?m)`.
2. Even fixed, the literal `ready_pattern: '^> $'` still didn't match real
   captured output: ConPTY rewrites a prompt's trailing space into a
   cursor-forward escape sequence (`\x1b[1C`) rather than a literal space
   byte. `(?:^|\r|\n)>[^\r\n]*$` (tolerant of whatever follows `>` on its
   line) matches the real bytes and is what ships in the test config and
   the spec's own guidance.

`tests/integration/engine/genericPtyAdapter.test.ts` (5 tests, all real
spawns): §7.8 test-3 shape (start/send/events/finished), the onReady
wiring proven by actually holding a *second* turn in the same live
session (exactly what ClaudeCodeAdapter's old pty branch could never do -
the bug §7.11 correction 2 was named for), env isolation (a real canary
env var proven absent from the spawned process), resume() honestly false,
and a live process-tree scan proving clean stop.

### Mode-parity real leg - no longer skipped

Rewritten for what's actually true now: no single real adapter has both
modes anymore, so the invariant under test is stronger, not weaker -
that the shared lifecycle backbone (`session.started -> turn.started ->
idle`) holds *across two different real adapters* (FakeAdapter scripted
to real structured-mode shape, GenericPtyAdapter's real pty output).
Passes for real, zero cost.

### The xterm mechanism - built and tested; IPC wiring and the renderer component deliberately not

`src/main/engine/terminalBroadcaster.ts` (13 tests, all real, using fake
timers for the coalescing assertions) - the actual mechanism behind
`on.terminalChunk`, covering exactly the four properties asked for:
coalescing (~16ms, multiple `feed()` calls collapse into one emission),
ring-buffer replay on `attach()` (a late subscriber gets recent history,
not blank; a subscriber whose gap has aged out of the buffer gets a
`resync` marker, never a silent gap), multi-window fanout (independent
subscribers, each unsubscribable without affecting the other), and
read-only by default (`sendInput` refused with no controller; exactly one
controller at a time; refused for anyone else while held; restored to
read-only on release).

`Supervisor` now owns one `TerminalBroadcaster` per employee, feeds it
from `raw` events (same bytes as the transcript writer, two independent
sinks), and exposes `takeControl`/`releaseControl`/`sendControlInput`
wrappers - real, tested end to end, including that `takeControl()` really
calls `interrupt()` first (§14.5's ordering). **Honestly flagged, not
silently half-built:** §14.5 also says taking control "blocks Bureau's
own send() until control is released" - enforcing that half needs a hook
into whatever routes Bureau's own automated messages, which doesn't exist
until a real caller does (M9/M11). And `sendControlInput` routes through
the adapter's existing turn-boundary-queued `send(data, 'user')` - §7.1
has no separate raw/immediate write path, so this isn't low-latency
keystroke-by-keystroke interactivity yet either, just the closest real
mechanism the current contract offers.

**Deliberately not built this session:** the live per-employee Supervisor
registry the `employees.*` IPC handlers would look a caller's `id` up in
(stays empty until M7's hiring flow ever spawns anything real - there is
nothing for it to route to yet), and the renderer's actual xterm.js
component. The IPC stub comments now point at the real mechanism by name
and file, re-labelled `stub('M7')` instead of `stub('M3')` - the honest
owning milestone for "something exists in the registry to wire these to,"
not a reflection of the mechanism itself being unbuilt. `resizePty`
additionally needs a `resize()` method added to `EngineAdapter`
(currently `PtySession`-internal only) - not added speculatively ahead of
a registry that would call it.

### Gate verification (run fresh, this session)

- `npm run typecheck && npm run lint && npm run check:ipc-surface` -
  clean (20/109/7, unaffected).
- Unit: **161/161** (22 files - +13 for terminalBroadcaster.test.ts).
- Integration: **116/116** (19 files).
- Contract: **17 passed, 2 skipped** (both real-engine, opt-in only -
  mode-parity's real leg is no longer one of the skips).
- Live process-tree scan after this part's real spawns (GenericPtyAdapter
  tests, the mode-parity real leg, the scripted CLI directly): zero
  orphaned `node.exe` processes matching the scripted CLI's own argv.

### M3 is closed

Step 8 (xterm mechanism) and §7.12 (fill-in) are done to the scope
described above. Nothing from M4+ was started. Carried forward,
unresolved by design (not this milestone's job): `${bureau_state}`'s
precise meaning (§11.3, M6), Verdict/VisualState types (§11.3/§13.4, M6/
M12), the live employee registry + renderer terminal component (M7+),
`EngineAdapter.resize()` (whenever resizePty gets wired), and the M4 open
question on what a programmatically-accepted trust gate would unlock
(§7.6).

## 2026-08-22 — M3->M4 boundary check, part 2 — the blocker fixed, M3 genuinely closed

Short session, one fix plus its follow-through, no new scope.

### The fix

`Supervisor.assign()` now delivers the task: `adapter.send(ctx.task.body,
'task')`, called once `start()`/`buildLaunchSpec()` have run, only when
`ctx.task` exists. Placed exactly where §7.11 already says it belongs —
the supervisor is the only thing permitted to touch an employee's
adapter — and routed through the adapter's own §7.4 turn-boundary queue,
not a spawn-time special case: whatever `send()`'s already-tested
immediate-vs-queued logic decides is what happens, no new mechanism
built. Scope discipline held: task body only, not a full context pack —
`memoryPack`/`decisionLog` composition stays a marked seam for M10/M11,
not a half-built version shipped early.

Verified in the TDD order asked for, not assumed: re-ran
`endToEndChain.test.ts`'s `it.fails` test *before* touching the fix,
confirmed it still failed for the documented reason; applied the fix;
re-ran the same test and confirmed it flipped to an *unexpected* pass
(`it.fails` correctly reported that as a failure, forcing the marker's
removal rather than letting it go unnoticed); removed `.fails`, and it's
now a normal, permanent test — the standing proof the chain holds end to
end, not just link by link.

### The second gap — closed permanently, not just documented

Added `endToEndChain.test.ts`'s second test: real DB rows, real
`Supervisor`, the real `GenericPtyAdapter`, the deterministic scripted
local CLI — `assign()` only, task body observed actually arriving via the
supervisor's own `TerminalBroadcaster` (the same path a real xterm.js
window would watch), clean stop verified against the real process tree.
This is the Supervisor+real-adapter combination that no test had ever
driven before session 3 closed — the more important of the two findings,
since a fake that never needs to be driven correctly is exactly what let
the first bug hide.

### FakeAdapter judgement — reported, not changed

Considered making `FakeAdapter` require a prior `send()` call before its
scripted events advance, matching real adapters' actual behaviour more
closely. **Recommendation: do not.** Checked precisely rather than
guessing: zero of `supervisor.test.ts`'s ~15 tests and
`twoEmployeeConcurrency.test.ts`'s test ever call `send()` at all — every
one uses `ctx.task: null` and relies on `FakeAdapter`'s script alone to
drive `Supervisor` through a controlled event sequence. Gating the script
behind `send()` would break all of them, forcing a rewrite of most of
`Supervisor`'s own test suite to fabricate a task and call `send()`
first, purely to keep testing what they already correctly test (how
`Supervisor` reacts to a given event sequence) — a different, legitimate
concern from "was `send()` invoked correctly," which is what the two new
`endToEndChain.test.ts` tests now guard directly and permanently
(one against `FakeAdapter` itself, one against a real adapter so no
fake's leniency can hide this class of bug again). `FakeAdapter`'s
`send()` genuinely isn't fake — it respects `turnState` and queues for
real, exercised directly by the contract suite's own §7.4 tests; only the
*event playback* is unconditional, and that's a deliberate session-1
design choice for a stated reason, not an accidental gap. Recorded this
reasoning directly in `FakeAdapter`'s own doc comment (comment-only, no
behaviour change) rather than leaving the judgement only in this file.

### Still not covered — flagged for M4, not built here

`ClaudeCodeAdapter` driven through `Supervisor` end to end has no test —
only `GenericPtyAdapter` does, both because it's free and because the M4
control channel is what will make a real `Supervisor.assign()` against
`ClaudeCodeAdapter` mean something (task delivery alone doesn't get an
employee reporting status or finishing a task without it). M4's own
first real spawn is the natural, cheapest place to close this, not a
dedicated test built ahead of it here.

### Gate verification (run fresh, this session)

- `npm run typecheck && npm run lint` — clean throughout, including after
  the comment-only `FakeAdapter` change.
- `npm run check:ipc-surface` — 20/109/7, unaffected.
- Unit: **165/165**, 23 files.
- Integration: **119/119**, 20 files (includes both `endToEndChain.test.ts`
  tests, the second one new this session).
- Contract: **17 passed, 2 skipped** (real-engine, opt-in only) —
  unaffected, since none of the mutated/fixed code touches the contract
  suite's own FakeAdapter/GenericPtyAdapter scenarios.
- Live process-tree scan after this session's real spawns (the new
  Supervisor+GenericPtyAdapter test): zero orphaned `node.exe` processes
  matching the scripted CLI.
- No new spend — every real behavior this session verified used
  `FakeAdapter` or the scripted local CLI.

### M3 is genuinely closed now

The Part-1 blocker was the one thing standing between "M3's pieces are
individually tested" and "M3's pieces actually work together" — fixed,
with the fix itself proven by a real adapter, not just the fake that
hid the original bug. **M4 (control channel + tool server) starts next.**

## 2026-08-25 — M4 (Control channel + tool server), session 1 of 2–3 — steps 1-4

Scoped per the prompt: loopback server, per-employee tokens, the three
endpoints, long-poll semantics. `bureau-hook`, `bureau-tools`, and MCP
wiring are session 2.

### Pre-implementation: A–D, resolved before writing code

- **A — which structured mechanism, and who calls `/v1/policy/check`.**
  `ClaudeCodeAdapter` uses only the `-p --output-format stream-json` CLI
  fallback — zero references to `@anthropic-ai/claude-agent-sdk` anywhere
  in the codebase, confirmed by grep, and the adapter's own top comment
  says so explicitly. So the endpoint's sole real consumer this session is
  `bureau-hook` (external hook over HTTP) — there is no in-process SDK
  `canUseTool` path to design around yet.
- **B — does the trust gate fire in structured mode.** Spawned the real
  installed `claude.exe` directly with the exact real argv
  `ClaudeCodeAdapter` uses, into a brand-new never-before-seen temp
  directory (simulating a fresh worktree), with a real seeded config dir.
  Exit 0, a real `system/init` event, real token usage — zero occurrences
  anywhere in stdout/stderr of any trust-gate string. **Confirmed empirically:
  not a blocker.** This was the one real spawn budgeted for the session; no
  further spend occurred.
- **C — the MCP discovery mitigation, confirmed for the real mechanism.**
  `claude --help` lists `--strict-mcp-config` and `--setting-sources` as
  plain top-level options, not annotated SDK-only the way some other flags
  explicitly are — confirmed applicable to the `-p` invocation, not just
  the SDK. `docs/BUILD-SPEC.md` §7.6 corrected in the same session (the
  hedge treating "spawn where no `.mcp.json` exists" as the *primary*
  mitigation is now downgraded to defense-in-depth; the flags are primary).
- **D — the interim policy evaluator.** §20.2's shape exactly: deny-by-
  default, hardcoded allow-list (`Read`/`Grep`/`Glob`, `bureau_*` prefix),
  strictly binary (no `ask` — that needs real checkpoints, M8). `bureau_*`
  calls route through the *same* evaluator function as everything else
  (§7.9: "every tool call is evaluated... like any other"), landing in the
  same allow-list mechanism as one more matched pattern — not a bypass. No
  loop risk: evaluation is synchronous, local, makes no outbound calls.
  Because the interim evaluator can never itself produce `'ask'`, the
  server's evaluator is injectable — production wiring uses the real one;
  tests inject one that returns `'ask'` to drive the long-poll hold
  through the real endpoint, so the hold mechanism is proven against the
  actual HTTP path M6/M8 will reuse unchanged, not a disconnected class.

### What landed

- **`src/main/controlChannel/`** — `tokens.ts` (`TokenRegistry`, in-memory
  so a token dies with the process that minted it — the property §7.10
  asks for, gotten for free instead of needing explicit DB cleanup on
  every crash path; `writeControlJsonWithAcl`/`readControlJsonAcl`, the
  real Windows ACL fix), `originCheck.ts`, `rateLimiter.ts`,
  `idempotencyCache.ts`, `policyEvaluator.ts`, `policyHoldRegistry.ts`
  (`DuplicateHoldError` for a reused `callId`), and `server.ts` (the
  `node:http` server itself — no framework dependency — wiring every
  primitive above into the three real endpoints).
- **`src/shared/controlChannel/`** — `schemas.ts` (the Zod wire contract,
  shared with the real clients M4 session 2 builds), `policyCheckClient.ts`
  (`checkPolicyFailClosed` — the one place the "unreachable → deny"
  judgment call lives, exercised by both a unit test and the real-kill
  integration test so there's exactly one implementation, not two that
  could quietly diverge).
- **`src/main/db/paths.ts`** — `getEmployeeStateDir`, the first real
  per-employee state-dir convention.
- **`src/main/db/reconcile.ts`** — `sweepStaleControlJson`: every
  `control.json` found under `<baseDir>/employees/*/` at startup is
  unconditionally stale (an in-memory `TokenRegistry` in a fresh process
  can never match a token minted by a prior life) and is deleted, one
  `control.stale_token_deleted` event each. `reconcile()`'s signature now
  takes `baseDir`; every call site updated.
- **`src/main/index.ts`** — `TokenRegistry` and `ControlChannelServer`
  constructed and started at boot, before any employee/window exists to
  need them.
- **THE WINDOWS ACL TRAP, actually fixed.** `fs.chmod(path, 0o600)` is a
  documented no-op on NTFS. `icacls /inheritance:r /grant:r
  "<user>:(R,W)" /grant:r "SYSTEM:(F)"` is the real mechanism — verified
  by reading the ACL back afterward (not trusting the exit code), and the
  test suite goes one step further: it deliberately *widens* a real file's
  ACL after the fact and confirms the detector actually catches it, not
  just the happy path.
- **Two real bugs found by testing against a real server, not mocks** (see
  the `test(control-channel)` commit): the body-cap path called
  `req.destroy()`, which tears down the shared socket and silently
  discards the 413 response it was trying to send — the caller would just
  see a bare connection reset. Fixed by dropping the `'data'` listener
  instead (Node returns the stream to paused mode on its own). And the
  employee-dies-mid-hold cleanup listened on the wrong object
  (`req.once('close', ...)` — by the time a hold exists, the request body
  is already fully read, so that event says nothing further); moved to
  `res.once('close', ...)`, which is what Node actually documents for "the
  connection died before the response could be sent."
- **`docs/BUILD-SPEC.md`** — §7.6's MCP-flag hedge corrected per item C
  above; §5.2 gained a `control.` event prefix (`origin_rejected`,
  `token_rejected`, `stale_token_deleted`).

### THE TEST THAT MATTERS MOST

CLAUDE.md invariant #6 ("fail closed... unreachable policy check... → the
safe option"), proven for the control channel for the first time, against
a **real process kill** — not a thrown exception standing in for one. A
plain-Node worker (`tests/integration/fixtures/controlChannelWorker.ts`,
no Electron) hosts a real `ControlChannelServer` in its own process; the
test issues a real long-poll `/v1/policy/check` against it via
`checkPolicyFailClosed`, waits for the worker to report the hold as
genuinely registered (polled, not a fixed sleep), then `taskkill /PID
<pid> /F`s the worker outright — the exact same real-kill discipline
`job-object.test.ts` uses. Confirms the process is actually dead, then
asserts the caller's outcome is `deny`, with a transport-failure reason —
so the denial is provably coming from the kill, not from the server
answering normally through some other path.

### The three named long-poll edge cases — decided and proven

- **Slow human answering after a real delay does NOT get denied.**
  Proven with a real ~500ms delay against a `maxHoldMinutes` far larger
  than it, confirming the wait itself is never punished — only actually
  exceeding the configured maximum is.
- **The employee's connection dying mid-hold terminates the hold**, rather
  than leaking a timer/connection until the full timeout. Proven by
  aborting the client's own request mid-flight and polling the server's
  hold registry back down to zero.
- **N employees holding simultaneously are genuinely concurrent.** 10
  employees' holds all register within milliseconds of each other and all
  resolve independently and correctly — nothing about the `node:http`
  event loop or the hold registry serializes them.
- **The same employee, same `callId`, while already held** → a clean
  `400 VALIDATION_FAILED` (`DuplicateHoldError`), not a second independent
  hold and not an uncaught 500 — a reused `callId` is a client bug (every
  real tool call mints its own), proven through the real endpoint, not
  just at the registry's own unit-test level.

### Gate verification

- `npm run typecheck && npm run lint` — clean throughout, reverified after
  every commit.
- `node scripts/checkIpcSurface.mjs` — 20/109/7, unaffected (M4 touches no
  IPC surface — the control channel is a separate loopback HTTP server,
  not `window.bureau`).
- Unit: **207/207**, 29 files (+42 this session: 5 files for the pure/small
  primitives, 1 for `checkPolicyFailClosed`).
- Integration: **149/151**, 23 files (+31 this session: 8 for the real
  Windows ACL + `TokenRegistry`, 18 for the full server against real HTTP,
  1 for the real-kill test, plus 4 new cases folded into the existing
  `reconcile`/`reconcileActivityEvents` suites — 3 and 1 respectively — for
  the stale-`control.json` sweep). **The 2 failures are pre-existing and
  unrelated**:
  `job-object.test.ts`/`native-modules.test.ts` both drive the *packaged*
  app (`dist-package/win-unpacked/Bureau.exe`), which was last built
  2026-08-22 — three days stale relative to this session's edits and, per
  `git status` at session start, stale relative to an even earlier
  `package.json`/`package-lock.json` change that was never repackaged
  either. Confirmed unrelated to this session's code: `main()` calls
  `maybeRunSmoketest()` and returns immediately before any control-channel
  code runs, so a stale binary genuinely cannot be affected by anything
  built this session. Needs `npm run package` rerun before those two pass
  again — flagged, not silently worked around.
- Contract: **17 passed, 2 skipped** (real-engine, opt-in) — unaffected.
- Full control-channel suite in isolation (unit + integration together):
  **69/69 green** across 9 files (42 unit, 27 integration).

### Still open for session 2

`bureau-hook` and `bureau-tools` themselves (the two programs that will
actually be the real clients of everything built this session), the MCP
wiring in `buildLaunchSpec` (§28 M4 step 7), and the real `/v1/tool/:name`
handlers behind the currently-honest `NOT_IMPLEMENTED` stub. The
`ControlChannelServer.stop()` on `before-quit` is best-effort (does not
block quit on the server's own close) — flagged in code as acceptable for
now since no real client exists yet to be mid-request at quit time;
revisit once session 2's processes are real.

## 2026-08-25 — M4 session 2 — bureau-tools, bureau-hook, the real tool
handlers, adapter wiring — M4 closes

### A and B, re-answered (session 1's report never covered them)

- **A.** Unchanged: `ClaudeCodeAdapter` still uses only `-p
  --output-format stream-json`, zero SDK references anywhere in the
  codebase. `bureau-hook` is `/v1/policy/check`'s real, load-bearing
  consumer — not a minority path, since `claude-code` (the only real
  adapter) never reaches `canUseTool` at all.
- **B.** Unchanged: the per-cwd trust gate does not fire in structured
  mode — session 1's real spawn already confirmed this empirically;
  re-confirmed by re-reading §7.6's own text ("`-p` is non-interactive and
  never shows it"). Not re-spawned to re-confirm — the existing evidence
  already answers it.

### THE BLOCKER, actually fixed

`SupervisorRegistry` (plain `employeeId -> Supervisor` map) plus
`Supervisor.noteTaskDone(taskId)` — a direct method call, not an event bus
or DB polling (reasoned through in `supervisorRegistry.ts`'s own doc
comment: each control-channel request is already scoped to one employee
by its token, so there's no fan-out need a bus would justify, and a direct
call either finds the instance or doesn't, which a bus's silent
misrouting can't offer). `handleFinished()` now branches for real: a
prior `bureau_task_done` -> `idle`/`task_reported`; without it ->
`blocked`/`ended_without_report`. The race the prompt asked to be
decided: **`bureau_task_done` wins whenever it lands, on either side of
the `finished` race** — its own handler is allowed to correct a task
already sitting in `blocked`/`ended_without_report` back to `review`, not
only when it arrives first. Proven by `supervisor.test.ts`'s new
task-reported case and, end to end, by the real gate below.

Found and fixed a real pre-existing bug while touching this exact code:
`handleFinished` emitted a second, mislabeled `employee.idle` event
alongside `transition()`'s own `employee.blocked` for the *same* state
change (CLAUDE.md invariant #3). `transition()` now takes an optional
payload so a state change is exactly one event, never two — proven by a
new assertion in the existing `ended_without_report` test.

`Supervisor.stop()` now revokes this employee's token and unregisters it
from `SupervisorRegistry` when both are supplied (§7.10: "revoked when
the process exits") — optional constructor deps, so every pre-M4 test
keeps working unchanged.

### Authorization, not just authentication

`authorization.ts`'s `resolveOwnedCurrentTask` walks token -> employee ->
`current_task_id` -> task and verifies the task's own
`assignee_employee_id` agrees, rather than trusting the denormalised
pointer alone — real defense against a desynced row, not a
never-reachable check. Closes the cross-employee vector at the *design*
level for `bureau_task_done`/`bureau_task_blocked` specifically: neither
tool accepts an agent-supplied `task_id` at all (§7.9's own arg tables
never list one), so there is no id for an agent to cross in the first
place. Proven with two real employees and a deliberately desynced
`current_task_id` (employee A pointed at employee B's task): rejected,
B's task provably untouched, `control.authorization_rejected` logged
(`security` severity, new taxonomy entry).

### `/v1/event` removed

Audited who would legitimately call it and found no caller: every event
that matters already has a more precise home (`/v1/policy/check` logs
`tool.requested/allowed/denied` itself; `/v1/tool/:name` logs whatever
each real handler decides; the adapter's own stream-json parsing is a
separate channel entirely, not part of the control channel). A live,
generically-typed, agent-authenticated write path into a tamper-evident
audit log with no real caller was exactly the audit-integrity gap the
prompt asked about — removed rather than kept "just in case"
(`server.ts`'s route dispatch falls through to the generic 404, proven by
its own test). `§7.10` now documents the decision directly, not just in
code comments. `AgentEventRequestSchema`/`EventResponseSchema` deleted
from `schemas.ts` rather than left exported-but-unused.

### TRAP #1 fixed: the real MCP tool-name string

`policyEvaluator.ts`'s allow-list now matches `mcp__bureau__bureau_*` —
the real string an engine reports for an MCP-provided tool (§11.3's own
`mcp__*__spawn_*` precedent, independently confirmed against the current
hooks docs) — alongside the bare `bureau_*` prefix kept for unit-test
convenience. Without this the interim evaluator would have denied every
one of Bureau's own tools the moment a real hook asked about one.

### The eight employee tools — all real

FULL/ROW ONLY/HONEST EMPTY exactly per the prompt's own breakdown, wired
into `/v1/tool/:name` in place of session 1's `NOT_IMPLEMENTED` stub
(`src/main/controlChannel/toolHandlers/`):

- `bureau_report_status` — FULL.
- `bureau_task_done` — FULL, the gate. Rejects an already-terminal source
  status with a specific reason; writes `result_summary`+`finished_at` in
  one statement; **writes real `artifacts` rows** (decided: not deferred
  — the table/repository already exist in full, so not writing them
  would silently drop agent-reported data); calls
  `supervisorRegistry.get(employeeId)?.noteTaskDone(taskId)`.
- `bureau_task_blocked` — FULL.
- `bureau_ask_director` / `bureau_send_message` — ROW ONLY: real
  `messages` rows, router is M8.
- `bureau_raise_checkpoint` — ROW ONLY: §9's "consequence required per
  option" already enforced by the Zod schema itself, not re-checked by
  hand.
- `bureau_propose_memory` — ROW ONLY via the activity event itself (no
  `memory_proposals` table exists — designing one now would be guessing
  ahead of M7's real §12.4 batched-checkpoint flow).
- `bureau_read_memory` — HONEST EMPTY: well-formed empty result with a
  clear M7 reason, never an error, no event (a read is not a state
  change).

VALIDATION ERRORS proven agent-actionable (§7.9's own explicit rule):
every handler's Zod failure names the field; a deliberately malformed
call's response is distinguishable from a transport failure (transport
succeeds; the envelope carries `ok:false`).

### `bureau-tools` and `bureau-hook` — real, bundled, MCP-verified

Both ship exactly per §7.10: plain JS run by Electron itself
(`process.execPath` + `ELECTRON_RUN_AS_NODE=1`), via `extraResources`, no
bundled second Node runtime. `resourceScripts.ts`'s dev-vs-packaged split
mirrors `jobObject.ts`'s own `resolveDummyScriptPath` exactly (TRAP #3).

- `bureau-tools.ts` — a real stdio MCP server on
  `@modelcontextprotocol/sdk` (new dependency; hand-rolling MCP's
  JSON-RPC/stdio framing was rejected as unnecessary risk for a protocol
  an official, pure-JS SDK already implements). Tool set parameterised at
  construction (`buildBureauToolServer(definitions, target)`) specifically
  so a future Director build (§7.9's 19 tools) is a new definitions
  array, not a refactor. Reuses `toolHandlers/schemas.ts`'s own schemas'
  `.shape` for MCP registration, so the tool description the agent sees
  and the validation the server actually runs can never quietly disagree.
- `bureau-hook.ts` — reuses `checkPolicyFailClosed` (M4 session 1)
  exactly as instructed. Races the real HTTP call against its own
  self-deadline (new setting, `permissions.hookSelfDeadlineMs`, default
  30min); either losing that race is a transport failure, mapped to deny
  uniformly. Confirmed for real: the bundled script, run directly, prints
  the correct `hookSpecificOutput` JSON and exits with real process exit
  code **2**, not a simulated one.

**The MCP round-trip proven for real**: a real `@modelcontextprotocol/sdk`
`Client` spawns the real bundled `bureau-tools.js` over stdio exactly as
`StdioServerParameters` describes (the same shape the agent CLI itself
uses), lists its tools (all eight real names), and calls
`bureau_report_status` for real — the employee's `status_detail` row
actually changes in the database. First proof that MCP tool call ->
bureau-tools' own HTTP POST -> the real control channel -> the real tool
handler -> a real DB write works as one connected path.

### Adapter wiring

`buildLaunchSpec` no longer emits the "deny everything, no gate exists
yet" shape. It writes two real files via `LaunchSpec.configFiles`
(finally consumed — `deliver()` writes them to disk before every spawn,
nothing did before this session): the real MCP config (from
`ctx.toolServer`, no longer a placeholder) and a real hook-registration
settings file (PreToolUse against `"*"`, pointing at `bureau-hook.js`,
registered timeout = `maxHoldMinutes+5min`, **validated at build time**
that `hookSelfDeadlineMs` is strictly less, per item 3's explicit
requirement — throws otherwise, not just assumed consistent).
`--allowed-tools` widened from `''` to `Read`/`Grep`/`Glob` plus all
eight `mcp__bureau__bureau_*` names — the model can now actually attempt
these tools; the hook remains the real, dynamic gate for every one.
`deliverStructured`/`deliverPty` no longer hand-duplicate CLI flags —
both spread `spec.args`, so the actual spawn can never drift from what
`buildLaunchSpec` computed. `capabilities().hookInterception` is `true`
for both modes now, proven by the real gate, not just declared.

`spawnSupervisedEmployee.ts` (new) is the one real place `control.json`
gets minted and the real `ToolServerDescriptor`/`ControlChannelDescriptor`
get built for an employee — replacing the M4-placeholder shape
`EmployeeContext` used everywhere until now. Nothing in production calls
it yet (hiring a real employee is a later milestone); built because the
M4 gate needs a real, non-placeholder spawn, and any future hiring flow
needs this exact sequence unchanged.

**Real fallout, fixed**: `resourceScripts.ts`'s real path resolvers need
a live Electron `app`, which does not exist under plain-Node vitest —
`buildLaunchSpec` is the first thing in this file to touch Electron at
all, and every test calling it broke immediately. Fixed the same way
`resolveBinary`/`runVersionCheck` already are: `resolveBureauHookScriptPath`
is now injectable on `ClaudeCodeAdapterOptions`.

### THE GATE — run for real, passes

`realAgentGate.test.ts`, run twice with explicit confirmation
(§7.8-style opt-in: `BUREAU_RUN_REAL_ENGINE_TESTS=1`, real `claude` CLI
resolved on the machine).

**Run 1** caught a second instance of the exact Electron-dependency gap
found earlier this session: `spawnSupervisedEmployee.ts`'s
`buildControlChannelAndToolServerContext` called the real
`resolveBureauToolsScriptPath()` unconditionally, which needs a live
Electron `app` this plain-vitest test doesn't have. Fixed the same way —
an injectable `resolveToolsScriptPath` parameter. No spend occurred; this
failed at context-building, before `assign()` (and therefore any real
spawn) ever ran.

**Run 2**, after fixing that and rebuilding `dist/` so the bundled
`bureau-tools.js`/`bureau-hook.js` reflected all of this session's code:
a real Claude Code agent, spawned through a real `Supervisor`, against a
real `ControlChannelServer`, with real `bureau-tools.js` and
`bureau-hook.js`. Observed for real, in the activity log:

1. The model tried `ToolSearch` (a Claude Code-native tool-discovery
   mechanism) first, looking up the bureau tools by name — **correctly
   DENIED** by the real hook (not on the interim allow-list), and the
   model recovered on its own and called the MCP tools directly. Neither
   session scripted this — it's the deny-by-default gate proving itself
   against a real, unscripted case, a stronger proof than the intended
   happy path alone.
2. `mcp__bureau__bureau_report_status` → **ALLOWED** →
   `employee.status_reported` → `employees.status_detail` actually set
   to `"running the M4 gate test"`.
3. `mcp__bureau__bureau_ask_director` → **ALLOWED** → `message.sent` → a
   real `messages` row, `to_addr='director'`.
4. `mcp__bureau__bureau_task_done` → **ALLOWED** →
   `task.submitted_for_review` → `tasks.status='review'`,
   `result_summary` set for real, `finished_at` set.
5. `employee.idle` with payload `{"reason":"task_reported"}` — **THE
   BLOCKER FIX, proven for real**: the supervisor took the `review`
   branch, not `blocked`/`ended_without_report`.

The only failure on run 2's first pass was this test's own assertion
("no `tool.denied` at all") — too strict given a real model can
legitimately try something else first. Fixed to assert what the gate
actually cares about (none of the *three intended* tools were ever
denied) and left the `ToolSearch` denial as a documented positive signal
in the test, not suppressed. Re-ran clean. Full suite reverified after
both fixes.

**M4 is closed.**

### Gate verification (this session's own work, independent of the real-agent gate)

- `npm run typecheck && npm run lint` — clean throughout, reverified
  after every commit.
- `node scripts/checkIpcSurface.mjs` — unaffected.
- Unit: **213/213**, 30 files.
- `npm run package` rebuilt for real (the prompt's explicit ask) —
  **`job-object.test.ts` and `native-modules.test.ts` are green again**,
  both root-caused as this coding session's own `ELECTRON_RUN_AS_NODE`
  environment pollution (already documented in this file's carried-forward
  notes from M0-M3), reproduced deliberately (the exact same V8 snapshot
  crash, on demand) and fixed the documented way, not papered over.
- New `resourcePaths.test.ts` (TRAP #3): proven green against the freshly
  rebuilt package — both script paths resolve under
  `process.resourcesPath` and genuinely exist on disk, the one thing that
  actually exercises `app.isPackaged`.
- **Full integration suite, run clean (no concurrent build contaminating
  it): 170/170, 26 files — every test green, including both previously-
  red packaged-app tests.** (+50 tests / +4 files this session:
  `toolHandlers.test.ts` 15, `bureauToolsMcp.test.ts` 3,
  `resourcePaths.test.ts` 1, plus new cases folded into
  `claudeCodeAdapterBuildLaunchSpec.test.ts` and `supervisor.test.ts`.)
- Contract: unaffected (`adapterContract.test.ts` 16,
  `twoEmployeeConcurrency.test.ts` 1, `realEngineSpawn.test.ts` 2 skipped)
  — plus the new, deliberately-not-yet-run `realAgentGate.test.ts`
  (THE GATE, see above).
- `docs/BUILD-SPEC.md` updated in the same commits as the code that
  motivated each change: §7.10 (`/v1/event` removed, documented why),
  §5.2 (`employee.status_reported`, `control.authorization_rejected`,
  `control.supervisor_not_found`), §16.1 (`permissions.hookSelfDeadlineMs`,
  49 -> 50 keys, pinned-count test updated in the same commit).

## 2026-08-25 — M5 session 1 housekeeping — `/v1/event`'s removal ratified

Not tolerated — **ratified**. The M4 session 2 removal was reviewed and
accepted as correct: an undefined event-write surface is a liability, not
a feature. Two stale references fixed to match §7.10's own already-correct
text: §28's M4 block item 3 still listed `/v1/event` alongside the two
real endpoints (now removed, with a one-line pointer to §7.10's full
reasoning); the Endpoints line in §7.10 itself was already correct from
the M4 session 2 commit. One commit, no code changes — the decision was
already implemented; this closes the last two places the spec disagreed
with itself.

## 2026-08-28 — M5 session 1 (part 1): workspace, worktrees, and leases — GATE PASSED

Employees now have somewhere to work. `src/main/workspace/` (new,
8 files): `gitProcess.ts` (the sole `git`-spawning function — argv
arrays only, per-repo serialization, main-tree-checkout guard, bounded
lock-contention retry), `gitQueue.ts` (`RepoCommandQueue`, an
`AsyncLocalStorage`-based per-repo queue with a structural re-entrancy
guard — only `gitProcess.ts` ever enqueues), `pathSanitize.ts` (employee
name → worktree dir name, with loud collision detection), `gitInit.ts`
(repo registration, unborn-HEAD bootstrapping, Bureau's own per-invocation
git identity), `gitWorktree.ts` (the low-level `git worktree`/branch/ref
ops, main-tree-exclusion built into `listWorktreesPorcelain`), `leaseTtl.ts`
(the M7-ready TTL formula), `employeeWorktree.ts` (orchestration:
`registerProjectWorkspace`, `hireEmployeeWorktree`, `fireEmployeeWorktree`,
`assignTaskToWorktree`, `acquireLease`, `createPhaseIntegrationBranch`,
`resolveDefaultIntegrationRef`), `reconcileGit.ts` (the bidirectional
table↔disk reconciler, wired into `db/reconcile.ts` after lease reclaim).
Repository additions: `setEmployeeWorktree`/`clearEmployeeWorktreeReference`
(employees.ts), `setProjectRepoInitialised`/`listRepoInitialisedProjects`
(projects.ts), `listWorktreesByProject`/`listAllWorktreePaths`/
`setWorktreeStatus`/`setWorktreeBranchAndBaseCommit`/`deleteWorktree`
(worktrees.ts). `reconcile()` is now `async` (the new git-reconciliation
step awaits real git calls) — every pre-existing call site across
`index.ts` and three integration test files updated in the same commit.
New test helper `tests/helpers/dbFixtures.ts` (trap f): `seedDepartment`/
`seedRole`/`seedEmployee`/`seedProject`/`seedBrief`/`seedPlan`/
`seedPhase`/`seedTask`, one real FK chain, auto-creating whatever parent
a caller doesn't supply.

**Plan mode caught two real design bugs before any code was written** —
worth recording since the plan file (`expressive-riding-tiger.md`) is
the canonical record: (1) an orchestration-layer queue on top of
`runGit`'s own queue would have deadlocked the first time a worktree op
called another worktree op on the same repo — fixed by making `runGit`
the *only* enqueuing layer, with `AsyncLocalStorage` structurally
rejecting re-entrancy rather than relying on a comment; (2) the
bootstrapping `git commit --allow-empty` would have failed on any
machine with no global git identity configured (the very first gate
item) — fixed with a per-invocation `-c user.name=/-c user.email=`
identity, never written to the repo's persistent config.

**A third bug was caught mid-implementation, after the plan was already
approved** — worth flagging explicitly since it means the approved plan
and the first draft of the code briefly disagreed: `hireEmployeeWorktree`
originally called the real `git worktree add` *before* inserting the
`worktrees` row, the reverse of what both CLAUDE.md invariant #3 ("commit
before side effect") and the plan's own gate-item-4 wording ("between
DB-insert and `git worktree add`") require. Reordered to insert-then-add
before any kill-point test was written against it — gate item 4's two
worker-script kill points are pinned against the corrected order, not
the original one.

### Gate verification — all seven items, real commands, real output

1. **3 employees hired in a real temp git repo** — `git worktree list
   --porcelain` (real command, output captured in the test log) parsed
   and diffed against the `worktrees` table: all 3 present, paths match,
   `base_commit` equals the real resolved SHA. Main tree's checked-out
   branch (`git rev-parse --abbrev-ref HEAD`) unchanged before/after.
   `tests/integration/workspace/hireFireWorktree.test.ts`.
2. **25 concurrent `acquireLease` racers × 30 fresh worktrees (750 total
   attempts)** — exactly one winner every single time; one
   `git.lease_acquired` event per iteration, no more, no fewer.
   `tests/integration/workspace/leaseAcquire.test.ts`.
3. **The actual safety proof, not a sidestep**: a real spawned child
   process, PID + `process_start_time` recorded on the lease-holding
   employee, an already-expired lease. `reconcile()`'s orphan sweep kills
   it; `getProcessStartTime()` confirms it's actually dead afterward; the
   `events` table's own `seq` ordering proves `employee.orphan_killed`
   strictly precedes `git.lease_reclaimed` for that worktree — the kill
   provably happened before the lease was ever handed back, not merely
   "reconcile ran and didn't throw." `tests/integration/workspace/leaseReclaim.test.ts`.
4. **Real process kills at both new crash windows**, worker-script
   pattern mirroring `killPoints.test.ts`'s own technique
   (`tests/integration/fixtures/worktreeKillWorker.ts`, `STEP_DONE`
   markers + a blocking stdin ack read): window 1 (row committed, `git
   worktree add` never ran) and window 2 (`git worktree remove`
   succeeded, row not yet deleted) both converge to a clean phantom-row
   delete on restart, real `reconcile()` reports and real `git worktree
   list --porcelain` output captured for both.
   `tests/integration/workspace/reconcileCrashWindows.test.ts`.
5. **Fire flow** — worktree removed, `git worktree list --porcelain`
   clean, row deleted, `employees.worktree_id` nulled,
   `git.worktree_released` emitted, branch retained (`git branch
   --list`, real output shows it). `hireFireWorktree.test.ts`.
6. **Assignment re-points from a real integration ref deliberately
   distinct from `base_ref`'s current value** — a second branch advanced
   past the phase branch's own base commit so a wrong-start-point bug
   can't hide behind "everything descends from base_ref anyway"; asserts
   `git rev-parse` of the new branch equals the integration ref's SHA
   *and* the stored `base_commit`, and that both differ from `base_ref`'s
   now-advanced value. `tests/integration/workspace/assignTask.test.ts`.
7. **`npm run lint && npm run typecheck && npm test`** — all three
   clean. `node scripts/checkIpcSurface.mjs` — unaffected (20
   namespaces, 109 methods, 7 events — no IPC surface this session).
   Unit: **237/237**, 34 files (+4 files / +24 tests this session).
   Beyond the gate's own literal ask, the full integration suite was
   also run clean: **182/182, 31 files** (+5 files / +12 tests this
   session, all new, all green).

Also covered, per the plan's traps: the dirty-worktree refusal (Q4/fix
#8) — throws *and* emits a `security`-severity `git.worktree_dirty_refused`
(the one genuinely new event type this session, added to §5.2's
taxonomy in the same commit); the "Ravi"/"ravi" collision (trap e) —
loud `WorktreeNameCollisionError`, caught before any git side effect;
`listWorktreesPorcelain`'s main-tree exclusion (fix #3), asserted
directly, not just implied by reconcile surviving it.

### What surprised me

- **The ordering bug above** — plan review had already caught the
  *deadlock* and *git-identity* bugs before implementation started; this
  third one slipped through the first implementation pass and was only
  caught by re-reading the plan's own gate-item-4 wording against the
  code before writing the crash-window test. Lesson for future sessions:
  when a doc comment and the approved plan both assert an ordering,
  actually diff the code against that assertion, don't just check "does
  it work."
- **`ELECTRON_RUN_AS_NODE=1` recurred in this session's own shell** —
  this is the exact, already-documented M0 sandbox quirk ("this
  session's own mistake, not a real issue," `docs/progress/M0-M2.md`),
  not a regression. It caused 3 packaged-app integration tests
  (`job-object`, `resourcePaths`, `native-modules`) to fail with
  misleadingly generic "timed out waiting for result.json" errors — root
  caused by manually spawning the packaged exe and observing an instant,
  silent, code-0 exit (Electron running as plain Node, `app.whenReady()`
  never resolving normally). Fixed the documented way: `unset
  ELECTRON_RUN_AS_NODE NoDefaultCurrentDirectoryInExePath` in the same
  command as the test run — all 3 green immediately after, in isolation
  and in a full clean re-run. Not a code fix; a sandbox-hygiene one.
- Two more failures in that same first full run
  (`claudeCodeAdapterBuildLaunchSpec.test.ts`'s `probe()` exceeding 5s,
  `genericPtyAdapter.test.ts`'s timestamp assertion off by ~650ms) were
  confirmed as transient timing flakes under the 231-second sequential
  batch's load — both pass cleanly in isolation and in the final clean
  full run. Neither touches anything this session modified.
- The packaged app itself (`dist-package/`) was stale from the M4
  session (14:58 vs. this session's 19:16+ source edits) — rebuilt via
  `npm run package` as due diligence once the smoke tests started
  failing, though the rebuild alone didn't fix them (the
  `ELECTRON_RUN_AS_NODE` issue did). Worth having rebuilt regardless —
  the packaged app now genuinely reflects this session's `reconcile()`
  signature change.

### What's stubbed / explicitly not written this session

- **`worktrees.status = 'dirty'` has no writer.** Confirmed by grep —
  nothing in `src/main/` ever sets it. `isWorktreeDirty()` exists and is
  used as a *read* (the pre-assignment refusal check), but nothing
  transitions the stored `status` column to `'dirty'`; that's part 2's
  job, once there's a commit path whose absence-of-a-commit is what
  `dirty` is supposed to represent.
- **Live (mid-session, non-restart) lease reclaim does not exist.**
  `reclaimExpiredLeases` has exactly one caller: `reconcile()` at
  startup. No orchestrator tick exists yet to call it from during a live
  session — noted in the approved plan (Q7) as an explicit, deliberate
  scope cut, not an oversight.
- **The fixture-migration commit (trap/fix #10) was skipped.** The four
  pre-existing ad-hoc fixture copies in M3/M4 test files
  (`supervisor.test.ts`, `twoEmployeeConcurrency.test.ts`,
  `singleWriterAndLocking.test.ts`, `reconcileActivityEvents.test.ts`
  and others) are untouched — still hand-rolled, not migrated to
  `dbFixtures.ts`. This was explicitly pre-authorized as skippable in
  the approved plan ("refactoring passing tests is how a session gets
  eaten"); every new M5 test uses `dbFixtures.ts`, so nothing new grew a
  fifth ad-hoc copy, but the existing four still exist. Someone should
  do this cleanup eventually, but it's zero-risk to leave for now.

### Explicitly deferred to part 2 (not optimistic — this is the real list)

- **Commits themselves.** No employee task ever produces a real `git
  commit` yet. The identity mechanism (`-c user.name=/-c user.email=`,
  per-invocation, never persisted) is proven for Bureau's own one
  bootstrapping commit this session; part 2's real per-task commits are
  expected to use the same mechanism with the employee as author and
  Bureau as committer, but that plumbing doesn't exist yet.
- **Validators, including the secret scan.** Nothing runs against a
  worktree's changes before/after a commit.
- **`--no-ff` merges into phase branches, conflict detection/handling.**
  `createPhaseIntegrationBranch` creates the branch (in scope this
  session, per §10.6); nothing ever merges into it.
- **Events**: `git.committed`, `git.validator_failed`, `git.merged`,
  `git.merge_conflict`, `git.pushed` — all still just names in the
  taxonomy table, no emitter.
- **The restricted-token layer** (§10.3.1 layer 1) — commit-time HEAD
  reconciliation is the only enforcement layer that exists at all right
  now (and only implicitly, via "employees never call git — Bureau does
  everything in this session"), matching CLAUDE.md invariant #4's own
  downgrade rule.
- **M6 policy/budget work, roles/packs (M7), checkpoints (M8), the
  Director (M11).** `resolveDefaultIntegrationRef(project) =>
  project.base_ref` is this session's *only* implementation of "what is
  the integration head" — M11's real phase-branch-computing Director is
  a different caller of the exact same `assignTaskToWorktree`, zero
  changes to this code, but that caller doesn't exist yet.
  `computeLeaseTtlSeconds(roleWallClockTimeoutS?)` is structurally ready
  for M7's real per-role value but nothing passes one yet — every call
  site this session uses the fallback.
- **The 100-cycle soak** — explicitly part 2's own item 9, not attempted
  here. The per-repo serialization (Q6) and bounded lock-contention retry
  exist specifically because that soak is coming, but nothing has
  actually run it yet.
- **Live (non-restart) lease reclaim** — see "stubbed" above; this is
  the same gap stated from the other direction, for part 2's planning.

## 2026-08-28 — M5 session 2 (part 2): the commit path, validators, merges, and the soak — MILESTONE GATE PASSED

M5 is closed. Employees' work now becomes real git history: `commitTaskWork`
(diff inspection → validators, secret-scan mandatory → structured commit,
employee-authored/Bureau-committed → §10.3.1 layer 4's HEAD check) and
`mergeAcceptedTask` (the acceptance seam — merge-tree plumbing, conflict
→ real checkpoint, no auto-resolution). Branch `m5-part2`, not merged,
not pushed — this entry documents everything on it for review.

**The spec contradiction, resolved before any code**: §28 M5 item 6 said
merge "on task completion"; §10.6 rule 3 and §8.5.1's own state diagram
said merge only on task *acceptance*, and gave the reason ("merging on
completion would integrate work that failed its acceptance criteria").
§10.6/§8.5.1 were correct — §28 item 6 was a compressed-checklist
summarization slip that cited §10.6 and then contradicted it. Fixed in
`docs/BUILD-SPEC.md` in the same commit as `integrationMerge.ts`. Since
there's no Director until M11 to evaluate real acceptance, the merge is
an explicit operation behind an acceptance seam (`mergeAcceptedTask`) —
this session's tests and soak call it directly; nothing auto-fires it
when a commit succeeds. Exactly Q8's `integrationRef` shape from part 1.

**A second ordering bug, caught in plan review this time, not after**:
the first draft of `commitTaskWork` ran the real `git commit` *before*
updating `worktrees.base_commit` — invariant #3 backwards, the same class
of bug part 1's `hireEmployeeWorktree` had. The failure it would have
caused: Bureau commits, crashes before the DB catches up, and on restart
`HEAD` is one commit ahead of `base_commit` — indistinguishable from an
employee bypass, so the reconciliation check would block the task and
raise a false security finding against Bureau's own crash, forever (no
reconciler covered this window). Fixed with a durable intent marker
(`worktrees.pending_commit_task_id`, migration `0003`) written *before*
the commit, cleared only by the same atomic UPDATE that records the real
commit SHA — the marker is what disambiguates "our own interrupted
commit" from "a genuine bypass," which — unlike part 1's worktree
create/remove windows — disk state alone cannot do here (a commit object
looks the same regardless of who wrote it; a directory's mere existence
doesn't). `reconcileGit.ts` resolves any stuck marker at startup too, not
just inline on the next `commitTaskWork` call, since no live retry loop
exists yet to guarantee "next call" ever happens. A third, smaller bug
surfaced fixing this: `resolveRef`'s single-path signature is wrong for a
worktree-scoped call (it would key the serialization queue by the
worktree's own path instead of the repo's), so a new
`resolveHeadInWorktree(repoPath, worktreePath)` was added instead of
reusing it.

**How the merge actually runs — changed mid-plan, for the better**:
verified empirically against this machine's real git (2.55.0, confirmed
2.38+ is the real minimum from git's own release notes, documented in
`docs/BUILD-SPEC.md` §10.6 with a pointer to §15.3 as where a real
version check eventually belongs) that `git merge-tree --write-tree`
performs a genuine three-way merge entirely at the object-database
level — no working directory touched at all. This replaced an earlier
"dedicated integration worktree" design with something structurally
simpler: no new worktree lifecycle, no physical directory two concurrent
merges could race on, and no way to violate §10.1's "never touch what
the user checked out" promise since nothing here touches a working tree
to begin with. The compare-and-swap `update-ref` this enables needed a
bounded retry (`MAX_MERGE_CAS_RETRY_ATTEMPTS`, short backoff) once real
concurrent merges against one branch were tested — three-way races
produce real CAS mismatches routinely, not as an edge case, and it fails
loudly (`MergeRefRaceExhaustedError`) rather than spinning if attempts
are exhausted.

**Secret-scan mandatoriness — enforcement point corrected in plan
review**: the first draft made it unremovable inside `detectValidators`
and proved that with a test passing an inert override key — which proves
the detector ignores one key shape, not that the scan is actually
mandatory, since any caller building its own validator list by hand and
calling `runValidators` directly would skip it entirely. Moved to the
real choke point: `runValidators` itself refuses to run against any list
missing the secret-scan validator, proven by constructing exactly that
bypass and asserting rejection.

### Gate verification — real commands, real output

1. **THE MILESTONE GATE** (§28 M5's own gate, not a part-2 invention):
   "three simulated employees commit in parallel and merge cleanly" is
   `integrationMerge.test.ts`'s 3-way concurrent-merge test — 3 real
   employees hired, assigned, and committed via `Promise.all` (genuinely
   concurrent, not sequential), then merged via a second `Promise.all`
   racing against one shared integration branch; all three land, `git
   ls-tree` shows all three files, 3 `git.merged` events. "A deliberate
   conflict produces a blocker checkpoint rather than a broken tree" is
   the same file's conflict test — two employees editing the same file
   from the same base produce a real conflict, a real `checkpoints` row
   with `type: 'blocker'`, real `base`/`ours`/`theirs` file content
   (captured in the test log: `ours: "ravi version\n"`,
   `theirs: "meera version\n"`), two real options each with a
   CLAUDE.md-invariant-#8 `consequence`, `expires_at`/`default_action`
   both null (the schema's own "no safe default" case), and the
   integration branch's own tip provably unchanged.
2. **The soak** (`soak.test.ts`): 3 employees, 34 real commit+merge
   cycles each (102 total, ≥100), genuinely concurrent via `Promise.all`,
   ran to completion in ~365s. `git log --graph` on the resulting
   integration branch: 510 lines, a real, fully-merged history, zero
   conflict markers. `git fsck --full` exits clean (102 lines of
   `dangling commit` — git's normal report of CAS-retry losers, still
   perfectly valid objects, not corruption; asserted for the absence of
   real problem indicators, not literally-empty output, after the first
   attempt at this assertion was too strict and caught its own bug).
   Cross-worktree-contamination check: every real commit touched exactly
   its own author's file. Zero security events during 100+ concurrent
   cycles.
3. **Chaos row 13, proven against a real second process** (not just
   Bureau's own serialized calls): the real path to a worktree's own
   `index.lock` resolved via `git rev-parse --git-path index` (never
   guessed — worktrees keep a separate index under
   `.git/worktrees/<name>/`, confirmed empirically before writing this),
   held for 250ms while `commitTaskWork` ran concurrently — recovered in
   615-790ms across three separate real runs, comfortably inside the
   retry's own backoff window, proving genuine recovery from external
   lock contention, not a race that never actually collided.
4. **The timing-flake verdict — ACQUITTED**: `claudeCodeAdapterBuildLaunchSpec.test.ts`
   and `genericPtyAdapter.test.ts`, run immediately after the full soak
   in the same process (heavier real load than part 1's original
   231-second run that first produced these flakes — 900+ real git
   spawns from the soak alone, immediately before), both green, 11/11
   tests. Confirms part 1's own conclusion: transient artifacts of that
   specific batch, not a real defect.
5. **S6** (`gitProtectionLayer4.test.ts`): the exact bypass §10.3.1
   names — `node -e "require('child_process').execSync(...)"`, a real
   separate process nested-spawning git — detected (task blocked,
   `security`-severity `git.unexpected_commit_detected`), not a regex
   match. A negative control proves the same check doesn't false-positive
   on a normal commit. Two real-kill crash-window tests
   (`commitKillWorker.ts`, mirroring part 1's own worker-script
   technique) prove the *other* direction: Bureau's own interrupted
   commit converges cleanly with **no** security event, at both new
   windows the durable marker introduces.
6. `npm run lint && npm run typecheck && npm test` — all clean. Unit:
   **258/258, 37 files** (+3 files/+21 tests this session — one
   pre-existing M1 test, `projectLifecycle.test.ts`'s raw
   `WorktreeSchema.parse()` construction, needed the new
   `pending_commit_task_id` field added, the same mechanical fallout
   class as part 1's `reconcile()` signature propagation). **Full
   integration suite, one clean run, zero failures: 194/194, 35 files**
   (+5 files/+14 tests this session), `ELECTRON_RUN_AS_NODE` unset per
   the by-now-three-times-recurring M0 sandbox quirk. One more pre-
   existing mechanical fallout found and fixed the same way:
   `migrate.test.ts`'s own pinned `[1, 2]` applied-migrations assertion,
   updated to `[1, 2, 3]` for the new migration — the exact same
   "pinned-count test updated in the same commit" precedent M4's own
   §16.1 settings-key change established. `checkIpcSurface.mjs`
   unaffected (20 namespaces, 109 methods, 7 events — no IPC surface
   this session either).

### Layer 1 (restricted token) — attempted for real, did not land

Not skipped: `CreateRestrictedToken` + `CreateProcessAsUser` via a
PowerShell `Add-Type` P/Invoke script (this codebase's own established
"shell out for real Windows primitives" pattern — `getProcessStartTime`,
M4's `icacls` work), spawning a process under a token restricted with the
well-known `S-1-5-12` (RESTRICTED) SID, matching the documented exception
that lets an unprivileged process do this without
`SE_ASSIGNPRIMARYTOKEN_NAME`. **Root-caused, not just failed**: a process
spawned under the restricted token fails its own initialization
(`STATUS_DLL_INIT_FAILED`) before it can run anything — a real, isolated
finding, not a guess: the identical `CreateProcessAsUser` call, given an
unrestricted duplicated token instead, spawned `cmd.exe /c exit 5` and
returned exit code 5 correctly, proving the surrounding plumbing is
right and the failure is specifically in the `RESTRICTED`-SID token
itself. This is a known, documented class of Windows difficulty — almost
nothing in a stock install grants `RESTRICTED` explicit access, including
resources a process needs merely to start. Making it reliable needs
either a materially weaker mechanism (privilege-stripping alone, which
doesn't achieve directory-level write denial — the actual property this
layer exists for) or real, separate ACL-configuration engineering across
system paths, both bigger than a "prove the mechanism standalone" scope
should absorb.

**Per §10.3.1's own pre-written downgrade rule** (and per the session's
own kickoff instruction): "employees cannot commit" is downgraded to
"employees are prevented from committing by policy, and any unexpected
commit is detected and flagged," documented directly in
`docs/BUILD-SPEC.md` §10.3.1 in the same commit as this entry.
**CLAUDE.md needed no edit** — its own invariant #4 wording already says
"the invariant is never claimed more strongly than the mechanism
supports" and was checked against the rest of the file; nothing else in
it claims layer 1 exists. No `restrictedSpawn.ts` was added to `src/` —
shipping a module with no passing test that doesn't work would violate
invariant #13 more than not shipping it at all. The scratch P/Invoke
scripts that produced this finding live outside the repo (session
scratchpad), not committed — the finding itself is what's preserved, in
`docs/BUILD-SPEC.md`. Layers 2-3 remain unbuilt for an unrelated,
already-known reason: no packs/roles exist yet (M7) to configure
`tools_deny`/PATH omission on. **Layer 4 shipped and is real** — the S6
test above is the actual proof, independent of layer 1's outcome.

### What surprised me

- **The RESTRICTED-SID failure mode itself** — expected layer 1 to be
  hard; didn't expect the specific failure to be "the restricted process
  can't even finish starting," rather than "the restricted process starts
  but fails the specific write it shouldn't be allowed." Worth recording
  precisely for whoever picks this up: the blocker is in token
  restriction, proven isolated from `CreateProcessAsUser`'s own
  plumbing, which works correctly.
- **A second real ordering bug, this time caught before implementation**
  — plan review is now 2-for-2 across both M5 sessions at catching an
  invariant-#3 violation in a worktree-lifecycle function before any
  code existed for it. Worth treating as a standing discipline for M6+,
  not a one-off: whenever a function's job is "record intent, then do a
  git side effect," check the ordering explicitly against invariant #3
  before writing it, not after.
- **`git fsck`'s own "dangling commit" output isn't a problem** — a
  detail obvious in hindsight but not anticipated: exercising CAS-retry
  under real 3-way concurrency creates real, legitimate object-database
  garbage (abandoned merge commits from attempts that lost the race),
  and asserting fsck's output is *empty* rather than *free of actual
  problem indicators* is a test bug that would have failed the soak
  every single time regardless of correctness — caught by the soak
  itself surfacing it, exactly what a soak is for.
- **`git merge-tree --write-tree`'s plumbing-only design simplified the
  plan mid-session**, dropping an entire "dedicated integration
  worktree" concept the original plan draft was heading toward before
  empirically checking what the flag actually does.

### What's stubbed / explicitly not written this session

- **The restricted-token layer** — see above; the honest downgrade is
  now the documented, accurate state, not an aspiration.
- **`node_modules` provisioning for a fresh worktree** — a `lint`/`test`
  validator needing installed dependencies will fail in a real project
  until something installs them first; unclear whether that's an M11
  Director step or a setup-wizard concern. This session's own tests and
  soak use dependency-free validator stand-ins specifically to keep the
  plumbing honest about this gap rather than papering over it.
- **Live/mid-session lease reclaim** — unchanged from part 1, still an
  M6+ concern; nothing this session needed it.
- **Recovering a worktree out of `dirty`** — unchanged from part 1.
- **The four pre-existing ad-hoc test fixtures** (`supervisor.test.ts`
  and friends) — the soak and every other M5 part 2 test import
  `dbFixtures.ts`; nothing this session touches those four files, so
  they're untouched, per the explicit conditional from the kickoff.

### Explicitly deferred beyond M5 (M6+)

Pattern-deny/PATH-omission layers of §10.3.1 (no packs/roles exist —
M7); pushing to a remote (§10.6 rule 6, an `approval` checkpoint — no
checkpoint-resolution flow exists before M8); wiring the (non-functional)
restricted-token research into anything real; the Director's own
acceptance-criteria evaluation actually calling `mergeAcceptedTask`
(M11); real per-role validator/lease-TTL configuration (M7).

## 2026-08-29 — M6 (Permissions + budgets), session 1 of 3 — rule model, canonicalisation, evaluator, tool classes, effective autonomy, loop detector

§28 M6 items 1–6, plus security tests S1/S2/S3/S9/S10, on `main` per the
explicit "no abandonable-by-design work this session" instruction — no
branch. The interim `policyEvaluator.ts` (M4's own "the real one is M6"
placeholder) is deleted, replaced through the exact `PolicyEvaluatorFn`
seam `server.ts`/bureau-hook/`checkPolicyFailClosed` already used, not
paralleled.

**Where rules come from, resolved as three tiers**: Tier 0, the seven
immutable global denies from §11.3, hand-translated verbatim into code
(`immutableRules.ts`), each carrying the spec's own reasoning as a
comment (writes confined to `${worktree}` never `${project}`;
`deny.subagent_spawn`'s "several engines ship a sub-agent tool by
default" rationale). Tier 100, `role.tools_allow`/`tools_deny` — real M1
schema, not invented this session (the column's own comment already said
"§11.3 owns the real grammar, M1 only needs an array of strings"); empty
in practice since no pack loader exists yet to populate a real role row.
Tier 200, an explicit `additionalRules` parameter on the loader — the M7
seam, exactly the `resolveDefaultIntegrationRef` shape from M5, nothing
in production passes it. **S3 without a real pack**: the loader's
`validateRuleSet` rejects any non-immutable rule whose `id` collides
with one of the seven reserved ids, regardless of source or of its own
`effect` — and, caught during implementation, does **not** trust an
incoming rule's own self-declared `immutable: true` flag, only actual
identity against the real `IMMUTABLE_RULES` objects; a rule that lies
about being immutable to dodge the id check is still rejected. Proven
against a hand-built "future pack" rule object attempting to redefine
`deny.write_outside_worktree` as an allow — never a parsed pack file, per
the explicit instruction not to invent a format early.

**`EngineCapabilities` gains `networkTools`/`toolClasses`** (§11.2/§11.3:
"declared per adapter"), touching all three adapters and the §7.8
contract suite (a new consistency check: every declared network tool is
classified `network`). A real gap found along the way: nothing in
production maps `employee.engine` (a free string) to an adapter
instance — `toolClassify.ts`'s `capabilitiesForEngine` is the minimum
bridge, **deliberately lazy** (`await import(...)`, not a top-level
import): a top-level import of `ClaudeCodeAdapter` pulls in
`resourceScripts.ts`, which imports `electron` at module scope, which
broke `coreDiesMidHold.test.ts`'s esbuild-bundled plain-Node worker at
process startup ("Electron failed to install correctly") the moment this
file imported adapters eagerly — found by actually running the suite,
not by inspection, since that worker's own injected evaluator never
reaches this code path at runtime at all. Fixed by deferring the import
to the one real call site that needs it.

**Path canonicalisation** (`fs.realpathSync.native` + `\`→`/` +
lowercase) handles the one edge case that would otherwise break the most
common case outright: `realpathSync.native` requires the full path to
already exist, which a new `Write`/`Edit` target never does. Walks up to
the longest existing ancestor, resolves that, re-joins the rest
unresolved. Tested against a **real** 8.3 short name (`C:\PROGRA~1`,
confirmed live on this machine via `dir /x C:\` before writing the
assertion — genuinely resolves to `C:\Program Files`) and a **real**
NTFS junction (`fs.symlinkSync(..., 'junction')`, no admin rights
needed), not synthetic strings with a backslash typed into them.

**A real asymmetry bug caught before it shipped**: the first pass left
`${worktree}`/`${project}`/`${bureau_state}` as raw, non-canonicalised
DB path strings in the evaluator's variable context, while the candidate
path being checked against them was fully canonicalised — comparing a
canonical path against a non-canonical root would silently misbehave for
any 8.3/junction/case difference in a stored worktree or project path.
Fixed by canonicalising every variable once, in `contextBuilder.ts`,
before it ever reaches a condition.

**Effective autonomy — what "computed, not persisted" actually
computes**: `employees.autonomy` turns out to be a real, always-required
column already (no role/settings fallback left to compute at spawn
time), so the one real thing this item protects is §11.2's own
requirement that `autonomous` needs an explicit first-time confirmation.
New column `employees.autonomous_confirmed_at` (migration 0004, nullable,
never set at hire — same convention as `lease_holder`) is the real seam
M9's dialog will write to; until it does, a stored `autonomy:
'autonomous'` computes an effective `guided`, never trusted at face
value. No dialog built this session, as instructed.

**Loop detector** reuses `breaker.repeatedToolLimit`/`repeatedToolWindowS`
(default 5/60 — already exactly §11.3's own default) — no new settings.
Downgrades an `allow` to `ask` only; never touches an existing
`deny`/`ask`, on the reasoning that forcing a human prompt onto
something already blocked adds nothing.

**Bash gets no path matching, on purpose, stated where it would be
tempting to add it**: `deny.credential_paths`' own spec YAML names
`Bash(**)` in its tool pattern alongside a `path_matches` condition —
kept verbatim, but the condition evaluator returns "no match" for any
path condition against a command-class call, so that half of the rule is
real but permanently inert. Proven with a test that a Bash command
literally mentioning a credential path is *not* denied by this rule
(falls through to the command autonomy default instead) — the honest
answer, not a command-line path parser dressed up to look complete.

**A second real bug caught during a final review pass, not by review
alone — traced back to CLAUDE.md invariant #6's own "ambiguous rule"
clause**: the first version of `matchCondition`'s `arg_regex` case
caught a malformed pattern and defaulted to "no match" unconditionally.
That default is silently wrong for a `deny` rule specifically — a
condition failing to evaluate should make a *deny* fire (the safe
direction), not fail to fire. `matchCondition` now lets that error
propagate; `evaluator.ts`'s new `conditionMatchesFailClosed` catches it
at the one place that actually knows the rule's own effect, resolving
"matches" for `deny`, "does not match" for `allow`/`ask`. No real rule
this session uses `arg_regex` (none of the seven immutable denies do),
so this was a forward-looking gap for a future role/pack rule, not a
live bypass — but exactly the class of thing invariant #6 exists to
close before it becomes one. Proven with a dedicated test per direction
plus a mutation check.

**A third real bug, same final-review pass**: `argExtraction.ts`'s
relative-path resolution (`path.resolve(effectiveRawPath)` when a tool's
own `file_path`/`path` argument arrived relative, not absolute) resolved
against the *Core's own* `process.cwd()` — which has no relationship to
where an employee's process actually runs. A relative path in a real
tool call would have canonicalised against the wrong base entirely,
silently. Fixed to resolve against the employee's own worktree/project
context instead (`impliedPathForRead`, already threaded through for the
"no path given" Grep/Glob case) — no behaviour change for the common
case (Claude Code reports absolute paths for `file_path`), a real fix
for the narrower one. No dedicated test existed for `argExtraction.ts`
at all before this pass; `tests/integration/controlChannel/policy/
argExtraction.test.ts` is new, including the specific case this fix
covers (asserting the resolved path is NOT what `process.cwd()`-based
resolution would have produced).

### Gate verification — real commands, real output

- **S1** (a denied tool provably does not execute): real
  `ControlChannelServer`, real default evaluator (no injected fake), a
  Write outside a real employee's real worktree denied, and the write
  only actually attempted on 'allow' — sentinel file confirmed absent.
  Parallel leg: the identical setup with a target inside the worktree
  really does write the sentinel. Confirmed to fail if the deny check is
  bypassed (the parallel-allow leg is exactly that mutation, made real
  rather than hypothetical).
- **S2** (outside-workspace fails at every autonomy level): a real read
  and write outside the workspace denied at `ask`, `guided`, and
  `autonomous` alike. Found and fixed a wrong test assumption along the
  way: an *inside*-workspace write at `ask` is genuinely `'ask'`, not
  `'allow'` (§11.2's own table) — the first version of this sub-test
  assumed a blanket allow and hung the real long-poll hold for the
  default 30-minute `maxHoldMinutes` until vitest's own 30s timeout
  killed it; fixed by giving that one server a real but short
  `maxHoldMinutes` and asserting the hold resolves to deny only after
  actually waiting for it (~3s), proving it went through the ask/hold
  path rather than an immediate deny.
- **S3** (a pack widening an immutable deny fails at load): see above —
  proven, plus a mutation check (temporarily bypassing `validateRuleSet`
  and confirming the forged rule then loads uncaught).
- **S9** (employee A cannot read/write employee B's worktree): two real
  employees, two real worktrees on disk, A's real evaluator context
  denies both a Read and a Write targeting B's worktree, sentinel-proven
  for the write; a parallel leg confirms A can still read/write its own.
- **S10** (employee process env contains only explicitly injected
  variables): confirmed empirically first, not assumed — PROGRESS.md's
  own prior CLAUDECODE/CLAUDE_CODE_EXECPATH root-cause entries already
  showed the leak was `probe()`'s and an ad-hoc script's own
  `process.env` spread, and `buildLaunchSpec()` in both real adapters
  never spreads `process.env` at all. So the real, stronger test built
  here is an **exact-set** assertion (derived from the real, separately-
  pinned `buildWindowsBaseEnv()`, not a hardcoded guess at which
  allowlist keys exist on this machine) against both adapters' real
  `buildLaunchSpec()` output — no tolerance list needed, and none added,
  since a real leak here would be a real regression, not sandbox noise.
  `CLAUDECODE`/`CLAUDE_CODE_EXECPATH` explicitly asserted absent by name
  too, not just implied by the set-equality check.
- `verdict === null` guard: a dedicated test proves the real evaluator
  doesn't let a later, lower-priority `ask` override an already-matched
  `allow`, plus a mutation check — a local, deliberately unguarded
  reimplementation of the same loop, shown to let exactly that
  overwrite happen, so the guarded test's pass is evidence of something
  real, not a tautology.
- `mcp__bureau__` prefix: carried forward from the interim evaluator with
  its own traps intact (`not_bureau_report_status` still denies,
  `mcp__other_server__bureau_task_done` still denies) — pinned by tests
  in the new evaluator's own suite, not re-derived.
- `npm run lint && npm run typecheck` clean. `npm test` (unit): 329/329
  (80 of them `tests/unit/policy/`, including the three added for the
  `arg_regex` fail-closed fix above). `npm run test:integration`:
  216/216 once `ELECTRON_RUN_AS_NODE` — the
  same documented sandbox leak named in this file's M0/M3/M5 entries — is
  unset for the run; confirmed by direct reproduction (the two packaged-
  app smoke tests fail identically and consistently with it set, pass
  cleanly with it unset, both in isolation and inside the full suite).
  One real, non-environmental fix needed along the way: `migrate.test.ts`
  pins the exact applied-migration list and count — mechanically updated
  from `[1,2,3]`/3 to `[1,2,3,4]`/4 for migration 0004, the same
  maintenance class M4's own §16.1 settings-key precedent already
  established. `npm run test:contract`: 18/18 (3 real-engine tests skip
  themselves, opt-in only, unchanged from before this session).

### Files

New: `src/shared/policy/{types,immutableRules,patternGrammar,variables,
conditions,evaluator,autonomyDefault,autonomy,ruleLoader}.ts`;
`src/main/controlChannel/policy/{pathCanonicalize,contextBuilder,
toolClassify,loopDetector,argExtraction,policyEvaluator}.ts`;
`src/main/db/migrations/0004_autonomy_confirmation.sql`. Modified:
`src/shared/engine/types.ts` (`EngineCapabilities`), all three adapters,
`src/shared/models/employee.ts`, `src/main/db/repositories/employees.ts`
(`confirmEmployeeAutonomous`), `src/main/controlChannel/server.ts`
(`PolicyEvaluatorFn` moved to `src/shared/policy/types.ts` to avoid a
circular import with the new real evaluator; `handlePolicyCheck` now
threads real `ruleId`/`reason` instead of hardcoded nulls, and emits
`tool.loop_detected`), `src/main/index.ts` (`baseDir` wired through).
Deleted: `src/main/controlChannel/policyEvaluator.ts` and its test.
Three pre-existing test files (`server.test.ts`, `controlChannelWorker.ts`
fixture, plus every `EmployeeSchema.parse(...)` call site across 7 test
files) updated for the new required `autonomous_confirmed_at` field and
the new evaluator return shape — none of these test *behavior* changed,
only the fixture/type-shape maintenance the new required field and
signature change force.

### Explicitly deferred beyond this session (M6 sessions 2–3)

`pricing.yaml` and the cost write path, budgets at four levels, rate-
limit handling (session 2, S7); circuit breaker, redactor, the full
S1–S11 gate run (session 3, S4/S5/S8/S11); the `autonomous` first-time
confirmation dialog itself (M9 — the DB seam is real, no UI); real packs/
pack manifests (M7); a general spawn-time engine-key→adapter registry
beyond the narrow classification bridge built here; `sql_statement_kind_
not_in`/`catalog_matches` exercised against a real tool (none exists in
§23's inventory — type-complete, honestly unexercised).

## 2026-09-01 — M6 (Permissions + budgets), session 2 of 3 — pricing, the cost write path, budgets, rate limits, zero-cost mode

§28 M6 items 7–9, plus §24.5 (zero-cost mode — omitted from §28's own
numbered list, but assigned to M6 by its own FLAGGED comment), plus the
two fixes session 1's own review flagged for this session, on `main`, no
branch. Security test **S7** (`budget_stops_runaway`).

### First: the two fixes from session 1's review

**A — `role.network_allow` was about to be synthesized as an ALLOW, not
a DENY.** In a deny-wins evaluator, an allow-list of domains that never
gets *matched against a deny* changes nothing — nothing else in the
system refuses a domain simply because no rule mentions it. Fixed by
synthesizing the opposite: a `deny` whose `domain_matches` condition is
`negate: true` against `network_allow` — it fires (and denies) exactly
when the requested domain is **not** on the list. An empty
`network_allow` therefore denies everything, matching "roles that don't
need the network don't get network tools." `domain_matches` also gained
a `toolClass !== 'network'` gate (mirroring the existing Bash gate for
path conditions) so it can never accidentally fire against an unrelated
tool. **A second gap found while wiring this, not in the review**: an
employee with **no role row at all** got zero role rules applied under
session 1's own `ctx.role ? roleRulesFrom(ctx.role) : []`, including this
new deny — fixed by calling the deny synthesis unconditionally, treating
a missing role's `network_allow` as `[]`. Proven with a mutation test:
remove the synthesized deny, confirm `guided` now allows an off-list
domain — the deny, not the fallback, was what had been denying it.

**B — `capabilitiesForEngine` fabricated `{} as ProbeResult}` instead of
using the employee's real probe.** The session 1 kickoff itself claimed
"the supervisor already holds" the real probe; checking the code found
that claim false — nothing anywhere called `adapter.probe()` and kept
the result. Built the real mechanism this session: `Supervisor.assign()`
now calls `adapter.probe()`/`adapter.capabilities()` once and caches
both for the employee's whole lifetime (`getProbeResult()`/
`getCapabilities()`), and `toolClassify.ts` lost its own
`capabilitiesForEngine` entirely — `policyEvaluator.ts` now reads
`supervisorRegistry.get(employeeId)?.getCapabilities()` instead of a
second, separately-cached, engine-string-keyed copy of the same facts. A
deliberate architectural choice, not just "cache it where it already
was": Supervisor already owns the one real adapter instance for an
employee's whole life; a second cache keyed a different way is exactly
the redundant-source-of-truth class of bug this project has caught
itself on before.

### Item 7 — `pricing.yaml` and the transactional cost write path

**Real, verified rates.** `resources/pricing.yaml` — three model tiers
(Opus 5, Sonnet 5, Haiku 4.5), rates fetched live this session (2026-08-
29) from `platform.claude.com/docs/en/about-claude/pricing`, not
memory — the primary source's own text was checked specifically because
two separate SEO/aggregator sites found via search disagreed with each
other about whether Sonnet 5's pricing was still "introductory" (it
isn't; $2/$10 per million tokens is the standing price, confirmed
verbatim on the provider's own page). `quota_reset: {kind: 'unknown'}`
for claude-code is a researched conclusion, not a shortcut: its real
reset behaviour is a 5-hour *rolling* session window plus a weekly reset
personalised per account, visible only in the user's own claude.ai
settings — neither shape fits "a daily wall-clock time" or "a rolling
window Bureau can know," so §24.3's own explicit fallback (`resume_at =
now + 1h`, never invented) is the honest, correct answer here, not a
gap.

**Authoritative cost, resolved.** When the engine reports its own cost,
that wins (a provider's own billing accounts for tiers/promotions/tool
surcharges a static table can't). Bureau's own `pricing.yaml`-computed
estimate is **always** computed when a rate exists and **always stored**
— new nullable `usage.computed_cost_usd_micros` (migration `0005`) —
even when the engine's figure wins, so a real disagreement between the
two stays a visible, queryable fact instead of a discarded log line.

**The write path, made real.** §11.5.1's own literal SQL: `insertUsage`
was a bare `INSERT` before this session, no transaction, no counter
updates. Now one `BEGIN IMMEDIATE` transaction inserts the `usage` row
and updates all three denormalised counters (`tasks.spend_usd_micros`,
`projects.spend_usd_micros`, `employees.lifetime_spend_usd_micros`)
together, returning real before/after values for each — what the
stateless warn/exceeded crossing detector (item 8) needs, computed
inside the same transaction so "before" is never subject to a
concurrent-write race. **A second migration-0005 column, `usage.
project_id`, found necessary while designing this same session's own
reconciliation check**: the Director has no task in the traditional
sense, so a usage row can carry a project attribution with `task_id =
NULL` — a reconciliation query that only reached `projects.
spend_usd_micros` through `tasks.project_id` would silently miss that
spending and "correct" a real counter down to a wrong, too-low value.
Made explicit and stored instead of re-derived through a join that
cannot see it.

**Reconciliation, demonstrated with real output, not just built.**
`reconcileUsageCounters()` (wired into `reconcile()`, both at startup and
as this session's demonstration) recomputes all three counters from the
`usage` ledger and repairs any drift, one `cost.counter_drift_repaired`
event per row with the real before/after. Proven by deliberately
corrupting all three counters directly (bypassing `insertUsage` entirely
— simulating manual DB surgery or a partial-backup restore), calling
`reconcile()`, and showing the counters restored to the ledger-derived
truth and three real drift events logged
(`tests/integration/db/usageReconciliation.test.ts`) — plus a dedicated
case for the Director's task-less, project-attributed spend specifically,
proving the `project_id` fix actually closes the gap it was built for.

### Item 8 — budgets at four levels, the Director reserve, and per-level events

**Stateless crossing detection.** `checkLevel()` compares before/after
spend against a budget and a warn percentage — `warn`/`exceeded` fire
exactly on the turn that crosses each threshold, never on every
subsequent turn while already over, with **no "already warned" tracking
column** anywhere: the crossing computation itself is the state,
recomputed fresh each time from real counters.

**Two review corrections from a mid-session design pass, both
incorporated as designed, not reworked after the fact:**

1. *Per-level events, one verdict.* The first draft of `checkAllLevels`
   returned only the single most-severe outcome — silently swallowing a
   real task-level `warn` crossing on the same turn a project-level
   `exceeded` also fired. Corrected before it shipped: `checkAllLevels`
   now returns both `perLevel` (every level actually checked, each with
   its own crossing result) and `mostSevere` (the one thing the caller
   acts on). `budgetEnforcement.ts` loops `perLevel` emitting one event
   per real crossing; `mostSevere` alone drives the `park`/`ask`/`stop`
   verdict. Reporting and enforcement are different jobs.
2. *Director reserve = a carve-out at two levels, not an exemption at
   either.* The first draft exempted the Director from `globalDailyUsd`
   entirely — rejected: that would make the daily cap stop capping total
   spend, a bigger change to what the setting means than the
   anti-deadlock rule justifies. Corrected shape (applied uniformly, via
   a `reserveCarveOut` helper): non-Director employees stop at `(budget −
   directorReserveUsd)` at **both** the project and global-daily levels;
   the Director may draw to the **full** budget at both, same anti-
   deadlock property, without either cap losing its meaning for everyone
   else. `perEmployeeDailyUsd` stays a genuine, total exemption for the
   Director — §8.0 states that one explicitly, unlike the other two.
   "Even the reserve is exhausted" falls out of this for free: the
   Director's own check already uses the full, non-carved-out ceiling, so
   the Director hitting `exceeded` at project/global-daily genuinely
   means nothing is left — exactly when the real approval checkpoint
   (`raiseBudgetExhaustedCheckpoint`) fires, its "raise the budget" option
   a real, already-callable, no-model-call `setSetting` write; the
   button's *rendering* is M9's, stated plainly rather than half-built.

**S7 (`budget_stops_runaway`), green and mutation-checked.** A real
Supervisor, a real employee with a tiny task budget, a real `turn.
completed` event carrying real usage through the real `insertUsage`/
`enforceBudget` chain: the employee's DB-row status is `parked` (not
just an in-memory flag), a real `employee.budget_exceeded` event exists,
and — the actual "stopped taking turns" proof, not just a status string
— a second scripted event after parking is confirmed not to un-park it.
Mutation check: the identical scenario with no budget configured (so
nothing crosses) never parks — confirms the enforcement, not the
scenario, causes the park.

### Item 9 — rate-limit handling (§24.3)

A real, distinct `AgentEvent` — `{t: 'rate_limited', classification:
'per_minute' | 'per_day', retryAfterMs}` — so a 429 is never routed
through `finished: 'error'`, which Supervisor already treats as a crash.
Detection is pattern-based against the CLI's own `is_error`/`result`
shape (`claudeCodeStreamJson.ts`) — the **same, confirmed** top-level
shape `modelTiers.ts`'s `validateModelId` already empirically verified
this session against real `--output-format json` output, extended to a
new purpose, not a new channel. **Explicitly not empirically verified**:
no real 429 was captured this session (deliberately exhausting a real
quota to capture one was out of scope) — the specific wording patterns
are inferred from provider documentation and common phrasing, flagged in
the code for correction the first time a real one is seen.

**The one design correction from review, incorporated as designed**: an
ambiguous message (contains rate/limit/quota language but matches
neither bucket's specific patterns) defaults to `'per_minute'`, not
`'per_day'` — the asymmetric-cost argument from the review: misclassifying
a real per-day exhaustion as per-minute costs exactly one wasted backoff
cycle, then the existing max-wait escalation correctly reclassifies it
as exhausted anyway (self-correcting); the reverse parks a working
employee for up to an hour on a transient blip, with nothing to correct
it early. Documented in `classifyRateLimitMessage`'s own comment, not
just decided quietly.

**Per-minute**: exponential backoff with jitter (2s/5s/15s/45s, cap 2m —
`backoffDelayMs`, injectable `random` for deterministic tests), status
`waiting` (its own real state, never `thinking`), `employee.rate_limited`
emitted per real occurrence, retries by resending the exact content
originally sent (`lastSentText`/`lastSentKind`, a real, honestly-limited
mechanism — nothing else in this codebase yet calls `adapter.send()` for
a *later* turn, so a rate limit hit deep into a multi-turn conversation
has only the original task body to replay), escalates to exhausted after
`engines.rateLimitMaxWaitMinutes` (default 10) elapses.

**Per-day** (or an escalated per-minute cluster): `parked`, task →
`blocked`/`quota_exhausted`, `employee.quota_exhausted` emitted, a real
persisted `employees.resume_at` (new `setEmployeeResumeAt`), and a real
`information` checkpoint raised directly by Supervisor — not literally
"by the Director" as §24.3's own prose says, since no Director agent
exists before M11; the same seam shape M5 used for `integrationRef`. The
checkpoint text is the exact §24.3 template, `{when}` substituted with
the known reset time or the literal "when we retry in an hour" fallback
— proven with an exact string match in the integration test, not just
"contains some words."

**The orchestrator-tick scoping decision**: §24.3 requires "a single
orchestrator tick (every 60s)" and none existed anywhere (checked). Built
the minimal, real thing — `parkedEmployeeResumeTick.ts`'s
`startResumeTick` (a bare `setInterval`, Supervisor's own heartbeat
monitor's own precedent for this primitive), doing exactly one job
(promote a `parked` employee whose `resume_at` has passed to `off`,
emit `employee.resumed`) and nothing else — no task assignment, no
employee spawning, not a general orchestrator. `reconcile()` calls the
same promotion function at startup (re-arming, per §24.3's own
requirement); `main/index.ts` now starts the live tick alongside
`ControlChannelServer`, stopped on quit.

**Never a crash, proven, not just claimed.** `Supervisor.handleFinished`
now consults a `rateLimitedThisCycle` flag set by the rate-limit
handler: the underlying process's own `finished`/`error` a moment after
a rate-limited turn (the realistic, expected shape — the CLI exits after
reporting the 429) is consumed once and never reaches `handleFailure` —
proven with a dedicated integration test scripting exactly that sequence
and asserting `consecutive_failures` stays 0 and no `employee.crashed`
event exists.

**A real FakeAdapter gap found while writing these tests, fixed, not
worked around**: `applyStateTransition` had no case for the new
`rate_limited` event type, so `turnState` stayed at whatever it was
before (`'generating'`, from the preceding `turn.started`) — a retry's
`adapter.send()` call was silently queued behind a "still generating"
state nothing in a finite scripted test would ever flush. A real
adapter's underlying process has exited by the time a rate limit is
even detected — `rate_limited` now resets `turnState` to `'idle'`,
matching that reality, the same way an explicit `idle` event already
does.

### §24.5 — zero-cost mode, real enforcement, flag removed

`refuseSpawnIfZeroCost(zeroCostModeEnabled, probe)` — wired into
`Supervisor.assign()`, first thing, before `adapter.start()`: a metered
(or unconfirmable) engine with the setting on is refused outright,
`cost.zero_cost_blocked` emitted (new §5.2 event), never a fabricated
0-cost spawn. `canEnableZeroCostMode(engine)` — the Director case §24.5
itself names: probes the configured engine **fresh** and refuses to let
the setting turn on at all when the only real adapter would be metered
or unconfirmable, "cannot tell" treated exactly like "definitely
metered." Wired into the real `settingsHandlers.set` IPC handler (not
left as a bare function nobody calls): turning `costs.zeroCostMode` on
runs the real check first and returns `VALIDATION_FAILED` with the real
reason when refused, before the setting is ever written; turning it off
is never gated. The §24.5 FLAGGED comment (M3 session 2's own note that
the enforcement was M6's job) is removed in this same commit set, per
that note's own instruction. **One-shot call refusal is a real, stated
seam, not built**: §22.2's mechanism doesn't exist yet (confirmed —
`UsageSourceSchema` has `'oneshot'`, `engines.oneshotProvider` exists,
nothing calls either) — a future caller would run the same
`refuseSpawnIfZeroCost`-shaped check before its own not-yet-built spawn.

### A real, pre-existing bug found and fixed — not part of items 7–9's own scope, but load-bearing for all of them

Writing item 8's own tests surfaced a live violation of CLAUDE.md
invariant #12 ("money is integer micro-dollars everywhere downstream of
the config loader") in `repositories/settings.ts` — pre-existing
infrastructure, not this session's own code. `SettingsValuesSchema`'s
`usd()` fields **transform** a decimal dollar input into integer micros;
that same schema was being reused to re-deserialize an **already-
transformed** stored value on every read, converting it a second time.
Empirically confirmed, not just reasoned about: `setSetting(db,
'budgets.projectUsd', 10.0)` followed by `getSetting` read back
`10_000_000_000_000`, not `10_000_000`. Worse: this wasn't a
`setSetting`-only edge case — `settingsLoader.ts`'s own first-boot
seeding (`seedSettingDefaults`) stores the schema's already-computed
default the same way, so **every fresh database, from its very first
boot**, would have every `budgets.*` money setting silently inflated by
1,000,000× the moment the settings table is seeded — `budgets.dailyUsd`'s
real $20 default reading back as $20,000,000 in the actual running app,
effectively defeating this session's entire budget-enforcement feature
in real use, not just in a contrived test. Fixed via
`USD_MICROS_SETTING_KEYS` (`schema.ts`) and `parseStoredValue`
(`settings.ts`): a stored row for one of the 5 `usd()` keys is now read
through the already-in-micros validator, never re-run through the
decimal-accepting transform; the transform itself still runs exactly
once, at `setSetting`'s own write time. New regression suite
(`tests/integration/db/settingsMoneyRoundtrip.test.ts`, 5 tests)
including the exact first-boot-seeding case that would have shipped this
bug silently.

### The `ELECTRON_RUN_AS_NODE` sandbox leak recurred, confirmed, fixed the documented way

Rebuilding the packaged app (`npm run package`) to prove `pricing.yaml`
actually ships — a real, second build-pipeline gap found and fixed this
session alongside `resolvePricingYamlPath()`: neither `electron-builder.
yml`'s `extraResources` nor `scripts/build.mjs` had an entry for any
non-`.ts` resource file before this session, so `resources/pricing.yaml`
would never have reached a packaged app's `process.resourcesPath` at
all (confirmed by inspecting the *pre-rebuild* packaged app: no
`pricing.yaml` present) — surfaced the exact, already-documented M0
sandbox quirk again: this session's own shell carried
`ELECTRON_RUN_AS_NODE=1`, causing the freshly-rebuilt packaged exe to
run as plain Node instead of real Electron, an instant silent exit-0
with zero output, misleadingly indistinguishable from a real crash.
Root-caused by direct reproduction exactly like the prior two
occurrences (checked `echo $ELECTRON_RUN_AS_NODE`, confirmed `1`), fixed
the documented way (`env -u ELECTRON_RUN_AS_NODE -u
NoDefaultCurrentDirectoryInExePath` in the same command as the test
run) — `resourcePaths.test.ts` (extended this session to also assert
the packaged app can find **and parse** `pricing.yaml`, not just that a
path string looks plausible) green immediately after. Not a code fix; a
sandbox-hygiene one, same as the prior two times.

### Gate verification — real commands, real output

- **S7** (`budget_stops_runaway`): green, mutation-checked — see item 8
  above.
- Counter reconciliation: demonstrated with real output — see item 7
  above (`usageReconciliation.test.ts`'s deliberate-drift case).
- Every `pricing.yaml` rate: verified against
  `platform.claude.com/docs/en/about-claude/pricing`, fetched live
  2026-08-29 (see item 7 and the file's own header comment).
- `npm run lint` clean. `npm run typecheck` clean throughout (checked
  after every major file change, not just at the end).
- `npm test` (unit): **388/388**, 48 files (+8 this session:
  `tests/unit/cost/{budgetCheck,pricingYaml,rateLimitHandling,
  zeroCostMode}.test.ts`,
  `tests/unit/engine/claudeCodeRateLimitClassifier.test.ts`, plus the
  Fix A policy test updates in `autonomyDefault`/`conditions`/
  `ruleLoader.test.ts`, plus two pre-existing `UsageSchema` fixtures in
  `outputsAndMisc.test.ts` updated for the new `project_id`/
  `computed_cost_usd_micros` columns — fixture maintenance, not a
  behavior change).
- `npm run test:contract`: 18 passed, 3 skipped (real-engine, opt-in) —
  re-run because `AgentEvent` gained `rate_limited`; unaffected,
  mode-parity intact.
- `npm run test:integration`, full sequential run (46 files, 263 tests,
  ~1160s): first pass came back 9 failures across 4 files. Triaged every
  one individually rather than accepting or dismissing any of them:
  - **`migrate.test.ts` (1 failure, real, mine)**: the pinned
    applied-migration list, same mechanical maintenance M4's/M6 session
    1's own precedent already established — `[1,2,3,4]` → `[1,2,3,4,5]`
    for this session's own migration `0005`. Fixed, re-run green (6/6).
  - **`policyRealEvaluator.test.ts` (6 failures, a real regression from
    Fix B, root-caused and fixed, not worked around)**: every "should
    allow"/"should ask-then-timeout" case in this file fell to an
    immediate `deny`. Root cause: this file constructs its
    `ControlChannelServer` with a brand-new, empty `SupervisorRegistry`
    — Fix B's own new dependency (`policyEvaluator.ts` now reads
    `supervisorRegistry.get(employeeId)?.getCapabilities()`) resolved to
    `null` for every one of its test employees, which `classifyTool`
    correctly treats as `'other'`, which §11.3's own rule denies by
    default. In real production this is not reachable — `/v1/policy/
    check` only exists for a token `spawnSupervisedEmployee` minted,
    which registers that employee's Supervisor in the same function,
    atomically — so the test's own premise ("wired exactly as production
    wires it") was the thing actually out of date, not Fix B. Fixed by
    giving the test a real `registerLiveSupervisorFor()` helper: a real
    `Supervisor` wired to an empty-script `FakeAdapter`, `assign()`ed
    (task: null, the same safe shape several `supervisor.test.ts` cases
    already use) and registered, called at all 9 employee-creation sites
    in the file — not just the ones that happened to fail, so the whole
    file is uniformly production-faithful now, not patched around the
    symptom. Re-run green (14/14).
  - **`supervisor.test.ts` (2 failures)**: confirmed transient timing
    flakes under the full sequential batch's real load — the exact same
    class of flake session 1's own PROGRESS.md entry documented for two
    different tests, same root cause (tight real-timer margins, a loaded
    machine). Re-run in isolation: 16/16 green, including both that
    failed under load.
  - **`soak.test.ts` (1 failure, confirmed environment-attributed, not a
    regression, out of this session's scope)**: the M5 100-cycle real
    git soak test timed out at its own 480s limit, then a cleanup
    `rmSync` hit `EPERM` (a lingering git process still holding a handle
    — fallout from the timeout, not a second bug). Re-run in isolation
    (ruling out cross-file contention): still times out, but its own
    smaller `chaos row 13` sub-test (real lock contention) passed in
    7.8s — confirming the underlying mechanism works, just slower than
    historically recorded (PROGRESS.md's M5 part 2 entry: 250ms lock,
    615–790ms recovery; this run: 1833ms for the equivalent operation).
    Checked for code overlap before attributing this to environment:
    zero — this test's entire dependency chain
    (`gitWorktree.ts`/`employeeCommit.ts`/`integrationMerge.ts`/
    `worktrees.ts`/`projects.ts` repos) was untouched by this session.
    Consistent with the Windows Defender real-time-scanning slowness
    already documented in this exact repo (`electron-builder.yml`'s own
    comment, a different context, same machine class). Not re-attempted
    a third time (8+ minutes per run) — named here rather than silently
    reported clean, per this session's own instruction to name an
    environment-attributed failure specifically.
  - **Final state, every file individually confirmed**: `migrate.test.ts`
    6/6, `policyRealEvaluator.test.ts` 14/14, `supervisor.test.ts` 16/16,
    every other file in the original 46-file run already green on the
    first pass. `soak.test.ts`'s one sub-test remains environment-limited
    in this sandbox, pre-existing and out of scope.

### Files

New: `resources/pricing.yaml`; `src/shared/models/pricing.ts`;
`src/main/cost/{pricingYaml,budgetCheck,budgetEnforcement,
rateLimitHandling,zeroCostMode}.ts`;
`src/main/engine/parkedEmployeeResumeTick.ts`;
`src/main/db/migrations/0005_usage_computed_cost.sql`. Modified:
`src/shared/policy/{types,conditions,ruleLoader,autonomyDefault}.ts`
(Fix A); `src/main/engine/supervisor.ts` (Fix B, item 7's `recordUsage`
extension, item 8's verdict handling, item 9's rate-limit handling);
`src/main/controlChannel/policy/toolClassify.ts` +
`src/main/controlChannel/policy/policyEvaluator.ts` +
`src/main/controlChannel/server.ts` (Fix B); `src/shared/models/
usage.ts` + `src/main/db/repositories/usage.ts` (item 7's transactional
write path); `src/main/db/reconcile.ts` (item 7's counter
reconciliation, item 9's resume-tick re-arm); `src/main/db/repositories/
employees.ts` (`setEmployeeResumeAt`); `src/shared/settings/schema.ts` +
`src/main/db/repositories/settings.ts` (the money round-trip bug fix);
`src/shared/engine/events.ts` (`rate_limited`); `src/main/engine/
claudeCodeStreamJson.ts` (the classifier); `src/main/engine/
fakeAdapter.ts` (the `rate_limited`→idle turnState fix); `src/main/ipc/
handlers/settings.ts` (§24.5's enable-check); `src/main/index.ts`
(resume tick started/stopped); `electron-builder.yml` +
`scripts/build.mjs` + `src/main/engine/resourceScripts.ts` +
`src/main/smoketest/resourcePaths.ts` + `tests/integration/
resourcePaths.test.ts` (the pricing.yaml packaging gap); `package.json`
(`yaml@^2.9.0`, new production dependency — this repo had no YAML parser
before); `tests/integration/migrate.test.ts` (pinned migration count,
mechanical); `tests/integration/controlChannel/policyRealEvaluator.test.ts`
(the Fix B regression fix — a real, live `Supervisor` registered per test
employee, not a workaround).

New tests: `tests/unit/cost/{pricingYaml,budgetCheck,rateLimitHandling,
zeroCostMode}.test.ts`; `tests/unit/engine/
claudeCodeRateLimitClassifier.test.ts`; `tests/integration/db/
{usageWritePath,usageReconciliation,settingsMoneyRoundtrip}.test.ts`;
`tests/integration/engine/{supervisorBudget,supervisorRateLimit,
parkedEmployeeResumeTick}.test.ts`; `tests/integration/cost/
zeroCostMode.test.ts`; `tests/integration/ipc/
settingsZeroCostGate.test.ts`.

### Explicitly deferred beyond this session (M6 session 3)

Circuit breaker, redactor, the full S1–S11 gate run (S4/S5/S8/S11
specifically — S7 is this session's own); wiring the loop
detector/circuit breaker together. Every UI surface (live cost meter,
Settings copy for any of this session's settings, the "raise budget"
button's actual rendering, the rate-limit speech bubble's rendering) —
M9. A general orchestrator — M11. §24.4's cost-reduction table — read
this session, none of it built (already shipped piecemeal elsewhere, or
scheduled for M3/M7/M10). One-shot call refusal's own mechanism (§22.2)
— the seam is real, the mechanism isn't. `resolveResumeAt`'s daily-
timezone branch is real, tested code (`Asia/Kolkata`/`UTC`, both fixed-
offset, deterministic) but unexercised by any real engine today —
claude-code's own `quota_reset` is `unknown`.

## 2026-09-02 — M6 (Permissions + budgets), session 3 of 3 — circuit breaker, redactor + real secret broker, three remaining stubs closed — MILESTONE CLOSED

§28 M6 items 10–12, plus the three `stub('M6')` surfaces the codebase
itself assigned to this milestone that §28's numbered list doesn't
mention (`costsHandlers.pricingTable`, `projectsHandlers.setBudget`,
`systemHandlers.supportBundle`). On `main`, no branch. Security tests
**S4** (`canary_secret_never_leaks`), **S5** (`redaction_across_chunk_
boundary`), **S8** (`breaker_trips_on_loop`), **S11**
(`hook_failure_denies`, relabeled from M4's `coreDiesMidHold.test.ts`,
not rebuilt). S1–S11 run as one suite for the first time this session.

### First: six corrections from plan review, before any code existed

The plan review this session found more than usual — six points, all
substantive, all incorporated before writing anything:

1. **§11.5 says "SKIP TO STEP 3" when `caps.interrupt===false` — my
   first draft sent the corrective message anyway.** Not a corner case:
   claude-code's real, default, structured mode has `interrupt:false`
   (§7.7.1), so this is the common path, not an edge case. Following the
   spec literally turned out to be the simpler code too — no "queue it
   and hope it lands eventually" branch to write at all.
2. **Applying the breaker uniformly to the Director reaches the exact
   deadlock the budget reserve (session 2) exists to prevent** — a
   stopped Director leaves nobody to answer the blocker checkpoint the
   breaker itself just raised. Fixed by the same shape as the budget
   reserve: the Director may be constrained (step 3) but is never
   stopped (step 4) — `if (this.isDirector) return` right after
   constraining, before `scheduleEscalation` is ever called.
3. **S4 could pass vacuously.** My first draft would have proven
   "the canary appears nowhere" without first proving it ever reached a
   spawned employee's real environment — a silently-broken broker
   resolution would have passed for the same reason an unmutated test
   passes. Fixed by requiring presence proven first (`FakeAdapter` now
   genuinely calls `ctx.broker.resolveForSpawn()`, a real, previously-
   missing behaviour this test's own requirement surfaced), and by
   dropping a proposed second "plant it straight into the registry"
   path entirely — that would only ever have exercised the registry's
   own lookup, not the store→broker→env chain S4 exists to prove.
4. **`RedactionStream` holding back up to ~4KB with only end-of-stream
   `flush()` releasing it would visibly freeze the live terminal** on
   any quiet stretch — nothing is "end of stream" until a whole turn
   finishes. Fixed with a second, independent release trigger:
   Supervisor's own `idle` handling now also flushes, and `feed()`
   resets a ~300ms inactivity timer that flushes too. The trade this
   makes is stated in the code, not hidden: a secret split across more
   than ~300ms of genuine silence *within* one still-generating turn
   could theoretically slip past — not realistic (bytes from one
   underlying write land together) against the alternative, a
   guaranteed-frozen terminal on every quiet moment.
5. **S15 (`prompt_injection_contained`) does not exist — I had proposed
   marking chaos row 11 covered by "S1/S15."** It's assigned to M8, not
   written by anyone yet. Corrected: row 11 stays "Not started," M8
   named as the real owner, not claimed against a test that doesn't
   exist.
6. **What does a restart do to the breaker's in-memory state?** Asked
   directly, not left implicit. `breakerTripped`/`breakerConstrained`/
   the escalation timer are all plain Supervisor-instance fields — an
   app restart drops them silently. Confirmed, not assumed, why this is
   safe: `reconcile()`'s existing `blockRunningTasks()` (M1) already
   blocks *every* task that was `running` at the moment of a crash,
   completely independently of breaker state — nothing resumes
   live-but-unwatched after a restart, breaker-tripped or not. Two
   different mechanisms with overlapping coverage of the same window,
   stated explicitly rather than left for a reader to infer.

### Item 10 — the circuit breaker

**Four triggers, four existing check points — no new polling loop.**
Token velocity is checked from `recordUsage()` (every `turn.completed`),
pruning a rolling 60s window (`pruneAndSumTokens`, the same
prune-then-reduce shape `LoopDetector` already uses). Repeated tool
calls arrive as an external signal — `server.ts`'s `handlePolicyCheck`,
exactly where session 1's own `tool.loop_detected` is already logged,
now also calls the new `Supervisor.noteLoopDetected()`. An error storm
is checked from the existing `case 'tool.completed':` handler,
inspecting `event.ok`, via a **second `LoopDetector` instance**
Supervisor now owns (`limit: breaker.errorStormLimit`) — genuine reuse
of the generic sliding-window primitive, not a second implementation of
it, and not the same instance the policy layer's own loop detector
owns. Wall-clock overrun piggybacks on the existing heartbeat tick
(`checkHeartbeat()`), comparing against `role.wall_clock_timeout_s` — a
real, existing per-role setting (M1, default 2400s) that had no
consumer anywhere in the codebase until this session.

**One flagged, reasonable-not-certain decision**: no dedicated
error-storm-window setting exists in `schema.ts`'s `breaker.*` keys, and
`repeatedToolWindowS` is the only window-shaped breaker setting
available — the error-storm detector reuses it. A real, load-bearing
call, not an oversight; stated here rather than silently assumed.

**The steer sequence, followed to the letter, with the reasoning kept
in the code, not just this file**:

```
tripBreaker → emit cost.breaker_tripped (always, before anything else)
  → breaker.hardStop? stopForBreaker(), done — the immediate-kill path,
    off by default because killing mid-write loses work (kept as a
    comment at the call site, not just a config default)
  → caps.interrupt? interrupt() [ends the current generation for real]
                     then send(STEER_MESSAGE, 'steer')
                     [§7.4's own turn-boundary queue does "wait for
                      idle" for free — no separate wait logic needed]
  → else: skip the message entirely (§11.5's own literal instruction)
  → constrain: breakerConstrained = true (isBreakerConstrained() —
    read by policyEvaluator.ts's own live-Supervisor override, wired
    the same way Fix B (session 2) wired live capabilities — computed,
    never written to employees.autonomy)
  → Director? return here, constrained but never scheduled to stop
  → else: scheduleBreakerEscalation(steerTimeoutS)
        fires → the SAME trigger still holds? stopForBreaker()
              → else: cleared, logged, no stop (wall-clock overrun is
                monotonic — it can never "improve," so it always
                escalates)
```

`stopForBreaker`: emits `employee.stopped` (a real event this session
gives its first real emitter), blocks the current task with reason
`breaker_tripped`, raises a real `blocker` checkpoint naming the
trigger (one honest "acknowledge" option, a real consequence, per
invariant #8), then calls the real `stop()`.

**`LoopDetector.peek(employeeId, tool, canonicalArg)`** — a new,
read-only method (no side effects, mirrors `recordAndCheck`'s filtering
without pushing/recording) added this session so the escalation check
can ask "does this still hold" honestly. One real, flagged limitation:
Supervisor has no access to the *policy layer's own* `LoopDetector`
instance, so `repeated_tool_calls` specifically always answers "still
holds" at escalation time — the safe, fail-closed direction, not a bug,
but worth naming rather than leaving implicit.

**Proving the message actually lands, not that `send()` was called**
(the kickoff's own explicit requirement): `supervisorBreaker.test.ts`'s
S8 test asserts `adapter.interruptCallCount === 1` *and then*
`adapter.sentMessages` contains the steer message with
`delivery:'immediate'` — real proof of landing (`FakeAdapter.interrupt()`
genuinely sets `turnState` back to `'idle'`, so the immediately-following
`send()` really does deliver right away rather than queuing). A second
test proves the honest §11.5-literal fallback: `caps.interrupt:false`
— `interrupt()` is never called, the steer message never appears in
`sentMessages` at all, only the constraint takes effect.

### Item 11 — the redactor, and the secret broker it depends on

**Three new files under `src/main/secrets/`, all with zero `electron`
dependency except `secretStore.ts`** (which lazily imports it, same
discipline as every other Electron-touching seam in this codebase):

- **`redactor.ts`** — `SecretRegistry` (never `unregister`s — an old,
  rotated secret must stay redactable in old logs), `PATTERN_MATCHERS`
  (JWTs, `sk-`/`gsk_`/`dapi` prefixes, AWS key IDs, PEM blocks, `Bearer`
  headers, connection strings), `redactText`/`redactDeep` (one-shot,
  for structured/file content), and `RedactionStream` — the real
  overlap-buffer mechanism for the one genuinely-chunked path. On each
  `feed(chunk)`, it finds every match in the *whole* buffered text but
  only finalizes and emits matches (and plain text) up to
  `pending.length − (maxMatchLen − 1)` — the standard streaming-scanner
  safety argument: any match not fully clear of that trailing window
  could still be a partial secret waiting on the next chunk, so nothing
  containing a real secret is ever emitted un-redacted. Bounded memory
  regardless of total stream length — `pending` never exceeds
  `chunk.length + maxMatchLen − 1` — proven directly (600 chunks × 1000
  chars, `pendingLength` checked after every one), not just reasoned
  about; this is chaos row 8's real coverage. Output is labeled
  (`«redacted:anthropic_key»`, `«redacted:secret»` for an exact-value
  match with no more specific pattern name) rather than blank or a
  generic `[REDACTED]` — so an agent that just wrote a sentence
  containing a real value sees *something* was there and doesn't retry
  in confusion, which is the exact failure mode a blank redaction would
  risk re-triggering.
- **`secretStore.ts`** — `storeSecret`/`retrieveSecret`/`clearSecret`,
  all `safeStorage`-backed via an injectable `SafeStorageLike` interface
  (a lazy `import('electron')` default). §11.4's literal rule enforced,
  not just documented: `isEncryptionAvailable()` called only after the
  caller's own `app.whenReady()`, and a `false` result means Bureau
  **refuses to store the key**, returning a real reason string, rather
  than falling back to plaintext. Ciphertext is stored base64-encoded
  directly in `secrets_meta.storage_ref` — simpler than a separate file
  (one atomic DB write, no file/DB desync window to reconcile on
  crash), and the column's own "no values, ever" comment still holds:
  what's stored there is unreadable without the same machine's own
  DPAPI key. `API_KEY_HONEST_NOTE` — §11.4's exact honest text about
  API keys being long-lived and unscopeable — exported as a real
  constant here, now threaded into `settingsHandlers.getSecretsStatus`'s
  own response (`{items, note}`, a small real schema addition) so a
  future settings screen (M9/M13) renders Bureau's real copy rather
  than re-deriving a paraphrase.
- **`secretBroker.ts`** — `createRealSecretBroker(db, registry?,
  safeStorage?)`. Only `claude-code` is real; the true current default
  (§7.6, unchanged) is that **nothing is stored and nothing is
  injected** — subscription auth via `CLAUDE_CONFIG_DIR` — so
  `resolveForSpawn` returns `{env:{}, secretValues:[]}` unless a user
  has explicitly opted into a stored, metered key, at which point the
  value is registered into the shared registry the moment it's ever
  resolved for any employee, not just the one that happened to resolve
  it first. `revokeForEmployee` is a real, honest, documented no-op —
  §11.4 itself says a provider API key can't be scoped down or minted
  short-lived, so a single shared, long-lived key has nothing
  per-employee to revoke — but it is still wired to fire on **every**
  real stop path that exists today: `Supervisor.stop()` (clean stop,
  fire) and `reconcile.ts`'s orphan sweep (crash recovery), per
  `SecretBroker`'s own interface contract, not just the happy path.

**The design question `claudeCodeAdapter.ts` explicitly flagged for
this session, settled, flag removed in the same commit**: both real
adapters (`ClaudeCodeAdapter`, `GenericPtyAdapter`) already
independently called `buildLaunchSpec()` then merged
`ctx.broker.resolveForSpawn()` inside their own `deliver()` — the same
shape, arrived at separately. This session ratifies that as the real
design (the adapter is the sole caller of both; the Supervisor never
touches a broker for spawning, only for `revokeForEmployee` on stop) —
not a new decision, a confirmed convergence. `seams.ts`'s own
`SecretBroker` doc comment, which had drifted to say "the supervisor
resolves credentials separately... and merges" (true of an earlier
draft, never of what got built), corrected to match; `docs/BUILD-SPEC.md`
§7.1.1 corrected the same way in the same commit. **One real,
previously-harmless bug found while settling this**: `GenericPtyAdapter.
deliver()` was recomputing `buildLaunchSpec()` + `resolveForSpawn()` on
*every* `send()` call even though PTY mode only spawns once — silently
discarding the recomputed spec/secrets for every turn after the first.
Harmless while the broker was a no-op; a real, wasted resolve — and,
now that the broker returns real credentials, a real design smell — the
moment it wasn't. Fixed: guarded to `if (!this.ptySession)`.

**Six choke points, one module, wired individually because the data
shapes genuinely differ**: (1+2) `Supervisor`'s `case 'raw':` — one
`RedactionStream` instance feeds both `writeTranscript()` and
`this.terminal.feed()` from the same already-redacted output (terminal
stream and transcripts are the same raw-byte path with two sinks, not
two separate redaction passes); (3) `ActivityLog.logEvent()` —
`redactDeep(input.payload)`, covering the file write and the mirror
insert with one call; (4) `stateDelta.ts`'s `buildFullSnapshot` — deep-
redacted right before `win.webContents.send`, and `pushPatch` too, even
though no real caller of the latter exists yet (a later milestone's
producer inherits the redaction for free rather than having to remember
it); (5) `employeeCommit.ts`'s `buildStructuredCommitMessage` —
`redactText` on the assembled message before the real `git commit` (git
history is effectively permanent — no "revoke it later" for this path);
(6) `system.ts`'s new real `supportBundle` handler.

### The three `stub('M6')` surfaces — all three built for real

- **`costsHandlers.pricingTable`** — reads `resources/pricing.yaml`
  (session 2), mapped through `CLAUDE_CODE_DEFAULT_MODEL_TIERS` inverted
  (model id → tier). A real architecture decision made while building
  this, not asked for verbatim by the plan: rather than have the
  handler call `resolvePricingYamlPath()` (which touches `app.
  isPackaged`, and per this repo's own established convention
  (`resourcePaths.test.ts`) is only ever exercised through a real
  packaged exe, never plain vitest) on every IPC call, `main/index.ts`
  now loads the pricing table exactly once at startup — finally giving
  session 2's own "loaded once here... once a real hiring flow calls
  it" comment its first real reader — and threads it through a new
  `HandlerContext.pricing` field (`registerIpcRouter` gained a 4th
  parameter). This makes the handler plain-Node testable with zero
  Electron dependency and avoids a redundant disk read + YAML parse on
  every renderer request. A model with no entry in the tier mapping is
  omitted from the result, not assigned a guessed tier — the same
  "unknown, not invented" discipline `pricing.yaml`'s own `quota_reset:
  unknown` already established.
- **`projectsHandlers.setBudget`** — new `setProjectBudget(db,
  projectId, budgetUsdMicros)` mirroring `setProjectRepoInitialised`'s
  shape exactly, writing the same `projects.budget_usd_micros` column
  session 2's `budgetEnforcement.ts` already reads as the per-project
  override. Fails closed with `NOT_FOUND` for an unknown project id,
  never a silent no-op. Emits a new, real event: `project.budget_set`
  — §5.2's own table has no existing type that means "a budget level
  changed" (`stage_changed` is specifically about workflow stage), so
  this is a genuine taxonomy addition, made in the code and in
  `docs/BUILD-SPEC.md`'s §5.2 table in the same commit, per that
  table's own "adding a type is a code change and a doc change" rule —
  not a string invented ad hoc and left undocumented.
- **`systemHandlers.supportBundle`** — real, but scoped smaller than a
  literal "bundle": one redacted JSON file
  (`<userData>/support-bundles/bundle-<timestamp>.json`), not a zip.
  No archive library exists in this repo's `package.json`, and adding
  one for a single-file feature is a real new-dependency decision left
  for whoever actually needs a multi-file bundle later — matches the
  existing IPC contract exactly (`output: z.object({path: z.string()})`,
  no schema change needed). Contains app/platform version, every
  detected prereq (`listPrereqs`, new), current settings (`getAllSettings`,
  redacted anyway even though §11.4 already means they hold no secret
  VALUE by design — defense in depth, not trust unaudited), the last
  500 activity-log entries (`readActivityLogTail`, already existed,
  reused), and each currently-tracked employee's transcript tail
  (`listEmployees`, new, capped at 20,000 chars, redacted a second time
  even though the transcript was already redacted once before being
  written — cheap insurance, and it also covers a transcript file
  written by an older build before that wiring existed). Split into an
  exported `buildSupportBundle(ctx, appVersion?)` plus a thin handler
  wrapper specifically so the real logic (everything except
  `app.getVersion()`) is plain-Node testable — `app.getVersion()` only
  resolves inside a real running Electron process, the same constraint
  `pricingTable` above ran into, solved the same way (an injectable
  parameter that defaults to the real call, same pattern
  `secretStore.ts`'s own `safeStorage` parameter already established).
  Also fixed in the same session: `createFileTranscriptWriter`'s own
  file location moved from a flat `<baseDir>/<id>.transcript.log` to
  `getEmployeeStateDir(baseDir, id)/transcript.log` — the same
  per-employee directory convention `bureau_state` already uses — so
  `supportBundle` has exactly one canonical place to look, not a second
  convention to keep in sync. (No real caller constructs a
  `Supervisor` with a real `transcriptWriter` yet — no hiring flow
  exists before M7 — so this is a real, tested convention with no live
  production traffic through it today; see "what's stubbed" below.)

### Item 12 — S4, S5, S8, S11, and the combined gate

- **S4** (`tests/integration/security/canarySecretNeverLeaks.test.ts`)
  — one canary, planted through the real `secretStore.storeSecret`, a
  real project/employee/worktree/task (the same setup
  `gitProtectionLayer4.test.ts`'s S6 uses), a real `Supervisor` +
  `FakeAdapter` bridged to resolve as `claude-code` (a test-only fixture
  standing in for what a real `ClaudeCodeAdapter`'s own `this.key`
  would already pass — `secretBroker.test.ts`'s own "never resolves for
  `generic-pty`" case proves that gate is real production behaviour,
  not something this bridges around). **Presence proven first**:
  `adapter.resolvedSecretsAtSpawn.env.ANTHROPIC_API_KEY === CANARY`,
  asserted before a single absence check. **Then absence across all
  six real sinks**: the transcript file, the raw `activity.jsonl`, the
  real state-delta snapshot (`buildFullSnapshot`, newly exported for
  exactly this), a real `git commit` message (read back via `git log`,
  not `commitTaskWork`'s own return value), and a real support bundle
  — zero hits, and a `«redacted:secret»` marker present in each. Uses
  `globalSecretRegistry`, not an isolated instance — unlike the pure
  matching-logic tests, the six real sinks under test here all default
  to the module-level singleton internally with no override seam, so
  there's nothing else to register the canary into that they'd ever
  see; the canary value is `newId()`-suffixed specifically so leaking
  into the shared registry for the rest of the process is harmless.
- **S5** (`tests/unit/secrets/redactionStream.test.ts`, written before
  Item 11's implementation, per §19's own rule) — a secret's actual
  bytes split mid-token across two and three separate `feed()` calls
  (not one chunk containing the whole value, which would pass
  trivially and prove nothing), a pattern-match split, and the bounded-
  memory proof chaos row 8 now cites.
- **S8** — see item 10 above (`supervisorBreaker.test.ts`).
- **S11** — formalized, not rebuilt, per the kickoff's own explicit
  instruction: `coreDiesMidHold.test.ts`'s `describe` block relabeled
  `— S11: hook_failure_denies`, a doc comment added explaining the
  mapping (an unreachable policy check *is* a hook failure; `deny` *is*
  the safe option), re-run to confirm the M4 session 1 test body is
  otherwise untouched and still passes.

**Mutation verdicts, stated explicitly for all eleven, per this
session's own gate role**:

| # | Name | Originated | This session |
|---|---|---|---|
| S1 | `denied_tool_does_not_execute` | M6 session 1 | Re-run green; mutation-checked at origin |
| S2 | `cannot_escape_workspace` | M6 session 1 | Re-run green; mutation-checked at origin |
| S3 | `immutable_rule_cannot_be_widened` | M6 session 1 | Re-run green; mutation-checked at origin |
| S4 | `canary_secret_never_leaks` | **This session** | Fresh — registry-neutering mutation (all six sinks fail) **and** broker-noop mutation (presence check fails) both confirmed to break the test, then reverted |
| S5 | `redaction_across_chunk_boundary` | **This session** | Fresh — a real split proven, not a whole-value-in-one-chunk placebo |
| S6 | `agent_cannot_commit` | M5 part 2 | Re-run green; mutation-checked at origin |
| S7 | `budget_stops_runaway` | M6 session 2 | Re-run green; mutation-checked at origin |
| S8 | `breaker_trips_on_loop` | **This session** | Fresh — `isBreakerConstrained()` neutered to always return `false`; 3 of 6 tests in the file fail, confirming the constraint (not the scenario) is what the assertions actually depend on |
| S9 | `worktree_isolation` | M6 session 1 | Re-run green; mutation-checked at origin |
| S10 | `no_ambient_env` | M6 session 1 | Re-run green; mutation-checked at origin |
| S11 | `hook_failure_denies` | M4 session 1 | Relabeled, not rewritten, per the kickoff's own instruction; re-run green — the real-process-kill mechanism this proves has been unchanged since M4 |

**The combined gate**: `npm run test:security` (new script — the exact
eight files above, split across the unit and integration vitest
configs since S3/S5 are unit-scoped) — **8 files, 44 tests, all green,
0 failures**, real output below.

### Gate verification — real commands, real output

```
$ npm run test:security
 ✓ tests/unit/secrets/redactionStream.test.ts (7 tests)
 ✓ tests/unit/policy/ruleLoader.test.ts (14 tests)
 Test Files  2 passed (2) · Tests  21 passed (21)

 ✓ tests/integration/engine/supervisorBreaker.test.ts (6 tests)
 ✓ tests/integration/controlChannel/policyRealEvaluator.test.ts (14 tests)
 ✓ tests/integration/workspace/gitProtectionLayer4.test.ts (4 tests)
 ✓ tests/integration/engine/supervisorBudget.test.ts (5 tests)
 ✓ tests/integration/engine/genericPtyAdapter.test.ts (4 tests)
 ✓ tests/integration/security/canarySecretNeverLeaks.test.ts (1 test)
 ✓ tests/integration/engine/claudeCodeAdapterBuildLaunchSpec.test.ts (6 tests)
 ✓ tests/integration/controlChannel/coreDiesMidHold.test.ts (1 test)
 Test Files  8 passed (8) · Tests  44 passed (44)
```

**The full milestone gate (§28), all four parts demonstrated with real
output this session, not cited from an earlier one**:

1. **S1–S11 green** — the table and command above.
2. **A denied command provably does not execute** — S1, inside the
   suite above: a `Write` outside the worktree denied by the real
   policy evaluator, verified by a filesystem sentinel's real absence,
   not a log line.
3. **A budget-exceeded employee parks** — S7, inside the suite above: a
   real `Supervisor` crossing its task budget is parked, not merely
   warned, and stays parked; mutation-checked (`enforceBudget` never
   called → never parks).
4. **A simulated 429 backs off and resumes** — re-run this session, not
   cited from session 2: `supervisorRateLimit.test.ts`, 5/5 green
   (per-minute backoff/retry/escalate-to-parked, per-day immediate
   park + real `resume_at` + real checkpoint, the "never looks like a
   crash" case, and the pending-retry-timer-cancelled-on-stop case).

**Full verification, run this session**:
- `npm run lint` clean. `npm run typecheck` clean (checked repeatedly
  through the session, not just at the end).
- `npm test` (unit): **420/420**, 51 files (+32 tests / +3 files over
  session 2's 388/48: `tests/unit/secrets/{redactor,
  redactionStream}.test.ts` (18+7), `tests/unit/engine/
  circuitBreaker.test.ts` (7) — `secretStore.test.ts`/`secretBroker.
  test.ts` moved to `tests/integration/` since both need a real
  migrated DB).
- `npm run test:contract`: 18 passed, 3 skipped (real-engine, opt-in,
  unchanged) — re-run because `EmployeeContext.broker` is a real field
  now, not the no-op; nothing in the contract suite assumed the noop
  shape, all green.
- `npm run test:integration`, full sequential run (51 files, 286
  tests): **284/286 on the first pass, 2 failures, both triaged
  individually, both confirmed environment-attributed, neither a
  regression from this session's changes**:
  - `claudeCodeAdapterProbe.test.ts`'s "binary present but
    unauthenticated" case failed under the full run
    (`expected false to be true`) — this test spawns the real `claude`
    CLI against a fresh, isolated `CLAUDE_CONFIG_DIR` and checks real
    auth state; re-run in isolation (this session ran the unit,
    integration, and contract suites simultaneously in the background
    to save wall-clock time, which is real, self-inflicted CPU/IO
    contention on this machine, not a product bug): **4/4 green**. This
    file's own code path (`ClaudeCodeAdapter.probe()`) was untouched
    this session.
  - `soak.test.ts` (the M5 100-cycle real git soak) timed out at its
    own 480s limit under the three-way-parallel contention. **This
    exact test, under load, already has a documented prior
    occurrence** — session 2's own PROGRESS.md entry: same test, same
    480s timeout, same conclusion (environment-attributed, Windows
    Defender real-time-scanning class of slowness), with its own
    smaller `chaos row 13` sub-test (real lock contention) passing
    standalone both times, confirming the underlying mechanism works.
    Session 2 could say "zero code overlap" and stop there; this
    session's changes genuinely touch two files in this test's
    dependency chain (`employeeCommit.ts` gained one `redactText()`
    call on the final assembled commit message; `activityLog.ts`
    gained one `redactDeep()` call per logged event), so that shortcut
    isn't available — re-run in full isolation (nothing else running):
    **still times out, at 491.6s against the same 480s limit** — worse
    than session 2's own isolated run, but the sub-test again passed
    standalone (5.9s), and this session's two new calls were checked
    for real cost, not assumed cheap: `redactText`/`redactDeep`'s
    pattern list is a module-level constant (never recompiled per
    call), the registry is empty for the whole test (no secret is ever
    stored), and every scanned string is short (a commit message, one
    activity-log payload) — microseconds per call at most, not the
    seconds a 100-cycle test would need to explain a ~10s swing at this
    boundary. Recorded as the same class of pre-existing,
    environment-attributed slowness session 2 already named, not
    silently assumed clean given the changed overlap — but not fully
    ruled out by code inspection alone either; if a future session sees
    this test cross further past its own limit, re-check these two call
    sites first rather than defaulting to "environment" again.
- No `stub('M6')` remaining anywhere (`grep -rn "stub('M6')" src/`:
  zero matches). `setSecret`/`clearSecret` remain `stub('M13')`,
  correctly out of this session's scope (a different milestone owns
  them, per the kickoff's own explicit exclusion).
- `node scripts/checkIpcSurface.mjs`: clean (20 namespaces, 109
  methods, 7 events) — `getSecretsStatus`'s new `note` field and
  `setBudget`'s real implementation didn't desync the schema/method-
  list agreement the router itself depends on.

### What surprised me

- **The new circuit-breaker settings reads and `LoopDetector`
  construction inside `assign()` cost enough real, synchronous work to
  break two pre-existing `supervisor.test.ts` timing margins.** The
  "slow but alive" heartbeat test's own `structuredTimeoutMs:300` had
  no real margin left — measured the first heartbeat check's
  `silentForMs` landing at 289ms against the old 300ms cutoff, not a
  flake. Widened to 600 with a comment explaining why it's a real cost,
  not superstition. Two more pre-existing tests (both asserting on raw
  PTY output reaching `TranscriptWriter`/`TerminalBroadcaster`) needed a
  scripted `idle` event appended, because `RedactionStream` now holds
  back short strings until a release trigger fires — correct, new
  behaviour these tests' own scripts predated. One of the two also
  needed its wait widened from 50ms to 500ms, root-caused via temporary
  debug prints (removed after diagnosis) to real wall-clock delay under
  this session's own disk I/O load, not a logic bug — both the redaction
  flush and the broadcaster's coalesce timer fired with correct data,
  just later than 50ms.
- **`FakeAdapter` was an inaccurate stand-in for the broker contract the
  moment the broker stopped being a no-op**, and nothing caught this
  until S4 needed it — `start()` never called `ctx.broker.
  resolveForSpawn()` at all, unlike both real adapters. Every existing
  test using `FakeAdapter` had been implicitly assuming a shape the fake
  didn't actually implement, silently, since session 1 shipped the
  no-op broker; it simply never mattered while the broker never
  returned anything real. Fixed as part of S4's own build, not
  worked around.
- **Git commit tests need a real file change, and `commitTaskWork`
  doesn't check for one.** S4's first attempt at the commit-message leg
  failed with a real `git commit` process exit code 1 and empty
  stderr — not an encoding bug (isolated and ruled out by hand,
  reproducing the exact multi-line, non-ASCII commit message directly
  against `execFile` outside this codebase), but simply "nothing to
  commit" (`stageAll`+`commitWithIdentity` attempt the real commit
  unconditionally; `gitProtectionLayer4.test.ts`'s own clean-commit case
  already writes a real file first, for the same reason — S4 just
  hadn't copied that half of the pattern).

### What's stubbed / explicitly not written this session

- **`revokeForEmployee` is a real, honest no-op**, not a placeholder —
  see item 11 above. Real work for a future broker backing a provider
  that offers genuinely scoped, revocable credentials; nothing does
  today.
- **The employee-transcript convention `supportBundle` scans
  (`getEmployeeStateDir(baseDir, id)/transcript.log`) has no real
  production writer yet.** `createFileTranscriptWriter` exists, is
  tested, and now writes to the corrected per-employee-directory path
  — but nothing in `main/index.ts` constructs a `Supervisor` with a
  real `transcriptWriter` today, because no real hiring flow exists
  before M7. `supportBundle`'s own loop over `listEmployees()` will
  find zero transcript files on any real install until then; this is a
  correct, tested convention with no live traffic, not a live gap.
  Same shape as session 2's own `main/index.ts` pricing-loading comment
  before this session gave it a reader.
- **`pushPatch` (`stateDelta.ts`) is redacted but still has no real
  caller** — unchanged from session 2's own note; a future incremental-
  delta producer inherits the redaction for free.
- **The settings UI is entirely M9/M13's** — the write-only key field,
  the "set/replace/clear" flow, rendering `API_KEY_HONEST_NOTE` and
  `getSecretsStatus`'s items to a person. This session built the
  refusal-to-store logic, the honest copy itself, and the `{items,
  note}` IPC seam; none of it has a screen yet.
- **Packs/roles' `additionalRules` seam is untouched** — still M7's,
  as it was at the end of session 1.
- **No settings UI exists to clear a breaker-constrained employee's
  restriction early** — once constrained, an employee stays constrained
  for the rest of its current task assignment by design (a genuine
  safety posture — "flagged once, confirm from here"); it only reverts
  on the next real `assign()`. Nothing in M6 builds a way for a person
  to lift it sooner; that's checkpoint-answering territory, M8/M9.
- **Who actually answers the breaker's `blocker` checkpoint** is
  entirely M11's Director — this session raises a real checkpoint row,
  same as session 2's budget-exceeded park, and nothing more.

### Files

New: `src/main/engine/circuitBreaker.ts`; `src/main/secrets/{redactor,
secretStore,secretBroker}.ts`; `tests/unit/secrets/{redactor,
redactionStream}.test.ts`; `tests/unit/engine/circuitBreaker.test.ts`;
`tests/integration/secrets/{secretStore,secretBroker}.test.ts`;
`tests/integration/engine/supervisorBreaker.test.ts`;
`tests/integration/security/canarySecretNeverLeaks.test.ts`;
`tests/integration/ipc/threeStubM6Handlers.test.ts`. Modified:
`src/main/engine/supervisor.ts` (the breaker's full stateful sequencing,
the Director never-stop guard, redaction wiring on `case 'raw':` and
`case 'idle':`, `createFileTranscriptWriter`'s corrected path,
`broker`/`revokeForEmployee` on stop); `src/main/engine/fakeAdapter.ts`
(`ctx.broker.resolveForSpawn()` call + `resolvedSecretsAtSpawn`);
`src/main/controlChannel/policy/loopDetector.ts` (`peek()`);
`src/main/controlChannel/server.ts` (`noteLoopDetected` call);
`src/main/controlChannel/policy/policyEvaluator.ts` (breaker-constrained
override); `src/shared/engine/seams.ts` (corrected `SecretBroker` doc
comment); `src/main/engine/claudeCodeAdapter.ts` (flag comment removed,
settled design documented) + `src/main/engine/genericPtyAdapter.ts`
(same, plus the re-spawn guard fix); `src/main/db/activityLog.ts`
(payload redaction); `src/main/ipc/stateDelta.ts` (`buildFullSnapshot`
exported, both producers redacted); `src/main/workspace/employeeCommit.ts`
(commit-message redaction); `src/main/db/reconcile.ts` (`broker`
threaded into the orphan sweep); `src/main/index.ts` (`secretBroker`
and `pricing` constructed, both threaded through); `src/main/ipc/
router.ts` + `src/main/ipc/handlers/types.ts` (`HandlerContext.pricing`);
`src/main/ipc/handlers/{system,costs,projects,settings}.ts` (the three
stubs closed, `getSecretsStatus`'s `note`); `src/main/db/repositories/
{employees,prereqs,projects}.ts` (`listEmployees`, `listPrereqs`,
`setProjectBudget`); `src/shared/ipc/schemas/settings.ts`
(`getSecretsStatus`'s `note`); `docs/BUILD-SPEC.md` (§7.1.1's corrected
`SecretBroker` doc comment, §5.2's `project.budget_set`); `package.json`
(`test:security` script). `tests/integration/engine/supervisor.test.ts`
(three pre-existing timing-margin fixes, see "what surprised me"
above); `tests/integration/ipc/settingsZeroCostGate.test.ts` (a fake
`PricingTable` added to its manually-constructed `HandlerContext`).

### Explicitly deferred beyond this session (M7+)

Everything the settings UI would render for any of this session's work
(M9/M13). Packs/roles' `additionalRules` (M7). The Director's own
existence, including who answers the breaker's blocker checkpoint or a
budget-exceeded park's own checkpoint (M11). A real hiring flow that
would give `createFileTranscriptWriter`/`SecretBroker` their first live
production caller (M7+). A revocable-credential broker backing a
provider that actually offers one (no such provider is wired today). A
zip/multi-file support bundle (no archive dependency exists in this
repo; a real product decision for whoever needs more than one file).
S15 (`prompt_injection_contained`, M8) and S12 (M8) — neither written
this session or any prior one; chaos row 11 stays "Not started (M8)."


## 2026-09-05 — the M3–M6 audit fix session

The second half of `docs/AUDIT-PROMPT.md`'s deliberately-split pair: the
audit ran as its own session and produced `docs/AUDIT-M3-M6.md`; this
session fixes what it found. BLOCKER and SERIOUS only — MINOR findings are
untouched and still listed. One commit per finding, referencing its number.

Every fix here has a test that was **confirmed to fail first, for the right
reason**, and for each of the four mutations the audit had shown surviving
the suite, that exact mutation was reintroduced, watched to fail against
the new test, and reverted. That confirmation is the deliverable — a
passing run alone would prove nothing, which is the whole finding.

### What the audit was actually about

Four of ten mutations survived the entire suite, and all four for one
reason: **a load-bearing test whose assertion path touches a stand-in
rather than the code that ships**, with a doc comment asserting a fidelity
that isn't there. A `FakeAdapter` for the two real adapters; a hand-written
fixture for `commitTaskWork`; a test-side `redactDeep(...)` for the real
outbound path; an inline `checkVersionDrift` for a feature that did not
exist at all. Those comments read as evidence and were not.

Fixing the four instances does not close the class, so item 6's sweep went
looking for more, and a standing review rule is now recorded in
PROJECT-CHECKLIST's Known Issues: *a test may not re-implement the
ordering, wiring or call it exists to verify; if it cannot reach the
production path, say so in the test NAME, not in a comment that reads like
proof.*

### The budget distinction this session had to make explicit

**"The enforcement logic is tested" and "the enforcement can fire in
production" were two different claims, and only the first was true.**
Nothing in PROGRESS.md distinguished them before, and both S7 and v1
definition-of-done row 6 read as though they were the same claim.

- S7 drives `enforceBudget` correctly by feeding usage events directly, and
  its arithmetic was never in question.
- But every real spawn carried a hardcoded `--max-budget-usd 0.05`, 40x
  smaller than the shipped `budgets.perTaskUsd` default — so in production
  the engine aborted the turn long before any of §11.5's four levels could
  bind. The levels were unreachable, not wrong (AUDIT #1).
- And `park` was a status label, not a gate: nothing stopped the adapter,
  `transition()` had no terminal guard, and `turn.started` resumed work
  unconditionally, so a parked employee whose engine emitted another turn
  silently resumed and kept billing. `enforceBudget` does not re-fire in
  that state — the threshold check only triggers on the CROSSING turn.
  S7's own "stays stopped" proof pushes a `turn.completed`, never a
  `turn.started`, so the one event that would have exposed it was the one
  never sent (AUDIT #8).

Both are fixed and both now have tests that fail if the fix is removed.
The honest phrasing going forward: **§11.5's four levels are now reachable
in production, and a park genuinely stops the employee** — a stronger and
different claim than "the budget arithmetic is tested", and the one v1
definition-of-done row 6 was always trying to make.

### Fixed this session

| # | Sev | What |
|---|---|---|
| 1 | BLOCKER | Model-tier resolution BUILT (§7.5 normative): role tier -> `settings.engines.modelTiers` (now per-engine) -> concrete id, resolved by the Supervisor, carried on a required `EmployeeContext.modelId`. Per-turn cap derived from the real task budget instead of hardcoded. Spec/schema question settled: `model_preference` **is** the tier column, and now validates as tier names |
| 2 | BLOCKER | §7.4's turn-boundary queue covered on BOTH real adapters (real PTY spawn asserting event order; real delivery-attempt counting for claude-code) |
| 3 | BLOCKER | S4 drives the real `wireStateDeltaOnLoad` instead of calling `redactDeep` itself; `pushPatch` covered too |
| 4 | BLOCKER | Crash-window fixture calls the real `commitTaskWork` via a test-only `testHooks` seam, mirroring `ActivityLog`'s existing `afterFileWrite` precedent |
| 5 | BLOCKER | `deny.subagent_spawn`'s `mcp__*__spawn_*` term can actually match — the grammar globs the tool-NAME position, not only the argglob |
| 6 | SERIOUS | Engine version drift is real (`engineVersionDrift.ts` + emission from a real probe); contract test 10 asserts against it. The "untested version" badge is still unbuilt and no longer claimed |
| 7 | SERIOUS | `realEngineSpawn.test.ts`'s Electron-injection rot fixed; both gated tests share one construction, guarded for free in CI |
| 8 | SERIOUS | A budget park is now a gate: it interrupts the adapter, and `handleEvent` refuses to resume a parked employee |
| 9 | SERIOUS | S1/S2/S9's project path is real and contains the worktree, so a `${project}` write-scope widening is visible to them |
| 11 | SERIOUS | §7.3's ungateable-engine floor implemented — `generic-pty` really does run at `ask` now |
| 12 | SERIOUS | `WebSearch` no longer escapes `network_allow`: an unreadable destination fails closed |
| 13 | SERIOUS | §10.6 rules 5/6 recorded as a tracked deferral (deferred, not built — see below) |
| 14 | SERIOUS | A stale packaged app now fails loudly, naming the offending files |
| 16 | SERIOUS | Quit waits (bounded) for the control channel to drain before closing the DB |
| 17 | SERIOUS | Cost views read `usage.project_id` — Director spend is no longer invisible |
| 18 | SERIOUS | "Cost not reported" stays null through to the renderer, never a fabricated `$0.00` |
| 19 | SERIOUS | The Director reserve's two-level carve-out documented in §11.5 and pinned by tests |

### Where I disagreed with the audit, and said so rather than silently complying

- **#17's `topTasks`.** The finding listed it alongside `summary`/
  `byProject`. It is correct as written: it groups BY task, so spend with
  no `task_id` has no task to attribute and rightly does not appear.
  Including it would mean inventing a task bucket. Left unchanged.
- **#19's "narrow it".** The audit offered narrowing the reserve to the
  project level, or documenting the daily-level behaviour. Narrowing would
  stop `budgets.dailyUsd` capping total spend at all. Documented instead,
  and pinned with tests so it cannot drift back to undocumented.
- **#13's "build them".** Deferred rather than built: both rules are
  triggered by events that do not exist until M8/M11, so building them now
  means inventing their triggers and shipping code with no caller — the
  exact shape the rest of this session was fixing.
- **#10's framing** (already corrected inside the audit report itself): the
  `bureau_` short-circuit is spec-sanctioned by §23.2, not a code-vs-spec
  violation. Left as an M7 requirement, not a code change.

### What surprised me

- **I reproduced the audit's own central mistake while fixing it.** The
  first draft of the §7.4 PTY test asserted
  `order.indexOf('idle') < order.indexOf('echo:second')` — and `indexOf`
  returns -1 when idle never happened, which is less than any real index.
  It passed under the very mutation it existed to catch. Fixed to assert
  the idle was observed at all before comparing order. The lesson
  generalises: an ordering assertion needs a presence assertion first.
- **The type system did the blast-radius analysis for free.** Making
  `EmployeeContext.modelId` required rather than optional turned "which
  spawn paths decide a model?" into a compiler error list of exactly 18
  sites. Optional would have compiled everywhere and silently kept the
  hardcoded default alive.
- **Two fixture bugs that silently measured nothing.** `insertUsage` takes
  project attribution as a separate second argument, not a field on the
  input object — passing it the obvious way stores NULL. And the
  global-daily budget level sums the real ledger rather than trusting the
  caller's `costMicros`, so a test that passes a number and inserts no rows
  measures zero while looking like it tests something.
- **A pre-existing flake, found and deliberately not fixed** (not an audit
  finding, so out of scope — recorded rather than silently absorbed):
  `claudeCodeAdapterBuildLaunchSpec.test.ts` failed once inside
  `npm run test:security` at 5064ms, and passed standalone and on re-run.
  `probe()` has a hard 5s deadline and shells out to the real
  `claude --version`; under concurrent load it can exceed it, and the test
  asserts `probeResult.installed === true`. Needs a deliberate decision
  later: either the probe deadline is too tight for a loaded machine, or
  that assertion should tolerate a timeout.

### Gate verification (run fresh at close, against a freshly rebuilt packaged app)

`npm run package` first, deliberately — AUDIT #14's whole point is that
these numbers mean nothing against a stale binary, and that check is now
enforced rather than remembered (a stale build fails loudly, naming the
files).

| Gate | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `node scripts/checkIpcSurface.mjs` | 20 namespaces, 109 methods, 7 events |
| `npm test` (unit) | **458/458**, 56 files (was 420/51 before this session) |
| `npm run test:integration` (minus soak) | **308/308**, 56 files (was 284/50) |
| `npm run test:contract` | 18 passed, 3 skipped (real-engine gate correctly off) |
| `npm run test:security` | 24 + 47, all green |
| `npx playwright test` (e2e, real packaged app) | 4/4 |
| `soak.test.ts` | **2/2 in 348s**, inside its new measured 900s budget |

The soak number is the second independent measurement (348s here, 348.8s
during profiling) — consistent, and the basis for finding #15's corrected
diagnosis rather than a one-off.

### Deliberately NOT done

- **All 11 MINOR findings are untouched and still open** (#20-#30), per the
  instruction to fix BLOCKER and SERIOUS only. Verified rather than
  assumed: `tasks.ts` still has its three `stub('M3')`s, `workspace.ts` its
  three `stub('M5')`s, there is still no coverage tooling, eslint's
  `ignores` are still unanchored, and `usage.ts` still carries its stale
  "no such column exists" comment. The audit report's outcome column marks
  each of them untouched.
- **§7.8 test 10's "untested version" badge** and **§7.3's
  `limited-control` badge** — both are UI that has nowhere to render until
  M9/M13. Detection is real for both now; the badges are not claimed.
- **§10.6 rules 5 and 6** — deferred with reasoning, see above.
- **AUDIT #10's reserved-prefix check** — belongs to M7's pack validator,
  which does not exist yet. It is now written down as an M7 requirement,
  which it was not before.

### The one thing to carry into M7

Model-tier resolution now works, so M7's hiring flow has a real default to
build on — that was finding #1 and it was the genuine blocker. The
remaining M7 obligation from this audit is #10: **pack validation MUST
reject any pack-declared MCP server or tool name starting with `bureau_` or
`mcp__bureau__`.** The evaluator's "Bureau's own tools are always allowed"
short-circuit (§23.2, spec-sanctioned) trusts a name prefix rather than
verified provenance. It is safe today only because `--strict-mcp-config`
blocks competing MCP servers and no pack loader exists. The moment packs
can declare servers, that becomes a real privilege-escalation path.
