# Project checklist — the living version of §1.8 / §27 / §29

`docs/BUILD-SPEC.md` already contains a director-level exhaustive pass: §1.8 (what
"done" means), §27 (36-item risk register — what will go wrong and what we do
about it), and §29 (open questions only you can answer). That content is
frozen — it's the spec. This file is the **tracked, living version**: status
against every one of those items, updated every session, plus a parking lot
for things that come up in conversation and aren't in the spec yet.

Distinct from the other three tracking docs, on purpose:
- **`docs/BUILD-SPEC.md`** — the frozen spec. Changes only when a documented
  interface actually changes.
- **`PROGRESS.md`** — a changelog. One entry per session: what landed, what
  surprised us.
- **`CLAUDE.md`** — invariants. Rules that never change regardless of milestone.
- **`PROJECT-CHECKLIST.md`** (this file) — status. Updated whenever a risk
  gets mitigated, a milestone completes, or a new idea surfaces mid-session.

---

## 1. v1 definition of done (§1.8)

| # | Item | Status |
|---|---|---|
| 1 | Signed `.exe` installs on a clean Windows 11 machine and launches | Not started (M15) |
| 2 | Setup wizard: nothing installed → working first project, no terminal | Not started (M13) |
| 3 | Describe a project in chat → interview → brief/plan approval → deliverable, no terminal panel | Not started (M9/M11) |
| 4 | Three employees work in parallel, no git conflicts, 100-task soak | 🔶 In progress — the M5-scoped soak is done and proven (2026-08-28): 3 employees, 102 real concurrent commit+merge cycles, zero conflicts by construction, real `git fsck`-clean history, chaos row 13's real lock-contention proof, all folded into the same soak. M15's full product-level soak (real Director-assigned tasks, real UI, a genuine end-to-end run rather than git-plumbing cycles a test script drives directly) is still not started — moved only as far as the M5-scoped evidence actually supports, not further |
| 5 | Office view: every sprite state maps to a real status, verified by test | Not started (M12) |
| 6 | Budgets and circuit breaker provably stop a runaway employee | Not started (M6) |
| 7 | Closing the app mid-task and reopening resumes cleanly, nothing lost | **In progress** — the data layer's own durability is done (M1); the supervisor's own clean-stop/heartbeat mechanics are done (M3); M5 part 1 adds real evidence for the *workspace* half specifically: a worktree created or removed when Bureau dies mid-operation converges cleanly on restart (proven via real process kills pinned at both crash windows), and an expired lease is reclaimed only after independently confirming its holder's process is actually dead, not just quiet (proven via `events` table ordering, not merely "reconcile ran and didn't throw"). What this does **not** yet cover: the task/employee's own mid-task state (still M4–M8's job — the control channel and real task execution aren't wired to a live git workflow together yet), and nothing here is live/mid-session — reconciliation only runs at startup, so a crash is still required to trigger it, not detected while Bureau keeps running |
| 8 | Two departments genuinely useful; a third definable via YAML alone | Not started (M7/M14) |
| 9 | Every claim in the app and README maps to a passing test | Not started (`claims.yaml`, M15) |

## 2. Milestones (§20/§28)

| Milestone | Goal | Status |
|---|---|---|
| M0 — Skeleton | Packaged app opens via `app://`, native modules load, Job Object containment | ✅ Done, CI green |
| M1 — Data layer | Durable state, survives a kill at any instant | ✅ Done, 20/20 kill points green |
| M2 — IPC + shell | Typed `window.bureau`, main-side validation, window layout, themes | ✅ Done — 140 unit+integration tests green, 4/4 e2e green, S13 and S14 both proven by mutation, `stateDeltaReconnect` proven against the real packaged app |
| M3 — Engine adapter + supervisor | `EngineAdapter`, `FakeAdapter`, Claude Code adapter, PATH resolution | ✅ Done — `ClaudeCodeAdapter` (structured mode, real subscription auth confirmed working from an isolated per-employee config dir), `GenericPtyAdapter` (real, config-driven, for any terminal-only tool — the real PTY adapter now, since Claude Code stayed structured-only, §7.7.1), the supervisor state machine (heartbeat, turn counting, usage recording, clean stop, the read-only-by-default terminal-streaming mechanism), and the §7.8 contract suite. A late end-to-end check found and fixed a real gap — the supervisor never actually told an employee what its task was — closed with a permanent regression test proving the fix against a real adapter, not just the scripted fake. 165 unit, 120 integration, 17 contract (+2 real-engine tests that skip themselves with no CLI/opt-in). |
| M4 — Control channel + tool server | Agents can talk back to Bureau (nothing above this works without it) | ✅ **Done.** Session 1: loopback HTTP server, per-employee tokens (real Windows ACL via `icacls`), the long-poll hold, CLAUDE.md invariant #6 proven against a real process kill. Session 2: all eight employee tools real (`toolHandlers/`), `bureau-tools` (real stdio MCP server) and `bureau-hook` (real PreToolUse hook, reuses `checkPolicyFailClosed`) both real and bundled, the real MCP round-trip proven end to end, `buildLaunchSpec` wired to a real MCP config + real hook registration (no more "deny everything"), cross-employee authorization proven with two employees and a deliberately crossed task id, `/v1/event` removed (audited, no legitimate caller), the supervisor's `finished`-branch blocker fixed and proven. Packaged-app tests (`job-object`, `native-modules`) rebuilt and green; the packaged-path resolution trap proven (`resourcePaths.test.ts`). **`realAgentGate.test.ts` run for real and passes**: a real agent set its status, asked the Director, and completed its task via `bureau_task_done`, all visible in the DB and activity log, with the supervisor taking the `review`/`task_reported` branch — and, unscripted, correctly got denied trying an off-allow-list tool first, proving deny-by-default against a real case neither session designed for. |
| M5 — Workspace + git | Worktrees, leases, commits, integration branches | ✅ **Done** (2026-08-28, branch `m5-part2`, not yet merged). Part 1: worktrees, leases, task re-pointing, bidirectional reconciliation. Part 2 closes the milestone gate itself: the commit path (structured message, employee-authored/Bureau-committed, §10.3.1 layer 4's HEAD-reconciliation check), the mandatory secret scan (enforced at `runValidators`'s own choke point, not just detection-time), integration-branch merges (`git merge-tree` plumbing, no working tree touched), conflict → a real blocker checkpoint with both sides' real content, and the 100+-cycle soak. **Gate proven for real**: 3 employees committing and merging in parallel (`integrationMerge.test.ts`), a deliberate conflict producing a blocker checkpoint rather than a broken tree (same file). Restricted-token layer 1 (§10.3.1) was genuinely attempted and root-caused, not skipped — did not land (a `RESTRICTED`-SID token fails its own process initialization on this machine); honestly downgraded in `docs/BUILD-SPEC.md` per that section's own pre-written rule. Layers 2-3 remain unbuilt for an unrelated reason (M7, no packs/roles yet); layer 4 shipped and is real. |
| M6 — Permissions + budgets | Policy evaluator, budgets, circuit breaker, redactor | Not started |
| M7 — Packs + roles + floor layout | Pack loader, engineering pack, director role, headless layout generator | Not started |
| M8 — Checkpoints | Full checkpoint system, message router | Not started |
| M9 — Chat UI | All message kinds, streaming, brief/plan/report/checkpoint cards | Not started |
| M10 — Memory | Retrieval packs, gated writes | Not started |
| M11 — Director core | Intake, brief, planning, assignment — first real end-to-end project | Not started |
| M12 — Floor rendering | Phaser scene, sprite states, floor-state test | Not started |
| M13 — Setup wizard | All eight steps, prerequisite install, engine connection | Not started |
| M14 — Board + Inspector + second pack | Board, Inspector, research-writing pack, operations pack | Not started |
| M15 — Package + harden | NSIS, signing, auto-update, E2E, soak, chaos, claim audit | Not started |

## 3. Risk register (§27) — tracked

Status legend: **Mitigated** (real code/test proves it) · **Designed-for**
(the schema/architecture already accounts for it, not yet exercised) · **Not
started** · **Accepted** (§27.4's honest no-full-mitigation risks — tracked,
not "fixed").

### 3.1 Will definitely happen in the first week (§27.1)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 1 | Native module ABI mismatch | M0 | ✅ Mitigated — `@electron/rebuild` postinstall, CI smoke test |
| 2 | Phaser assets 404 in packaged build | M0 | ✅ Mitigated — `app://` protocol, e2e-tested |
| 3 | `claude` not found after install | M3 | ✅ Mitigated — the resolved-PATH service (§15.4) rebuilds PATH from the registry/known install locations rather than trusting the stale one this process inherited; `probe()` reports a clear "not found" rather than throwing |
| 4 | Preload can't `require` what you expect under `sandbox:true` | M0 | ✅ Mitigated — bundled preload, main-side validation |
| 5 | Windows path comparisons silently never match | M6 | Not started |
| 6 | PTY output arrives mid-escape-sequence | M3 | ✅ Mitigated — `PtyOutputBuffer` matches against the rolling accumulated buffer, not a single chunk in isolation; tested against an escape sequence deliberately split across two chunks |

### 3.2 Product risks (§27.2)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 7 | Director asks too many questions | M11 | Not started |
| 8 | Director asks too few, builds the wrong thing | M8/M11 | Not started |
| 9 | Plans too coarse | M11 | Not started |
| 10 | Agents report success on work that doesn't run | M8/M5 | Not started |
| 11 | Cost surprise | M6 | Designed-for — `budget_usd_micros` columns exist in M1's schema |
| 12 | Merge conflicts between parallel employees | M5 | ✅ Mitigated (M5 part 2) — a real conflict produces a real `checkpoints` row (`type: 'blocker'`), both sides' actual file content, and `task.status = 'blocked'`; the integration branch itself is left untouched. No auto-resolution, by design — a follow-up task or manual resolution are the two real options offered, matching §10.6 rule 4's own text. Proven against a genuine conflict (`integrationMerge.test.ts`), not merely a scenario asserted to work |
| 13 | The office feels like a gimmick | M12/M13 | Not started |
| 14 | Free-tier user hits a wall mid-project | M6 | Not started |

### 3.3 Technical risks (§27.3)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 15 | Engine CLI changes output format/flags | M3 | 🔶 Detection exists, immunity doesn't — a version outside the tested-and-pinned range (2.1.238) fires `employee.engine_version_drift` and an "untested version" badge rather than silently misbehaving (§7.8 test 10). Doesn't prevent an actual format change from breaking parsing, only surfaces that it's unverified |
| 16 | Director context exhaustion | M11 | Designed-for — `conversations.summary`, `director.compactAfterTurns` setting in M1 |
| 17 | Employee loops burning tokens | M6 | Not started |
| 18 | Orphaned agent processes after a crash | M0/M4 | ✅ Mitigated at the mechanism level (M0 Job Object), confirmed via the real packaged app (`job-object.test.ts`, direct child only). M3 additionally confirmed clean-stop leaves no orphan for both real adapters (`ClaudeCodeAdapter`, `GenericPtyAdapter`) via live process-tree scans — the *clean stop* path, not a crash. Grandchild-level coverage on an actual crash (audit finding #6) still not built — see "Known issues" below. The real end-to-end loop (a genuine crash mid-task, not a clean `stop()`) still needs M4's control channel to mean anything against a real running task |
| 19 | SQLite corruption | M1 | ✅ Mitigated — WAL, single writer (now enforced in code, not just documented — audit finding #3), `BEGIN IMMEDIATE` for counter/lease transactions, backup-before-migration, `integrity_check`/`foreign_key_check`, tested via the 20-kill-point gate |
| 20 | FTS desync after `VACUUM` | M1 | ✅ Mitigated — explicit `INTEGER PRIMARY KEY`, tested (`tests/integration/ftsVacuum.test.ts`) |
| 21 | Very large repo makes worktrees slow/huge | M5 | Not started |
| 22 | Antivirus quarantines spawned CLIs | M15 | Not started |
| 23 | User edits files while an employee works on them | M5 | Not started |
| 24 | OneDrive/Dropbox sync corrupts a worktree | M13 | Not started |
| 25 | Long Windows paths break git | M5 | Not started |

### 3.4 Accepted — no full mitigation, stated honestly (§27.4)

| # | Risk | Position |
|---|---|---|
| 26 | Prompt injection from repo/fetched content | Contained via permissions, not prevented (§11.1 R3) |
| 27 | Shell commands can reach the network regardless of tool policy | No egress control at v1, documented |
| 28 | Model API keys are long-lived, unscopeable | Blast radius limited, not eliminated |
| 29 | A machine admin can do anything | Out of scope, as for any desktop app |
| 30 | Model quality not under our control | Process (criteria, validators, review), not magic |
| 31 | Agents can produce plausible, subtly wrong code | Reduced, not eliminated — user is the final reviewer |

### 3.5 Business and legal risks (§27.5)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 32 | Non-commercial art licence poisoning the project | M12 | Not started — `ASSETS.md` + CI licence check |
| 33 | Trademark collision on the name | Before M15 | Not started |
| 34 | An engine's terms prohibiting orchestrated use | M3 | Not started — must read terms before listing an engine as supported |
| 35 | User believes Bureau is responsible for agent output | M9 (copy) | Not started |
| 36 | Copyleft dependency contaminating the licence | M15 (CI) | Not started |

## 4. Chaos scenarios to test explicitly (§27.6)

| # | Scenario | Covered by |
|---|---|---|
| 1 | Kill the app at 20 points across a task lifecycle | ✅ M1's kill-point test covers the **data-layer** version (`tests/integration/killPoints.test.ts`); the full task-lifecycle version is `tests/chaos/`, M15 |
| 2 | Revoke API key mid-task | Not started (M6/M13) |
| 3 | Exhaust free-tier quota mid-task | Not started (M6) |
| 4 | Fill the disk during a commit | Not started (M5) — a real commit path exists now (part 2, `commitTaskWork`), but nothing in it special-cases a disk-full failure specifically; it would surface as a generic thrown `GitCommandError` from the underlying `git add`/`git commit` call, uncaught by anything this session built. Reviewed, not addressed |
| 5 | Corrupt `bureau.db` | 🔶 Detection mechanism done (M1: `integrity_check`, `listBackups`/`restoreFromBackup`); no UI to "offer" the restore from yet |
| 6 | Delete a worktree externally while leased | 🔶 Partially covered (M5 part 1) — the bidirectional reconciler (`reconcileGit.ts`) removes a DB row whose worktree directory is missing on disk, the same mechanism gate item 4 proved against Bureau's own interrupted operations; it doesn't distinguish "Bureau crashed mid-op" from "something else deleted this folder," so an external deletion should converge the same way. But this only runs at startup, not live/mid-session, and no test specifically models external deletion of an *actively leased* worktree — only Bureau's own crash-interrupted creates/removes are tested |
| 7 | Two employees write the same file | ✅ Mitigated (M5 parts 1+2) — one worktree per employee (part 1) means two employees can never race on the same file on disk; the *merge-time* conflict this row actually names — what happens once both sets of edits are combined — is now real (part 2): a genuine conflict produces a blocker checkpoint with both sides' real content, task blocked, integration branch untouched, no auto-resolution. Proven against a real conflict, not asserted (`integrationMerge.test.ts`) |
| 8 | Employee produces a 500MB log file | Not started (M6) |
| 9 | Engine CLI uninstalled while running | Not started (M3) |
| 10 | Clock jumps backwards | Not started |
| 11 | README containing injection text | Not started (M6) |
| 12 | 10,000 events in one project, UI stays responsive | Not started (M9/M14) |
| 13 | User's own git client (terminal, GUI) runs concurrently against a repo Bureau is operating on | ✅ Mitigated (M5 part 2) — `runGit()`'s per-repo queue only serializes Bureau's *own* git calls against each other; it cannot serialize against a genuinely separate process like the user's own terminal, but it retries (up to 4 attempts, short backoff) on lock-contention failures (`index.lock`, "cannot lock ref"). Now proven against a real, independent second holder of the lock, not just reasoned about: a worktree's own `index.lock` (resolved via `git rev-parse --git-path index`, never guessed) held for real for 250ms while `commitTaskWork` ran concurrently, recovered in 615-790ms across three separate runs — comfortably inside the retry's own backoff window (`tests/integration/workspace/soak.test.ts`, chaos row 13) |

## 5. Open product-owner questions (§29) — unresolved

1. **Monetisation** — free/OSS, paid, or free-core + paid packs? Affects licence choice.
2. **Distribution name** — verify name/domain/GitHub org availability before M15.
3. **Telemetry** — default is none; stays none until you say otherwise.
4. **Voice** — push-to-talk + realtime mode, recommended v1.2, after text chat is excellent. See parking lot below — you raised this again today.
5. **Team/cloud features** — deliberately out of scope for v1.

## 6. Parking lot — ideas raised outside the spec, not yet implemented

| Date | Idea | Where it likely belongs | Status |
|---|---|---|---|
| 2026-08-21 | A spend-tracking "board" prop in the office floor — clickable, shows total spend, detail on click | M12 (floor props, §13) + M14 (Costs view, §16.1 already specs a Costs settings page) | Not started. Data it needs (`spend_usd_micros` columns, `usage` table) lands in M1. |
| 2026-08-21 | Chat/talk (voice) toggle when talking to the Director | Already §29 open question #4 — re-raised, not re-prioritized yet | Deferred per spec (v1.2) unless you want to move it up |

## Known issues surfaced during development sessions

| Date | Issue | Impact | Status |
|---|---|---|---|
| 2026-08-21 | ~~Packaged `Bureau.exe` fails to launch~~ — **false alarm, resolved same session.** Cause was `ELECTRON_RUN_AS_NODE=1`, a documented sandbox env var (M0's own PROGRESS.md entry) not unset in that session's ad-hoc manual-launch commands. Both packaged-app gate tests pass cleanly once cleared; no code was ever broken. | None — was never real | ✅ Resolved (self-inflicted, corrected within the session) |
| 2026-08-21 | This coding session's own sandboxed shell appears to reap orphaned child processes even with *zero* Job Object code — discovered while building finding #6's test, which passed even with `assignProcess()` deliberately disabled | Only affects a *new* bare-`node` test built and run from inside this specific tool session — `job-object.test.ts` (drives the real packaged Electron app) is unaffected and passes cleanly | Low priority — likely just this coding tool's own process containment, not a product concern. Confirm on a plain terminal before building finding #6 |
| 2026-08-21 | ~~`npm run package` intermittently fails or produces an exe that vanishes/dies within seconds~~ — **resolved same session.** Two real, distinct causes, both fixed: (1) Windows Defender locking `node-pty`'s unused non-Windows `spawn-helper` binary during electron-builder's file moves — excluded non-Windows prebuilds from packaging entirely in `electron-builder.yml` (Bureau is Windows-only, §3). (2) A killed/interrupted `electron-builder` process (from chasing (1) via `taskkill`) could leave a corrupted, partially-written asar that a later "successful"-looking run didn't always fully overwrite — confirmed by hashing `dist/main/index.js` against the same file extracted back out of the packaged asar; verified identical once the build-then-package sequence ran uninterrupted. | None once resolved — S14's mutation proof and `stateDeltaReconnect.spec.ts` both completed successfully against the real packaged app this session. | ✅ Resolved — packaging confirmed reliable across several independent, separately-invoked verification runs |
| 2026-08-22 | `ELECTRON_RUN_AS_NODE` recurred across *every* M3 session that manually launched or tested the packaged app — same root cause as the M0 entry above (this coding tool's shell doesn't persist env changes between separate commands), not a new issue. Confirmed as a genuine pattern worth permanent attention, not a one-off. **Recurred again in M5 session 1 (2026-08-28)**: 3 packaged-app integration tests (`job-object`, `resourcePaths`, `native-modules`) failed with a misleadingly generic "timed out waiting for result.json" error — the failure gives no hint of the real cause, so each recurrence costs real diagnosis time from scratch unless someone remembers to check this row first. Root-caused (manually spawning the packaged exe showed an instant, silent, code-0 exit — Electron running as plain Node) and fixed the documented way, not papered over; all 3 green immediately after. | Wastes real session time re-diagnosing the same known cause each time it recurs — now confirmed across three separate sessions (M0, M3, M5) | Not "fixable" — a property of this coding session's own shell. Mitigation is procedural: always `unset ELECTRON_RUN_AS_NODE` in the *same* command as any manual packaged-app launch or test run (see `PROGRESS.md`'s carried-forward list). Given three independent recurrences now, worth considering whether the *test helper* (`tests/helpers/packagedApp.ts`) should strip it automatically rather than relying on every session's shell hygiene |
| 2026-08-22 | This coding session's own environment leaks self-identifying variables (`CLAUDECODE`, `CLAUDE_CODE_EXECPATH`, etc.) into anything it spawns — first caught when a real-auth probe of the Claude Code CLI came back `authenticated:false` on a machine that is genuinely logged in, because those variables pointed the CLI at a *different* `claude.exe` (this IDE's own bundled binary) than the one actually being tested. | Would silently produce wrong `probe()`/auth results if unhandled — same failure class as `ELECTRON_RUN_AS_NODE` above, a different variable | ✅ Mitigated in `ClaudeCodeAdapter.probe()` — strips the specific confirmed contaminant variables by name (never a blanket `CLAUDE*` prefix, which would also strip the legitimate `CLAUDE_CONFIG_DIR` override tests need). Worth remembering as a pattern: this dev environment is not a clean room, and any future adapter/tool that shells out should check for the same class of leak rather than assume a fresh one won't recur |
| 2026-08-22 | A real-world PTY gotcha, found by actually running a scripted terminal target rather than trusting a written example: (1) the spec's own `ready_pattern`/`done_pattern` example used `(?m)` as an inline regex flag prefix — valid in Python/PCRE, invalid in JavaScript, and threw `SyntaxError: Invalid group` the first time it was actually run; (2) even fixed, matching a literal trailing space in a prompt (`'^> $'`) still failed against real captured output, because Windows' ConPTY rewrites a prompt's trailing space into a cursor-move escape code rather than a literal space byte. | Would silently break any `generic-pty` role author who copied the documented example literally | ✅ Fixed in both code (the adapter now applies the multiline flag itself, never expects it embedded in the pattern string) and in `docs/BUILD-SPEC.md` §7.7's own example. Worth knowing for anyone authoring a new `ready_pattern`: verify it against real captured output before shipping it, not just by inspection — `tests/integration/engine/genericPtyAdapter.test.ts` has the worked example |
| 2026-08-28 | `hireEmployeeWorktree`'s first implementation called the real `git worktree add` *before* inserting the `worktrees` DB row — the reverse of both CLAUDE.md invariant #3 ("commit before side effect") and the approved M5 plan's own gate-item-4 wording ("between DB-insert and `git worktree add`"). Plan review (before any code) had already caught two other real design bugs in this same area (a queue re-entrancy deadlock, a missing git identity); this third one slipped past that review and was only caught by re-reading the plan's own ordering claim against the actual code, immediately before writing the crash-window test that would pin a kill point to it. | Would have been silently wrong in a subtle way: a crash between the two steps would leave an *untracked* orphan directory with zero durable record it was ever supposed to exist, rather than a phantom DB row the reconciler is specifically built to notice — still recoverable via `git worktree prune`, but not the invariant-#3 guarantee the plan promised | ✅ Fixed before any test was written against the original order — reordered to insert-then-add, then gate item 4's two crash-window tests were pinned against the corrected order. Worth remembering as a pattern: when a doc comment and an approved plan both assert an ordering, diff the actual code against that specific claim before building tests on top of it — don't stop at "does it work" |

---

**How this file gets updated:** every session, before writing `PROGRESS.md`'s
entry, sweep this file — mark anything the session mitigated, add any new
risk or idea that came up, update milestone status. If a session doesn't
touch this file, that's a sign something worth tracking was missed.
