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
| 0.1 | Commit `docs/AUDIT-M3-M6-REGRESSION.md`, its staged Outcome corrections to `docs/AUDIT-M3-M6.md`, and this file | One `docs:` commit | OPEN |
| 0.2 | Point `PROJECT-CHECKLIST.md` §2's M11 row at this plan | M11's row says "blocked on docs/PRE-M11-PLAN.md" | OPEN |
| 0.3 | Remove stale local branches: `m0-skeleton`, `m5-part2` and the two `worktree-agent-*` subagent leftovers | List them first. Delete **only** branches `git branch -d` accepts, which is its refusal on unmerged work. Anything it refuses goes to §F, not `-D` | OPEN |

---

## §A: SERIOUS, on the path M11's Director runs

| ID | What (plain) | Done when | Status |
|---|---|---|---|
| N-16 | "The Director is never stopped" is enforced on only one of three stop paths (`supervisor.ts:1287`, `steerBreaker`). `breaker.hardStop` and `budgets.onExceed: stop` can still stop it. The wall-clock breaker trips a long-lived Director after about an hour | One Director guard that every stop path consults (`stopForBreaker`, `applyBudgetVerdict`), or the Director parks instead of stopping. The wall-clock trigger's meaning for a long-lived session is decided (likely per turn). One test per path showing the Director survives, each mutation-confirmed | OPEN |
| N-1 | While parked or paused, `handleEvent` returns before **every** event (`supervisor.ts:758`), including `turn.completed`. A turn that really ran is never billed. The #8 fix's test asserts this as success | The park gates **state transitions**, not **accounting**: usage is recorded, the ledger row written, counters updated and `cost.turn_recorded` emitted, and only `→ working` is refused. `parkedIsAGate`'s money assertion is rewritten, plus a test that no `employee.working` follows `employee.parked` (M10′). Also closes `docs/NEXT-VERSION.md`'s related notes | OPEN |
| N-2 | Secrets are redacted on live pushes but not on request/response IPC, e.g. `chat.listMessages` on every window load (also `NEXT-VERSION` §K.5) | Redaction happens once, in `dispatchIpcCall`, after output-schema validation. S4's IPC leg covers a request/response method and is mutation-confirmed. §K.5 is marked resolved | OPEN |
| N-9 + #13 rule 6 | The immutable `git_write` deny misses ordinary `git push` shapes, and nothing detects a push | Terms widened (`git push`, `git push *`, `-C`/`--git-dir` forms) as a §11.3 amendment logged in §0.1, each mutation-tested. **Plus a push detector** (compare remote refs or reflog around a turn, the way layer 4 checks HEAD), because matching shell text can never be complete. Rule 6 ("push is an approval checkpoint") is built on the detector. The detector and rule 6 consult `projects.protected_refs` (stored since M1, default `["main","master"]`, read by nothing today) | OPEN |
| N-14 | The hook binary every tool call passes through has fail-closed branches that no free test runs | A free integration test runs the real bundled `bureau-hook.js` via `process.execPath` in four cases: no env, missing/malformed `control.json`, killed Core, and live Core returning allow and deny. It asserts stdout JSON **and** exit code, and is added to `test:security` | OPEN |
| N-6 | S7's "and stays stopped" step never reaches the Supervisor, because the FakeAdapter has no `keepOpen` | `keepOpen: true`, or the step replaced by `parkedIsAGate`. `parkedIsAGate.test.ts` added to `test:security` and S7's coverage mapping. Other `pushEvent` calls on non-`keepOpen` adapters grepped and checked | OPEN |
| N-10 | Most immutable-deny terms are pinned by one test assertion at most, several by none | One exemplar per term (every glob, every alternation branch) in `immutableWidening.ts`'s table. Credential-path and Program Files reads added to S2's real-evaluator loop | OPEN |

---

## §B: MINOR, from the regression check

| ID | What | Done when | Status |
|---|---|---|---|
| N-3 | The autonomy floor fails **open** when capabilities are unknown, and it lives in two functions of which production calls one | Unknown capabilities → the floor applies (`ask`), per invariant #6. The unused parameter is removed so the decision lives in one function. A test covers unknown capabilities | OPEN |
| N-5 | The Director side of the **project**-level reserve is untested; every Director test is `globalDaily` | A project-level pair in `directorReserveLive.test.ts`: not parked at `project − reserve`, and parked with an approval checkpoint past the full project budget | OPEN |
| N-7 | `autonomy.default` is a spec'd, registered setting that nothing reads | Per §E-3: wired at hire with a decided precedence (§16.1 global → §6.5 role → per employee), or marked reserved in §16.1 and the registry | OPEN |
| N-8 | The unconfirmed-`autonomous` → `guided` downgrade is pinned by unit tests only | One S2-style case in `policyRealEvaluator.test.ts` through the real HTTP path, asserting `ask` | OPEN |
| N-11 | The worktree lease is a guard nothing on the production path calls, and "renewed on every heartbeat" isn't implemented | Per §E-2: wired and tested, **or** §10.3/§28 amended to mark the lease reserved and state the double-assignment guarantee M11 must meet | OPEN |
| N-12 | Reconcile's standalone `git worktree prune` can be removed and the suite stays green | Reconcile test: delete a worktree directory externally, run `reconcile()`, assert `git worktree list --porcelain` no longer names it | OPEN |
| N-13 | `bureau_task_blocked`'s cross-employee rejection is an untested copy of `bureau_task_done`'s | One shared helper both call, or the crossed-id test parametrised over both | OPEN |
| N-15 | Nothing asserts the eslint rules the codebase relies on | `configurationIsInForce.test.ts` loads the real config (`ESLint.calculateConfigForFile`) and asserts `no-explicit-any` and the other invariant rules are `error` | OPEN |
| N-17 | `attachments.ts` confinement has no junction or short-name test case | A "refuses a path that escapes only through a junction" test, mirroring `memoryWriteConfinement.test.ts` | OPEN |
| N-4 | A test writes engine config into the repo root, tracked with a machine-specific path | `mkdtemp` `stateDir`; `git rm` both files; `.gitignore` them | OPEN |
| B-1 | `bureau_task_done` stores `artifacts[].path` verbatim and never validates it (regression check Part 4 §3). Harmless until something opens it. Invariant #5's carve-out makes the handler the only guard for a `bureau_` tool | The handler confines each path to the employee's worktree: canonicalise, confine, fail closed, following the `attachments.ts`/`memoryTarget.ts` pattern. Handler-level test including a junction escape | OPEN |

---

## §B2: Promised by past milestones, never done

These come from `PROJECT-CHECKLIST.md`'s risk register and chaos scenarios,
§28 and `docs/NEXT-VERSION.md`. Each one's owning milestone has already
passed, and its status still says "Not started".

| ID | Source | What | Done when | Status |
|---|---|---|---|---|
| P-1 | Chaos #4 (owner M5) | Fill the disk during a commit | A test injects ENOSPC inside `commitTaskWork`'s write step and asserts fail-safe: no half commit, the pending-commit marker handled, `reconcile()` converges | OPEN |
| P-2 | Chaos #9 (owner M3) + `NEXT-VERSION` §H.9 | The engine CLI is uninstalled while running; and `assign()` doesn't refuse a *determined* "not installed" (it fails later at spawn with an untranslated error) | `assign()` refuses a determined `installed: false` with a plain-language error (CLAUDE.md: translate, don't show raw engine output). A test removes or renames the binary mid-session: the running Supervisor fails closed with a translated message, and the next probe reports it determined-absent. §H.9 marked resolved | OPEN |
| P-3 | Chaos #10 (no owner) | The clock jumps backwards | An inventory of wall-clock logic: checkpoint expiry, the post-restart grace, lease TTL, the 60 s probe cache TTL, the budget daily window, backoff. Each is tested against an injected backward jump, or switched to monotonic time where it measures a duration. Owner recorded as M10 hardening | OPEN |
| P-4 | Chaos #12 (owner M9/M14) + §L.7 | 10,000 events: does the UI stay responsive? `chat.listMessages` is unpaginated and the unread badge relies on that | The **chat half** measured with 10,000 messages (load time and render). Paginate if unresponsive, and update the badge's assumption to match. The activity-timeline half MOVED to M14 | OPEN |
| P-5 | Chaos #6 (owner M5, "partially covered") | A worktree is deleted externally while leased | The uncovered remainder named against N-12's test. Either covered, or its gap stated and tested | OPEN |
| P-6 | Risk #23 (owner M5) | The user edits files while an employee works on them | Behaviour documented with evidence: the user edits their own checkout, the employee works in a separate worktree, and conflicts reach M5's conflict checkpoint. A test exists for that path, or one is added | OPEN |
| P-7 | Risk #21 (owner M5) | A very large repo makes worktrees slow or huge | Measured once: worktree creation on a large fixture (~50k files, shared object store). If acceptable, close with the numbers. If not, MOVED to M15 with the numbers | OPEN |
| P-8 | Risk #35 (owner M9, copy) | The user believes Bureau is responsible for agent output | Plain-language copy in the chat surface that the user is the final reviewer of what employees produce. Presentation stays in the renderer. Risk row updated | OPEN |
| P-9 | `NEXT-VERSION` §E.2 | Opt-in real-spend tests rot, and M11 depends on the real engine | `realAgentGate.test.ts` and `realEngineSpawn.test.ts` run **once** with opt-in enabled (the M4 gate cost $0.0497; on subscription auth it uses quota), with results recorded. Anything that fails is fixed or goes to §F with an owner | OPEN |
| P-10 | August M0–M2 audit #6 (`docs/progress/M0-M2.md:506,563`, SERIOUS, "not built" ever since) | Job Object containment is only tested for a direct child, never a **grandchild**. M11's Director CLI spawns its own node children | A test where Bureau spawns a child that spawns a grandchild, Bureau is hard-killed, and **both** are gone. `docs/progress/M0-M2.md`'s record updated | OPEN |
| P-11 | `.github/workflows/ci.yml` vs §11.7 "release-blocking" | CI runs lint, the spec checks, unit, package, integration, contract and e2e, but **never `npm run test:security`**. Most S-files run incidentally inside other suites, but the suite as a gate does not exist in CI | A `test:security` step in CI after integration, or proof that every file in the script already runs in CI plus a recorded decision. `securitySuiteCoverage` still green | OPEN |
| P-13 | Invariant #15 / BUILD-SPEC §1 ("an employee MUST never claim to be human"), owner M7 (pack content) | Only `packs/operations/prompts/director.md` says it. None of the five engineering role prompts, nor `prompts/_shared/engineering-standards.md` or `definition-of-done.md`, carries the instruction. Employees' text reaches the user through checkpoints, messages and the status bubble | The instruction added once to the shared standards every engineering role includes. **Plus a mechanical check** (in `validatePack` or a test over every shipped pack) that each role's composed prompt carries it, so a new pack can't drop it. Mutation-confirmed | OPEN |
| P-14 | CLAUDE.md trap: "Do not let a `finished` event mean task complete. Only `bureau_task_done` does" (owner M3/M4) | Structurally true today (`handleFinished` only applies a transition `bureau_task_done` staged), but **no test pins it**, the same shape as the config-assertion gaps | A test: an employee turn ends with `finished` and no `bureau_task_done` → the task is **not** moved to `review`/`done`. Mutation-confirmed by making `handleFinished` complete the task | OPEN |
| P-12 | `CLAUDE.md` invariant #4 | The text says layers 2–3 (pattern denies, PATH omission) are "not built; no packs/roles exist until M7 to configure them on". M7 has passed. Layer 2 now exists as `deny.git_write` (and N-9 widens it). Layer 3 (git omitted from an employee's PATH) has never been built | Layer 3 built and tested (an employee's resolved PATH has no `git`, which Core-side git calls don't need), **or** declined with the reason recorded. Invariant #4's text rewritten to state each layer's real status today, and §21 kept verbatim in sync | OPEN |

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
| E-6 | **`main` is 164 commits ahead of GitHub.** The last push was 2026-08-21, so all M1–M10 work exists only on this machine. Sessions are told never to push | **Push `main` yourself**, right after §0.1's commit, and again when this plan closes. A disk failure today would lose everything since M0 | |
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
