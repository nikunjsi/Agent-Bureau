# Pre-M11 plan: the closed list

**Written:** 2026-09-17. **Owner:** Nikunj. **Status:** OPEN.

This is the **last** body of work before M11. It exists to end a loop. Since
M10 closed, every audit → fix → audit round has produced a new batch of
findings. The findings were real but pre-existing (every earlier fix held).
Audit yield measures how deep someone looks, not how many defects remain, so
"audit until zero findings" never finishes.

So readiness means **this list, resolved**, not zero findings. The list was
built from **three passes over every source** on 2026-09-17: a reading pass, a pass over the files the first missed, and a mechanical pass by script (§S says
exactly which sources, and where each open item landed). It is not added to
by further review.

---

## The rules

1. **The list is closed.** Sessions work what is written here and nothing
   else. Do not look for new issues. **No audits before M11.** §H's coverage
   check is bookkeeping, not an audit: it re-tests nothing.
2. **Something new turns up?** Add one line to **§F "Found while fixing"**
   with a proposed owner milestone. Fix it now **only if both** of these are
   true: it would break M11, **and** it is in a file you are already changing
   for a listed item. Otherwise it waits for its owner.
3. **Don't widen a fix beyond its "Done when".** A fix that grows is a new
   §F line.
4. **Method per item.** Write a failing test first and confirm it fails for
   the right reason. Then fix, and confirm it passes. Standing rule 9: before
   trusting a green run, show the mutation actually changed behaviour. One
   commit per item. For documentation items, check the claim against the code
   before editing the prose.
5. **Record progress in this file, in the same commit as the fix.** Set Status
   to `DONE <commit>`, `DECLINED: reason`, or `MOVED: owner, reason`. If the
   item came from an audit report, also fill that report's Outcome cell
   (standing rule 8).
6. **Running out of room?** Stop at an item boundary and commit. The next
   session re-reads this file and starts at the first item not resolved. The
   prompt is the same every time.
7. **Stage files by name.** `docs/artifacts/` stays untracked unless §E-1 says
   otherwise. Never push.

**Exit criterion: "ready for M11."** All four must hold:
- every row in §0–§D has a resolved Status
- every §E decision is filled in, except E-4 (Nikunj answers it after this plan closes; it gates **M11**, not this plan) and E-6 (Nikunj's own push)
- §G's sweep is green
- §H's coverage check passes

Then this file's status becomes CLOSED and M11 starts. There is no further
review round.

---

## §0: Housekeeping (do first)

| ID | What | Done when | Status |
|---|---|---|---|
| 0.1 | Commit `docs/AUDIT-M3-M6-REGRESSION.md`, its staged Outcome corrections to `docs/AUDIT-M3-M6.md`, and this file | One `docs:` commit | DONE 631006e |
| 0.2 | Point `PROJECT-CHECKLIST.md` §2's M11 row at this plan | M11's row says "blocked on docs/PRE-M11-PLAN.md" | DONE 92a36aa |
| 0.3 | Remove stale local branches: `m0-skeleton`, `m5-part2` and the two `worktree-agent-*` subagent leftovers | List them first. Delete **only** branches `git branch -d` accepts, which is its refusal on unmerged work. Anything it refuses goes to §F, not `-D` | MOVED: Nikunj, because this session's permission classifier refused `git branch -d` itself ("irreversible local destruction"), so the deletion can't be run from a session. Listed 2026-09-17: `m5-part2` (3b0d0a7) and both `worktree-agent-*` (e170ad5) have 0 commits outside `main`, so `-d` will accept them. `m0-skeleton` (247c1f1, "sync package-lock.json") has **1 commit outside `main` and on no remote branch**, so `-d` will refuse it (§F). Run: `git branch -d m5-part2 worktree-agent-a00a5e0b720867cbb worktree-agent-aab2e126134801913` |

---

## §A: SERIOUS, on the path M11's Director runs

| ID | What (plain) | Done when | Status |
|---|---|---|---|
| N-16 | "The Director is never stopped" is enforced on only one of three stop paths (`supervisor.ts:1287`, `steerBreaker`). `breaker.hardStop` and `budgets.onExceed: stop` can still stop it. The wall-clock breaker trips a long-lived Director after about an hour | One Director guard that every stop path consults (`stopForBreaker`, `applyBudgetVerdict`), or the Director parks instead of stopping. The wall-clock trigger's meaning for a long-lived session is decided (likely per turn). One test per path showing the Director survives, each mutation-confirmed | DONE 4fe3446: `Supervisor.mustNotStop()` is consulted by `applyBudgetVerdict`, `stopForBreaker` (so `hardStop` too) and `steerBreaker`. The Director parks (budget) or is constrained (breaker). Its wall clock is decided as **per turn** (`turn.started` → `idle`), recorded in §11.5 and §0.1. Four tests (steer escalation, hardStop, onExceed=stop, wall clock). Mutations `mustNotStop → false` (3 fail) and clock-from-assign (wall-clock test fails) both caught |
| N-1 | While parked or paused, `handleEvent` returns before **every** event (`supervisor.ts:758`), including `turn.completed`. A turn that really ran is never billed. The #8 fix's test asserts this as success | The park gates **state transitions**, not **accounting**: usage is recorded, the ledger row written, counters updated and `cost.turn_recorded` emitted, and only `→ working` is refused. `parkedIsAGate`'s money assertion is rewritten, plus a test that no `employee.working` follows `employee.parked` (M10′). Also closes `docs/NEXT-VERSION.md`'s related notes | DONE 2bd7723: `handleEvent` records `turn.completed` usage while parked and refuses everything else. `parkedIsAGate`'s money assertion rewritten (turn 1 billed), plus no `employee.working` after `employee.parked` (M10′ mutation caught) and a pause-mid-turn test. No `NEXT-VERSION` section describes this defect (checked by grep for park/pause/billing), so there was nothing there to close. The post-exit adapter flush went to §F |
| N-2 | Secrets are redacted on live pushes but not on request/response IPC, e.g. `chat.listMessages` on every window load (also `NEXT-VERSION` §K.5) | Redaction happens once, in `dispatchIpcCall`, after output-schema validation. S4's IPC leg covers a request/response method and is mutation-confirmed. §K.5 is marked resolved | DONE d43cae6: `ipcOk(redactDeep(parsedOutput))` in `dispatchIpcCall`. S4's new request/response leg fails with the call removed. §K.5 resolved |
| N-9 + #13 rule 6 | The immutable `git_write` deny misses ordinary `git push` shapes, and nothing detects a push | Terms widened (`git push`, `git push *`, `-C`/`--git-dir` forms) as a §11.3 amendment logged in §0.1, each mutation-tested. **Plus a push detector** (compare remote refs or reflog around a turn, the way layer 4 checks HEAD), because matching shell text can never be complete. Rule 6 ("push is an approval checkpoint") is built on the detector. The detector and rule 6 consult `projects.protected_refs` (stored since M1, default `["main","master"]`, read by nothing today) | DONE 9a4ad1d: terms `git push`, `git -C * push[ *]` and `git --git-dir* push[ *]` added, each with a check-5 exemplar and a shape test, every term's removal caught. `workspace/pushDetection.ts` reads `update by push` reflog entries since the task branch was created, and `commitTaskWork` raises rule 6's `approval` checkpoint (no default, no expiry) and blocks the task, graded by `protected_refs`. Four mutations caught (no detection, protected ignored, dedupe removed, since-floor removed). Limits recorded in §10.6: URL pushes and disabled reflogs are invisible, and the user's own push during a task is reported. A Core-initiated push stays with M11 (§M11 1) |
| N-14 | The hook binary every tool call passes through has fail-closed branches that no free test runs | A free integration test runs the real bundled `bureau-hook.js` via `process.execPath` in four cases: no env, missing/malformed `control.json`, killed Core, and live Core returning allow and deny. It asserts stdout JSON **and** exit code, and is added to `test:security` | DONE 69dc1ac: `tests/integration/controlChannel/bureauHookBinary.test.ts` bundles `resources/bin/bureau-hook.ts` from source (so it can't pass on a stale `dist/`) and runs six cases. Mutations caught: no-env exit 0, control.json failure → allow, transport error → allow, final exit always 0. In `test:security`, claims S11 |
| N-6 | S7's "and stays stopped" step never reaches the Supervisor, because the FakeAdapter has no `keepOpen` | `keepOpen: true`, or the step replaced by `parkedIsAGate`. `parkedIsAGate.test.ts` added to `test:security` and S7's coverage mapping. Other `pushEvent` calls on non-`keepOpen` adapters grepped and checked | DONE 8daf4aa: S7 made `keepOpen`; its stays-stopped step now pushes a real `turn.started` and asserts the event trail and billing, and deleting the park gate fails it. `parkedIsAGate.test.ts` in `test:security`, claiming S7 (the coverage test maps S-numbers from the file). Every other `pushEvent` caller grepped: all `keepOpen` |
| N-10 | Most immutable-deny terms are pinned by one test assertion at most, several by none | One exemplar per term (every glob, every alternation branch) in `immutableWidening.ts`'s table. Credential-path and Program Files reads added to S2's real-evaluator loop | DONE c1e58d2: every term now has an exemplar, and `immutableWidening.test.ts` enumerates the terms from `IMMUTABLE_RULES` so a new term without one fails (17 did before, including Agent/Spawn/Dispatch, which an effect-only check had wrongly passed through the autonomy default). S2 in `policyRealEvaluator.test.ts` reads `.env`, `.ssh`, `.aws` and `*.pem` inside the worktree (ruleId `deny.credential_paths`) and Program Files, at all three levels. Mutations caught: three term deletions (unit) and the `.ssh` glob (S2) |

---

## §B: MINOR, from the regression check

| ID | What | Done when | Status |
|---|---|---|---|
| N-3 | The autonomy floor fails **open** when capabilities are unknown, and it lives in two functions of which production calls one | Unknown capabilities → the floor applies (`ask`), per invariant #6. The unused parameter is removed so the decision lives in one function. A test covers unknown capabilities | DONE 19e861a: null capabilities → `ask` in `applyUngateableEngineFloor`, called unconditionally by `policyEvaluator`; the second copy (and its optional parameter) removed from `computeEffectiveAutonomy`. The unit test's unknown-capabilities case fails when null returns the hired autonomy. Recorded honestly: no verdict changes today, because unknown capabilities already classify every tool as `other` (deny); the floor now holds regardless of that |
| N-5 | The Director side of the **project**-level reserve is untested; every Director test is `globalDaily` | A project-level pair in `directorReserveLive.test.ts`: not parked at `project − reserve`, and parked with an approval checkpoint past the full project budget | DONE 6ccf34b: two project-level cases in `directorReserveLive.test.ts` through a real hired Director and a real project task. Both mutation-confirmed (project carve-out forced to non-Director; checkpoint limited to global-daily) |
| N-7 | `autonomy.default` is a spec'd, registered setting that nothing reads | Per §E-3: wired at hire with a decided precedence (§16.1 global → §6.5 role → per employee), or marked reserved in §16.1 and the registry | DONE 8217948: per §E-3 (recommendation followed), wired at hire. Precedence decided and recorded in §16.1: the stricter of global and role, then the per-employee value, and the Director fixed at `guided`. A literal global → role order is impossible because every role declares a default. `autonomyDefaultAtHire.test.ts` (5 cases) fails without the change, and with looser-of or no Director exemption |
| N-8 | The unconfirmed-`autonomous` → `guided` downgrade is pinned by unit tests only | One S2-style case in `policyRealEvaluator.test.ts` through the real HTTP path, asserting `ask` | DONE dafcc58: S2 case in `policyRealEvaluator.test.ts` (unlisted `Bash` command, autonomous unconfirmed → permission checkpoint + hold deny; confirmed → allow, no checkpoint). The `ask` is asserted through the checkpoint, since the HTTP verdict is only allow/deny. Mutation (downgrade disabled) caught |
| N-11 | The worktree lease is a guard nothing on the production path calls, and "renewed on every heartbeat" isn't implemented | Per §E-2: wired and tested, **or** §10.3/§28 amended to mark the lease reserved and state the double-assignment guarantee M11 must meet | DONE 772d416: per §E-2 (recommendation followed), declared reserved. Claim checked against code first: `acquireLease` and `computeLeaseTtlSeconds` have only test callers, no renew exists, and `assignTaskToWorktree` takes no lease. §10.3 gains a build-status paragraph with the guarantee M11 must meet (one transaction, a typed refusal of a concurrent second assignment, restart-safe with reconcile release, a two-concurrent-assignments test); §28 M5 item 2 annotated; §0.1 row |
| N-12 | Reconcile's standalone `git worktree prune` can be removed and the suite stays green | Reconcile test: delete a worktree directory externally, run `reconcile()`, assert `git worktree list --porcelain` no longer names it | DONE b2f4e4f: `tests/integration/workspace/reconcilePrunesDeletedWorktree.test.ts`, real repo and worktree, real `reconcile()`. It asserts the path is listed before deletion and after the external delete, and gone after reconcile. Mutation (standalone prune removed) caught |
| N-13 | `bureau_task_blocked`'s cross-employee rejection is an untested copy of `bureau_task_done`'s | One shared helper both call, or the crossed-id test parametrised over both | DONE de9ecb6: the crossed-id test parametrised over both tools (the Done-when's second option), asserting the message, the untouched task, and a `security`-severity `control.authorization_rejected` naming the tool. Mutation (task_blocked accepting a mismatch) caught |
| N-15 | Nothing asserts the eslint rules the codebase relies on | `configurationIsInForce.test.ts` loads the real config (`ESLint.calculateConfigForFile`) and asserts `no-explicit-any` and the other invariant rules are `error` | DONE cfbe89e: 10 resolved-config assertions over real files in six areas (each asserted to exist, after a first draft named a renderer file that didn't and still passed on the glob). Mutations caught: `no-explicit-any` turned off for one directory group (3 fail), react-hooks recommended rules removed (1 fails) |
| N-17 | `attachments.ts` confinement has no junction or short-name test case | A "refuses a path that escapes only through a junction" test, mirroring `memoryWriteConfinement.test.ts` | DONE 28bd3a3: two cases added to `attachmentConfinement.test.ts`: a junction inside the workspace pointing outside is refused, and a short-name spelling of an inside path is accepted against a long-form workspace (the case fails loudly on a machine with no short-name component instead of passing vacuously). The textual-normalisation mutation fails exactly these two |
| N-4 | A test writes engine config into the repo root, tracked with a machine-specific path | `mkdtemp` `stateDir`; `git rm` both files; `.gitignore` them | DONE 6ae7877: writer identified by mtime (`turnBoundaryQueueRealAdapters.test.ts`, `stateDir: process.cwd()`); it and the same shape in `adapterContract.test.ts` now `mkdtemp`. `mcp-config.json` and `claude-settings.json` `git rm`'d, added to `.gitignore`, and removed from `.prettierignore` (the workaround for them). Integration and contract re-runs leave no file at the root |
| B-1 | `bureau_task_done` stores `artifacts[].path` verbatim and never validates it (regression check Part 4 §3). Harmless until something opens it. Invariant #5's carve-out makes the handler the only guard for a `bureau_` tool | The handler confines each path to the employee's worktree: canonicalise, confine, fail closed, following the `attachments.ts`/`memoryTarget.ts` pattern. Handler-level test including a junction escape | DONE de1ef11: `toolHandlers/artifactPath.ts` resolves each path against the employee's own worktree, canonicalises both sides, and fails closed with no worktree. `handleTaskDone` checks every artifact before `completeTask`, so a refusal writes nothing, and logs a `security` `control.authorization_rejected`. Handler-level tests over the real control channel: relative inside accepted, traversal, absolute outside, junction escape and no worktree refused. Mutations caught: textual confinement (junction case) and no-worktree allowing. Invariant #5's list of guards updated in `CLAUDE.md` and §21 (§0.1 row). From regression check Part 4 §3, which has no Outcome cell |

---

## §B2: Promised by past milestones, never done

These come from `PROJECT-CHECKLIST.md`'s risk register and chaos scenarios,
§28 and `docs/NEXT-VERSION.md`. Each one's owning milestone has already
passed, and its status still says "Not started".

| ID | Source | What | Done when | Status |
|---|---|---|---|---|
| P-1 | Chaos #4 (owner M5) | Fill the disk during a commit | A test injects ENOSPC inside `commitTaskWork`'s write step and asserts fail-safe: no half commit, the pending-commit marker handled, `reconcile()` converges | DONE ce01267: `commitDiskFull.test.ts` injects `ENOSPC` after the intent marker and after `git commit`. Each case asserts the error propagates, no half commit, the marker is kept, no security event, and `reconcile()` converges (and in the first case the retry commits). Mutations caught: reconcile never adopting a landed commit, and the marker written after the commit. Chaos row #4 updated |
| P-2 | Chaos #9 (owner M3) + `NEXT-VERSION` §H.9 | The engine CLI is uninstalled while running; and `assign()` doesn't refuse a *determined* "not installed" (it fails later at spawn with an untranslated error) | `assign()` refuses a determined `installed: false` with a plain-language error (CLAUDE.md: translate, don't show raw engine output). A test removes or renames the binary mid-session: the running Supervisor fails closed with a translated message, and the next probe reports it determined-absent. §H.9 marked resolved | DONE 602149c: `assign()` throws `EngineNotInstalledError` (a `UserFacingError`) on a determined absence, and the old asymmetry test now asserts the refusal. `engineUninstalledMidSession.test.ts`: real `ClaudeCodeAdapter` + Supervisor, binary renamed mid-session → `failed` with a translated `employee.crashed` message (raw `ENOENT` in `detail`), and `ProbeCache.forget` makes the next probe report it determined-absent. Mutations caught: no forget, no translation, no refusal. §H.9 resolved, chaos row #9 updated, and a generic-pty binding consequence sent to §F |
| P-3 | Chaos #10 (no owner) | The clock jumps backwards | An inventory of wall-clock logic: checkpoint expiry, the post-restart grace, lease TTL, the 60 s probe cache TTL, the budget daily window, backoff. Each is tested against an injected backward jump, or switched to monotonic time where it measures a duration. Owner recorded as M10 hardening | DONE 075b139: inventory in `clockJumpsBackwards.test.ts` (one case each) and chaos row #10. Wall clock kept and shown to fail safe for checkpoint expiry and the budget day. Switched to monotonic: post-restart grace (`uptimeMs` from the tick), probe cache TTL (default `performance.now()`, negative elapsed = stale), rate-limit wait cap (`Supervisor.monotonicNow`). Lease TTL is reserved (N-11). Three switch mutations caught. Two tick fixtures (M8 gate, S12) now give their hour of uptime to the monotonic clock. Owner recorded as M10 hardening; other durations to §F |
| P-4 | Chaos #12 (owner M9/M14) + §L.7 | 10,000 events: does the UI stay responsive? `chat.listMessages` is unpaginated and the unread badge relies on that | The **chat half** measured with 10,000 messages (load time and render). Paginate if unresponsive, and update the badge's assumption to match. The activity-timeline half MOVED to M14 | DONE 6123f38 (chat half); activity-timeline half MOVED: M14, which builds the timeline view (nothing renders events yet). Measured at 10,000 messages: 1.1 s main-process block and 4.5 MB per load, newest message 8.1 s after the shell, a tab click 8.9 s, so unresponsive. Paginated: a page of 200 on a `(created_at, id)` cursor, a "Show earlier messages" button, and the badge adding the Core's `unreadOlderCount` (`UNREAD_FOR_USER_SQL` beside the predicate). After: 89 ms / 94 KB, newest visible in 234 ms, a click handled in 101 ms. Integration and packaged e2e tests added; badge and cursor mutations caught. §L.7 resolved, chaos row #12 updated |
| P-5 | Chaos #6 (owner M5, "partially covered") | A worktree is deleted externally while leased | The uncovered remainder named against N-12's test. Either covered, or its gap stated and tested | DONE 97e9468: remainder named against N-12's restart test. (1) "While leased" is untestable as written, since no lease is taken (N-11), so "while assigned a task" stands in. (2) There is no mid-session detection. Tested at the point of discovery by `worktreeDeletedMidTask.test.ts`: the commit fails with nothing committed, no security event and no marker, the task is not completed, and `reconcile()` removes the phantom row and clears the employee's reference (mutation: phantom rows kept → fails). Gap (2) to §F; chaos row #6 updated |
| P-6 | Risk #23 (owner M5) | The user edits files while an employee works on them | Behaviour documented with evidence: the user edits their own checkout, the employee works in a separate worktree, and conflicts reach M5's conflict checkpoint. A test exists for that path, or one is added | DONE f404599: `userEditsWhileEmployeeWorks.test.ts` documents both halves with evidence. Uncommitted user edits are isolated from the worktree and untouched by the ref-only commit and merge. A committed conflicting user edit reaches M5's blocker checkpoint (integration ref = `base_ref` before phases), with the user's branch left alone. Mutation (conflict check bypassed) caught. Risk #23 updated. The clean-merge-into-checked-out-branch hazard seen along the way went to §F (M11) |
| P-7 | Risk #21 (owner M5) | A very large repo makes worktrees slow or huge | Measured once: worktree creation on a large fixture (~50k files, shared object store). If acceptable, close with the numbers. If not, MOVED to M15 with the numbers | MOVED: M15, with the numbers. On a 50,000-file fixture (11.8 MB working files, 4.2 MB packed), through the real `hireEmployeeWorktree`: worktree creation took 47.5 s, 48.5 s and 55.3 s, on Windows 10 with Defender. Size is acceptable (shared object store, 11.8 MB checkout per employee). Time is not, and it runs inside the per-repository git queue, so it stalls other employees' git work on that project. Recorded on risk #21 with M15 options (sparse or lazy checkout, running outside the queue, Defender exclusions) |
| P-8 | Risk #35 (owner M9, copy) | The user believes Bureau is responsible for agent output | Plain-language copy in the chat surface that the user is the final reviewer of what employees produce. Presentation stays in the renderer. Risk row updated | DONE e47ce38: ReviewerNotice.tsx in the chat view beside the composer, with plain-language copy naming the user as the final reviewer. tests/unit/renderer/reviewerNotice.test.ts checks the copy and that ChatView renders it (removing it fails), and tests/e2e/chat.spec.ts asserts it in the packaged app (run in the §G sweep). tests/tsconfig.json gained jsx react-jsx so a test can import a component. Risk #35 updated |
| P-9 | `NEXT-VERSION` §E.2 | Opt-in real-spend tests rot, and M11 depends on the real engine | `realAgentGate.test.ts` and `realEngineSpawn.test.ts` run **once** with opt-in enabled (the M4 gate cost $0.0497; on subscription auth it uses quota), with results recorded. Anything that fails is fixed or goes to §F with an owner | DONE 3927f31: both run once with BUREAU_RUN_REAL_ENGINE_TESTS=1 against Claude Code 2.1.238. realEngineSpawn passed. realAgentGate FAILED: the CLI defers MCP tool schemas behind ToolSearch, which the adapter classified as other (denied), so no agent could reach bureau_task_done. Fixed (ToolSearch = read in CLAUDE_CODE_TOOL_CLASSES; unit test fails without it) and the gate re-ran green (status, ask, done, idle). Spend: gate runs at $0.094, $0.077 and $0.123, plus one spawn run. The version-drift false positive seen in the same runs went to §F. NEXT-VERSION §E.2 updated |
| P-10 | August M0–M2 audit #6 (`docs/progress/M0-M2.md:506,563`, SERIOUS, "not built" ever since) | Job Object containment is only tested for a direct child, never a **grandchild**. M11's Director CLI spawns its own node children | A test where Bureau spawns a child that spawns a grandchild, Bureau is hard-killed, and **both** are gone. `docs/progress/M0-M2.md`'s record updated | DONE 38b6570: grandchild case in job-object.test.ts (packaged app contains a dummy, the dummy spawns a grandchild after containment, Bureau killed by PID only, both gone). The negative control found libuv's own kill-on-close job reaps non-detached children with containment OFF (bare node, WMI, and the packaged app), so both processes are spawned detached. Control: containment OFF, both alive after 10 s; containment ON, both dead. docs/progress/M0-M2.md #6 updated. Two §F lines: the direct-child case is non-discriminating, and containProcess has no production caller (M11) |
| P-11 | `.github/workflows/ci.yml` vs §11.7 "release-blocking" | CI runs lint, the spec checks, unit, package, integration, contract and e2e, but **never `npm run test:security`**. Most S-files run incidentally inside other suites, but the suite as a gate does not exist in CI | A `test:security` step in CI after integration, or proof that every file in the script already runs in CI plus a recorded decision. `securitySuiteCoverage` still green | DONE 6ca95bf: a 'Security tests' step running npm run test:security after the integration step in .github/workflows/ci.yml. securitySuiteCoverage.test.ts gained a case asserting the step exists and follows integration; it failed before the step was added. securitySuiteCoverage still green (7/7). Whether CI itself goes green is verified on the next push, which is Nikunj's (E-6) |
| P-13 | Invariant #15 / BUILD-SPEC §1 ("an employee MUST never claim to be human"), owner M7 (pack content) | Only `packs/operations/prompts/director.md` says it. None of the five engineering role prompts, nor `prompts/_shared/engineering-standards.md` or `definition-of-done.md`, carries the instruction. Employees' text reaches the user through checkpoints, messages and the status bubble | The instruction added once to the shared standards every engineering role includes. **Plus a mechanical check** (in `validatePack` or a test over every shipped pack) that each role's composed prompt carries it, so a new pack can't drop it. Mutation-confirmed | DONE 133a9f1: claim checked (director.md line 7 carries it; no engineering prompt or shared file did). The line added once, at the top of prompts/_shared/engineering-standards.md, which all five engineering roles include. Mechanical check: shippedPacks.test.ts walks every directory under packs/ and asserts each role's composed prompt (own plus shared prompts) contains it, so a new shipped pack is covered without editing the test. Mutations caught: the Director's line removed, and a role dropping the shared standards. Chose the shipped-pack test over validatePack: a third-party pack is the user's own content, and the invariant is about Bureau's employees |
| P-14 | CLAUDE.md trap: "Do not let a `finished` event mean task complete. Only `bureau_task_done` does" (owner M3/M4) | Structurally true today (`handleFinished` only applies a transition `bureau_task_done` staged), but **no test pins it**, the same shape as the config-assertion gaps | A test: an employee turn ends with `finished` and no `bureau_task_done` → the task is **not** moved to `review`/`done`. Mutation-confirmed by making `handleFinished` complete the task | DONE 4caca96: supervisor.test.ts 'a finished event never completes a task' covers finished(completed) and finished(error) with no bureau_task_done: the task is never review or done, result_summary stays null, and the supervisor is not idle. Mutation (handleFinished writing the task to review with the summary) fails both |
| P-12 | `CLAUDE.md` invariant #4 | The text says layers 2–3 (pattern denies, PATH omission) are "not built; no packs/roles exist until M7 to configure them on". M7 has passed. Layer 2 now exists as `deny.git_write` (and N-9 widens it). Layer 3 (git omitted from an employee's PATH) has never been built | Layer 3 built and tested (an employee's resolved PATH has no `git`, which Core-side git calls don't need), **or** declined with the reason recorded. Invariant #4's text rewritten to state each layer's real status today, and §21 kept verbatim in sync | DONE <pending>: layer 3 DECLINED. §10.3.1's own list shows PATH omission defeated by node -e, which a developer role needs, so it would add a claim, not a guarantee; the guarantee is layer 4 plus N-9's push detector. Invariant #4 rewritten identically in CLAUDE.md and §21 with each layer's real status (1 not built; 2 built: deny.git_write widened at N-9, and Bash(git *) in all five writing engineering roles, checked; 3 declined; 4 built and S6-tested, plus the push detector). §10.3.1's M5 status note corrected, §0.1 row added |

---

## §B3: Required test approaches from BUILD-SPEC §19 that were never built

§19 names a required test approach per area, and CLAUDE.md's definition of
done includes "the property tests named for it". These rows' areas are
M0–M10's, and no matching test exists (checked 2026-09-17: `fast-check` is
not a dependency, and nothing named fuzz or property covers them).

| ID | §19 area (owner) | Required | Done when | Status |
|---|---|---|---|---|
| T-1 | Checkpoint state machine (M8) | Property test: **no sequence of events leaves a task blocked with no pending checkpoint.** §19 calls this "the deadlock that would make the product feel broken", and M11 is what drives this machine | Generated event sequences (raise, answer, expire, auto-resolve, cancel, restart grace, message delivery) run against the real checkpoint and task code. The invariant is asserted after every step, and a mutation that introduces a stuck `blocked` task is caught | OPEN |
| T-2 | Redactor (M6) | Property test: for **any** secret and **any** chunking of a stream containing it, the secret never appears in output. Today's tests cover two hand-picked splits | Generated secrets (values and pattern matches) and every split point / random chunkings through the real `RedactionStream`. The M3–M6 chunk-isolation mutation stays caught | OPEN |
| T-3 | Policy evaluator (M6) | A fuzz pass asserting **no input produces an accidental allow**, on top of the table-driven tests | Generated tool calls (names, paths, commands, including traversal, junction-shaped, mixed-case and `mcp__` shapes) through the real `evaluate()`. Nothing matched by an immutable deny is ever allowed, and nothing out-of-policy falls through to allow | OPEN |
| T-4 | IPC (M2) | **Every** handler fuzzed with malformed payloads: none crashes, none coerces. S14 covers representative cases only | A test that iterates `methodList.ts` and sends malformed inputs to every handler through the real router, asserting a typed `VALIDATION_FAILED` and no throw. New methods are covered automatically | OPEN |
| T-5 | Migrations (M1) | Each migration applied to a fixture DB **from the previous version**. Today it is only applied to an empty DB | For each migration N, a DB built at N−1 **with representative rows** migrates to N and keeps its data (checked by row counts and a few spot values) | OPEN |

If `fast-check` is added for T-1 to T-3, it's a devDependency and its licence is
checked (invariant #14 covers assets; risk #36 covers copyleft dependencies).

---

## §B4: Found by the mechanical sweep (settings, events, dependencies)

A third pass on 2026-09-17 used scripts rather than reading. Each script walks
a whole category: every registered setting against its readers, every event
type against its emitters, every IPC error code against its producers, every
§7.9 tool against its handlers, every test file against the suite globs,
every schema column against its users, plus `npm audit` and a committed-secrets
scan. Error codes, test globs, tools (all 17 missing ones are Director tools →
§M11), columns and secrets came back clean. These did not:

| ID | What | Done when | Status |
|---|---|---|---|
| S-1 | `permissions.hookSelfDeadlineMs` is registered but nothing reads it. `bureau-hook` takes its deadline from `BUREAU_HOOK_SELF_DEADLINE_MS` with a hardcoded 30-minute fallback. §7.10 says it is "strictly less than the registered hook timeout, **validated at startup**", and that validation doesn't exist (owner M4) | The setting feeds the hook's environment at launch, and startup validates it against the registered hook timeout, failing closed with a readable error. Tested. Or marked reserved in §16.1 with the reason | OPEN |
| S-2 | `pty.readyDebounceMs` (global, per engine) is registered but unread. The generic-PTY adapter takes debounce from engine options (owner M3/M8) | Precedence decided (setting → per-engine override) and wired, with a test. Or marked reserved | OPEN |
| S-3 | `orchestrator.idleStopMinutes` is unread, and **no Supervisor ever idle-stops.** §7's supervisor limits list "idle-stop after `orchestrator.idleStopMinutes` (→ `off`, still assignable)"; §22.3 says an idle employee must not hold a process (owner M3) | The Supervisor stops an idle employee after the setting's interval → `off`, still assignable, with one event per state change. Tested with a FakeAdapter. Or MOVED to M11 with the reason recorded | OPEN |
| S-4 | Event types whose owner has passed but that nothing emits: `tool.asked`, `tool.executed`, `tool.failed` (M4/M6); `checkpoint.expired` (M8, where expiry is recorded as `auto_resolved`); `user.message_sent`, `user.checkpoint_answered`, `user.employee_paused` (deliberately not emitted per M8/M9's one-event rule); `company.created` (no production path creates a company before M13); `company.department_added` (reasoned in `installPack.ts:157`) | Each one is either emitted where it marks a real state change (invariant #3), or annotated in §5.2 the way `employee.ready` already is: documented-but-not-emitted, with the reason and owning milestone. §0.1 row added. `check:event-taxonomy` still green | OPEN |
| S-5 | 17 more settings nothing reads, owned by later milestones: `director.*` ×3, `intake.maxRounds`, `reporting.heartbeatMinutes`, `orchestrator.stallTimeoutS`/`maxReassignments`/`maxConcurrentEmployees`, `review.*` ×2 (M11); `floor.*` ×2 (M12); `general.sounds`, `general.keepAwake` (M13/M14); `retention.transcriptDays`/`eventTableDays` (nothing prunes; M15); `updates.channel` (M15) | Each setting's owning milestone recorded (registry metadata or a §16.1 note). **The current Settings UI does not present a dead setting as if it works**: such settings are hidden, or labelled as not yet active | OPEN |
| S-6 | `npm audit`: production dependencies have 1 high (`fast-uri`) and 2 moderate (`hono`, `qs`), all transitive with fixes available. Development: 1 critical (`vitest`, direct) and high `vite`, `js-yaml`, `@xmldom/xmldom`. No vulnerability check exists anywhere in the project | `npm audit fix` (without `--force`) applied, and the full sweep still green. Whatever needs a breaking upgrade is recorded with its owner (M15, alongside risk #36). A CI decision recorded on adding `npm audit --omit=dev --audit-level=high` | OPEN |

**Written-but-never-read columns** (30, found by the same sweep) are all owned
by M11's plans, tasks, phases and Director state, or are audit-trail fields a
later UI reads (`hired_at`, `answered_at`, `installed_at`,
`resolution_*`). None is a past-owner gap, with two exceptions already in
this plan: `worktrees.lease_*` → N-11, and `projects.protected_refs` → N-9.

---

## §B5: Found by the M7–M10 spec trace (E-7)

A read-only, one-pass trace of §6.2–§6.8, §8.0 (the Director's role
definition), §7.9 (four employee tools), §9.1–§9.7, §12.1–§12.5, §13.3, §14.2,
§14.4, §14.9, §22.4 and §28 M7–M10, done by a subagent that read only the spec
and the code. The full report, with evidence per requirement and the dedupe of
every gap, is `docs/TRACE-M7-M10.md`. Result: 270 requirements, of which 196
MET, 46 PARTIAL, 13 NOT MET and 15 LATER. Of the 59 gaps, 10 were already
plan rows, 6 are recorded deviations, 3 are later-owned (one line each added to
§M11/§After) and 4 were reasoned out as not gaps in the report. These rows cover
the remaining 36.

| ID | Spec (§, line) | What | Done when | Status |
|---|---|---|---|---|
| X-1 | §6.2, L835-841 | The pack layout's `templates/` (brief, plan, deliverable) and `skills/*.yaml` don't exist in any pack, and nothing reads either. Role `skills` is a bare string list. No §28 item owns them | Each is built (content in the engineering pack, validated at load, and a real consumer) **or** §6.2 annotated with its owning milestone and what M7 shipped instead, with a §0.1 row | OPEN |
| X-2 | §6.3, L863 | `requires.engines` ("at least one must be available") is parsed and never checked | Install/startup validation (or hire) checks the pack's `requires.engines` against the engine probe. A pack with none available is reported unavailable with a readable reason. Tested both ways | OPEN |
| X-3 | §6.4, L895 | `default_hires` is validated, but nothing hires them. `company.addDepartment` is `stub('M13')`, and §28 M13 doesn't list it | Built with `addDepartment` (hires via `hireEmployee`, tested), **or** §6.4 and §28 M13 annotated with the owner, with a §0.1 row | OPEN |
| X-4 | §6.7, L989 | Startup revalidation calls `validatePack` without `installedDepartmentKeys` (`revalidateInstalledPacks.ts:63`). A role whose department is in another installed pack passes install, then is marked `failed` on the next boot | Revalidation passes the other installed packs' departments, as install does. Test: install two packs with a cross-pack department reference, restart, and the pack stays `ok`. Mutation-confirmed | OPEN |
| X-5 | §6.7, L1000 | A pack that fails revalidation is withheld only at hire/fire. Its departments still appear in `company.listDepartments` and the floor layout, and `packs.list` returns `enabled:false` with no reason | A failed pack's departments and roles are withheld from `company.listDepartments` and the layout input (existing employees kept, per §6.7). `packs.list` output carries `last_validation_error`. Schema updated. Tested | OPEN |
| X-6 | §6.8, L1028 | `rehireEmployee` keeps id and memory, but has no IPC method or production caller. A user hire into the same role creates a new employee with empty notes | A production path reaches `rehireEmployee` (an IPC method, or `company.hire` choosing rehire for an archived employee of that role, per a recorded decision), tested end to end. **Or** MOVED to M11's hire proposals with the reason | OPEN |
| X-7 | §8.0, L1669 | The Director's autonomy is "fixed at `guided`, not user-configurable". `director.yaml:51-52` says this "is enforced in code", but `employees.updateSettings` sets any autonomy on any employee, the Director included | `employees.updateSettings` refuses an autonomy change for an `is_director` employee with a typed, plain-language error (budget changes still allowed). Test. Mutation-confirmed | OPEN |
| X-8 | §9.2, L1932 / invariant #8 | `consequence: z.string().min(1)` accepts a whitespace-only consequence, and `checkpointAnatomy.test.ts:53` pins that as accepted | Validation trims before the length check (or rejects blank). The test is rewritten to assert rejection. Mutation-confirmed | OPEN |
| X-9 | §9.2, L1925/L1934 · §9.5, L1954 · §28 M8 item 2 / invariant #7 | "`default_action` is always the safe, reversible choice" and "nullable only when no reversible option exists" are unchecked. Options carry no reversibility, so a checkpoint can time out into any option, or have all-reversible options and a null default and never expire | Options state reversibility (a schema field, amended in §9.2/§5.1 with a §0.1 row). Validation rejects a `default_action` naming an irreversible option, and a null `default_action` when a reversible option exists. Tests for both refinements, mutation-confirmed. S12 still green | OPEN |
| X-10 | §9.2, L1935 | "Checkpoint creation runs a duplicate-check against answered checkpoints": `duplicateDetection.ts:70-73` checks only `decision`/`information`, so agent-raised `approval`/`blocker`/`review` checkpoints skip it. (Consulting memory, brief and workspace is §28 M11 item 14) | Every agent-raised type except `permission` is duplicate-checked, tested per type, **or** the exclusion and its reason written into §9.2 as an in-place note with a §0.1 row | OPEN |
| X-11 | §9.4, L1945 · §28 M8 item 6 and gate | Nothing in the Core writes a `checkpoint` conversation message, and the chat card renders only from one (`MessageRow.tsx:212-224`). A raised checkpoint never appears in chat, and M8's gate "answered **from the UI**" is proven only at the IPC handler. `NEXT-VERSION` §J.5's outcome says surface 1 is built | The Core writes a `checkpoint` message (one event) when a checkpoint that doesn't wait for the Director's grouping is surfaced: at least `permission` and `blocking`. An e2e test raises a real permission checkpoint, answers it through the rendered chat card, and the held agent proceeds. §J.5 corrected | OPEN |
| X-12 | §9.7, L1968-1971 | A producer should insert its message and update task state in one `BEGIN IMMEDIATE` transaction. `answerCheckpoint` unblocks the task (`:224-232`) and inserts the message (`:342-357`) as separate writes | Both writes (and any other producer's pair) run in one transaction. A kill-point test between them shows no unblocked task without its message, or the reverse. Mutation-confirmed | OPEN |
| X-13 | §12.1 (M10 amendment), L2372 | "`memory.reindex` hashes unconditionally" (the repair for a stamp that lies). `reindex({full:false})` is stamp-skipping, `full:true` wipes pins, and the `force` scope that hashes without wiping has no caller | Non-full `memory.reindex` uses the `force` scope. Test: a file changed with mtime and size preserved is re-indexed by `memory.reindex` and pins survive | OPEN |
| X-14 | §12.3, L2396 · §12.5, L2416 | The memory pack's "company standards + role playbook + project decisions" clauses include only **pinned** notes. Pack-seeded standards are written unpinned, so the engineering conventions enter only through keyword search. The decision log reaches only roles whose `memory_scopes` include `project` ("every employee reads this") | Composition includes seeded company standards and the role playbook whether pinned or not, and `project/decisions.md` for every employee on a project, within the budget. Tested against the shipped engineering pack. **Or** §12.3/§12.5 annotated with what the clauses actually include, with a §0.1 row | OPEN |
| X-15 | §12.4, L2402 | Memory-proposal reviews are "raised at most once per phase". Reuse only covers a still-pending review, so once one is answered the next proposal in the same phase raises another | A proposal in a phase whose review was already raised attaches to the next phase's batch (or a recorded equivalent), tested with two proposals either side of an answer. **Or** the rule's pre-M11 meaning (phases exist only at M11) recorded in §12.4 and MOVED: M11 | OPEN |
| X-16 | §14.4, L2645 · §9.1, L1909 · §28 M9 item 7 | The Checkpoints view shows only title and context in `created_at` order. It lacks: `blocking` first, the chat card, `J`/`K`/`1`–`9`/`Enter`, answered checkpoints kept for the session, and single-keypress permission answers | The view renders `CheckpointCard`, sorts `blocking` first, and keeps the session's answered checkpoints with their decision. Keyboard `J`/`K`/`1`–`9`/`Enter` works, and a permission checkpoint is answerable with one key. An e2e test drives it by keyboard only | OPEN |
| X-17 | §14.9, L2675 · §28 M9 item 7 | A pinned note in the memory list has an icon and a screen-reader-only label, so there's no **visible** label ("never colour alone", icon *and* label) | A visible "Pinned" label beside the icon in the list, with a renderer test asserting it | OPEN |
| X-18 | §14.9, L2676 | Editing an `employee/` note from the Memory view always fails: `memory.write` passes `employeeId: null` and confinement refuses employee scope without an owner | The view derives the owning employee from the note path and the handler confines to that employee's directory (still refusing traversal and junctions), **or** the view offers no Edit on `employee/` notes and §14.9 says so. Handler-level test either way | OPEN |
| X-19 | §22.4, L3235/L3241 | One-shot resolution: `model` is the **main engine's** fast-tier model whatever the provider, so an `openai`/`google` provider gets an Anthropic model id. `engines.oneshotProvider` stores `''`, not "same as the main engine" | `oneshotConfig` resolves the fast-tier model **for the one-shot provider**, and the stored default and its resolution match §22.4's text (or §22.4 amended, with a §0.1 row). Unit tests per provider | OPEN |
| X-20 | §22.4, L3244 | No Settings entry: "Add a key for small helper tasks (optional — a few cents a month)" with the honest note | Settings offers the entry, the key is stored through the secrets path (never a value in settings) and the note is shown. Renderer test. **Or** MOVED: M14 (settings completeness) with the reason | OPEN |
| X-21 | §22.4, L3250 | The error-message-rewriting fallback isn't built: nothing gives "unknown errors show raw text plus a 'report this' action" | Unknown errors reaching the user carry a "report this" action (curated messages per known code already exist via `UserFacingError`). Renderer test. **Or** §22.4's row annotated as superseded by `UserFacingError`, with a §0.1 row | OPEN |
| X-22 | §22.4, L3254 | One-shot usage rows record no cost, so project spend increases by 0, and nothing charges the Director reserve when no project is active | A one-shot call's cost is computed from its reported usage (or recorded as "cost not reported") and counted against the project budget or the Director reserve per §22.4, with `cost.oneshot_recorded`. Tested both ways | OPEN |

---

## §C: Earlier audits' leftovers and record corrections

**Untouched MINORs from `docs/AUDIT-M3-M6.md`** (verdicts from the regression check):

| ID | What | Done when | Status |
|---|---|---|---|
| M3-6 #24 | No coverage tooling in the repo, only a `--no-save` install | `@vitest/coverage-v8` added as a devDependency, a `test:coverage` script, baseline recorded (not a CI gate yet). `NEXT-VERSION` §E.1 updated | OPEN |
| M3-6 #27 | §5.1 says `secrets_meta` holds "no values", but `storage_ref` is DPAPI ciphertext | §5.1 corrected, §0.1 row added | OPEN |
| M3-6 #29 | A `usage.ts` comment says `usage` has no `project_id`; the INSERT below it writes one | Comment corrected (same file as N-1, so do them together) | OPEN |
| M3-6 #30 | `eslint.config.mjs` ignores lack `.claude/**` | Added | OPEN |
| M3-6 #20 | Lease-exclusivity spy; the premise was measured wrong | Row closed with the regression check's reason | OPEN |
| M3-6 #26 | `usage.computed_cost_usd_micros` is written and never read | Row marked MOVED: M14 (Costs view) | OPEN |

**Cheap real residuals from `docs/AUDIT-M0-M2.md`'s "fixed with a narrowing" rows:**

| ID | What | Done when | Status |
|---|---|---|---|
| M0-2 #10 | The contrast test doesn't check `bg-inset` for four tokens | Covered, or each pairing shown not to occur | OPEN |
| M0-2 #23 | The `company` stateDelta slice isn't watched live | Added to `liveState.ts`, or reasoned out in the row | OPEN |
| M0-2 #24 | `modelDiff` wasn't lifted into CI with the other three spec checks | Lifted and mutation-confirmed, or declined with a reason | OPEN |
| M0-2 #29 | No runtime guard against `logEvent` inside a transaction | A `db.inTransaction` assertion in `logEvent`, tested, or declined with a reason | OPEN |
| M0-2 #7 | The unmetered count is a roster-wide superset | Scoped correctly, or the superset documented as intended | OPEN |

The remaining narrowed or declined rows (#2 CHECK, #13 `foreign_keys`, #19 log
completeness, #30 rule numbering) were reasoned trade-offs. They stay as they
are unless a session disagrees in writing.

**Record corrections:**

| ID | What | Done when | Status |
|---|---|---|---|
| R-1 | `docs/AUDIT-M0-M2.md`'s status block says audit #24 (coverage) is closed. It isn't | Status block corrected, and its "where this audit's evidence was wrong" list gains a ninth entry | OPEN |
| R-2 | `docs/AUDIT-M0-M2.md` §6(b) prints its status lines as one block after item 4 | Each status under its own item | OPEN |
| R-3 | Known Issues rows whose status may no longer be true | The soak row ("Not fixed") checked against M3–M6 #15's fix (`SOAK_TIMEOUT_MS = 900_000`, which held). The two-suites-at-once row marked **accepted practice: one suite at a time**. The `genericPtyAdapter` row folded into D-3's pattern row. Every row states its real status | OPEN |
| R-4 | `NEXT-VERSION` §H.8 may have been settled by `55b4c22`, which deliberately keeps `zeroCostMode` off the cache | §H.8 marked resolved-by-decision, or left open with the reason | OPEN |
| R-5 | `PROJECT-CHECKLIST.md`'s M5 row still says "branch `m5-part2`, not yet merged". It is merged into `main` | Row corrected | OPEN |
| R-6 | `NEXT-VERSION` sections whose status has changed: §D.3 (eleven open MINORs → now this plan); §J.5 (§9.4 surfaces: Checkpoints view and desktop notification exist, floor signal is M12's); §J.6 (S15 applied at `e10e0e6`); **§H.1 ("the one-shot client has no caller") is stale**, since `checkpoints/duplicateDetection.ts:7` imports and uses `runOneShot` | Each section's status line says what is true today | OPEN |
| R-8 | Two deliberate spec deviations are recorded only in `NEXT-VERSION` (§I.1: permission checkpoints offer two options, not §9.1's three; §J.1: §9.7's in-process signal not built). The spec sections themselves carry no note, unlike §10.6's rules 5/6 | §9.1 and §9.7 each get an in-place build-status note pointing at §I.1/§J.1, the way §10.6 does | OPEN |
| R-7 | Owners never recorded or already expired: chaos #1 (full task-lifecycle kill points), chaos #2 (revoke key mid-task, "M6/M13"), §28 M7 item 8 (pack scaffold and validation "exposed in Settings": the IPC exists, no UI) | Chaos #1 → owner M15. Chaos #2 → M13, after confirming nothing in M6's scope claims it. M7 item 8 → per §E-5 | OPEN |

---

## §D: M11 prep that can be done now

| ID | What | Done when | Status |
|---|---|---|---|
| D-1 | `ProbeOptions.budgetMs` defaults to the 30 s ceiling, so a UI caller that forgets a budget hangs | `budgetMs` required; every caller passes one; typecheck enforces it | OPEN |
| D-2 | The shutdown sequence stops no Supervisor (none exist in production yet) | Supervisors are stopped in `runShutdownSequence` before the control channel drains, tested with a live FakeAdapter Supervisor | OPEN |
| D-3 | Real-process tests with wall-clock bounds flake on a cold page cache. Six Known Issues occurrences, including `genericPtyAdapter` §7.8 test 3. The mechanism is known from §7.8's measurement | Every remaining real-process `elapsed <` assertion removed or replaced with a correctness assertion, as done for `probe()`. Packaged-app launch timeouts (`Bureau.exe`, 224.6 MB) given cold-start headroom. Known Issues rows updated | OPEN |
| D-4 | `EmployeeContext.effectiveAutonomy` (`src/shared/engine/types.ts:156`) is read by nothing. `NEXT-VERSION` §H.7 says fix this **before M11 builds the context composer** | Field removed from the interface (§H.7 option 1), or kept with a real reader. §H.7 marked resolved | OPEN |
| D-5 | Nobody has proven that a crash **during** `reconcile()` is safe (M0–M2 report §6(c) item 7). M11 lengthens `reconcile()` | First check whether `reconcileCrashWindows.test.ts` already kills mid-reconcile and re-runs to convergence. If so: DONE, citing it. If not: one kill point inside `reconcile()`, re-run, and assert convergence with no duplicate events | OPEN |

---

## §E: Decisions for Nikunj

Recommendations are pre-filled. Sessions proceed on the recommendation if
Decision is empty, and write "recommendation followed".

| ID | Question | Recommendation | Decision |
|---|---|---|---|
| E-1 | Track `docs/artifacts/REGENERATION.md` in git? It's 400+ lines of pending notes with no backup | Track `REGENERATION.md` and `README.md` only; keep the HTML pages untracked | Nikunj: recommendation accepted (2026-09-17) |
| E-2 | N-11: wire the worktree lease now, or declare it reserved? | Declare it reserved and write the double-assignment guarantee M11 must meet. M11 builds assignment and will know its real shape | Nikunj: recommendation accepted (2026-09-17) |
| E-3 | N-7: wire `autonomy.default`, or mark it reserved? | Wire it at hire (small, and it already appears in the Settings group) | Nikunj: recommendation accepted (2026-09-17) |
| E-4 | **Risk #34 (owner M3, never done): do Claude Code's terms allow orchestrated, parallel, headless use on a Pro/Max subscription?** M11 is where Bureau starts doing this at scale | **You read the current Anthropic terms and usage policy yourself** before M11 starts, and record the answer on risk row #34. A session can gather links but must not decide it | |
| E-5 | §28 M7 item 8: pack scaffold and validation "exposed in Settings". The IPC exists; there is no UI | MOVED to M14 ("settings completeness"). You plan to redesign the front end after the phase anyway | Nikunj: recommendation accepted (2026-09-17) |
| E-6 | **`main` is 164 commits ahead of GitHub.** The last push was 2026-08-21, so all M1–M10 work exists only on this machine. Sessions are told never to push | **Push `main` yourself**, right after §0.1's commit, and again when this plan closes. A disk failure today would lose everything since M0 | Done by Nikunj 2026-09-17: pushed `43b58bf..2ffc0d9` after marking the two fake token fixtures as test values (§F). Push again at plan close |
| E-7 | **Trace M7–M10's spec requirements line by line before M11?** The M0–M2 and M3–M6 regions were traced MUST by MUST; M7–M10 (packs, checkpoints, chat, memory) never has been. This plan covers what was *recorded* as missing, not requirements nobody noticed. **This is the one kind of gap no sweep of documents can find** | **Yes, once, bounded:** a read-only trace of §6, §9, §12, §13.3, §14.2, §22.4 and §28 M7–M10 (Phase 1 only: no mutations, no lenses), with its results added to this plan as §B5 in the same pass and no second round. If you choose no, those gaps surface in M11 or in the post-M11 audit instead | Nikunj: recommendation accepted (2026-09-17) |

---

## §M11: Required in M11 (cannot be built before)

These need M11's code to exist. They are **gate items for M11 session 1**
unless marked otherwise.

1. **§10.6 rule 5**: merge the integration branch into `base_ref` on phase
   acceptance, in the same session that builds phase acceptance.
2. **The first `spawnSupervisedEmployee` production caller** (`NEXT-VERSION`
   §H.6), with registry, live capabilities to policy (N-3) and shutdown (D-2)
   verified in production shape.
3. **The lease decision (§E-2)** honoured by the assignment path.
4. **§28 M9's gate**, deferred to M11 (§L.1, §K.1): a full conversation
   including brief approval works end to end, now with a real producer.
5. **Every new `bureau_` tool the Director gets** that takes a path, git ref,
   branch or URL has a handler-side guard and a handler-level test.
6. **§26.1 user-message coalescing** while the Director is mid-turn (parking
   lot, 2026-09-07), in M11's trigger queue.
7. **The Director's restart report** (§I.3): the post-restart grace suppresses
   silently until something reports it.
8. **§9.7 "the Director is notified"** for an unfillable role (§J.3).
9. **Bound `buildFullSnapshot`'s `tasks` slice** before M11 creates tasks
   (§N.5).
10. **Attachments reach the Director's context** (§L.2), **brief `requestEdit`
    gets its §5.2 event** (§L.4), and **the Director's memory tools and
    Appendix B prompt slots** (§M.4, §M.5).
11. **The one-shot client's first real caller**: intent classification (§H.1).
12. **The conversation switcher** once there is more than one (§K.2).
13. **The deliverable-shape recommendation** in the interview: recommend local
    vs hosted with consequences, don't ask.
14. **§9.3's grouped checkpoint message** (trace 9.3-2, §B5): batching decides
    today, but nothing writes the one message "grouped by the Director".

---

## §After: Tracked, not before M11

| What | Owner |
|---|---|
| The scheduled post-M11 phase-boundary audit (covers M7–M11) | after M11 |
| Quota management for subscription users (budgets only count dollars) | before v1 |
| Local-runnable deliverable (double-click to open) | v1 |
| Persist probe results across restarts (§H.3.1); `auth status` network tail (§H.3.2); parallel probe launches (§H.3.3) | when hiring is wired / when it matters |
| True post-reboot verification of the probe fix | next real reboot |
| `stateDeltaReconnect.spec.ts` unreproduced failure | on recurrence: capture renderer console and hydration state |
| Employee badges: "untested version" (M3–M6 #6) and `limited-control` (#11) | M14 |
| Error remedies with nowhere to go (§K.4); no file picker (§L.3); plan hand-editing (§L.5) | M13 / M14 |
| Surfacing a dropped floor pin to the user (PROGRESS, M7 s2) | M12 |
| Pack `requires.tools` surfaced in the setup wizard (§6.3; trace 6.3-3) | M13 |
| The report card's diff link (§14.2; trace 14.2-5), with the Files-with-diffs view | M14 |
| `claims.yaml` and the claim-audit job (§19.6; DoD #9) | M15 |
| Risks #22 antivirus (M15), #24 OneDrive (M13), #32 asset licences (M12), #33 trademark (before M15), #36 copyleft deps (M15) | as listed |
| Future scope: modalities/multi-engine (§B.1, §5 item 6), reference material beyond schema (§B.2), PTY mode (§B.7), voice (v1.2), spend-board floor prop (M12) | NEXT-VERSION |
| Open product questions in `PROJECT-CHECKLIST.md` §5 (monetisation, name, telemetry, voice, team/cloud) | none blocks M11; decide before M15 |
| Regenerate the three artifact pages from `docs/artifacts/REGENERATION.md`'s pending list | after M11 (its own schedule) |
| Long operations with no job id (`NEXT-VERSION` §N.1–§N.4: `compactDb`, `backupDb`, `memory.reindex`, `packs.install`) | recorded against the milestone that makes each slow |
| Scheduled scope: nine more roles, voice, smaller items (`NEXT-VERSION` §A.1–§A.3) | NEXT-VERSION |
| Accepted limitations (`NEXT-VERSION` §C.1–§C.4) and accepted designs (§H.2 finite name pool, §M.3 interrupted-accept residual, §L.6 `markRead` without an event) | no action; decided |
| Known Issues rows that are practice or tooling notes, not defects (source edits during packaged runs; this coding tool reaping orphans; the stand-in class, now a standing rule) | no action |

---

## §F: Found while fixing

Anything new a session notices goes here, **not** into the work (rule 2).

| Found by | What | Proposed owner | Fixed now? (only if M11-breaking and in an edited file) |
|---|---|---|---|
| Push to GitHub, 2026-09-17 (step 3) | GitHub push protection blocked the push: the fake Slack (`tests/unit/workspace/secretScan.test.ts`) and Databricks (`tests/unit/secrets/redactor.test.ts`) fixtures match real token shapes. Nikunj marked both as test values and the push went through (`43b58bf..2ffc0d9`). Any new or edited fixture of that shape will trigger it again | Pre-M11 plan (test hygiene, same class as N-4): build token-shaped fixtures at run time (e.g. `'xoxb-' + '…'`) so no literal full token is ever committed. Tests still assert detection | No: not M11-breaking, and no listed item edits these files |
| 0.3, 2026-09-17 | `m0-skeleton` holds one commit (247c1f1, a `package-lock.json` sync, 2026-08-21) that is in neither `main` nor any remote branch, so `git branch -d` would refuse it. It is almost certainly superseded by later lock-file changes, but that call is Nikunj's, not a session's | Nikunj: inspect, then `-D` or keep | No: not M11-breaking |
| N-1, 2026-09-17 | `claudeCodeAdapter`'s child `exit` handler calls `flushOneQueued()` whatever the Supervisor's state, so a send queued before a park launches a new billed `claude -p` turn. Its usage is now recorded (N-1) but the turn still runs. The audit's suggested fix: have the flush ask the Supervisor, or drop the queue on park | M11 (the first production Supervisor caller) | No: not in N-1's Done-when, and `claudeCodeAdapter.ts` is not otherwise being edited |
| P-2, 2026-09-17 | `GenericPtyAdapter.probe()` answers `installed: false, determined` ("no command configured") until a command is bound, and `assign()` now refuses that. Its class comment names `boundCommand` as the seam, and no production code constructs one yet. M11's per-employee construction must pass `boundCommand` from the role's `engine_options.command` (or the "no command" answer should become its own non-determined state) | M11 (the first production Supervisor/adapter construction) | No: nothing constructs a generic-pty adapter in production; the one test that assigned an unbound one now binds it |
| P-3, 2026-09-17 | Durations still measured on the wall clock, outside P-3's named inventory: heartbeat silence (`adapter.lastActivityAt` vs `Date.now()`; a forward jump fires a false 'hung' crash, a backward one never does), the breaker's wall-clock and token-velocity windows, `LoopDetector`, and the IPC and control-channel rate limiters. Same fix shape: `performance.now()` behind an injectable clock | M15 (hardening, alongside chaos #1) | No: outside the row's Done-when, and none breaks M11 unless the clock jumps |
| P-5, 2026-09-17 | A worktree deleted mid-session is not noticed until the next git operation on it (in practice the commit), because there is no file watcher and `reconcile()` runs only at startup. The employee keeps working in a directory that no longer exists until then. Fail-safe at discovery is tested (`worktreeDeletedMidTask.test.ts`) | M11 (assignment could check the worktree exists before each task), or M15 hardening for a watcher | No: stated and tested as the row requires; detection is new behaviour |
| P-6, 2026-09-17 | Before phases exist, `resolveDefaultIntegrationRef` returns `base_ref`, and `mergeAcceptedTask` moves the integration branch with `update-ref`. A CLEAN merge therefore moves the branch the user has checked out in their own checkout without touching their working files, which then look like they revert the merged work (`git status` shows the employee's changes as the user's uncommitted edits). §10.6 rule 5 says the base branch is written only on phase acceptance. M11 builds phases and must never merge a task directly into a checked-out `base_ref` | M11 (phases and rule 5; plan §M11 item 1) | No: not reachable from production before M11 (nothing calls `mergeAcceptedTask`) |
| P-9, 2026-09-17 | The engine version-drift check (checkEngineVersionDrift) compares the probe's raw version string, which the real CLI reports as '2.1.238 (Claude Code)', against the pin '2.1.238', so employee.engine_version_drift fires on every spawn against the exact tested version. A warning that always fires is one nobody reads. Fix: compare the leading semver | M11 (the first production spawns make it visible) | No: a false warning, not M11-breaking, and engineVersionDrift.ts is not otherwise being edited |
| P-10, 2026-09-17 | job-object.test.ts's original direct-child case passes with Bureau's Job Object switched off: libuv puts every non-detached child in its own kill-on-close job, so the child dies with its parent regardless. It proves nothing about Bureau's containment. Fix: spawn that dummy detached too (the grandchild case already does) | M15 (hardening; the grandchild case now carries the real proof) | No: not M11-breaking |
| P-10, 2026-09-17 | containProcess() has no production caller: only the smoketest contains a process, and ensureJobObject() at startup creates the job without putting anything in it. Engine CLIs are non-detached and so die with Bureau through libuv's own job, but anything detached, or spawned by a non-libuv process such as a CLI's own helpers, is not covered. M11's first spawnSupervisedEmployee caller should contain the engine process immediately after spawn | M11 (plan §M11 item 2, the first production Supervisor) | No: nothing spawns engines in production before M11 |

---

## §G: Final sweep

Run one suite at a time, with no `src/` edits while a packaged suite runs:

`format:check`, lint, typecheck, `check:ipc-surface`, `check:schema-spec`,
`check:event-taxonomy`, `check:settings-spec`, unit, `npm run package` then
integration (staleness gate confirmed by name), contract, e2e including
S13/S14, `test:security` with both runs reported, and the `test:coverage`
baseline.

---

## §H: Coverage check (last step, bookkeeping only)

This check **re-tests nothing and investigates nothing new.** It confirms
that every item is accounted for. Paste each result into the §H results table
below.

1. **No open rows.** `grep -cE '^\|.*\| OPEN \|$' docs/PRE-M11-PLAN.md`
   returns `0`. The pattern is anchored to table rows, so this line can't
   match itself.
2. **Every decision made.** No empty Decision cell in §E, except E-4 and E-6: E-4 gates M11's start, not this plan's close, and E-6 is Nikunj's own push.
3. **Every DONE has a real commit.** For each `DONE <hash>`,
   `git cat-file -t <hash>` returns `commit`.
4. **Audit reports agree with the plan.** No empty Outcome cell remains in
   `docs/AUDIT-M0-M2.md`, `docs/AUDIT-M3-M6.md` or
   `docs/AUDIT-M3-M6-REGRESSION.md`'s findings tables for any item this plan
   resolved.
5. **The source ledger holds.** For each §S row, confirm its items appear in
   this plan with a resolved status, or in §M11 or §After with an owner.
6. **`PROJECT-CHECKLIST.md` agrees.** No risk-register or chaos-scenario row
   whose owner is M0–M10 still says "Not started" without a resolved plan
   row. Every Known Issues row states a real status.
7. **`NEXT-VERSION.md` agrees.** Every section this plan touched carries its
   updated status.
8. **§F is settled.** Every §F line has an owner, and any line marked "fixed
   now" has a commit.
9. **Nothing below M11 is stubbed.** `grep -rhoE "stub\('M([0-9]|10)'\)" src/`
   returns nothing.
10. **No unowned dead setting or event.** Every setting and event type listed
    in §B4 (S-1 to S-5) is wired, emitted, or carries an owner annotation.

**§H results:**

| Check | Result | Evidence |
|---|---|---|
| 1 | | |
| 2 | | |
| 3 | | |
| 4 | | |
| 5 | | |
| 6 | | |
| 7 | | |
| 8 | | |
| 9 | | |
| 10 | | |

When all ten pass: set this file's status to CLOSED, unblock M11 in
`PROJECT-CHECKLIST.md`, and add a `PROGRESS.md` entry. **M11 starts next.**

---

## §S: Source ledger (the sweep this list came from)

Three passes on 2026-09-17 (reading, files the first pass missed, and scripts over whole categories). Each source, and where its open items went:

| Source | Checked | Open items → where |
|---|---|---|
| `docs/AUDIT-M3-M6-REGRESSION.md` (N-1…N-17, Parts 1–5) | all | §A, §B, B-1, §C, §D-1/D-2, §M11 1–5 |
| `docs/AUDIT-M3-M6.md` (30 rows) | all | §C (untouched MINORs); #6/#11 badges → §After; #13 → §A N-9, §M11 1 |
| `docs/AUDIT-M0-M2.md` (30 rows, §6(b), §6(c)) | all | §C residuals, R-1, R-2; §6(c) item 7 → D-5 |
| `PROJECT-CHECKLIST.md` §1 DoD (9) | all | #4/#7 → §M11 / M15; #9 → §After |
| `PROJECT-CHECKLIST.md` §2 milestones | all | R-5 (M5 row); M11 row → 0.2 |
| `PROJECT-CHECKLIST.md` §3 risk register (36) | all | #21 P-7, #23 P-6, #34 E-4, #35 P-8; the rest are Director-owned (§M11) or future (§After) |
| `PROJECT-CHECKLIST.md` §4 chaos scenarios (13) | all | #1 R-7, #2 R-7, #4 P-1, #6 P-5, #9 P-2, #10 P-3, #12 P-4 |
| `PROJECT-CHECKLIST.md` §5 questions, §6 parking lot | all | coalescing → §M11 6; the rest → §After |
| `PROJECT-CHECKLIST.md` Known Issues | all | R-3, D-3; practice notes → §After |
| `docs/BUILD-SPEC.md` §28 M0–M10, item by item | all | M7 item 8 → R-7/E-5; M8 item 6 floor → M12; M9 gate → §M11 4; M10 watcher → recorded §M.2 |
| `docs/NEXT-VERSION.md` (72 sections) | all | §E.1 → M3-6 #24; §E.2 → P-9; §H.7 → D-4; §H.8 → R-4; §H.9 → P-2; §K.5 → N-2; §L.7 → P-4; §D.3/§J.5/§J.6 → R-6; M11-owned → §M11; future → §After |
| `PROGRESS.md` deferrals naming M0–M10 | all | none open beyond the above (`${bureau_state}` settled in code; floor pin → §After) |
| `docs/BUILD-SPEC.md` §19 required test approaches (9 areas) | all | policy fuzz T-3, redactor property T-2, checkpoint property T-1, IPC fuzz T-4, migration upgrade path T-5; leases ✓ built; brief/plan schemas ✓ built; Director behaviour → §M11; lifecycle kill points → R-7 (M15) |
| `docs/BUILD-SPEC.md` §21 / `CLAUDE.md` invariants | all | invariant #4 → P-12; invariant #5 carve-out already recorded; #13 `claims.yaml` → §After (M15) |
| `docs/progress/M0-M2.md` (the August audit record) | all | #6 grandchild containment → P-10; the other eight checked by the M0–M2 re-audit |
| `.github/workflows/ci.yml` | all | `test:security` missing → P-11 |
| `HOW-IT-WORKS.md` (19 "still missing" notes) | all | dated per-part narrative, not current claims → no action |
| `CONTRIBUTING.md`, `docs/CLAUDE-CODE-PROMPTS.md`, `docs/AUDIT-PROMPT.md`, `docs/bureau-overview.html`, `electron-builder.yml`, `native/`, `scripts/` | all | no open work items; packaging config → M15 |
| Code: `stub('M…')` | all | none below M11 (M11 14, M12 3, M13 12, M14 11, M15 3) |
| Code: `.skip`/`.todo`/`.only`, `TODO`/`FIXME`/`HACK` | all | only opt-in real-spend gates (by design, P-9); no real TODOs |
| Git: branches and worktrees | all | 0.3; 164 unpushed commits → E-6 |
| **Mechanical sweep (scripts over whole categories):** 52 settings vs readers; 142 event types vs emitters; 7 IPC error codes vs producers; §7.9 tools vs handlers; 209 test files vs suite globs; 338 columns vs users; `npm audit`; committed-secrets scan | all | S-1 to S-6; N-9 (`protected_refs`); error codes, test globs and secrets clean; 17 unbuilt tools are Director tools → §M11 |
| `CLAUDE.md` invariants #1–#15, each mapped to code or tests | all | #3 → S-4; #4 → P-12; #5 carve-out recorded; #13 → §After (M15); #15 → P-13; #1/#2/#9-in-conversation → §M11; #10/#14 → M12; the rest have tests (#6 fail-closed suites, #7 `checkpointTimeoutIsSafe`, #8 consequence validation, #11 S13, #12 money round trip) |
| `CLAUDE.md`'s 16 "looks reasonable and is wrong" traps, each mapped | all | `finished` ≠ done → P-14 (unpinned); hook deadline → S-1; batching questions → §M11; Phaser `file://`, fractional scaling → M12; the other 11 have code or tests (no disable-log setting among the 52; `immutableWidening`; §7.4 real-adapter queue test; resolved-PATH service; structured mode; `ErrorNotice` test; native-modules packaged test; long-poll hook; autonomy written only by the user's IPC handler, pinned by `autonomy.test.ts`; "$0.00" #7; restart-grace tests) |
| **Not coverable by any sweep of documents:** requirements in M7–M10's spec sections that nobody recorded as missing | — | E-7 (your decision) |
| **M7–M10 spec trace (E-7)**: `docs/TRACE-M7-M10.md`, 270 requirements across §6.2–§6.8, §8.0, §7.9 (four tools), §9.1–§9.7, §12.1–§12.5, §13.3, §14.2, §14.4, §14.9, §22.4, §28 M7–M10 | all | 59 PARTIAL/NOT MET: 10 already plan rows (R-7/E-5, R-8, §M11 4/8/10); 6 recorded deviations (`NEXT-VERSION` §M.1, §K.3, §L.5; spec §12.1 note); 3 later-owned → §M11 14, §After ×2; 4 reasoned as not gaps in the report; 36 → §B5 X-1…X-22 |
