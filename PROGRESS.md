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

