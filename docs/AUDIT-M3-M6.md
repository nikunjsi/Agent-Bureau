# M3–M6 phase-boundary audit

> **Title line repaired 2026-09-09 (M10).** From `e0134f9` (2026-09-05)
> until this commit, line 1 of this file was not the title: a botched
> column-wide edit had written a *draft of the whole Outcome column* over
> it, leaving the real heading stranded at the end of a 3 KB line. The table
> itself was never damaged — every row kept its own outcome — so nothing
> read from this report was wrong, and it survived five commits because
> nobody reads line 1 of a file they open with `grep`.
>
> It had one real casualty, now put back where it belongs: M9 session 2's
> strengthening note on finding **#19** was appended to the corrupted line
> instead of to row 19, so for a day that row's *"pinned by tests"* read
> stronger than the tests supported — the exact failure mode standing rule 8
> exists to prevent, arriving by a route the rule does not cover.

**Run:** 2026-09-02 → 2026-09-05, against `e170ad5` (`main`), before M7 starts.
**Method:** `docs/AUDIT-PROMPT.md`'s five phases. Phases 1 and 3 were run by
independent subagents with no visibility into this project's build
conversations, reading only `docs/BUILD-SPEC.md` and the code — `PROGRESS.md`,
`HOW-IT-WORKS.md`, `PROJECT-CHECKLIST.md` and git history were explicitly
excluded from their evidence base. Phases 2, 4 and 5 were run by the
orchestrating session directly.

**Every subagent finding rated BLOCKER or SERIOUS below was independently
re-verified by reading the cited source directly** before being included. One
Phase 1 finding was materially reframed as a result (#10) and one was softened
(#23); nothing else needed correcting.

---

## Headline

The core mechanisms are genuinely well built and genuinely tested: real
filesystem-sentinel proofs for policy denies at every autonomy level, a real
nested-`child_process` commit bypass detected and blocked, real process kills
proving fail-closed behaviour, real 429 backoff/park/resume, real
budget-crossing parks with their own sibling mutation checks. **420/420 unit,
284/284 integration and 18/18 contract tests pass against a freshly rebuilt
packaged app, and the M4 real-agent gate passes for real, today, for $0.0497
of actual spend.** That is a real result and it should be said plainly.

What the audit found is a specific, recurring structural weakness underneath
that surface, which Phase 3's mutations exposed and Phase 1's trace explains:
**several of the most load-bearing tests exercise a stand-in for the
production path rather than the production path itself** — a `FakeAdapter`
instead of the two real adapters, a hand-written fixture instead of
`commitTaskWork`, a test-side `redactDeep(...)` call instead of the real
outbound path, an inline `checkVersionDrift` instead of a feature that does
not exist at all. In every case the test's own doc comment asserts fidelity to
the real path. Those comments read as evidence and are not.

Four of ten deliberate, code-review-survivable mutations went **undetected by
the entire suite**, including one that would ship unredacted secrets to the
renderer with S4 still green.

---

## Findings

Severity per `docs/AUDIT-PROMPT.md`: **BLOCKER** = M7 would be built on
something broken · **SERIOUS** = real gap, fix before it compounds ·
**MINOR** = tidy when convenient.

Source column: **P1** = Phase 1 subagent (spec↔code trace), **P3** = Phase 3
subagent (mutation testing), **self** = orchestrating session. All BLOCKER and
SERIOUS rows were verified directly regardless of source.

**Outcome column added 2026-09-05 by the fix session** (`docs/AUDIT-PROMPT.md`
runs the audit and the fixes as two separate sessions on purpose; this report is
the record, so it is kept accurate rather than left as a snapshot). Every
BLOCKER and SERIOUS finding is resolved as fixed, deferred with a reason, or
disagreed with and left alone. Four were disagreed with in whole or in part —
#13, #17's `topTasks`, #19, and #10's original framing — and the reasoning is
in each row and in that session's PROGRESS.md entry. **MINOR findings were
deliberately not touched** by that session and remain open.

**Updated 2026-09-08 (M8 session 1): #23 is now FIXED.** It is the first MINOR
to close, and it closed because the milestone that owns the area came to it —
which is the right time for a MINOR, rather than a separate pass. The rest
remain open.

| # | Severity | Src | Area | Finding | Evidence | Suggested fix | Effort | **Outcome** |
|---|---|---|---|---|---|---|---|---|
| 1 | BLOCKER | P1 | Engine / cost | **Model-tier resolution is entirely unimplemented.** Every real spawn is hardcoded to the cheapest tier plus a $0.05-per-turn cap, "regardless of what a role or task might otherwise call for" — the code's own comment. `role.model_preference` is written at hire time and read nowhere. `settings.engines.modelTiers` is a flat map (§7.5 requires per-engine), defaulted to `{}` and never populated or read. Beyond the wrong model: §11.5's $2.00 per-task budget is presently meaningless, because the CLI is told to refuse anything past 5¢ per turn. M7 *is* roles and hiring — it would be built directly on this. | `src/main/engine/claudeCodeAdapter.ts:604-618` (`costSafetyArgs()` + its own doc comment), applied at `:636` and `:701`; `src/shared/settings/schema.ts:140`; `src/main/db/settingsLoader.ts:25-26`; zero readers of `model_preference` outside repositories | Wire `role.model_preference` → `settings.engines.modelTiers[engine][tier]` → concrete id; fix the per-engine shape; drop or scope the hardcoded cap. | M | **FIXED** (`4765667`) — tier resolution built; per-turn cap derived; spec/schema settled in §7.5 |
| 2 | BLOCKER | P3 | §7.4 turn boundary | **The turn-boundary queue can be deleted from both real adapters with a fully green suite.** Removing the `if (turnState !== 'idle') { queue; return; }` guard from `ClaudeCodeAdapter` *and* `GenericPtyAdapter` produced results byte-identical to baseline: 420/420 unit, contract pass, integration unchanged. The same mutation applied to `FakeAdapter` fails 3 tests immediately — so §7.4 is tested **only through the test double.** The one integration test whose name implies real coverage waits for a real `idle` before sending, so the queue branch is never entered. Directly violates CLAUDE.md's "do not inject a message into an agent mid-generation." | `src/main/engine/claudeCodeAdapter.ts:555-559`, `src/main/engine/genericPtyAdapter.ts:215-219`; contrast `src/main/engine/fakeAdapter.ts:176-180`; `tests/integration/engine/genericPtyAdapter.test.ts:128` | Add a real-adapter test that sends while `turnState !== 'idle'` and asserts nothing reaches the process until idle. | S | **FIXED** (`89b545e`) — both real adapters covered; mutation reintroduced and caught |
| 3 | BLOCKER | P3 | §11.4 / S4 | **S4 does not actually cover the state-delta outbound path — it re-implements it.** Deleting `redactDeep` from `wireStateDeltaOnLoad` (the only production caller) leaves S4 `canary_secret_never_leaks` **green**, along with the whole suite. S4 imports `buildFullSnapshot` and calls `redactDeep` *itself* rather than exercising the real path; `wireStateDeltaOnLoad` is invoked by no test in any of the three suites. Shipped, this sends every checkpoint `context`, task `result_summary` and employee `status_detail` to the renderer unredacted on every window load — with a release-blocking security test still passing. | `src/main/ipc/stateDelta.ts:74` (mutated); `tests/integration/security/canarySecretNeverLeaks.test.ts:210` — `JSON.stringify(redactDeep(buildFullSnapshot(db)))`; `grep -rn wireStateDeltaOnLoad tests/` → only a prose mention in an e2e comment (all verified directly) | S4 must call the real outbound path for all six legs, not reproduce the redaction call. | S | **FIXED** (`d2726e7`) — S4 drives the real path; mutation reintroduced and caught |
| 4 | BLOCKER | P3 | §10.3.1 / invariant #3 | **The intent-marker ordering has no test enforcing it.** Moving the `pending_commit_task_id` write to *after* the `git commit` — the exact bug plan review caught before it was written — leaves the full suite green, including both crash-window tests. Reason: `commitKillWorker.ts` never calls `commitTaskWork`; it hand-writes the same calls in its own order, so the ordering under test is the fixture's, not production's. The end-state assertions pass either way because step 6's atomic UPDATE clears the marker regardless. Plan review caught this; **the tests would not have.** | `src/main/workspace/employeeCommit.ts:194-201` (mutated); `tests/integration/fixtures/commitKillWorker.ts:111,119-123` — imports and calls `setWorktreePendingCommitTask`/`stageAll`/`commitWithIdentity` directly, never `commitTaskWork` (verified directly) | Drive the crash-window worker through the real `commitTaskWork` with an injected kill hook, so ordering is observed, not restated. | M | **FIXED** (`5b3782a`) — fixture calls the real `commitTaskWork`; mutation reintroduced and caught |
| 5 | BLOCKER | P1 | §11.3 policy | **One of the seven immutable global denies can never match.** `deny.subagent_spawn`'s `mcp__*__spawn_*` term is compared by exact string equality — the pattern grammar supports globbing only in the argglob, never the tool-name position (only the reserved single `'*'` token). It cannot match `mcp__foo__spawn_worker`. The one test touching it locks in the broken parse as *expected*; nothing tests the match. Mitigated today only incidentally, by unmatched tools falling to the `other` class default-deny — not a designed defence, and it breaks if any adapter ever classes such a name as `command`. | `src/shared/policy/patternGrammar.ts:118-119,140-141`; `src/shared/policy/immutableRules.ts:91`; `tests/unit/policy/patternGrammar.test.ts:38-43` (verified directly) | Support globs in the tool-name position (or express the rule as a condition), plus a test feeding a realistic MCP-shaped name through `evaluate()`. | S–M | **FIXED** (`cf090fc`) — tool-name globbing; realistic MCP names tested |
| 6 | SERIOUS | P1 | §7.8 test integrity | **Contract test 10 asserts against a function defined inside itself.** `checkVersionDrift` is declared inline in the `it()` body; the feature it claims to cover — `employee.engine_version_drift` plus an "untested version" badge — exists nowhere in `src/`. The test would pass forever whether or not the feature was ever built, and it counts toward "contract suite green." | `tests/contract/adapterContract.test.ts:208-217` (verified directly); no `employee.engine_version_drift` emitter anywhere in `src/` | Build the feature and test it for real, or mark the test `.todo()` naming the gap. | S | **FIXED** (`60841b5`) — detector + emission built and tested. Badge half **DEFERRED to M14**, re-pointed at M10 (2026-09-09): the old "M9/M13" was guessed before anyone knew what M9 contained, and M9 has now passed without touching it. An "untested version" badge is per-employee state, so it belongs to §14.5's Inspector (M14) or §13.4's floor (M12) — never to chat. Re-pointed rather than left to become a stale row, per standing rule 8. Not claimed in risk row 15 |
| 7 | SERIOUS | self | M3 gate | **`realEngineSpawn.test.ts` throws for real when actually run** — `TypeError: Cannot read properties of undefined (reading 'isPackaged')`. It constructs `new ClaudeCodeAdapter()` with no override, so the default resolver reads Electron's `app`, undefined under plain-Node vitest. `realAgentGate.test.ts` injects the override and works. Silently broken since M4 introduced `resourceScripts.ts`; invisible because the file is opt-in behind real spend, so nobody re-ran it. Found by actually running it this session. | Ran live: `BUREAU_RUN_REAL_ENGINE_TESTS=1 vitest run tests/contract/realEngineSpawn.test.ts` → 1 failed; `tests/contract/realEngineSpawn.test.ts:134` vs `realAgentGate.test.ts:169-171`; `src/main/engine/resourceScripts.ts:25` | Apply the injection pattern `realAgentGate.test.ts` already uses. | XS | **FIXED** (`5c60bfe`) — shared construction + a free CI wiring guard |
| 8 | SERIOUS | P3 + self | §11.5 budgets | **A budget "park" is a status label, not a gate.** For the default `budgets.onExceed: park`, `applyBudgetVerdict` only calls `transition('parked')` — it never stops or interrupts the adapter. `transition()` has no terminal-state guard (`if (this.state === next) return` only), and `case 'turn.started'` transitions to `'working'` unconditionally, so a parked employee that receives another `turn.started` silently resumes and keeps spending; `enforceBudget` won't re-fire, since the threshold check only triggers on the crossing turn. Nothing drives further turns *today* (no Director yet), so this is latent — but it directly under-writes PROJECT-CHECKLIST.md's v1 row 6, "Budgets and circuit breaker provably stop a runaway employee ✅ Done." S7's "stays stopped" proof pushes a `turn.completed`, never a `turn.started`. | `src/main/engine/supervisor.ts:698-724` (`applyBudgetVerdict`), `:511-517` (`turn.started`), `:1251-1253` (`transition`); `src/main/cost/budgetCheck.ts` crossing-only semantics (all verified directly) | Add an explicit terminal-state gate: refuse `turn.started`→`working` while parked/stopped, and have park interrupt the adapter. | M | **FIXED** (`42c55b3`) — park interrupts and gates; billing stops. **Corrected 2026-09-17 (M3–M6 regression check):** the gate holds, but "billing stops" is true of the ledger, not of the spend. `handleEvent` drops *every* event while parked, `turn.completed`'s usage included, and claude-code cannot be interrupted (`interrupt: false`). So a turn in flight at a park or a user pause finishes, costs money, and is never recorded. `parkedIsAGate.test.ts` asserts that omission as its success condition. See `docs/AUDIT-M3-M6-REGRESSION.md` N-1 |
| 9 | SERIOUS | P3 | §11.3 write scope | **The write-scope widening is caught by exactly one unit assertion; the suite that looks like the real proof is blind to it.** Adding `${project}` to `deny.write_outside_worktree`'s roots — the change the rule's own comment says "silently undoes all of M5" — fails only `evaluator.test.ts`'s single "writes never see ${project}" case. Full integration is unchanged and `test:security` is fully green, because `policyRealEvaluator.test.ts` (S1/S2/S9) leaves the project path at a fake default while the "outside" target is a real temp dir, so a widened `${project}` root can never contain it. | `src/shared/policy/immutableRules.ts:18` (mutated); `tests/unit/policy/evaluator.test.ts`; `tests/integration/controlChannel/policyRealEvaluator.test.ts` (`seedEmployeeWithWorktree` fixture paths) | Point the S1/S2/S9 fixtures' project path at a real directory that actually contains the outside-write target. | S | **FIXED** (`60841b5`) — S1/S2/S9 fixture made real; the widening is now visible to them |
| 10 | SERIOUS | P1, reframed | §11.3 / §23.2 | **The `bureau_`/`mcp__bureau__` short-circuit bypasses all seven immutable denies on a string-prefix match.** Confirmed in code — but this is **spec-sanctioned**, not a hidden bug: §23.2/§23.4 define a "Bureau" tool class that is "always allowed." (Phase 1 reported this as a code-vs-spec violation; that framing is wrong and is corrected here.) The real issues are that CLAUDE.md's invariant list never mentions the carve-out, and that the check trusts a *name prefix* rather than verified provenance. Safe today only because `--strict-mcp-config` blocks competing MCP servers and no pack loader exists. **The moment M7 loads packs, pack validation must reject these reserved prefixes** — nothing records that as an M7 requirement anywhere. | `src/shared/policy/evaluator.ts:26-28,72-75`; `docs/BUILD-SPEC.md:1922` (§23.2), `:2991-3031` (§23.4); `src/main/engine/claudeCodeAdapter.ts:496-499` | Document the carve-out in CLAUDE.md; make reserved-prefix rejection a tested M7 pack-validator requirement. | S — must land *with* M7 | **SPLIT — both halves now closed.** (1) **Reserved-prefix check: FIXED at M7** (`src/main/packs/validatePack.ts:196`), logged in BUILD-SPEC §0.1 as *2026-09-06, §6.7, AUDIT #10*. This outcome column said "DEFERRED to M7" for three milestones after that landed — the fourth stale row of the kind standing rule 8 exists for. (2) **Documentation: FIXED at M10** (2026-09-09). The carve-out is now stated beside invariant #5 in both `CLAUDE.md` and §21, naming what it covers and what enforces the boundary instead: *for a `bureau_` tool, policy is not the guard — the handler is.* M10 built the first Bureau tool that writes files, so the consequence is now load-bearing rather than theoretical: `src/main/memory/memoryTarget.ts` canonicalises and confines every memory write inside the Core-side path, proven at the handler by S2 in `tests/integration/memory/memoryWriteConfinement.test.ts` (mutation-confirmed) — not by a policy test for a scan that never runs. The *provenance* half (the check trusts a name prefix) remains as originally assessed: mitigated by `--strict-mcp-config` and now by the M7 prefix rejection |
| 11 | SERIOUS | P1 | §7.3 autonomy | **§7.3's effective-autonomy rule is not implemented at all.** The normative rule (no `hookInterception` **and** no `permissionCallback` ⇒ force `ask`) appears nowhere; only the separate unconfirmed-`autonomous` downgrade exists. So `generic-pty` employees — both flags false — are **not** forced to `ask`, contradicting §7.7's and §7.12's own claims that they run at `ask` by default. | `src/shared/policy/autonomy.ts:29-36`; zero consumers of `permissionCallback`/`hookInterception` outside adapters/types; `src/main/engine/genericPtyAdapter.ts:148-149` | Implement the rule as an input to `computeEffectiveAutonomy`; add the `limited-control` signal it drives. | S–M | **FIXED** (`cb14434`) — §7.3 floor implemented and wired. `limited-control` badge still unbuilt, **re-pointed from "M9/M13" to M14** at M10 (2026-09-09) for the same reason as row 6: it is a per-employee badge, so §14.5's Inspector owns it (§13.4's floor at M12 is the other candidate); M9 was chat, and it has passed. Re-pointed rather than left to become a stale row — standing rule 8 |
| 12 | SERIOUS | P1 | §11.2 network | **`WebSearch` escapes the `network_allow` gate.** It is declared a network tool but carries no `url`, so the extracted domain is `null`, `domain_matches` returns false regardless of `negate`, the synthesized deny never fires, and evaluation falls through to the autonomy default — **allowed** at `guided` (the shipped default) and `autonomous`, even with `network_allow: []`. Reproduced by the Phase 1 pass against the real modules. | `src/main/engine/claudeCodeAdapter.ts:54,58`; `src/main/controlChannel/policy/argExtraction.ts:92-103`; `src/shared/policy/conditions.ts:60` | Extract a synthetic domain for `WebSearch`, or deny it outright under a restrictive `network_allow`. | S | **FIXED** (`79aabe0`) — fail-closed on an unreadable destination; one prior test deliberately reversed |
| 13 | SERIOUS | P1 | §10.6 git workflow | **Rules 5 and 6 are entirely absent** — nothing ever merges the integration branch into `base_ref` on phase acceptance, and there is no push path or `git.pushed` event anywhere. `base_ref` is only ever read. Possibly deliberate sequencing (phase acceptance is arguably M8/M11), but unlike this project's other honest gaps, neither living-status doc records it as deferred. | `src/main/workspace/**` — `base_ref` read-only in 2 files, zero push code | Build them, or add an explicit tracked-deferral line to PROJECT-CHECKLIST.md. | M (build) / XS (document) | **DISAGREED → DEFERRED** (`cda0c04`) — not built: both rules are triggered by M8/M11 events that do not exist. Now explicitly tracked in §10.6 and PROJECT-CHECKLIST instead of silent. **Re-checked 2026-09-17 (M3–M6 regression check): still entirely absent, and the deferral's reason expires at M11**, which builds phase acceptance, the trigger for rule 5. Separately, BUILD-SPEC §10.6's *"nothing in Bureau ever … pushes to a remote"* holds for the Core only: `deny.git_write` does not match a bare `git push` or `git -C . push …` (regression-check N-9) |
| 14 | SERIOUS | self | Process | **Nothing ties "gate green" to "the packaged binary was fresh."** Every integration/e2e test exercises only the packaged app, never dev mode. CI always rebuilds, so CI is fine — but a *local* re-verification session (this project's recurring habit) can silently validate stale code. Caught live this session: the packaged app predated 28 source files, including `policyEvaluator.ts`, `circuitBreaker.ts`, `redactor.ts`, `secretBroker.ts`, `employeeCommit.ts`. Rebuilt and re-ran before trusting anything. | Self-discovered; `tests/helpers/packagedApp.ts:14-20` ("never dev mode"); `.github/workflows/ci.yml` | Pretest rebuild hook, or a build-hash stamp checked at test startup that fails loudly when stale. | S | **FIXED** (`5c60bfe`) — staleness gate throws, naming the offending files |
| 15 | SERIOUS | self | Test reliability / M15 | **`soak.test.ts` is genuinely too slow for its own timeout — third consecutive session, standalone, non-flaky.** Timed out at exactly 480000ms this session. Its `chaos row 13` sibling — same commit/retry mechanism, one cycle — passed in 5.3s with real recovery in 1378ms, so the mechanism is correct and only the wall-clock budget is wrong. It is consistently a *timeout*, never an assertion failure. **M15 inherits this exact test as its 100-task soak gate.** | Ran standalone this session: `Error: Test timed out in 480000ms` at 483286ms; PROJECT-CHECKLIST.md's own Known-issues row records the same in M6 sessions 2 and 3 | Raise the timeout backed by a real profiling run (all that has backed it so far is code inspection), or cut real git spawns per cycle. | M | **FIXED, and the finding's own conclusion CORRECTED** — profiled for real: the soak completes in 348,776ms and PASSES inside the old 480s limit. It is not inherently too slow; the three timeouts were a ~27% margin eaten by concurrent load (this audit's own run had a subagent working alongside it). Timeout raised to 900s on that measurement |
| 16 | SERIOUS | self | Shutdown / invariant #3 | **Quit doesn't wait for the control channel to drain before closing the DB.** `before-quit` calls `void controlChannelServer.stop()` (promise discarded) then synchronously closes `activityLog`/`db`. `stop()` does synchronously deny held policy checks (good), but `httpServer.close()` — which drains in-flight *non-held* requests, e.g. a DB-writing tool handler — sits inside the discarded promise. The comment above it says to revisit "once M4 session 2's bureau-hook/bureau-tools are real processes"; they now are, and it wasn't. | `src/main/index.ts:123-134`; `src/main/controlChannel/server.ts:112-127` | Await `stop()` with a bounded timeout before closing the DB and log. | S | **FIXED** (`5350413`) — bounded drain awaited; verified against the real packaged app + e2e |
| 17 | SERIOUS | P1 | Cost UI | **Three cost views use the join migration `0005` exists to prevent.** `summary`, `byProject` and `topTasks` join `usage → tasks → projects`, the exact path `0005_usage_computed_cost.sql` says would "silently miss Director-attributed spend" (which has no `task_id`). `reconcile.ts` gets this right; the handlers don't. | `src/main/ipc/handlers/costs.ts:34-36,60-66,88-95`; `src/main/db/migrations/0005_usage_computed_cost.sql`; contrast `src/main/db/reconcile.ts:310-315` | Join on `usage.project_id` directly, as `reconcile.ts` does. | S | **FIXED** (`bad3eaa`) — `summary`/`byProject` corrected. **DISAGREED** on `topTasks`: it groups BY task, so task-less spend rightly has no bucket; left unchanged |
| 18 | SERIOUS | P1 + self | Cost UI | **Direct violation of a CLAUDE.md-named anti-pattern**: "do not show `$0.00` for an engine that does not report usage — show 'cost not reported'." All five cost views `COALESCE(SUM(u.cost_usd_micros), 0)`, so an engine that never reports cost renders as exactly `$0.00`. The data layer gets this right (`insertUsage` and `getUsageSummaryForTask` both preserve `NULL` deliberately, with tests); the violation is entirely in the read queries. | `src/main/ipc/handlers/costs.ts:38,43,50,61,71,81,92` (verified directly) | Distinguish "zero cost" from "no cost data" in each query and render the latter honestly. | S | **FIXED** (`9c11cb8`) — bare `SUM()`; null carried through the IPC schema |
| 19 | SERIOUS | P1 | Budgets | **Undocumented widening of `budgets.directorReserveUsd`.** It is subtracted from **both** `projectUsd` and `dailyUsd` for every non-Director employee — the code's own comment concedes this is "a bigger change to what the setting means than the anti-deadlock rule justifies (§8.0 only describes the project-level interaction)." `dailyUsd = $20.00` actually caps employees at $18.00, with no spec text saying so. | `src/main/cost/budgetEnforcement.ts:46-55` (comment) and the subtraction at `:143-145` | Narrow to project level, or document the daily-level behaviour in §11.5. | S | **DISAGREED → DOCUMENTED** (`8b83ead`) — behaviour judged correct (narrowing would stop `dailyUsd` capping total spend); §11.5 now states the two-level carve-out, pinned by tests. **Strengthened 2026-09-09 (M9 session 2), state unchanged** — restored to this row at M10, having landed on the corrupted title line instead: those tests passed `isDirector` in as a boolean, so they proved the arithmetic and said nothing about whether anything ever passed `true` — and until that session nothing could, because `hireEmployee` hardcoded `is_director: false`. The carve-out is now demonstrated firing against a Director hired through the production path (`tests/integration/cost/directorReserveLive.test.ts`), both sides of the branch, mutation-confirmed. Recorded because this row's "pinned by tests" read stronger than it was. **Narrowed again 2026-09-17 (M3–M6 regression check):** code and §11.5 still agree, but every Director-side test, unit and live, exercises `globalDaily` only. The project-level carve-out is proven for non-Directors alone (regression-check N-5) |
| 20 | MINOR | P3 | §10.3 leases | Lease exclusivity is defended by a **white-box SQL-string spy only**. `BEGIN IMMEDIATE` → `BEGIN` fails just `singleWriterAndLocking.test.ts`'s assertion that the literal string appears once. The behavioural test (25 acquirers × 30 iterations, "exactly one wins") stays green — correctly, as its own comment predicts, since better-sqlite3 is synchronous with one write connection. A change that kept the string but lost exclusivity would pass. | `src/main/db/repositories/worktrees.ts:124`; `tests/integration/singleWriterAndLocking.test.ts` | Accept as-is (documented), or add a real multi-process contention test. | S | Untouched — MINOR, deliberately not fixed this session |
| 21 | MINOR | P3 | §11.3 priority | `IMMUTABLE_RULE_PRIORITY` 0 → 150 (behind every role rule) is **NOT CAUGHT** — zero tests reference it. Assessed as **genuinely inert**, not a hole: `evaluate()` returns on the first matching deny regardless of sort order and all seven immutable rules are denies, so priority cannot change their outcome. Residual risk is that this is unguarded — if an immutable rule were ever `ask`/`allow`, or the deny-wins short-circuit were removed, an inversion would be silent. | `src/shared/policy/immutableRules.ts:10`; `src/shared/policy/evaluator.ts:81-100` | Add a guard/test pinning immutable priority, cheap insurance against a future non-deny immutable rule. | XS | **FIXED (M7 session 1) — this row read "Untouched" for three milestones after it was true.** `validatePack`'s check 5 runs the real `buildRuleSet({ roleRules })`, so the tier floor and the id-collision rule are on the install path; the M7 session found it by mutation (inverting `IMMUTABLE_RULE_PRIORITY` 0 → 150 left S3 green because the install path never reached `validateRuleSet`) and its own comment records exactly that — *"a guard nothing on the real path calls is not a guard"* (standing rule 2, earned here). Corrected 2026-09-09 by M9 session 1, which is also where the close-out rule making this someone's job comes from (PROJECT-CHECKLIST §7 rule 8). |
| 22 | MINOR | self | Process | M3 and M5 each left **3 of their own `stub('M<n>')`-tagged handlers** unimplemented while declared "✅ Done" (`tasks.cancel/retry/reassign`; `workspace.diffForTask/diffForEmployee/fileTree`). M4 and M6 have zero — M6's close-out explicitly names closing its three. Neither living-status doc mentions the M3/M5 leftovers. | `src/main/ipc/handlers/tasks.ts:26-28`, `workspace.ts:5-7`; zero hits for these names in PROGRESS.md / PROJECT-CHECKLIST.md | Implement or re-tag; add a `grep stub('M<n>')` check to milestone close-out. | S | Untouched — MINOR, deliberately not fixed in the audit session. **Re-pointed at M14 (2026-09-09, M10)**, documentation only: all six are per-task/per-employee detail views (`tasks.cancel/retry/reassign`, `workspace.diffForTask/diffForEmployee/fileTree`) that §14.3's Board and §14.5's Inspector own, so M14 is where they land — not implemented here, and now named rather than left as an M3/M5 leftover nobody owns. The suggested `grep stub('M<n>')` close-out check **has** been adopted as practice since M6 and is run at every milestone close, M10 included. **Corrected 2026-09-17 (M3–M6 regression check): FIXED in code, not only re-pointed.** M0–M2 fix session 3b (`ced30f4`) re-tagged all six handlers `stub('M14')` (`src/main/ipc/handlers/tasks.ts:32-34`, `workspace.ts:8-10`) and added `tests/unit/ipc/stubMilestonesNotShipped.test.ts`, which fails for any stub naming a shipped milestone. That is the mechanical form of this row's suggested close-out check, and the fix for M0–M2 #25, this finding's repeat. The words "documentation only" above were stale from that commit on (standing rule 8) |
| 23 | MINOR | P1, softened | §11.6 events | Checkpoint rows created by the budget and breaker paths don't emit a `checkpoint.raised`-shaped event — they emit a differently-typed triggering-condition event (`employee.budget_exceeded`, etc.) instead. (Phase 1 reported this as "no event at all"; that is too strong — each state change *is* logged. The real issue is inconsistent granularity vs. `raiseCheckpoint.ts`.) A consumer filtering on `checkpoint.raised` would miss these. | `src/main/cost/budgetEnforcement.ts:120-137,180-186`; `src/main/db/repositories/checkpoints.ts:6` (pure DB write, no built-in event) | Emit `checkpoint.raised` uniformly, or centralize it inside `insertCheckpoint`. | S | **FIXED (M8 session 1, 2026-09-08)** — the second option taken. `insertCheckpoint` now takes `activityLog` as a **required** parameter and emits `checkpoint.raised` itself, so no creation path can write a row silently; all five existing callers were updated. The first option was rejected on the finding's own logic: four more emit call sites is four more a sixth path can forget to copy, which is exactly how this arose. Pinned by `tests/integration/checkpoints/raisedEventCentralised.test.ts`, including a structural case that greps the real `src/` tree for any other `INSERT INTO checkpoints` — so a future bypass fails a test rather than going unnoticed. Mutation-confirmed (emit disabled → 3 failures) |
| 24 | MINOR | self | Test infra | **No coverage tooling exists anywhere** — no `@vitest/coverage-v8`/istanbul in any config. "Which branches of the evaluator / commit path / redactor / breaker are never hit" cannot be answered with data, only by reading code. Given this audit found three tests that don't reach their production path at all, that gap is not academic. | All three vitest configs + package.json | Add a coverage provider and a baseline. | S | Untouched — MINOR, deliberately not fixed this session. **Corrected 2026-09-17 (M3–M6 regression check): measured once, NOT closed.** The M0–M2 re-audit's Phase 5 (*"audit #24, open since M6, now closed"*) installed `@vitest/coverage-v8@2.1.9` with `--no-save --no-package-lock` and recorded one baseline. The provider is still in the local `node_modules` from that install, but it is in no `package.json` dependency, no vitest config, no npm script and no CI workflow. A fresh clone has no coverage tooling, which is this finding exactly. "Now closed" was true of the question "can coverage be measured?" and not of the finding. Still open; verdict **FIX NOW** in `docs/AUDIT-M3-M6-REGRESSION.md` Part 5 |
| 25 | MINOR | P1 | §5.2 taxonomy | 7 event types are emitted that §5.2 doesn't document (`employee.off/starting/thinking/blocked/waiting/failed/stopping`, via template expansion over `SupervisorState`); conversely `employee.ready`/`employee.restarted` are documented but unreachable. Nothing validates an emitted type against the taxonomy (`EventTypeSchema = z.string().min(1)`), so drift is silent. | `src/main/engine/supervisor.ts:1251-1263`; `src/shared/models/event.ts:8` | Sync the docs and narrow the schema to a closed enum. | S | **FIXED (M9 session 1, 2026-09-09)** — both halves, in one commit, because either alone would drift again. `src/shared/models/eventTypes.ts` holds the closed list and `EventTypeSchema` is now `z.enum(EVENT_TYPES)`, which makes `NewEventInput['type']` a **union type**: an undocumented emitter fails `npm run typecheck` rather than being caught by nothing, and that includes the `` `employee.${next}` `` template expansion, which only compiles because every `SupervisorState` is now listed. §5.2 gained the seven real `employee.*` states; `employee.ready`/`restarted` are kept and annotated as documented-but-not-yet-emitted rather than quietly deleted or left looking live. One emitter needed changing: `ControlChannelServer.logSecurityEvent(type: string)` was the one place the enum could still be sidestepped. Pinned by `tests/unit/models/eventTypes.test.ts`. |
| 26 | MINOR | P1 | Dead data | `usage.computed_cost_usd_micros` is written on every insert and read nowhere — the column's stated purpose ("a real disagreement stays a visible, queryable fact") is unfulfilled. | `src/main/db/repositories/usage.ts:66`; `src/main/engine/supervisor.ts:646`; no readers | Add the comparison it exists for, or note it as reserved. | S | Untouched — MINOR, deliberately not fixed this session |
| 27 | MINOR | P1 | Spec accuracy | `secrets_meta.storage_ref` stores the DPAPI ciphertext of the secret itself; §5.1 introduces the table as holding "no values." Likely the right call — the spec text is just now untrue. | `src/main/secrets/secretStore.ts:44-51` vs §5.1 | Correct the spec wording. | XS | Untouched — MINOR, deliberately not fixed this session |
| 28 | MINOR | P1 | Settings | `review.trivialTaskMaxChangedLines` (§16.1, default 20) is missing from both the schema and the registry, so its sibling `review.autoAcceptTrivialTasks` has no configurable threshold. | `src/shared/settings/schema.ts` (absent); §16.1 | Add the key to both. | XS | **FIXED (M9 session 1, 2026-09-09)** — `review.trivialTaskMaxChangedLines` added to the schema (`z.number().int().default(20)`, matching §16.1) and to the registry (`group: 'Advanced'`). `tests/unit/settingsRegistry.test.ts`'s key count failed the moment it landed and was updated to 51 with the reason — which is that guard doing its job, not a chore. Still nothing *reads* it: `review.autoAcceptTrivialTasks` has no consumer either, and both are §8.5.1's, which is M11's. What is fixed is that the threshold is now configurable at all. |
| 29 | MINOR | P1 | Comment accuracy | `usage.ts`'s doc comment states "usage itself has no `project_id` column (confirmed: no such column exists)" — 40 lines above the INSERT that writes it. | `src/main/db/repositories/usage.ts:17-19` vs `:56,62` | Delete the stale comment. | XS | Untouched — MINOR, deliberately not fixed this session |
| 30 | MINOR | self | Lint config | `eslint.config.mjs`'s `ignores` are not `**/`-anchored, so a nested `.claude/worktrees/**` — created by exactly the subagent workflow `docs/AUDIT-PROMPT.md` prescribes — is linted. A first `eslint .` this session produced 35 spurious errors from a subagent's worktree. | `eslint.config.mjs:10-18`; reproduced this session | Add `.claude/**` to `ignores`. | XS | Untouched — MINOR, deliberately not fixed this session |

---

## Phase 2 — gate evidence, run fresh (not remembered)

| Gate | Result |
|---|---|
| `npm run typecheck` | Clean |
| `eslint src tests scripts resources` | Clean (0 errors) |
| `npm test` | **420/420** tests, 51/51 files, 27.8s |
| integration, fresh packaged build, minus soak | **284/284** tests, 50/50 files, 808.8s |
| `npm run test:contract` (CI-safe) | **18 passed, 3 skipped** (real-engine gate correctly off) |
| contract with `BUREAU_RUN_REAL_ENGINE_TESTS=1` | `realAgentGate.test.ts` **PASS** ($0.0497 real spend) · `realEngineSpawn.test.ts` **FAIL** → finding #7 |
| `soak.test.ts` standalone | Main test **timed out at 480000ms**; `chaos row 13` passed in 5.3s → finding #15 |

**M3** — contract suite green for FakeAdapter and claude-code; no orphan
processes after stop (verified by live process-tree scan inside
`genericPtyAdapter.test.ts`). One of its two real-engine files is broken
(#7), and its "an agent completes a trivial task" claim is carried in
practice by M4's gate, not by `realEngineSpawn.test.ts`.

**M4** — passes for real, verified live this session. The full sequence was
observed end to end: `employee.started` → `tool.requested`/`tool.denied`
(ToolSearch, twice, correctly denied — deny-by-default working unscripted) →
`bureau_report_status` allowed → `employee.status_reported` →
`bureau_ask_director` → `message.sent` → `bureau_task_done` →
`task.submitted_for_review` → `cost.turn_recorded` → `employee.idle
{reason: "task_reported"}`. All DB rows and activity-log entries as claimed.

**M5** — three employees hired with real worktrees, parallel commits and
merges, real 2-parent merge commit with the structured trailer, and a real
conflict producing a real blocker checkpoint carrying both sides' actual file
content with the integration branch untouched. All green. The 100-cycle soak
is the exception (#15).

**M6** — S1–S11 green with real mechanisms: S1's filesystem sentinel (plus a
non-placebo allow-path control), S2 across all three autonomy levels for both
read and write, S6's real `child_process` bypass, S7's park with its own
sibling mutation check, S8's breaker, S11's real process kill. A denied
command provably does not execute; a budget-exceeded employee parks; a
simulated 429 backs off and resumes. Caveats: #3, #8, #9 above.

### Could these gates pass while the real behaviour is broken?

Yes, in four specific places — that is findings #2, #3, #4 and #6, and it is
the single most important result in this report. Phase 3 demonstrated it by
construction rather than argument.

### The two claims singled out for interrogation

**`soak.test.ts`** — genuinely slow, **not** flaky and **not** hiding a
correctness defect. Three sessions, three identical *timeouts*; never an
assertion failure; the same mechanism passes in 5.3s at single-cycle scale.
The "environment-attributed" reading was right in substance, but it was
reached by inspection each time and is now confirmed by measurement. Honest
caveat: this run was not in perfectly clean isolation (the Phase 3 subagent
was active in a separate worktree), and the test was not instrumented to show
how many of the 102 cycles completed.

**`ELECTRON_RUN_AS_NODE`** — the contamination is real and current:
`ELECTRON_RUN_AS_NODE=1` was present in this session's own ambient
environment before any command ran. The mitigation is real, and every command
in this audit applied it. No packaged-app result in this report was recorded
while contaminated — the three packaged-app tests passed cleanly here against
a freshly rebuilt binary. The Phase 3 subagent's worktree showed those same
three failing with "Packaged app not found… run `npm run package`", which is
the *absence* of a build in a fresh worktree, a different and benign cause.

---

## Phase 4 — the two most important tests

**`tests/contract/realAgentGate.test.ts`** — real throughout: real
`ControlChannelServer`, real adapter, real built `bureau-hook.js`/
`bureau-tools.js`, real credentials, real spawn, fresh state per run, and it
passes for real today. Gaps: it is **opt-in behind real spend and absent from
CI**, so the single most important gate in M3–M6 has no continuous signal and
depends on someone remembering; and it covers one happy path only — no real
`blocked`/`ended_without_report` branch, no multi-run stability evidence, and
its tool-sequence assertions were evidently calibrated against one observed
prior run.

**`tests/integration/workspace/gitProtectionLayer4.test.ts` (S6)** — the
strongest test in the repo, and it deserves that billing. It exercises the
real mechanism (real nested-`child_process` bypass matching §10.3.1's named
threat, not a string match), real process kills rather than thrown
exceptions, and genuine fresh-start reads through a new DB connection in a
different process. `reconcile()` is confirmed wired into real startup
(`src/main/index.ts:72`), so its premise holds in production. Two caveats:
the crash-window half is weaker than it looks (#4 — the worker reimplements
the ordering it claims to pin), and layer 4 detects an unexpected *HEAD move*,
so a commit-then-`reset --soft` back to the expected HEAD is out of its scope
— that belongs to write-scope policy, and nothing tests the two composing.

---

## Phase 5 — hygiene

Clean: zero `TODO`/`FIXME`/`HACK`/`XXX` in `src/`; zero bare `any` (the
eslint rule is real and enforced); zero `@ts-ignore`/`@ts-expect-error`; five
narrow, justified `as unknown as` casts; **zero empty or swallowed catches**;
no stray `.only`/`.todo`. 70 `stub()` markers, all milestone-tagged — see #22
for the M3/M5 leftovers. No coverage tooling at all (#24).

**Does PROGRESS.md describe what is stubbed accurately?** Mostly yes — M6's
close-out in particular is scrupulous. Three exceptions: the M3/M5 stub
leftovers (#22); the model-tier gap, tracked only as a naming ambiguity when
the reality is that tier selection does not work at all (#1); and v1
definition-of-done row 6's "provably stop a runaway employee ✅ Done", which
is stronger than the mechanism supports (#8).

---

## Things I believe are correct but could not prove

1. **Renderer-side requirements** — the Settings tier editor, the activity
   timeline UI, §7.12's generated support matrix, the `limited-control`
   badge. Phase 1 scoped to `src/main`/`src/shared`; `src/renderer` was not
   audited. Their absence from `src/` is evidence, not proof.
2. **The Claude Code CLI flags behave as assumed** (`--strict-mcp-config`,
   `--setting-sources`, `--max-budget-usd`, `--permission-mode`). Load-bearing
   for finding #10's "safe today" conclusion. Not re-verified against the
   installed CLI's own `--help`.
3. **`migrate.test.ts` satisfies §5.3 rule 4** (each migration applied to a
   previous-version fixture). It passed for real; the wording was not checked
   assertion by assertion.
4. **Layer 4 and write-scope policy compose** against commit-then-reset. No
   test exercises the combination; each looks sufficient alone.
5. **Phase 3's six CAUGHT verdicts are caught for the right reason.** I
   verified the four NOT-CAUGHT results directly because those carry the
   weight; for the CAUGHT ones I relied on the subagent's named failing tests
   without re-deriving each.
6. **That the M4 gate is stable across runs.** It passed once, for real, this
   session. One real pass is one data point, and a real model is a
   nondeterministic input.

## Things I would do differently starting M3–M6 again

1. **Never let a test stand in for the path it claims to cover.** Findings
   #2, #3, #4 and #6 are one mistake made four times: a `FakeAdapter` for the
   real adapters, a fixture for `commitTaskWork`, a test-side `redactDeep`
   for the real outbound path, an inline function for a feature that was
   never built. Each carries a doc comment asserting fidelity to the real
   path, and those comments are precisely where the gap hid. The rule worth
   adopting: **a test may not re-implement the ordering, wiring or call it
   exists to verify** — if it can't reach the production path, say so in the
   test name rather than in a comment that reads like proof.
2. **Wire model tiers end to end before anything assumes roles differ.**
   Every employee currently runs on the cheapest model with a 5¢ turn cap
   "regardless of what a role or task might otherwise call for." M7 is about
   to build hiring on that.
3. **Make "mutation-checked" mean the whole suite, not the nearest test.**
   M6's own sibling mutation checks (S7, S8) are excellent practice — but
   they check that *the guarded behaviour* fails when removed, not that *no
   other* removal passes unnoticed. Four did.
4. **Enforce rebuild-before-trust mechanically.** This session nearly built
   13.5 minutes of integration evidence on a binary 28 source files stale.
   Memory is not a gate.
5. **Add coverage tooling in session one.** "No claim without a test" is only
   as strong as knowing which lines a test actually reaches — and this audit
   found three that reach nothing.
6. **Grep `stub('M<n>')` at every milestone close.** M4 and M6 did this by
   instinct; M3 and M5 didn't, and six handlers sat mislabelled for months.
7. **Give the expensive gates a cheap proxy.** The M4 real-agent gate is the
   most important test in the project and cannot regress-detect itself
   because it costs money to run. A scripted stand-in exercising the same
   wiring (real hook, real MCP server, fake model) would catch wiring
   regressions between real runs — which is exactly the class of breakage
   #7 turned out to be.
