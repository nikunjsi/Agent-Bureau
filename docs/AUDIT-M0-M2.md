# M0–M2 phase-boundary re-audit

**Run:** 2026-09-10, against `3af75d9` (`main`), before M11 starts.

**Why this region, out of schedule.** `docs/AUDIT-PROMPT.md` schedules
phase-boundary audits after M2, M6, M11 and M15, and M0–M2 was audited in
August 2026. This is a **re-audit**, for three reasons:

1. **The August audit predates every sharp lens this project later
   developed** — `PROJECT-CHECKLIST.md` §7's standing rules did not exist,
   nor did the M3–M6 audit's central finding (load-bearing tests that
   exercise a stand-in for the production path), nor disciplined mutation
   testing.
2. **There is one proven miss, and it was severe.** `jsonColumnSchema` in
   `src/shared/models/json.ts` was not idempotent under re-parsing, while
   §17.2's dispatcher parses every handler's success payload against the
   same row schemas. `checkpoints.listPending` and `checkpoints.get`
   returned `INTERNAL_ERROR` for every checkpoint with options — every type
   except `information` — for seven milestones. It survived both prior
   audits. The question this audit exists to answer is *what else is shaped
   like that.*
3. **M0–M4 had no real human review.** The product owner was accepting
   plans without reading them until roughly M5.

Also applied: `AUDIT-PROMPT.md`'s own exception clause — *"audit immediately
if a milestone went suspiciously smoothly."* M0 and M2 went smoothly.

**Method.** `docs/AUDIT-PROMPT.md`'s phases, extended to six. **Phase 1
(the two-directional spec↔code trace) was run by an independent subagent**
with no visibility into this project's build conversations, reading only
`docs/BUILD-SPEC.md` and the code — `PROGRESS.md`, `HOW-IT-WORKS.md`,
`PROJECT-CHECKLIST.md` and git history were excluded from its evidence base,
with two scoped exceptions (§0.1's amendment log, and `docs/progress/M0-M2.md`
solely to recover the August audit's nine findings). Phases 2–6 were run by
the orchestrating session directly.

**Phase 3 was run by the orchestrating session, not a subagent, deliberately.**
A mutation verdict is objective — CAUGHT or NOT CAUGHT — so independence buys
little there, while running it in-session buys the ability to write each
verdict to this file the moment it is known. A first attempt at delegating
Phase 3 returned zero bytes after five and a half hours.

**Every subagent finding rated SERIOUS below was re-verified by reading the
cited source directly** before being included here.

---

## Headline

**The foundation is well built, and the things that are wrong with it are
almost all the same thing.**

The mechanically checkable parts of M0–M2 are in genuinely good shape, and the
Phase 1 subagent's scripted diffs say so in four directions at once: §5.1's
schema against the migrations *and* against the Zod models, §16.1's 51 settings
against the registry, §5.2's 139 event types against the enum, and §17.1's 109
methods against the method list, the schemas, the handlers and the preload.
Every one of those diffs came back **empty**. The gates pass, today, for real:
22/22 kill points against a real killed process, S13 and S14 against the real
packaged binary, both native modules loading inside it.

Phase 3 broke the code in eighteen ways. **Eleven were caught, six survived, and
one was caught only by accident** — and the six survivors are not scattered.
Every one is a **declaration rather than a behaviour**: a pragma, a compiler
flag, a partial unique index, an `fsync`, and a function whose result is
injected into its caller as a boolean. *This repository has no test that asserts
a configuration is in force.* One small test file would close four of this
report's findings and immunise every region downstream. That is the single
cheapest, highest-leverage thing on the list.

The one BLOCKER is the question this audit was convened to answer. §5.1's
`jsonColumnSchema` was fixed at M8 after it silently broke every checkpoint with
options for seven milestones. **The fix is incomplete and the residual case is
live, agent-reachable, and on the trust surface.** Any `preview` an employee
supplies that happens to be valid JSON arrives at the renderer as a different
type than the database holds, and a preview of exactly `null` disappears from
the checkpoint card — the card on which a human approves or denies what an agent
wants to do. The test named for idempotency sets that column to `null` in its
fixture.

Two further results are worth stating plainly because they are about the record
rather than the code. **One of the August audit's own fixes has been undone in
the exact file its record calls clean** (finding #4) — a fix the record says is
done is worse than one never made. And **§0.1's amendment log claims to list
every spec change and lists 8 of 32**, including one entry describing a
narrowing of a release-blocking security test's assertion that was never
applied — so S15 still promises "zero egress" while the log says that promise
was withdrawn.

Underneath all of it is one pattern, and it is the answer to *what else is
shaped like `jsonColumnSchema`*: **both prior audits verified that a mechanism
exists, not that anything reaches it.** A schema with no production caller, a
guard with no coverage, a MUST whose test re-implements it, an index whose test
proves the transaction instead. In every case the thing is present and correct
in isolation, and reading cannot see the absence of the connection to it. Only
mutation can — which is why Phase 3 found six survivors that a careful
17-finding read-through did not name.

---

## What M11 inherits and this audit could not prove

The short list, at the top because it is the reason this audit ran now. Detail
and evidence in **Phase 6(c)** below.

1. **#1 (BLOCKER)** — checkpoint previews are type-mangled between the database
   and the renderer, and a preview of exactly `null` / `true` / valid JSON
   vanishes from the card entirely. M11's Director is the main producer of
   checkpoints, and this is the surface on which a human approves its plans.
2. **#2** — nothing validates an event at write time, and `reconcile()`'s repair
   path will fabricate a `seq` for a line missing one. M11 emits more event
   types than any milestone so far.
3. **#9** — the kill-point gate does not check for lost committed state at 12 of
   its 22 points, and M11's brief / plan / phase / task writes are exactly the
   state that gate is supposed to certify.
4. **#22** — no IPC rate limiting, in the milestone where an IPC call first
   costs money on every invocation (`chat.send` → a Director turn).
5. **#23** — `projects` and `tasks` reach the renderer only on window load. M11
   is the first milestone that writes tasks while a window is open.
6. **Unproven** — that a crash *during* `reconcile()` is recoverable. It is not
   obviously idempotent and no test kills it mid-run; M11 lengthens its work.
7. **§10.6 rules 5 and 6 (audit #13)** — confirmed still entirely absent, and
   the deferral's stated reason ("triggered by M8/M11 events that do not exist")
   expires at M11. See Phase 6(d).

---

## Findings

Severity per `docs/AUDIT-PROMPT.md`: **BLOCKER** = M11 would be built on
something broken · **SERIOUS** = real gap, fix before it compounds ·
**MINOR** = tidy when convenient.

Source column: **P1** = Phase 1 subagent (spec↔code trace) · **P3** = Phase 3
mutation testing · **self** = orchestrating session (Phases 2, 4, 5).

**Outcome column is deliberately empty.** `PROJECT-CHECKLIST.md` §7's standing
rule 8 requires the session that closes a finding to fill in its outcome here,
in the same commit. Three rows in `docs/AUDIT-M3-M6.md` went stale for want of
one.

| # | Severity | Src | Area | Finding | Evidence | Suggested fix | Effort | Outcome |
|---|---|---|---|---|---|---|---|---|
| 1 | BLOCKER | self | §17.2 / §5.1 `jsonColumnSchema` | **The M8 fix to `jsonColumnSchema` is incomplete, and the residual case is agent-reachable and user-visible.** The union still double-parses whenever `inner` accepts a string — which is exactly `checkpoints.preview` (`z.unknown()`). An employee sets `preview` via `bureau_raise_checkpoint`; if that string is itself valid JSON, the value the renderer receives is a **different type** from the value the database holds. `kinds.tsx:654` branches on `typeof preview === 'string'`, so a JSON-object string renders reformatted, and `preview: "null"` makes `preview !== null` false and **the preview block disappears from the checkpoint card entirely** — on the surface where a human approves or denies an agent's action. Same function, same mechanism, same class of defect that returned `INTERNAL_ERROR` for every checkpoint with options for seven milestones. | probe **A1** in the appendix (a verbatim transcription of `json.ts`): **5 of 7 cases not idempotent**. Chain verified end to end: `toolHandlers/schemas.ts:88` (`preview: z.unknown().optional()`) → `raiseCheckpoint.ts:62` → `checkpoint.ts:30,149` → `schemas/checkpoints.ts:24-25` (output schema **is** `CheckpointSchema`) → `router.ts:93` re-parse → `kinds.tsx:652-656`. The test named for this property, `jsonColumnRoundTrip.test.ts`, sets `preview: null` in its fixture (`:32`) and its one `preview` case (`:61-68`) only asserts the stored-TEXT-wins direction, never a re-parse | Make the TEXT branch conditional on the column actually being a stored column read, not on the runtime type — e.g. parse rows through an explicit `fromRow` schema and validate outbound payloads with a plain (non-widening) schema, so "parse a row" and "re-validate a parsed row" stop being the same function. Minimum stopgap: add re-parse cases for every string shape to `jsonColumnRoundTrip.test.ts` and set a non-null `preview` in the Checkpoint fixture | 3–5 h | **FIXED** (fix session 1). Took the structural fix (a), scoped to the one column where the ambiguity is real. `checkpoint.ts` now derives two schemas from one shared field map and both refinements: `CheckpointSchema` parses a stored row (JSON columns as TEXT, unchanged — all 6 repository/`duplicateDetection` call sites keep it), and a new non-widening `CheckpointOutputSchema` re-validates an already-parsed one. §17.2 `checkpoints.listPending`/`get` and `events.checkpointRaised` now use the wire shape, so the second parse transforms nothing. **Not** (b): §9.2 calls a preview a diff/command/doc excerpt, three of which are naturally strings, and `kinds.tsx:654` renders `typeof preview === string` — typing it concretely would either keep the ambiguity or break an agent-facing tool contract no finding asked to change. **Not** (c). Global (a) across all 9 row-schemas-as-output-schemas is still open and still correct, but the other 8 are provably idempotent today (every other `inner` rejects strings), so it is a cleanup rather than a defect — see Phase 6(a). Tests: fixture now carries a non-null preview; 8 agent-authored preview shapes asserted identical across both parses; wire schema asserted to reject a raw row; a 7-case drift guard asserting both shapes agree on every §9.2 rule; a compile-time `Exact<>` assertion that they infer the same type. Confirmed failing first — 9 failures, each `expected null to be 'null'`-shaped, i.e. the type change itself; the drift guard and the type assertion were each separately mutation-checked as non-vacuous. |
| 2 | SERIOUS | P1 + self | §5.2 / §11.6 event taxonomy | **The taxonomy is closed at typecheck only; nothing enforces it at write time, and the mirror-repair path trusts an unchecked cast.** `logEvent` never calls `NewEventInputSchema.parse`; `insertMirrorRow` writes raw; `events.type` has no CHECK; `tryParseLine` is `JSON.parse(line) as ActivityLogEntry`. Both validators exist and have **zero production callers** — they are called only from tests. Consequence measured directly: a JSONL line missing `seq` binds SQL NULL to `seq INTEGER PRIMARY KEY`, so SQLite **auto-assigns a fabricated sequence number**, silently desynchronising the mirror from the file that `getMaxMirrorSeq()` uses as its high-water mark. A line with an out-of-taxonomy `type` is written happily and then makes `activity.query` throw `INTERNAL_ERROR` for the whole timeline. | `activityLog.ts:43-80,140-162,169`; `event.ts:41-65` (`ActivityLogEntrySchema`, `NewEventInputSchema` — grep shows callers only in `tests/`); `0001_initial.sql:558` (no CHECK); probe: binding `seq: undefined` inserts NULL and auto-assigns, binding a *missing* key throws `RangeError` — so the dangerous case is the silent one | Call `NewEventInputSchema.parse(input)` at the top of `logEvent` and `ActivityLogEntrySchema.parse` in `tryParseLine`; make `activity.query` `safeParse`-and-skip so one bad row cannot black out the timeline | 1–2 h | **FIXED** (fix session 2), with one correction to this row and one suggestion declined. All three fixes landed and were each mutation-confirmed separately: `NewEventInputSchema.parse` at the top of `logEvent` (reverting it fails 4 tests), `ActivityLogEntrySchema` in `tryParseLine` (3), and `safeParse`-and-skip in `activity.query` (1). **August finding #1's residual is closed in the same commit**: `NewEventInput` was `z.infer` — the OUTPUT type, so every `.default()`ed field read as REQUIRED — and is now `z.input`. **Correction to the evidence:** this row says binding a *missing* `seq` key throws `RangeError` while `undefined` inserts NULL, so "the dangerous case is the silent one". Measured through the real `insertMirrorRow`, **both are silent** — it builds its bound object field-by-field (`seq: entry.seq`), so a missing key and an explicit `undefined` are indistinguishable by the time SQLite sees them. There is no loud path at all; the finding is stronger than written. **The parse surfaced 10 pre-existing test failures across 3 files, and they were a real finding, not an obstacle**: `reconcile.test.ts`, `reconcileActivityEvents.test.ts` and `activityLogHook.test.ts` all seeded ids like `'co1'`, `'proj1'`, `'emp-lease-holder'` and `'id-1'` — none of which are 26-character ULIDs, so every event those suites drove carried correlation ids the application cannot produce. Fixtures padded to real ULID length and annotated; the schema was NOT loosened to accommodate them, since that would be fixing the code to match the test. **Behaviour change stated rather than buried:** a mid-file JSONL line that parses as JSON but is not a valid entry now raises `CorruptActivityLogError` and stops boot, exactly as invalid JSON in that position already did (invariant #6). **The `events.type` CHECK is declined, deliberately** — see the commit message and PROGRESS.md. |
| 3 | SERIOUS | self + P1 | §28 M1 item 8 recovery | **The database recovery path has never executed, in any context, and `restoreFromBackup` is wrong in exactly the case it exists for.** `listBackups` and `restoreFromBackup` have zero callers in `src/` and zero in `tests/`. Coverage confirms it independently at **13.6%**. Worse than dead: `restoreFromBackup` is a bare `copyFileSync` over a WAL-mode database and does **not** remove the stale `-wal`/`-shm` sidecars. Its own comment reasons about the destination being open but not about the leftover WAL — and the scenario it exists for is restore-after-crash, which is precisely when an uncheckpointed WAL is sitting there. | `backup.ts:18-37`; a grep for `listBackups` and `restoreFromBackup` across `src/` and `tests/` → only the definition; coverage `db/backup.ts 13.63% stmts, lines 19-28 and 36-52 uncovered`; `index.ts:64-71` throws instead of offering a backup, with an honest in-line comment naming no owning milestone | Delete `<db>-wal` and `<db>-shm` alongside the copy (or restore via `better-sqlite3`'s backup API); write the first test that actually runs a restore; name the milestone that owns the recovery UI so the deferral is tracked rather than floating | 2–3 h | **FIXED** (fix session 2). `restoreFromBackup` now removes `<db>-wal` and `<db>-shm` before the copy — sidecars first, since the reverse order leaves a window in the corrupt state it prevents. `tests/integration/db/restoreFromBackup.test.ts` is the first test that runs a restore at all. **The corruption was reproduced, not just reasoned about**: the strong case snapshots the three live files while the connection is open (a `close()` would checkpoint and destroy the very condition), lays that crash state down beside a backup, and the pre-fix function returns `['Lost To Restore', 'Only This One']` where only `['Only This One']` should survive — the stale WAL replayed straight over the restored file. Both cases confirmed failing first for that reason. A third case pins `listBackups`' newest-first ordering, which the eventual "offer the most recent backup" depends on. Two incidental corrections to my own first draft, both from the tests: a migrated directory already holds one pre-migration backup per migration (so "no backups yet" was wrong), and the single-writer guard forbids a second connection, which is why the crash state is snapshotted rather than re-opened. **Second half — the deferral now has an owner: M15.** `index.ts:64-71` still throws instead of offering a backup; that needs a pre-window recovery dialog, which is shippable-hardening work of the class M15 already carries, whereas M13's wizard is for a user with nothing installed rather than one whose database broke. Recorded in `PROJECT-CHECKLIST.md` chaos row 5 and in the code comment. No recovery UI built this session, per scope. |
| 4 | SERIOUS | P1 | §28 M1 item 4 — **regression** | **The August audit's finding #9 has been undone in the exact file its record calls clean.** `docs/progress/M0-M2.md:478` states "`reconcile.ts`'s raw SQL was eliminated entirely". It is back: three direct spend-counter mutations, each on a column that already has a designated repository writer, so three columns now have two owners. Standing rule 6's exact shape, and invisible to every test of either half. Broader: ~40 `db.prepare` sites live outside `repositories/`, including two different `UPDATE memory SET pinned` in one handler file. | `reconcile.ts:354,372,386` (`UPDATE tasks/projects/employees SET …spend…`) vs `repositories/usage.ts:91,104,120`; `handlers/memory.ts:123,166`; `parkedEmployeeResumeTick.ts`, `checkpoints/taskBlocking.ts` | Add `setTaskSpend`/`setProjectSpend`/`setEmployeeLifetimeSpend` to `repositories/usage.ts` and call them; add `setMemoryPinned`; then add a lint rule or test asserting `db.prepare(` appears only under `repositories/` plus the two documented sole-writer modules — without the guard this regresses a third time | 4–6 h | **FIXED** (fix session 2), with the guard scoped deliberately. Named cases closed: `setTaskSpend`/`setProjectSpend`/`setEmployeeLifetimeSpend` added to `repositories/usage.ts` beside the increments that maintain the same columns, and `reconcile.ts`'s three raw `UPDATE`s now call them; `setMemoryPinned` (addressable by id or by path) added to `repositories/memory.ts` and both `handlers/memory.ts` sites route through it. **The two pin writers were worse than duplicated — they disagreed**: one was keyed by `id` and stamped `updated_at`, the other keyed by `path` and did not, so the same column had two owners writing different things. Both now stamp it, per §5.0's blanket rule. **Guard scope, chosen and stated: write statements only, not every `db.prepare`.** Reads outside `repositories/` number ~55 and are mostly legitimate — a query joining five tables for a cost view belongs in no single-table repository — while writes number twelve and are where "two owners for one column" actually lives. Scoping to writes makes it a rule about the defect rather than about style, and keeps the allowlist short enough to read. `tests/unit/rawSqlWritesAreOwned.test.ts` carries **eight** allowlisted sole-writer modules, each with a one-line reason, and adding one requires editing that list. Both `parkedEmployeeResumeTick.ts` and `checkpoints/taskBlocking.ts` were judged on whether another writer exists for the same columns, as this row asks, and both are genuinely sole writers. Three further assertions: the scan must find writes at all (a regex that silently stopped matching would make the file pass while checking nothing), the allowlist must have no stale entries, and **`reconcile.ts` is pinned BY NAME** so a future allowlist row cannot quietly re-open it. Confirmed failing first — the guard flagged exactly the five sites this row names — and mutation-confirmed in both directions: adding a raw `UPDATE` to `handlers/tasks.ts` fails it, and a stale allowlist entry fails it. `docs/progress/M0-M2.md:478`'s claim is now annotated in place rather than left standing, since a record claiming a fix that has been undone is worse than no record. |
| 5 | SERIOUS | P3 | §17.2 sender check | **`isKnownSender()` — the one gate between any `webContents` and all 109 handlers — has zero coverage of any kind.** Mutating it to `return true` leaves the entire unit suite (613 tests), `tests/integration/ipc/` and `liveCheckpointPatch` green. The router injects the *boolean* for testability, and the only test passes `false` in directly, so it exercises the router's branch and never the function that computes it. S13/S14 cannot help: they send from a genuine window, where `return true` is the correct answer anyway. | Mutation M9b **NOT CAUGHT**: full unit 613/613 green, integration/ipc 58/58 green. `grep -rn windowRegistry tests/` → two hits, neither imports `isKnownSender`. `router.ts:45-46` states the injection rationale | Test `isKnownSender` directly against a registered window, an unregistered one, and a destroyed one; keep the injection for the router's own unit tests | 1 h | **FIXED** (fix session 1). `tests/integration/configurationIsInForce.test.ts` tests `isKnownSender` directly against a registered window, an unregistered one, a destroyed one, and a closed-and-deregistered one — plus a fifth case holding a known and an unknown window at once, because a blanket `return true` passes every single-window case that expects `true`. The router's boolean injection is untouched, per the suggested fix. `windowRegistry.ts` imports only *types* from Electron, so this runs the real function; the windows are stand-ins for Electron's objects and exercise the two fields it actually reads (`webContents.id`, `isDestroyed()`). Mutation-confirmed: 9b (`return true`) now fails 4 of the 5 cases. |
| 6 | SERIOUS | P1 | §5.1 `memory_fts` MUST | **`system.compactDb` runs `VACUUM` without §5.1's mandatory FTS rebuild, and the test named for that rebuild never calls the handler.** §5.1: *"Compact database MUST run `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` after any VACUUM."* The handler is `ctx.db.exec('VACUUM')` and nothing else. `ftsVacuum.test.ts:68-85` executes both statements inline on its own connection — a fixture shaped like the production path, so the production path's omission is invisible to it. | `handlers/system.ts:64-67`; `ftsVacuum.test.ts:68-85` never imports `systemHandlers` | Add the rebuild to the handler; rewrite the test to invoke `systemHandlers.compactDb` with a real `HandlerContext` and confirm it fails when the rebuild line is removed | 30 min | **FIXED** (fix session 2). `handlers/system.ts` now runs §5.1's mandatory rebuild after its `VACUUM`. `ftsVacuum.test.ts`'s VACUUM case goes through `systemHandlers.compactDb` with a real `HandlerContext` instead of executing both statements inline, so the production path is now the path under test (standing rule 1). Confirmed failing first for the right reason — `expected +0 to be 2`, the index empty because nothing rebuilt it — and mutation-confirmed after: replacing the new line with a comment fails it again. One thing the old test could not have caught even if it had called the handler: **a VACUUM alone does not damage a well-formed FTS5 index**, so `search()` returns the right answer either way. The new case deletes every `memory_fts` row first, so only a real rebuild can restore it. Also splits out the rowid assertion, whose old title (*"explicit rowid means VACUUM cannot desync it"*) claimed a cause **#21** shows this build does not exhibit; retitled to what it actually asserts, with #21 cross-referenced in the test. #21 itself left open — it is session 3's. |
| 7 | SERIOUS | P1 (verified) | §14.1 / invariant #10 / CLAUDE.md trap | **Both title-bar indicators lie.** The notification bell is the literal `🔔 0` in the visible text *and* the `aria-label`, while the true pending count is one selector away in the same store. Separately, `todayUsdMicros === null` renders `…`, conflating "loading" with the schema's documented "cost not reported" — and `SUM()` over an empty `usage` table returns SQL NULL, so **a fresh install shows a loading ellipsis forever instead of `$0.00`**. CLAUDE.md names this trap explicitly ("Do not show `$0.00` for an engine that does not report usage. Show 'cost not reported'"); the transport was built correctly for it (AUDIT #18) and the renderer discards the distinction. | `TitleBar.tsx:8,29,31`; true count already computed at `RightPanel.tsx:90`; `schemas/costs.ts:17-24` documents the null contract; `handlers/costs.ts:62-67` returns NULL for an empty ledger | Bind the bell to the checkpoints slice; distinguish `undefined` (loading) from `null` (not reported) from `0`; add `unmeteredEmployeeCount` to `CostSummarySchema` so §14.1's unmetered disclosure becomes possible at all | 1 h + 2–3 h | **FIXED** (fix session 3a). Both lies, and the third part that made §14.1's disclosure inexpressible. **The bell** now reads `state.checkpoints.length` — §9.4's one piece of state, the same slice `RightPanel`'s badge and the chat card read, so the three cannot disagree. **The meter** distinguishes all three states: `undefined` (not asked yet), `null` ("cost not reported", CLAUDE.md's named trap) and a real number including `0`. That required a Core fix too, which is where the "ellipsis forever" actually lived: `costs.summary` returned SQL NULL for an *empty* ledger, indistinguishable from an unreported one. Both summary totals now carry a `COUNT(*)` beside the `SUM()` and separate them in `reportedTotal` — no rows is a known, complete `0`; rows that all declined to report stays `null`. `byDay`/`byProject`/`byEmployee`/`byRole`/`topTasks` keep the bare `SUM()`, correctly: each groups or joins, so a row exists only because usage rows exist for it. **`unmeteredEmployeeCount` added** to `CostSummarySchema`, and `unmeteredEmployees.ts` is its single decision site (standing rule 6) — a fact, a count, with the renderer choosing the words. **Narrowed, and said so in the schema:** §14.1 says "running today", which is not knowable for exactly these employees — an unmetered engine emits no `turn.completed`, so it writes no `usage` rows at all and the ledger is empty for it by construction. The count is therefore every unmetered employee on the roster, a deliberate superset; over-disclosing is the fail-closed direction (invariant #6), since the harm §14.1 names is a total that *looks complete*. Narrowing it needs M11's activity attribution. **Standing rule 9 applied throughout.** Handler tests confirmed failing first for the right reason (`expected null to be +0`; `expected undefined to be 1`), and one of them was rewritten when its premise proved false — `insertUsage` stamps `nowIso()` and ignores a `ts` input, so the backdating case had to backdate after the production write rather than pretend to seed an old row. The wiring is proven by `tests/e2e/titleBar.spec.ts` against the **real packaged app** (a component test handed props reproduces this bug rather than catching it), and both halves were mutation-confirmed: restoring the hardcoded bell renders `🔔 0` against a real seeded checkpoint, and restoring the bare `SUM()` loses `$0.00 today` on a fresh install. **One thing the fix found that the finding did not name:** the guard test `unmeteredEngineMode.test.ts` failed 3 of 10 on its first run. Metering is not a property of the mode alone as §7.7.1's wording suggests — `GenericPtyAdapter` ignores the mode entirely and reports `usageReporting: false` in all of them, so a `generic-pty` employee with a NULL `engine_mode` was unmetered in fact and metered in the predicate, silently omitted from the very disclosure being built. The predicate is keyed on engine **and** mode because that test said so. |
| 8 | SERIOUS | P3 + self | §28 M1 item 6 durability | **The `fsync` is written down and never tested, and §5.0 omits `synchronous` entirely.** Deleting the `fsync` is caught only by lint (unused import); the realistic refactor — `fsync` once on `close()` — is caught by nothing at all: eslint clean, tsc clean, 32/32 tests green. `grep -rn fsync tests/` returns one passing comment. Compounding: §5.0 names three pragmas and not `synchronous`, so the connection runs at WAL's `NORMAL`, which does not fsync the WAL on commit. The kill-point gate proves durability across *process* death, which the OS page cache survives; nothing proves durability across machine death, and the gate's wording does not distinguish them. | Mutations M3a/M3b **NOT CAUGHT**; `activityLog.ts:71`; §5.0's pragma list | Either test it (a `fsyncSync` spy asserting it is called before `insertMirrorRow` — cheap, and pins the ordering too) or state the limit honestly in §11.6 and §28 M1. Decide `synchronous` deliberately and write it into §5.0 either way | 1–2 h | **FIXED** (fix session 1), and the audit's `synchronous` claim was **confirmed after initially appearing wrong** — see the note below. `tests/integration/activityLogFsyncOrdering.test.ts` asserts the `fsync` is issued once per event and, from *inside* the mocked `fsyncSync`, that the mirror row does not exist yet — so it pins §28 M1 item 6's ordering rather than merely both calls happening. Mutation-confirmed: 3a (delete the `fsync`) and 3b (defer it to `close()`) each now fail all 4 cases. `synchronous`: a bare connection reads `2` (FULL), which briefly looked like a refutation, but it drops to `1` (NORMAL) the moment WAL engages on the first write — a state every real run reaches in milliseconds. So the audit was right about the running value and understated the mechanism. Now set explicitly (`synchronous = FULL` in `openConnection`, which survives WAL activation, `db.backup()` and later writes), named in §5.0, and asserted post-migration. The gate's wording is settled the honest way rather than tested: §11.6 and §28 M1 now say *process death, tested; machine death, designed for and untested*, since nothing here pulls power and an `fsync` still trusts the drive's write cache. Amendment log rows added for both §5.0 and §11.6/§28 M1. |
| 9 | SERIOUS | self | §28 M1 gate wording | **The kill-point gate promises "no lost committed state" and for 12 of its 22 points nothing checks for lost committed state.** Those points assert only `integrity_check` + `foreign_key_check` and that `reconcile()` did not throw — none of which looks at whether the step's own committed row survived. Kill at step 19 asserts nothing about `general.notifications`; kill at step 20 asserts nothing about the `usage` row. A repository that silently failed to commit would pass the gate. | `killPoints.test.ts:150-160` (`assertBaseInvariants` is integrity + FK only); point-specific assertions exist only for 3,4,5,14,15,17,18+,21,22 | Add a cumulative assertion: after a kill at step *k*, every row steps 1..*k* committed must still be present. It is one helper and it turns 22 smoke checks into 22 real ones | 2–3 h | **FIXED** (fix session 2). One cumulative helper, `assertCommittedStateThrough(db, k)`, asserting that after a kill at step *k* every row steps 1..*k* committed is still present — run at all 22 points, **before** `reconcile()` (so it is about what the kill left, not what repair restored) and again after (so repair cannot lose anything either). Steps 3-4 get the inverse clause: mid-transaction, nothing may be committed. It deliberately asserts identity and presence rather than mutable status, because `reconcile()` is *supposed* to move a running task to `blocked` and a streaming message to `aborted`; those transitions stay in the point-specific assertions. **Standing rule 9 applied — the mutation was checked, not assumed.** Making `setSetting` silently not commit now fails points 19-22 (`step 19: the setting row exists: expected undefined to be defined`), and making `insertUsage` skip its row fails 20-22. grepping the pre-change file for either `settings` or `FROM usage` returned **0** hits, so neither was asserted anywhere — this row's "a repository that silently failed to commit would pass this gate" is confirmed exactly. One incidental correction while writing it: the settings column is `value_json`, not `value`. `PROJECT-CHECKLIST.md`'s M1 row updated to say the gate now verifies committed state rather than integrity alone; session 1's `20/20` → 22 correction left intact. |
| 10 | SERIOUS | P1 | §14.7 / §28 M2 item 6 | **WCAG AA fails in both themes, and §28 M2 item 6 claims it was "verified on both".** Nothing verifies contrast anywhere — a grep of `tests/` for `contrast`, `wcag` and `axe` returns nothing. Measured ratios include live combinations: light `--color-text-muted` on `--color-bg-elevated` = **4.40:1** (needs 4.5) and on `--color-bg-inset` = **3.81:1**; dark `--color-accent` on inset = **2.84:1**. Both are real pairings — `RightPanel.tsx:144+159` inactive tabs, `FloorPane.tsx:31+33`. | `theme.css:20,35`; ratios computed per WCAG 2.x sRGB relative luminance | Darken `--color-text-muted` in light to ≥ `#5f5f68`; re-check accent/error on dark elevated and inset; add a unit test computing the ratio for every (token, surface) pair actually used | 1–2 h | **FIXED** (fix session 3a), and the test is the half that lasts. Eight tokens changed across the two themes — light `text-muted` `#71717a`->`#52525b`, `accent` `#2563eb`->`#1d4ed8`, `warn` `#b45309`->`#92400e`, `success` `#15803d`->`#166534`; dark `text-muted` `#a1a1aa`->`#b4b4bd`, `accent` `#3b82f6`->`#7dabf8`, `warn` `#d97706`->`#f59e0b`, `error` `#ef4444`->`#fca5a5`. Tightest surviving pair is 4.98:1 light and 5.08:1 dark, so this is not sitting on the threshold. `tests/unit/renderer/themeContrast.test.ts` is the durable part, and it is deliberately the same shape as session 1's `configurationIsInForce`: a colour token is a **declaration, not a behaviour**, nothing fails when one drifts, and the damage never appears in the diff that causes it. It **parses `theme.css` itself** rather than carrying a copy of the palette (standing rule 1 — a copy would assert that the copy is accessible and say nothing about what ships), scans the components for the token names actually used, and computes every pair including the `/10` tints as real alpha composites over what sits behind them. **82 assertions, 25 of them red before the change**, reproducing the audit's measured ratios to the second decimal. **Standing rule 9, twice.** Reverting light `text-muted` to `#71717a` fails 8 cases at exactly the audit's 4.40 and 3.81; reverting dark `accent` in **one of the two dark blocks only** fails 3 contrast cases *and* the identity guard. **Two things found that the finding did not name.** (a) The dark palette is written out twice in `theme.css` — once under `prefers-color-scheme`, once under `data-theme` — which is standing rule 6's exact shape, and drift there would only be visible to users whose OS preference and in-app choice disagree; the two blocks are now asserted identical. (b) A first draft of the scanner derived pairings by co-occurrence within one `className` string and produced impossible pairs like `accent-text` on `bg` at 1.00:1, because template literals hold mutually exclusive ternary branches. A test that fails on combinations no element can have is a test whose threshold gets lowered until it is quiet, so the pairing model is now hand-written **and guarded in both directions**: a token a component renders but the model omits fails, and a model entry no component uses fails. **Narrowed, deliberately, and recorded here rather than left implicit:** `error`, `warn`, `success` and `accent` are NOT checked against `bg-inset`. Every one of the twelve `bg-bureau-bg-inset` call sites is either a button hover state or a `<pre>` block, both of which carry inherited text only — so requiring those four tokens to be legible on inset would be inventing a requirement rather than checking one. The audit asked for accent and error on "elevated and inset"; they are checked on elevated, where the cards actually are, and the reason inset is excluded is asserted by the model guard rather than assumed. §28 M2 item 6 (*"WCAG AA verified on both"*) is corrected in place in `docs/BUILD-SPEC.md` — it was false when written. **§14.7's "status never conveyed by colour alone" was checked in the title bar and the tab bar as asked, and both are clean** — no fix needed: the tab bar distinguishes the active tab by a 2px bottom border, font weight and `aria-selected`, not colour; `EmployeeBar` renders employee status as a **word** with an `aria-hidden` uncoloured dot; and the title bar's two indicators (rebuilt under #7) are icon plus text plus a full sentence as the accessible name. |
| 11 | SERIOUS | P1 | §17.1 events | **Five of seven `on.*` events have no producer, and the surface check reports the surface as matching.** `terminalChunk`, `activityEvent`, `checkpointRaised`, `floorEvent` and `toast` are in `methodList.ts`, exposed by the preload, and given payload schemas — and are never sent by anything. Only `stateDelta` and `chatMessage` have producers. So a reader tracing §9.4 from the IPC contract finds `checkpointRaised` and follows a mechanism that does not exist, while checkpoints actually reach the UI via `liveState` → `stateDelta`. `terminalBroadcaster.ts:128-160`'s `fromSeq`/`resync` protocol — which §17.2 spells out in detail — has no caller at all. | Three IPC send sites total: `stateDelta.ts:88,108`, `electronChatBroadcaster.ts:47`; `ipcBridge.ts:17-46` subscribes to two | Either wire producers or mark the five as declared-but-unproduced with owning milestones, the way handler stubs are marked, and extend `checkIpcSurface.mjs` to fail on an unmarked event with no producer | 1 h to annotate | **FIXED** (fix session 3b) — marked honestly, not wired, and **one of the five removed rather than marked.** Verified first: exactly three send sites in `src/main` (`stateDelta.ts:88,108`, `electronChatBroadcaster.ts:47`), so five of seven events really had no sender. **Owners taken from §28 and PROGRESS, not guessed:** `terminalChunk` -> M14 (item 2; M3 built and tested `TerminalBroadcaster` including `fromSeq`/`resync` and deliberately deferred the wiring, which its own PROGRESS entry records), `activityEvent` -> M14 (item 3), `floorEvent` -> M12. **`toast` is marked `unassigned`** — no §28 item owns in-app toasts and nothing in the spec consumes the event (§9.4's notification is native and main-process). Inventing an owner would put a false statement into the record this finding exists to correct. Flagged for the product owner, along with `ToastSchema` carrying a `kind` and a pre-formatted `message`, the presentation-in-payload shape M9 removed from errors. **`checkpointRaised` removed, and this is the decision the finding asked for.** It is redundant, not late: §9.4's four surfaces are the chat card and the Checkpoints badge (both render from the `checkpoints` slice `liveState` pushes on every `checkpoint.*` event), the floor signal (M12) and the desktop notification (raised in the main process, never crosses IPC). A dedicated event would be a second channel for one piece of state (standing rule 6). Fix session 1's careful move of this event onto `CheckpointOutputSchema` was a correct change to an event nothing emitted; it goes with the event. **The durable half:** `IPC_EVENTS_NOT_YET_SENT` in `methodList.ts` holds each marker with its owner and reason, §17.1's code block carries the same marker per line plus a note, and `checkIpcSurface.mjs` now fails on any event with neither a literal `.send('<event>'` in `src/main` nor a marker, and on a marker for an event that has gained a sender. Confirmed failing first — before any marker existed it listed exactly the five and found `stateDelta` and `chatMessage` as sent. **Standing rule 9, four mutations:** removing the `floorEvent` marker fails; a stale marker on `stateDelta` fails naming the file that sends it; a sixth event added to both §17.1 and `IPC_EVENTS` with no sender fails (the case this exists for); and breaking the sender regex fails both real senders plus a "the scan itself is broken" guard, so the check cannot go green by matching nothing. |
| 12 | SERIOUS | self | §11.7 S13 / §28 M0 item 4 | **S13 is blind to `sandbox: false`.** Measured with two repackaged probes: dropping only the sandbox leaves S13 green; the classic insecure config (`contextIsolation:false` + `nodeIntegration:true`) fails it. §28 M0 item 4 names all three flags, and dropping the sandbox is a real weakening — the preload regains full Node in the renderer process — that leaves `window.require`/`process`/`ipcRenderer` undefined in the main world, which is all S13 inspects. The file's own header admits the gap and points at an out-of-band mutation proof that is not in the repo. | Probe table in Phase 4; `s13RendererHasNoNode.spec.ts:14-19`; `window.ts:13-17` | Assert the three `webPreferences` values directly (they are readable from the main process), or add a renderer-side probe that distinguishes a sandboxed preload; keep S13's behavioural assertions as they are | 1–2 h | **FIXED** (fix session 1), and **one piece of this row's evidence is wrong** — recorded because it changes how the next probe of this kind should be built. `tests/e2e/security/s13WebPreferences.spec.ts` asserts all three §28 M0 item 4 flags from the real packaged **main** process via `webContents.getLastWebPreferences()`, which reports what Electron applied rather than what the source requested. S13 is untouched, per the suggested fix. Mutation-confirmed the substance: repackaged with `sandbox: false`, S13 **passes** and the new spec **fails** — so S13's blindness is real and is now covered. **But "dropping only the sandbox" measured nothing.** Deleting the `sandbox: true` line is inert on Electron 43, which has defaulted renderer sandboxing ON since Electron 20; the deleted-line build still applies `sandbox: true`, verified by dumping the applied preferences. So the probe this row cites as evidence produced a green S13 against a build that was never weakened. The gap is real; the measurement of it was not — and it is the same shape as #13's `foreign_keys`, an inert line assertable only for its value. The probe method is absent from Electron 43's `.d.ts` and reached through a cast, so the spec also asserts the method exists: if a future Electron drops it, this fails as a broken probe rather than passing on three `undefined`s. |
| 13 | SERIOUS | P3 | §5.0 pragmas | **No pragma is asserted anywhere, and one of the three is inert.** Removing `foreign_keys = ON` changes nothing because `better-sqlite3` already defaults it ON — so referential integrity across all 26 tables currently rests on an undocumented library default, not on §5.0's line. Removing `journal_mode = WAL` is a genuine behavioural change (default is `delete`) and 34 tests across killPoints, singleWriterAndLocking and migrate stay green — while `backup.ts` and `migrate.ts` both contain reasoning that assumes WAL. | Mutations M1a/M1b **NOT CAUGHT**; probes: `foreign_keys` default `1`, `journal_mode` default `delete` | One test that opens a real connection and asserts all three pragma values. Three lines, and it closes the whole class | 30 min | **FIXED** (fix session 1), with one honest exception. `tests/integration/configurationIsInForce.test.ts` opens a real connection, runs the real migrations, and asserts all four pragmas — `foreign_keys`, `journal_mode`, `busy_timeout`, and `synchronous`, which §5.0 did not previously name (see #8). Mutation-confirmed: 1b (`journal_mode`) and the new 1c (`synchronous`) each now fail. **1a is still NOT CAUGHT, and cannot be**: deleting the `foreign_keys = ON` line has no observable effect at all, exactly as this row says, so no assertion on a connection can distinguish it from the library default. What the test does catch is any *weakening* — confirmed by mutating the line to `foreign_keys = OFF`, which fails. §5.0 now records that distinction so the next reader does not mistake the assertion for line coverage. |
| 14 | SERIOUS | P3 | §5.1 lease index | **The partial unique index on `worktrees.lease_holder` is untested.** Dropping it leaves `leaseAcquire.test.ts` — including *"N concurrent acquirers racing for one free worktree — exactly one ever wins"* — green, because what serialises that race is `acquireWorktreeLease`'s `BEGIN IMMEDIATE`, not the index. The two are independent defences and only one is under test. The index exists for the writer that does not go through the repository, which finding #4 shows is not hypothetical here. | Mutation M12 **NOT CAUGHT**: `leaseAcquire.test.ts` + `killPoints.test.ts`, 24/24 green; `0001_initial.sql:321-322` | Assert the constraint directly — two raw `UPDATE`s setting the same `lease_holder` on two worktrees, expecting the second to fail | 30 min | **FIXED** (fix session 1). `tests/integration/configurationIsInForce.test.ts` asserts the constraint directly with two raw `UPDATE`s setting the same `lease_holder`, expecting `UNIQUE constraint failed` on the second — deliberately bypassing the repository, because the writer this index exists to stop is the one that does not go through it. Two companion cases pin what the index must *not* do: many worktrees may hold no lease (it is partial), and releasing a lease frees that employee to take another. `leaseAcquire.test.ts` is untouched; the `BEGIN IMMEDIATE` defence and the index defence are now tested separately. Mutation-confirmed: 12 (drop `idx_worktree_lease`) now fails. |
| 15 | SERIOUS | P3 | §28 M0 item 2 | **`noUncheckedIndexedAccess` can be turned off with a fully green CI.** typecheck, eslint and 613 unit tests all pass with it `false`. Nothing — no test, no lint rule, no CI step — asserts the flag is on, and turning it off is strictly more permissive so no existing code can fail. The damage is not in the diff that removes it but in every unguarded index access written afterwards. | Mutation M13 **NOT CAUGHT**; `tsconfig.base.json:4` (one definition, all five projects extend it) | Assert the compiler options in a unit test by reading `tsconfig.base.json`, alongside the pragma test from #13 — same three-line pattern, same class of gap | 30 min | **FIXED** (fix session 1). `tests/integration/configurationIsInForce.test.ts` reads the real `tsconfig.base.json` and asserts seven flags on, not just the two §28 M0 item 2 names by hand — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`. One definition, all five projects extend it. Mutation-confirmed: 13 (`noUncheckedIndexedAccess: false`) now fails. |
| 16 | SERIOUS | P1 | §14.6 error states | **`IpcErrorAction` is a fully-modelled dead union, and raw OS error strings reach the user.** §14.6 requires every error to offer a concrete next action; the five-variant union exists, no handler ever sets `action`, and `error.action` appears nowhere in the renderer — all seven renderer error paths render `result.error.message` as bare text. Meanwhile `router.ts:98` interpolates the raw thrown message into the user-facing string, and at least two handlers throw raw `shell.openPath` errors into it, which is exactly §14.6's "'Error: ENOENT' reaching the user is a bug". | `envelope.ts:51-58`; `handlers/system.ts:71`, `handlers/activity.ts:43`; renderer call sites `Composer.tsx:86`, `ChatView.tsx:144`, `kinds.tsx:325,395`, `MemoryView.tsx:71`, `BriefEditor.tsx:46`, `EmployeeBar.tsx:27` | Log the raw message and return a fixed plain-language `INTERNAL_ERROR` with `action: {type:'contact_support'}`; give `NOT_FOUND`/`NOT_IMPLEMENTED`/`CONFLICT` their natural actions; render the button in a shared `<ErrorNotice>` so new call sites get it by default | 4–6 h | **FIXED** (fix session 3a) — **and the finding is corrected in one respect, understated in another.** **Correction: `action` is NOT unset by every handler.** Six sites set it — `company.ts:26,61,92` and `packs.ts:125,145,172` — so the claim "no handler anywhere sets `action`" is wrong. The finding's substance survives intact and is arguably worse for it: `error.action` really does appear nowhere in `src/renderer`, so those six were computed, validated, sent across the bridge and **dropped on arrival**. The union was vestigial at the point of use, which is the part that matters. **Understated: there were four raw-message leaks, not one.** Beyond `router.ts:98`, three handlers did `ipcError(..., (err as Error).message, ...)` — `company.ts:61,92` and `packs.ts:172` — putting whatever was thrown inside the `try` straight in front of the user. The comment above one of them asserted these errors "are already written for a person", which was true of the errors its author had in mind and false of the `catch`, which also caught every SQLite failure and TypeError in the same block. Classic fail-open. **What landed.** (a) `dispatchIpcCall` logs the raw error in full and returns a **fixed** sentence with `action: {type:'contact_support'}` — fixed rather than templated, because a message that varies with the internals is a leak waiting to be reintroduced, and the test asserts three different throws produce the identical string. (b) `UserFacingError` is the new marker for "this sentence was written for a person"; ten domain error classes extend it and the three leaking catch blocks now show only those and **rethrow** everything else for the router to translate — one translation, one place (standing rule 6). (c) The three `shell.openPath` sites went through `openInShell`, which is one function rather than three copies of the sentence. It deliberately carries **no action**: every button Bureau could offer would rerun the same call and fail identically, so the path is in the sentence instead and there is no button that lies about being useful. (d) `NOT_FOUND` and `CONFLICT` gained `retry` at all 17 construction sites; **`NOT_IMPLEMENTED` deliberately gained none**, documented in `ipcNotImplemented` — for a feature that does not exist, every variant of the union would be a false promise, and "no action" is the honest answer rather than an omission. (e) `<ErrorNotice>` renders the message and the button, and **all seventeen renderer call sites now hand it the whole error** rather than a string. **The durable half is the guard, and it is the reason this closes rather than recurs.** `errorNoticeIsTheOnlyRenderer.test.ts` fails if any component reads `error.message` itself, if `ErrorNotice` stops reading it, if a variant is added to the union with no branch, or if the renderer starts branching on `error.code` (the Core's vocabulary, not a UI one — M9's boundary). The union was correct and unreachable for nine milestones and nothing noticed; the scan is what makes the eighteenth call site impossible to get wrong quietly. **Two things the fix had to undo rather than add.** `envelope.test.ts` asserted `result.error.message` **contained** the thrown string — the leak was not merely untested, it was **pinned in place by a green assertion**, which is why reading the suite could not find it. And `EmployeeBar` carried a comment saying it "proves the envelope's error.message reaches the user as-is", calling the failure mode the point of §14.6. Both corrected in place. **Standing rule 9, four times.** A call site reverted to reading `.message` fails the scan; removing a `case` from `ErrorNotice` fails the union check; and against the **real packaged app**, making `ErrorNotice` ignore `error.action` again removes the button `errorActions.spec.ts` requires — that spec drives the whole chain (`company.hire` with no company -> `NOT_FOUND` + `open_settings` -> a real button -> the real settings dialog opens), because a scan cannot tell you a button appears or that pressing it does anything. |
| 17 | SERIOUS | P1 (verified) | §14.1 / §28 M2 item 5 | **No draggable persisted splitter, and no minimum window size or auto-collapse — and none of it is recorded as deferred.** §28 M2 item 5 lists the splitter as a build item and §14.1 specifies "Minimum window 1280×800; below that the floor auto-collapses". `FloorPane.tsx:31` is a fixed `w-64` with no drag handler and no persistence; `window.ts:8-19` sets initial size but no `minWidth`/`minHeight`. Neither the M2 "Deviations" nor "What's stubbed" section mentions any of it. Same shape as M7's four missing `role.yaml` columns: an item in an enumerable list that was never built and never recorded. | `WindowShell.tsx:20-36`, `FloorPane.tsx:31`, `window.ts:8-19`; no `splitter`/`paneWidth` key in `settings/schema.ts` | Add `minWidth`/`minHeight`; implement the splitter persisted to a new §16.1 settings key (spec row and schema entry in the same commit, per §16.1's own rule); add the width observer | 3–4 h | **FIXED** (fix session 3a), all three parts. `window.ts` gained `minWidth: 1280, minHeight: 800`. `FloorPane` gained a real pointer-drag splitter — a `role="separator"` with `aria-valuenow`/`min`/`max`, pointer capture rather than window listeners, **and arrow-key operation**, because a control only a mouse can reach fails §14.7's "full keyboard navigation" while satisfying §14.1. The width persists to a new §16.1 key, `general.floorPaneWidth` (int px, 160–720, default 256 — the `w-64` it was hardcoded to, so no existing window jumps on upgrade). **The §16.1 rule was followed and is worth recording, because #24 is that nothing mechanical enforces it:** the spec row, the Zod schema entry and the `SETTINGS_REGISTRY` metadata all landed in the same commit, plus the §0.1 amendment row. What actually caught the omission risk was `settingsRegistry.test.ts`'s key-count assertion firing on cue (51 -> 52) — the same tripwire that caught M9's `review.trivialTaskMaxChangedLines`. It is not the mechanical spec<->registry check #24 asks for, and it is the only thing standing in for one. The bound is enforced in the **schema**, not only in the renderer's clamp: this is the first setting a user writes by gesture rather than by typing, so an out-of-range value is much easier to produce. **One real bug, found by the e2e rather than by reading, and it is the reason the test had to be an e2e.** The first auto-collapse implementation compared the renderer's `window.innerWidth` against §14.1's 1280. But 1280 is a **window** size and `innerWidth` is the **content** width — measured at 1264 for a window sized exactly 1280 on this machine, the frame taking 16px. So the floor auto-collapsed on every single launch at the minimum size: the feature firing constantly instead of never, and a component test with a mocked width would have agreed with itself and shipped it. Fixed to `outerWidth`. **Why both halves of §14.1's sentence are needed**, since a minimum makes the auto-collapse look redundant: a minimum is a request a window manager can decline. On a display narrower than 1280 logical pixels, or under heavy OS scaling, Electron hands back a window under its own minimum — which is exactly when the pane has to get out of the way itself. The e2e reproduces that machine on this one by dropping the minimum before resizing. **Standing rule 9, three times, against the real packaged app.** Removing `minWidth`/`minHeight` fails with "no minimum size is set at all"; removing the persistence write fails the drag test (the pane snaps back to the stored 256, so the failure lands on the width assertion before the reload assertion is reached — reported precisely rather than claimed as the reload catching it); and neutering the width observer fails with "the floor stayed expanded in a window too narrow for it". **#23 was landed first, in its own commit, because this depends on it** — the pane renders from the `settings` slice (invariant #11: the renderer holds no authoritative state), and before #23 that slice only arrived on window load, so a dragged width would have snapped back until the next reload. |
| 18 | SERIOUS | P1 | §5.2 / invariant #3 | **Five documented `app.*` event types have no emitter, including `app.migrated`, which records a real state change.** `app.started`, `app.stopping`, `app.migrated`, `app.updated`, `app.crashed` — zero emitters. Applying a migration is unambiguously a state change; `migrate.ts` returns `{applied:[…]}` and `index.ts:57-62` discards it. There is a structural cause — `ActivityLog.open` happens *after* `runMigrations` — so it is a boot-ordering problem, not a forgotten call. §5.2 annotates `employee.ready`/`restarted` as documented-but-unemitted; these five carry no such annotation, so a reader takes them as live. | `grep` for each type across `src/`; `index.ts:57,73` ordering | Open the `ActivityLog` before `runMigrations` (it needs only `dbPaths` and `db`, both available) and emit `app.migrated`; emit `app.started` after `reconcile()` and `app.stopping` at the head of `runShutdownSequence`; annotate `app.updated`/`app.crashed` in §5.2 if they belong to M15 | 1–2 h | **FIXED** (fix session 2), **but not by the suggested fix, which does not work.** The suggestion — open the `ActivityLog` before `runMigrations` — was checked and rejected: `logEvent` mirrors into `events`, and `events` is created BY migration 0001, so on a first run (the run where migrations matter most) there is no table to write to and boot would throw. Making `insertMirrorRow` tolerate a missing table would weaken the writer #2 had just made strict. `app.migrated` does not need to be emitted *before* migrations, only *about* them, so `index.ts` now captures `runMigrations`' already-returned `{applied}` instead of discarding it and emits after the log opens as it always did. No reordering. Emitted only when something actually applied — a boot that migrates nothing is not a state change. `app.started` after `reconcile()` and settings seeding (it means "up and consistent", not "main() began"); `app.stopping` as the FIRST thing `runShutdownSequence` does, wrapped so a wedged log cannot strand a user in an app that will not quit. **Tested against the real packaged app rather than a helper**, because a unit test of an `emitBootEvents()` would prove the helper works and nothing about whether boot calls it — finding #6's exact shape. `tests/e2e/appLifecycleEvents.spec.ts` boots the packaged binary on a fresh user-data dir, reads `activity.jsonl`, and asserts the types, their order, the applied-version payload, gapless `seq`, and that a SECOND boot re-emits `app.started` but not `app.migrated`. Both confirmed failing first (`app.migrated` absent). `app.updated`/`app.crashed` are annotated in §5.2 as documented-but-not-emitted with **M15** named as owner — the whole fix for those two, per this row's own suggestion. Amendment log row added. |
| 19 | SERIOUS | P1 | §0.1 amendment log | **The amendment log's completeness claim is false, one entry records a change that was never made, and that entry concerns a release-blocking security test.** 24 of 32 spec-modifying commits are unrecorded, including 7 that changed §5.1 and 10 that changed §5.2. The structural cause is exculpatory — §0.1 was created at `10767e9` and the retrospective reconstruction caught 5 of 27 prior changes. Two entries are individually wrong: the `2026-09-08 §11.7` row claims S15's assertion was "narrowed to match §11.2", but S15's row is **byte-identical from the first spec commit to HEAD** and still reads "denied calls **and zero egress**" — so a release-blocking test's stated assertion is stronger than the project believes it can deliver *and the record says the opposite*; and the `2026-09-05 §11.5` row describes a commit whose whole diff lands under §8.0. | `git log --follow -p -- docs/BUILD-SPEC.md` (33 commits); `git log -S'zero egress'` returns only the original commit and the amendment row quoting it; `BUILD-SPEC.md:2277` | Apply the S15 narrowing §0.1 already claims, or correct the entry to say it was not applied and why; fix the §11.5→§8.0 attribution; add a paragraph stating honestly that pre-`10767e9` coverage is partial | 1 h (+2–3 h to backfill) | **FIXED** (fix session 3b), with the completeness half **narrowed to an honest statement rather than a backfill**. **(a) S15.** Verified all three places before editing: §11.2 honest, §11.7's S15 row still promising "denied calls and zero egress" (unchanged since `9d63738`; `git log -S'zero egress'` returns only that and `10767e9`), and the §0.1 row claiming it had been narrowed. The row now says what `promptInjectionContained.test.ts` actually asserts — denied filesystem and network-tool calls, each with a `tool.denied` event — and names the shell-egress gap it documents rather than asserts past. The log row is corrected to say the narrowing was decided 2026-09-08 and **applied at fix 3b**, so the log is truthful about its own history. The test itself was honest throughout; its header, which described §11.7 as still disagreeing, is updated. **(b) Coverage.** Chose the honest limit over a 24-row backfill: §0.1 now says coverage before `10767e9` is a partial look-back, that every spec-changing commit from `10767e9` onward has a row, and that `git log --follow -p -- docs/BUILD-SPEC.md` is the complete record. A backfill would mostly restate that command. `8b83ead` re-attributed from §11.5 to §8.0 (its diff lands at the §8.0 carve-out table), with the old attribution kept visible. **Two corrections to the finding.** The header never literally said "every" — it said a reader "should not have to reconstruct that by diffing", which implies completeness; the paragraph now makes the limit explicit either way. And re-running `specHistory.mjs` against HEAD to check the "from `10767e9` onward is accurate" claim before writing it found **one omission this project made after the audit**: `3d4bc7a`, fix session 3a's own #10 commit, corrected §28 M2 item 6 without a §0.1 row. Backfilled, and said so in the row. The claim written into the log was checked, not inherited. |
| 20 | MINOR | self | §11.7 S14 / §4.2 | **S14 does not assert the "logged" half of its own name**, and production "logging" is `console.error` in the main process, which in a packaged app goes nowhere a user or a support bundle can reach. The test asserts dropped and not-coerced, both well; it asserts nothing about logging. | `s14RejectsBadPayload.spec.ts:29-57`; `router.ts:69,75` | Route rejections to the activity log (or the support bundle) and assert it, or narrow §4.2/§11.7's wording to what is actually guaranteed | 1–2 h | **FIXED** (fix session 3b) — built rather than narrowed. The deciding precedent was already in the codebase: the control channel records its own trust-boundary rejections as `control.*` events at `severity: security`, and a request from an unknown frame or a payload no typed caller could construct is the same class of event at the IPC boundary. `dispatchIpcCall` now emits `ipc.sender_rejected` and `ipc.payload_rejected` (severity `security`, payload `{ channel }` plus Zod issue **paths and codes, never values** — a rejected payload may be exactly what must not reach a durable log). Recording is wrapped so a logging fault cannot change the outcome: the request is still refused with the same code. Successful calls log nothing. New §5.2 row and §4.2 annotation, §0.1 row. **Tests failed first for the right reason:** three new unit cases (payload rejected recorded; values never written; sender rejected recorded) failed with "expected [] to have a length of 1", and **S14 now asserts the logged half of its own name** by reading the packaged app's real `activity.jsonl` — it failed with "the malformed payload was dropped but never logged" before the fix and passes after. Standing rule 9: removing the payload `recordRejection` call fails both payload unit cases. S14's file is unchanged in count, so `test:security` stays at 17 files. **#24's new taxonomy check caught this commit's own intermediate state:** adding the two types to `EVENT_TYPES` before writing the §5.2 row failed it, naming both — its first real-world catch. **Two things recorded, not fixed.** (a) Not rate-limited: a renderer looping a malformed call writes one fsync'd line per call (see #22). (b) While writing the §4.2 note, a draft sentence claimed outbound events are validated against `IPC_EVENT_SCHEMAS`; checking before committing it showed **nothing in `src/main` validates outbound events** — `stateDelta` is TypeScript-typed and `chatMessage`'s payload is not typed against its schema at all — so §4.2's "every IPC payload in both directions is validated with a Zod schema" is true inbound and not outbound. The sentence was dropped rather than written, and the gap is noted here for the next audit; it is not in this finding's scope. |
| 21 | MINOR | P3 | §5.1 rowid rationale | **§5.1 states a causal claim the test named after it cannot demonstrate and this build does not exhibit.** `ftsVacuum.test.ts` passes 4/4 with the explicit `rowid INTEGER PRIMARY KEY` removed, including the case titled *"explicit rowid means VACUUM cannot desync it"*. A four-configuration probe shows VACUUM preserves rowids with or without the declaration and with or without the rebuild, so neither the `VACUUM` nor the `rebuild` line in that test is load-bearing. The column is held in place only incidentally, by `MemorySchema` requiring a numeric `rowid`. The declaration should stay (SQLite does not *promise* to preserve rowids) — the finding is that the evidence does not exist. | Mutation M7; probe **A2** in the appendix, four configurations | Soften §5.1's claim to what SQLite actually guarantees, and either build a test that demonstrates a real desync or delete the VACUUM case's misleading title | 1 h | **FIXED** (fix session 3b) by correcting the claim — the finding's first option (soften §5.1) rather than its second (build a desync demonstration), because there is no desync to demonstrate. **Re-measured, not inherited:** probe A2 was extracted from this report's appendix and re-run against the current `better-sqlite3`; all four configurations (explicit rowid or not, rebuild or not) keep rowids 1, 3, 5 across `VACUUM` and the FTS join intact. A test that "demonstrates a real desync" cannot be written against a build that does not exhibit one. **The declaration is kept**, as the finding recommended. §5.1's row now says why in terms SQLite actually guarantees: `memory_fts` joins by rowid, and SQLite documents that `VACUUM` *may* renumber rowids of tables without an explicit `INTEGER PRIMARY KEY`, so the declaration turns an observation into a guarantee. The old "required so VACUUM cannot desynchronise" wording is quoted in the row as the corrected text, and a §0.1 row records the change. **The test title half was already done** — session 2 (#6) retitled the case to "FTS rowids still join to memory after VACUUM + rebuild (see audit #21 re: the cause)" and left a cross-reference calling #21 "still open". That comment is updated to record the close and the reason no demonstration was built. The §5.1 `checkpoints_fts` block (#28) was written in the same guarantee-not-hazard terms so the two do not contradict each other. Migration `0001`/`0009` comments that repeat the stronger claim are left untouched because migrations are checksummed. |
| 22 | MINOR | P1 | §17.2 rate limiting | **No IPC rate limiting anywhere**, despite a MUST rule and a reserved `RATE_LIMITED` code with no IPC-side producer. Low severity today because the renderer is the only permitted sender; it stops being low when `chat.send`, `memory.write` and `packs.install` become loops that spend money. M11 is that milestone. | a grep of `src/main/ipc/` for `rateLimit` and `throttle` → nothing; `envelope.ts:27` | A per-channel token bucket in `dispatchIpcCall` applied to a named list of expensive methods, not all 109 | 2–3 h | **FIXED** (fix session 3b) — built now rather than recorded against M11, because M11 is the next session and is the milestone the finding names as making it real. Verified first: no `rateLimit`/`throttle` anywhere in `src/main/ipc`, and `RATE_LIMITED` had no producer. A per-channel token bucket in `src/main/ipc/rateLimit.ts`, on a **named list** of three methods: `chat.send` (burst 10, 1/s — every accepted call can be a Director turn from M11), `memory.write` (20, 2/s) and `packs.install` (3, one per 10s). Not all 109: the sender check already limits callers to Bureau's own windows, so the abuse being guarded against is a renderer bug in a loop, and that only matters where a call is expensive. One limiter per process, because what it protects is spend. A refused call gets plain language and `action: retry`. **Placed after the sender check and before input validation**, so an unknown frame cannot spend a real window's tokens, and a *malformed* loop to these channels is bounded too — which also caps how fast #20's new rejection events can be written for them. **The numbers are not tuned against measurement**, because there is no traffic to measure; they are chosen so a person cannot hit them and a loop always does, and a test pins the contract ("one message every two seconds for a minute is never refused"). If one binds on real use, raise it. **Standing rule 9, twice, and the second is the one that matters.** A limiter that never refuses fails 3 of 6 unit cases. But those tests inject the limiter by hand, so **deleting the single line in `registerIpcRouter` that passes the real one in left every unit test green** — standing rule 2 exactly. `tests/e2e/ipcRateLimit.spec.ts` closes that: forty back-to-back `chat.send` calls from the real renderer in the packaged app must include `RATE_LIMITED`, and with that line removed and the app repackaged it fails with "forty back-to-back calls were never rate limited". |
| 23 | MINOR | P1 | §17.2 push | **Four of six `stateDelta` slices are pushed only on window load**, so `projects`, `tasks`, `settings` and `company` are stale until reload while §17.2 says the renderer never polls. The Board renders from `state.tasks`, so a task created while the window is open never appears. Arguably M11's problem — nothing writes tasks yet — but the mechanism is one line per slice. | `liveState.ts` watches `checkpoints`+`employees`; `stateDelta.ts:83-90` | Add `projects` and `tasks` to `liveState.ts`'s watched slices with their `project.*`/`task.*` event prefixes; `settings` already has `app.setting_changed` | 1–2 h | **FIXED** (fix session 3a), folded in early rather than left to M11 — and it stopped being "arguably M11's problem" the moment #17 landed in the same session: the splitter persists to a settings key and the floor pane renders from the `settings` slice, so without this push a dragged width snapped back to the stored value until the next reload. `liveState.ts` now watches five slices. `project.*` -> `projects`, `task.*` -> `tasks`, and **`app.setting_changed` as a single type rather than an `app.` prefix** — `app.` also carries `started`, `migrated` and `quit`, none of which change a setting, and every needless patch consumes a sequence number the renderer checks for gaps. `projects` and `tasks` read through `buildFullSnapshot` rather than getting list queries of their own: neither has a shared reader the way `listPendingCheckpoints` and `listEmployees` do, and a second definition of what a slice contains is the drift this file exists to prevent (standing rule 6, and the same fix `buildFullSnapshot`'s own `checkpoints` line got at M9). **`company` is deliberately NOT watched, and this narrows the finding.** The audit lists four stale slices and its suggested fix names three. The fourth is real but has no honest trigger today: `company.created` fires once before any window exists, and the remaining `company.*` types are pack and floor events that change no field of the company row. Adding a subscription that can never fire would look like coverage and be none. Recorded here rather than silently skipped. **Standing rule 9.** All three cases confirmed failing first, for the right reason ("expected undefined to be defined" — no patch at all), and each subscription line was then removed on its own: deleting the `task.` line fails exactly one test and leaves the other three green, so no line is riding on another's coverage. A fourth case is a negative control — an unrelated `app.started` must churn no slice — and it passed before the fix as well as after, which is what makes the other three meaningful. **What the test can and cannot prove, stated in its own header rather than left for a reader to assume.** `settings` is driven end to end through the production `settings.set` handler. `projects` and `tasks` cannot be: **nothing in `src/` emits `project.created` or `task.created`** — those producers are M11's. Those two cases drive the real `activityLog.logEvent`, which is the exact mechanism the subscription hangs off, over real repository writes; what is missing is only the producer, and inventing one would be inventing the Director. |
| 24 | MINOR | P1 | Process | **Only one of the spec's four enumerable lists has a mechanical check.** §17.1 is pinned by `checkIpcSurface.mjs` in CI. §5.1's schema, §5.2's taxonomy and §16.1's registry are pinned by convention only — and all three happen to be exactly correct right now, which is the best possible moment to lock them. The named precedent (`review.trivialTaskMaxChangedLines` missing from both sides) is what happens when convention is the only mechanism. | `grep -rl BUILD-SPEC tests/ scripts/` → only `checkIpcSurface.mjs`; Phase 1's three diff scripts each under 60 lines | Lift the Phase 1 subagent's `schemaDiff.mjs`, `settingsDiff.mjs` and `evDiff2.mjs` into `scripts/` and add them to CI after the existing surface check | 2–3 h | **FIXED** (fix session 3b) — three checks in CI after the surface check, each mutation-confirmed — **with a correction to the finding's premise.** **Correction: the three lists did not "all match exactly" by the time this session ran the Phase 1 scripts against HEAD.** They reported four differences. Three were **parser artifacts, not drift**: session 2's #18 annotation added unparenthesised prose to §5.2's `app.` row, which the prototype read as the types `app.events` and `app.restarted`; `PRAGMA table_info` hides generated columns, so `roles.full_key` looked missing; and `task_deps` is described as a parenthesised composite key. The fourth was **real**: `checkpoints_fts`, which is #28 and was fixed first so these checks could land green. **So the scripts were rewritten, not lifted verbatim**, into `scripts/checkSchemaSpec.mjs`, `checkEventTaxonomy.mjs` and `checkSettingsSpec.mjs` (shared helpers in `specLists.mjs`), under one principle: **a row the parser cannot read unambiguously is an error, never a skip or a guess.** A prototype that invents two event types is noise in a one-off audit and a lie in CI. They read the real code (TypeScript bundled with esbuild, migrations applied to in-memory SQLite, `table_xinfo`), and each has a "found nothing at all — the parser is broken" guard. The schema check's first draft had its own artifact — a regex matching from one code span's closing backtick to the next one's opening backtick — caught on its first run and fixed by tokenising spans properly. **Standing rule 9, ten mutations, all caught:** a column added by a migration only; a column added to §5.1 only; a whole table added by a migration only; a setting added to schema+registry only; a setting added to §16.1 only; a group changed in §16.1 only; a default changed in the schema only; an event type added to `EVENT_TYPES` only; one added to §5.2 only; and prose inserted into a type list, which the old prototype would have read as types and this refuses. The settings check compares keys, groups, scopes and defaults — strictly more than `settingsRegistry.test.ts`'s key count, whose comment (written in fix 3a, calling this check nonexistent) is updated. **Narrowed:** `modelDiff.mjs` (Zod entity models vs table columns) was **not** lifted — it is a fourth list the finding did not name, compares code to code rather than spec to code, and depends on bundles of every model; recorded here rather than silently dropped. `ipcDiff.mjs` duplicates `checkIpcSurface.mjs`. Indexes and triggers are not diffed, because §5.1 does not enumerate them. |
| 25 | MINOR | P1 (verified) | IPC stubs | **Six handler stubs name milestones that already shipped** — `tasks.cancel/retry/reassign` → `stub('M3')`, `workspace.diffForTask/diffForEmployee/fileTree` → `stub('M5')`. The label is user-visible via `ipcNotImplemented(owningMilestone)`, so the app tells a user a feature is coming in a milestone that is behind them. Both belong to **M14** (§28 M14 item 1 "task detail", item 2 "Files with diffs"). The four `employees.*` Inspector stubs are the counter-example done right. | `handlers/tasks.ts:28-30`, `handlers/workspace.ts:5-7`; §28 M14 | Re-tag both groups to M14; add a check that a stub's milestone is not already complete | 30 min | **FIXED** (fix session 3b). All six confirmed still present, all six re-tagged: `workspace.diffForTask/diffForEmployee/fileTree` -> M14 (§28 M14 item 2, "Files with diffs"), `tasks.cancel/retry/reassign` -> M14 (item 1's task detail). No §28 item names the task actions explicitly; their comment now says the assignment loop they act on is M11's (item 10), so M11 may make them real first. **This finding is a repeat, and that is the useful part.** The **M3–M6 audit's #22 found these exact six stubs** — M3 and M5 closed with `stub('M3')`/`stub('M5')` in the tree. Its fix added guards for **one milestone at a time** (`companyHandlers.test.ts` and `employeeControlHandlers.test.ts` both assert only that `stub('M7')` is gone) and never re-tagged the M3/M5 stubs themselves. A per-milestone guard has to be remembered and written for each milestone, which is exactly the step that got skipped. **The durable half is general:** `tests/unit/ipc/stubMilestonesNotShipped.test.ts` reads every `stub('Mn')`/`ipcNotImplemented('Mn')` in the handlers and fails if its milestone's row in `PROJECT-CHECKLIST.md` §2 begins with ✅ — the checklist being where this project records a milestone as closed, so there is one definition of "done", not two. Confirmed failing first on exactly these six. **Standing rule 9:** marking M11 ✅ in a copy of the checklist fails the test with all **13** remaining `stub('M11')` handlers listed — which is also what it will do, usefully, the day M11 really closes. The two older M7-only guards are left in place; they still pass and are now subsumed. |
| 26 | MINOR | P1 | §16.1 | **`settings.json` is never written.** §16.1 describes it as an export/import convenience "written on change for user inspection and never read at runtime". Nothing writes it. The important half — never read at runtime — is satisfied by construction, so there is no drift risk today. | `grep -rn "settings.json" src/` → only `claude-settings.json` and a comment | Write the redacted snapshot from `handlers/settings.ts`'s `set` path | 1 h | **FIXED** (fix session 3b) — built, not deferred. Verified first: nothing in `src/` wrote `settings.json` (the only mention was `secretStore.ts` promising never to put secrets in it), while §16.1 and Appendix D both tell a user the file exists. `settings.set` now writes `settings.json` beside the database after the setting is committed and `app.setting_changed` is logged (invariant #3): the whole registry, **redacted** (`redactDeep`, since this file exists to be opened and shared), **atomically** (temp file + rename). A write failure is logged and does not report the committed change as failed. It emits no event of its own — it is a derived copy, not a state change. Written on change only, as §16.1 says; not at first run. **"Never read at runtime"** — the half §16.1 cares most about — now has a test: a scan of `src/` for any reader of the file. **Tests failed first for the right reason** ("settings.json was never written"; ENOENT), driven through the real handler rather than a unit test of the writer, so the test proves the handler calls it. They cover the value landing, the whole registry being present, a secret-shaped value being redacted, and no temp file left behind. **Deferred part, named:** the *import* half of "export/import convenience" is not built; nothing reads the file, by design, and an import flow belongs with §16's Privacy & Data "export everything" work (`projects.exportData`, `stub('M15')`). **One unrelated failure seen and diagnosed rather than dismissed:** `settingsZeroCostGate.test.ts` failed once during this work and passed on a clean HEAD, so it was checked properly — it passes 3/3 with this change in place, and this change cannot reach its outcome (the refusal returns before the snapshot, and the snapshot cannot alter `result.ok`). The test probes the real `claude.exe` twice, once inside the handler and once as "ground truth", and compares — so a cold first probe (indeterminate, fail-closed) against a warm second probe disagrees. That is the bimodal cold/warm mechanism the §7.8 probe-deadline session measured; recorded against the real-process row in `PROJECT-CHECKLIST.md`. |
| 27 | MINOR | P1 | §17.2 long operations | **No job-id mechanism.** §17.2 requires long operations to return a job id and report progress. Four already-real handlers are synchronous and unbounded on the main thread: `system.compactDb` (VACUUM), `system.backupDb`, `memory.reindex`, `packs.install`. `buildFullSnapshot` is a related instance — it loads every project, task and employee row into one push on every window load, unbounded. | `grep jobId src/shared/ipc src/main/ipc` → nothing; `stateDelta.ts:39-66` | Not worth the general mechanism now; record the four in `NEXT-VERSION.md` against the milestone that makes any of them slow, and bound `buildFullSnapshot`'s `tasks` slice before M11 starts creating tasks | 30 min to record | **RECORDED, as the finding recommended** (fix session 3b) — the general job-id mechanism deliberately not built; `docs/NEXT-VERSION.md` §N now records each case against the milestone that first makes it slow. Verified first: `jobId` appears nowhere in `src/`, all four handlers are real and synchronous, and because better-sqlite3 is synchronous the real cost of each is that the **main process** blocks — every IPC call, push and control-channel request queues behind it — which §N says, rather than framing it as a UI spinner. Owners: `system.compactDb` and `system.backupDb` -> **M15** (linear in database size; `events` is the table expected to grow fastest, stated as unmeasured); `memory.reindex` -> **M15**, moving to M11 if a full reindex is noticeably slow there; `packs.install` -> **M14**, which authors the first large packs. **`buildFullSnapshot`'s `tasks` slice -> M11, and made more pressing by these fix sessions.** Fix 3a's #23 made `liveState` push `projects`/`tasks` live by reading them *through* `buildFullSnapshot` (one definition of a slice), so every coalesced `task.*` burst now builds all six slices to send one. Coalescing keeps a plan insert to one rebuild, but that rebuild is O(everything). §N names the fix — scope the slice to a project and give `projects`/`tasks` shared readers of their own — so M11 does not meet it as a mystery. Two claims in the draft entry were corrected before it was written: the per-migration backup at startup is `migrate.ts`'s own `backupBeforeMigration`, not the `system.backupDb` handler; and "the largest table by far is `events`" was softened to an unmeasured expectation. |
| 28 | MINOR | P1 | §5.1 docs | **`checkpoints_fts` and its three triggers exist in the schema and nowhere in the spec.** §5.1 documents `memory_fts` in detail and every column added by migrations 0002–0008 and 0010; `grep checkpoints_fts docs/BUILD-SPEC.md` returns nothing. The migration's own header contains the best reasoning in the repo on why this index is standalone rather than external-content — which belongs beside `memory_fts` where the next person choosing an FTS shape will read it. | `0009_checkpoints_fts.sql:1-53`; §5.1 | Add a `checkpoints_fts` block to §5.1 and an amendment-log row | 30 min | **FIXED** (fix session 3b). Verified first: `grep checkpoints_fts docs/BUILD-SPEC.md` returned nothing, and `duplicateDetection.ts` is its one reader. §5.1 now has a `checkpoints_fts` block directly after `memory_fts`, in the same `CREATE VIRTUAL TABLE` shape, carrying the migration header's reasoning: standalone rather than external-content because `checkpoints` has an implicit rowid; keyed by a TEXT id nothing renumbers; triggers that delete by `checkpoint_id`; the backfill; no post-`VACUUM` rebuild needed; and `idx_checkpoints_expiry` for §9.5's sweep. §0.1 row added. **One wording change from the migration's own text, deliberately.** The migration says an implicit rowid "is exactly what VACUUM is free to renumber". That is true as a statement of what SQLite *guarantees* and, per #21's probe, not what this build observably does. The spec states it as the guarantee argument, so this block and the #21 correction do not contradict each other. The migration comment (which also says `ftsVacuum.test.ts` "pins that behaviour", which #21 shows it does not) was **left alone**: migrations are checksummed, and editing an applied migration's comment would fail every existing database's checksum. Noted here instead. **Found mechanically as well as by reading:** the first honest run of #24's new `checkSchemaSpec.mjs` reported exactly one real difference against HEAD — this table — and passes (29 tables, 348 columns) with this block in place. |
| 29 | MINOR | self | §11.6 / lens 2 | **`ActivityLog.onEvent`'s doc comment asserts a safety property on a premise that is false today, and the premise is not safe anyway.** It says listeners are deferred because "`logEvent` is frequently called mid-transaction". A brace-matching scan of every `db.transaction(...)` body in `src/` finds **no** production `logEvent` call inside one; every caller deliberately logs after commit. The deferral is good defensive design, but the comment reads as licence for a future author to log mid-transaction — and that is unsafe for a reason nothing records: a rollback would leave the fsync'd JSONL line with no mirror row, and `repairMirror` replays only entries *after* `MAX(seq)`, so a hole below the high-water mark is never repaired. | `activityLog.ts:96-102`; scan script; `reconcile.ts:219-227` (`repairMirror` uses `MAX(seq)`) | Correct the comment to say mid-transaction logging is *not* currently done and must not be, and say why; if it is ever wanted, `repairMirror` needs to detect holes rather than trust the high-water mark | 30 min | **FIXED** (fix session 3b) — comment rewritten, **premise re-verified after session 2's changes, and one consequence added that the finding did not name.** Re-ran the scan rather than inheriting it, since #2 made `logEvent` strict: a brace-matching scan (strings and comments blanked first) finds **18** `db.transaction(...)` bodies in `src/`, **none** calling `logEvent` directly, and none calling any of the **39** named functions that do. Standing rule 9: injecting `activityLog.logEvent(...)` into `usage.ts`'s transaction body makes the scan report it at the right line, so the zero is a real zero. Limit stated in the comment: the one-level indirect check follows named function declarations, not class methods or passed-in arrows, so it is evidence rather than proof. The comment now says mid-transaction logging **is not done and must not be**, and gives both reasons. The audit's: a rollback leaves the mirror with a hole *below* `MAX(seq)` (the insert rolls back, `nextSeq` has already advanced), and `repairMirror` only replays entries after the high-water mark. **And a worse one it did not name:** the JSONL line is fsync'd before the mirror insert and the file is the authoritative record, so the log would permanently record a state change that never happened — invariant #3 broken in the durable direction, not just the mirror. **Narrowed:** no runtime guard was added. `better-sqlite3` exposes `db.inTransaction`, and a throw at the top of `logEvent` would turn this from a documented rule into an enforced one; it is a behaviour change on the hottest write path, beyond what the finding asked, and is recorded here as the obvious next step rather than built quietly. |
| 30 | MINOR | self | Docs | **`PROJECT-CHECKLIST.md` §7 has seven standing rules numbered 1–6 and 8; there is no rule 7.** Traced with `git log -S`: rule 8 was added by `66609a3` (M9) numbered "8" when the highest existing rule was 6. **No rule was lost** — it is an authoring off-by-one. Worth correcting because the count is now cited as fact, including by this audit's own brief. | `PROJECT-CHECKLIST.md` §7; `git show 66609a3 -- PROJECT-CHECKLIST.md` | Renumber 8 → 7 | 5 min | **DECLINED** (fix session 3b) — not renumbered, **and the finding's diagnosis is corrected.** The audit traced rule 8 to `66609a3` and called the gap "an authoring off-by-one". Checking with `git log -S` shows the opposite ordering matters: the paragraph "**A seventh, provisional**" (the identity-over-name cache rule, not yet earned by a second instance) was added on **2026-09-07 in `8bca2d2`**, two days before rule 8 was numbered on 2026-09-09. At `66609a3`, §7 held rules 1–6 *and* a paragraph already named as the seventh. Numbering the new rule "8" is most consistent with holding 7 for it — a reserved slot, not a slip. The audit read the numbered list and missed the unnumbered paragraph beneath it. **Declined with reasons, both now stated in §7 itself:** 7 is held for the provisional rule (it becomes 7 if earned; a different new rule takes 10), and renumbering would break citations that cannot be fixed — rules 8 and 9 are cited by number in 17 commit messages (immutable) and on 26 lines across the tracked files. Numbers are identifiers, not a count. The placeholder paragraph fix 1 left ("the gap at 7 is audit #30's") is replaced by this explanation. |

---

## Phase 3 — adversarial mutation testing

Fourteen mutations, each corresponding to a promise the spec makes, each one
that would survive code review as a plausible refactor, each silent until the
day it matters.

**Budget discipline.** The full integration suite is 851s; fourteen mutations
against it would be over three hours of pure execution. Each mutation below
names the suites actually run and why they were the ones that could plausibly
catch it. A narrow run reporting NOT CAUGHT is recorded as a finding with the
run named; runs were widened only to confirm a surprising CAUGHT.

**Baselines, measured today at `3af75d9`, all green:**

| Suite | Result | Time |
|---|---|---|
| `npm test` (unit) | 73 files, 613 tests passed | ~22 s |
| `npm run test:integration` | 103 files, 688 tests passed | 851 s |
| `killPoints.test.ts` alone | 22 passed | 23.9 s |
| `playwright packaged-window + security/` | 3 passed | 12.3 s |
| `npm run lint` / `npm run typecheck` | clean | — |

*(verdicts appended below as they are confirmed)*

### M1 — Drop a §5.0 pragma from `openConnection`

`openConnection()` is the **only** write-connection path in `src/` (the sole
other `new Database(` is `smoketest/nativeModules.ts:26`, `:memory:` running
`SELECT 1+1`), so this is one target, not a "non-first connection path".

**M1a — `foreign_keys = ON` removed** (`src/main/db/connection.ts:42`).
**Verdict: NOT CAUGHT — and the mutation is behaviourally inert, which is the
actual finding.**

Suites run: `deferredForeignKeys.test.ts`, `repositoryValidation.test.ts`,
`killPoints.test.ts` (36 tests), then the full unit suite (613 tests). All
green.

The surprise is that `deferredForeignKeys.test.ts:108-116` — *"still rejects a
truly dangling FK at commit — deferred is not the same as disabled"* — passed
with the pragma gone. Root-caused by direct probe rather than assumed:

```
$ node -e "const db=new Database(tmp); db.pragma('journal_mode = WAL');
           console.log(db.pragma('foreign_keys'))"
foreign_keys default when not set: [{"foreign_keys":1}]
```

**`better-sqlite3` turns foreign keys ON for every connection it opens.** The
SQLite C library defaults them OFF; this driver does not. So
`db.pragma('foreign_keys = ON')` restates a default, removing it changes
nothing, and no test could have caught it because there was nothing to catch.

That is not a clean bill of health. §5.0 names this pragma as a requirement,
and **nothing anywhere asserts it is actually on** — the guarantee currently
rests entirely on an undocumented library default. A `better-sqlite3` major
bump that changed it, or any future path that reaches the database through a
different driver (a `sqlite3` CLI recovery step, a restore path, a second
process), would silently disable referential integrity across all 26 tables
with a fully green suite. Recorded as finding **#13**.

**M1b — `journal_mode = WAL` removed** (`src/main/db/connection.ts:43`).
**Verdict: NOT CAUGHT.**

Suites run: `killPoints.test.ts` (22), `singleWriterAndLocking.test.ts` (6),
`migrate.test.ts` (6) — 34 tests, all green.

Unlike M1a this is a genuine behavioural change: the probe confirms the
default is `delete`, not `wal`.

```
journal_mode default: [{"journal_mode":"delete"}]
```

Losing WAL changes durability and reader/writer concurrency, and it silently
invalidates reasoning the codebase already depends on —
`src/main/db/backup.ts:31-33` warns that "copying over an open WAL-mode
database would corrupt it", and `migrate.ts:121` uses `db.backup()`
specifically because it is WAL-safe. All 22 kill points still pass, so the
durability gate does not notice which journal mode it is proving durability
*of*. Recorded as finding **#13**.

### M2 — Invert the activity-log write order

§28 M1 item 6: append + `fsync` to `activity.jsonl` **first**, then the mirror
row. Mutation moves `insertMirrorRow` above the file write, leaving the
`afterFileWrite` hook where it semantically belongs.

**Verdict: CAUGHT.** Two tests, both reaching production `logEvent()`:

```
× kill point 15: reconciles cleanly, no lost committed state
  → mirror must NOT have it yet — that is the whole point of this kill
    point: expected 1 to be +0

× ActivityLog.logEvent() afterFileWrite hook (AUDIT finding #4)
  > the file has the entry and the mirror does not, at the moment the hook fires
  → mirror must NOT have it yet when the hook fires: expected 1 to be +0
```

Suites run: `killPoints.test.ts`, `activityLogHook.test.ts`,
`reconcileActivityEvents.test.ts`.

**Lens 1 — this is a real catch.** Kill point 15 spawns a real OS process and
pins the kill inside the real `logEvent()` via its own `afterFileWrite` seam;
`activityLogHook.test.ts` calls the same production method. Neither
re-implements the ordering it asserts. This is the August audit's finding #4
fix doing exactly the job it was built for, three milestones later.

### M3 — Remove the `fsync`, keeping the order

**M3a — delete `fsyncSync(this.fd)` outright** (`activityLog.ts:71`).
**Verdict: NOT CAUGHT by any test** — `killPoints` + `activityLogHook` +
`reconcileActivityEvents` = 32/32 green. Caught **incidentally by lint only**:

```
src/main/db/activityLog.ts
  2:33  error  'fsyncSync' is defined but never used  @typescript-eslint/no-unused-vars
```

**M3b — the realistic refactor: `fsync` once on `close()` instead of per
write.** This is what a performance-minded reviewer would actually propose,
and it keeps the import used, so the incidental lint catch disappears.
**Verdict: NOT CAUGHT.** `npx eslint` clean, `tsc --noEmit` clean, 32/32
tests green.

**This is the answer the mutation existed to get: §28 M1 item 6's `fsync` is
written down and never tested.** Nothing in the repo asserts durability across
power loss — `grep -rn fsync tests/` returns exactly one hit, a passing
mention in a comment in `supervisor.test.ts:591`. The kill-point gate proves
durability across *process* death (`TerminateProcess`), which the OS page
cache survives; it cannot and does not prove durability across machine death,
and the gate's wording ("every one reconciles cleanly with no lost committed
state") does not distinguish the two.

Compounding it, and not previously recorded anywhere: **§5.0 does not specify
`synchronous`**, so the connection runs at SQLite's WAL default of
`synchronous=NORMAL`, which does **not** fsync the WAL on every commit. So the
database half of a committed state change has the same exposure as the file
half. Recorded as finding **#8**.

### M4 — Downgrade the migration checksum mismatch to a warning

§28 M1 item 2 says hard error. Mutation replaces the `throw
MigrationChecksumMismatchError` at `src/main/db/migrate.ts:158` with a
`console.warn` + `continue`.

**Verdict: CAUGHT.**

```
× migration runner (§5.3) > a checksum mismatch on an already-applied migration is a hard error
  → promise resolved "{ applied: [] }" instead of rejecting
```

Suite run: `tests/integration/migrate.test.ts` (1 failed | 5 passed).

**Lens 1 and lens 4 both pass, and this is the best-built test in the region.**
`migrate.test.ts:132-155` calls the real `runMigrations`, copies the *whole*
real migrations directory to a temp dir, and appends `-- tampered` to `0001`'s
bytes — a genuine on-disk edit, not a hand-written `schema_migrations` row.
Its own comment explains why it copies every file rather than just the tampered
one: otherwise `MissingMigrationFileError` (the August audit's finding #7)
would fire first and mask the behaviour under test. That is a test author
explicitly defending against lens 4 before lens 4 had a name.

### M5 — Weaken `reconcile()`'s orphan identity to PID only

`src/main/db/reconcile.ts` `sweepOrphans` — drop the
`currentStartTime === row.process_start_time` half, leaving `currentStartTime
!== null`. PID reuse then kills an innocent process.

**Verdict: CAUGHT.**

```
× reconcile() (§4.4, §28 M1 step 7) > does not touch an employee whose recorded
  start time no longer matches (PID reuse guard)
  → expected [ 'emp2' ] to deeply equal []
```

Suites run: `reconcile.test.ts`, `reconcileActivityEvents.test.ts`
(1 failed | 15 passed).

**The August audit's finding #5 fix holds and has teeth.** That finding was
that the guard's test used PID 999999 — a PID that does not exist — so it never
exercised reuse at all. `reconcile.test.ts:117-140` now spawns a real live
process, records a deliberately stale `process_start_time` against it, and
asserts `reconcile()` leaves it alone. Zero occurrences of `999999` remain in
`tests/`.

### M6 — Delete the `memory_fts` UPDATE trigger

`src/main/db/migrations/0001_initial.sql:539-542`, keeping INSERT and DELETE.

**Verdict: CAUGHT.**

```
× memory_fts (§5.1) > an update is reflected — old term gone, new term found (sync trigger)
  → expected 1 to be +0
```

Suites run: `ftsVacuum.test.ts`, `tests/integration/memory/`
(1 failed | 74 passed).

### M7 — Remove `memory.rowid INTEGER PRIMARY KEY`'s explicit declaration

`src/main/db/migrations/0001_initial.sql:505`. §5.1 names this column
specifically, with the rationale: *"Explicit INTEGER PRIMARY KEY rowid —
required so VACUUM cannot desynchronise the FTS index."*

**Verdict: CAUGHT — but by nothing that has anything to do with VACUUM, and
the test named for the property passes.** This is the sharpest lens-4 result
in the audit.

What actually failed: five M10 memory tests and kill point 21, all with the
same cause —

```
[ipc] memory:write threw: ZodError: [{ "code": "invalid_type",
  "expected": "number", "received": "undefined", "path": ["rowid"] ... }]
```

`MemorySchema` requires a numeric `rowid` field, and with the column implicit
`SELECT *` no longer returns it. So the declaration is pinned **incidentally,
by a Zod model**, not by any test of the property §5.1 states.

What did *not* fail:

```
$ npx vitest run ... tests/integration/ftsVacuum.test.ts
 ✓ tests/integration/ftsVacuum.test.ts (4 tests)
 Test Files  1 passed (1)   Tests  4 passed (4)
```

**`ftsVacuum.test.ts` passes 4/4 with the explicit rowid gone — including the
test titled *"survives VACUUM + the documented rebuild — explicit rowid means
VACUUM cannot desync it (§5.1)"*.**

Pushed one step further, by direct experiment rather than inference
(probe **A2** in the appendix — four configurations, with rowid gaps created
by deleting rows before the VACUUM):

```
explicitRowid=true  rebuild=true  | rowids before=[1,3,5] after=[1,3,5] | join=["m1","m3","m5"]
explicitRowid=true  rebuild=false | rowids before=[1,3,5] after=[1,3,5] | join=["m1","m3","m5"]
explicitRowid=false rebuild=true  | rowids before=[1,3,5] after=[1,3,5] | join=["m1","m3","m5"]
explicitRowid=false rebuild=false | rowids before=[1,3,5] after=[1,3,5] | join=["m1","m3","m5"]
```

**VACUUM does not renumber rowids in any configuration on this SQLite build**,
with or without the explicit declaration, with or without the rebuild. So the
test's VACUUM case cannot distinguish any of the four states, and neither its
`VACUUM` nor its `rebuild` line is load-bearing for anything it asserts.

To be fair to the code: SQLite documents that VACUUM *may* change rowids for a
table without an `INTEGER PRIMARY KEY` — it does not promise to preserve them.
So the explicit declaration remains correct defensive practice and should stay.
The finding is narrower and is about evidence, not about the schema: **§5.1
states a causal claim ("required so VACUUM cannot desynchronise") that the
test named after it does not demonstrate and this build does not exhibit**, and
the only thing actually holding the column in place is a Zod field that no one
chose for that purpose. Recorded as finding **#21**.

### M8 — Add a second write connection

§28 M1 item 1 says **one**. Mutation removes `openConnection`'s
`ConnectionAlreadyOpenError` guard (`src/main/db/connection.ts:37-39`).

**Verdict: CAUGHT.**

```
× single-writer enforcement (AUDIT finding #3) > refuses a second connection to
  a path that is already open
  → expected [Function] to throw an error
```

Suite run: `tests/integration/singleWriterAndLocking.test.ts`
(1 failed | 5 passed). The August audit's finding #3 fix holds.

### M12 — Drop the partial unique index on `worktrees.lease_holder`

`src/main/db/migrations/0001_initial.sql:321-322`:

```sql
CREATE UNIQUE INDEX idx_worktree_lease
  ON worktrees(lease_holder) WHERE lease_holder IS NOT NULL;
```

**Verdict: NOT CAUGHT.**

Suites run: `tests/integration/workspace/leaseAcquire.test.ts` (which contains
the concurrency case), `tests/integration/killPoints.test.ts` (which acquires a
lease at step 14) — 24 tests, all green.

**Lens 4.** The test that looks like it covers this is `leaseAcquire.test.ts`'s
*"gate 2: N concurrent acquirers racing for one free worktree — exactly one
ever wins, across many independent runs"*. It passes with the index gone
because the thing that actually serialises the race is
`acquireWorktreeLease`'s `BEGIN IMMEDIATE` transaction
(`repositories/worktrees.ts:151`), not the index. The two are independent
defences and only one of them is under test.

The index exists to catch the case the transaction cannot: a *second* writer of
`lease_holder` that does not go through `acquireWorktreeLease`. That is not
hypothetical in this codebase — `reconcile()`'s lease reclamation and
`reconcileGit` both touch worktree rows, and finding **#4** documents ~40
`db.prepare` sites already living outside `repositories/`. Recorded as finding
**#14**.

### M13 — Turn off `noUncheckedIndexedAccess`

`tsconfig.base.json:4`, `true` → `false`. §28 M0 item 2 requires it. Note
there is exactly one place it is defined — all five project tsconfigs extend
`tsconfig.base.json` — so this is repo-wide, not "one tsconfig".

**Verdict: NOT CAUGHT.**

```
npm run typecheck   → exit 0
npx eslint .        → exit 0
npm test            → 73 files, 613 tests passed
```

This is the expected shape and it is worth stating plainly: turning the flag
off makes the compiler strictly **more permissive**, so no existing code can
fail to compile. Nothing in the repo — no test, no lint rule, no CI step —
asserts the flag is on. A future "the build is slow / this cast is annoying"
edit removes a §28 M0 requirement with a fully green CI, and the damage is not
in the diff that removes it but in every subsequent unguarded index access.
Recorded as finding **#15**.

### M9 — Weaken the IPC sender check

Two sub-mutations, because the check has two halves and only one of them is
under test.

**M9a — remove the router's `if (!isSenderKnown)` block** (`router.ts:68-71`).
**Verdict: CAUGHT.**

```
× dispatchIpcCall (§17.2: "never throw across IPC") — unit
  > rejects an unrecognised sender before the handler ever runs
  → expected true to be false
```

Suite run: `tests/unit/ipc/` (1 failed | 7 passed).

**M9b — leave the router untouched; make `isKnownSender()` return `true`
unconditionally** (`src/main/windowRegistry.ts:16-21`).
**Verdict: NOT CAUGHT.**

Suites run: the **entire unit suite** (73 files, 613 tests — all green), then
`tests/integration/ipc/` and `tests/integration/chat/liveCheckpointPatch.test.ts`
(8 files, 58 tests — all green).

**This is lens 1, exactly.** `router.ts:45-46` says `isSenderKnown` is
"injected rather than importing `windowRegistry` directly, for the same
testability reason" — and that is true, and it is also precisely why the real
check has never been tested. `envelope.test.ts:57-66` passes the boolean `false`
in as a parameter; it exercises *the router's branch on a boolean*, never the
function that computes it. `grep -rn windowRegistry tests/` returns two hits,
and neither imports `isKnownSender` — one imports `registerWindow`, the other
mentions the file in a comment.

S13 and S14 cannot cover it either: both send from a genuine Bureau window, so
`return true` gives the same answer the real function would. The result is that
`isKnownSender` — the one gate standing between "any `webContents` in the
process" and all 109 handlers — has **zero** direct coverage of any kind.
Recorded as finding **#5**.

### M10 — Remove §17.2's output-schema validation on handler success payloads

`router.ts:93` — `const parsedOutput = schema.output.parse(result.data);` →
pass the handler's own envelope straight through.

**Verdict: CAUGHT.**

```
× dispatchIpcCall (§17.2: "never throw across IPC") — unit
  > a handler's own success data that does not match its output schema is
    caught as INTERNAL_ERROR, not shipped
```

Suite run: full unit suite (1 failed | 612 passed).

This is the good news the mutation existed to establish. The mechanism whose
interaction with row schemas hid `jsonColumnSchema` for seven milestones is
itself directly tested, so the mechanism cannot silently disappear. (What was
never tested was the *interaction* — see finding **#1**, which is about the
schemas being handed to it, not about the dispatcher.)

### M11 — Make a handler throw instead of returning `{ok:false}`

§17.2: "Never throw across IPC."

**M11a — `settingsHandlers.set` throws unconditionally.**
**Verdict: CAUGHT.**

```
× settingsHandlers.set — the costs.zeroCostMode enable-check (§24.5) > ... → boom   (×3)
```

Suite run: `tests/integration/ipc/settingsZeroCostGate.test.ts`
(3 failed | 0 passed).

Worth noting *how* it was caught, because it is not the way it looks: these
three tests call `settingsHandlers.set(...)` **directly**, so the `boom`
propagated to the test rather than being converted to an envelope. They caught
a broken handler; they did not exercise §17.2's never-throw guarantee at all.

**M11b — remove the router's `try`/`catch` entirely** (`router.ts:79-99`),
which is the actual MUST.
**Verdict: CAUGHT**, by four tests:

```
× a handler that throws still produces a well-formed INTERNAL_ERROR envelope,
  not an uncaught rejection                                          → boom
× a handler that throws a non-Error value still produces a well-formed envelope
                                              → a plain string, not an Error
× a handler's own success data that does not match its output schema is caught
  as INTERNAL_ERROR, not shipped
× a handler that returns a bare, unwrapped value (not ipcOk()/ipcError()) is
  treated as a bug, not shipped as data
```

Suite run: `tests/unit/ipc/` (4 failed | 4 passed). §17.2's never-throw rule is
genuinely and specifically pinned.

### M14 — Move `registerSchemesAsPrivileged` after `whenReady`

§18.1.1 and §28 M0 item 5 both say **before**. `src/main/index.ts:34` calls it
at module scope; the mutation moves it to just after `await app.whenReady()`.
Repackaged (`npm run package`) before running, so the binary under test
actually contained the mutation.

**Verdict: CAUGHT.**

```
3 failed
  packaged-window.spec.ts › packaged app opens a window loaded via app://
  s13RendererHasNoNode.spec.ts › S13 ...
  s14RejectsBadPayload.spec.ts › S14 ...
  Test timeout of 30000ms exceeded.   (×3)
```

The window never finishes loading: without privileged registration `app://` is
not a standard, secure, fetch-capable scheme, so the renderer's module scripts
never load.

**This also answers the sub-question the mutation was chosen for: the suite
does distinguish dev from packaged.** All three of these specs drive the real
`Bureau.exe` via `resolvePackagedExePath()`; a dev-mode-only suite would have
been blind to this entirely, because in dev the renderer comes from Vite over
`http://` and never exercises the scheme.

### Phase 3 summary

| # | Mutation | Verdict | Suites run | Caught by |
|---|---|---|---|---|
| 1a | `foreign_keys = ON` pragma removed | **NOT CAUGHT** (inert) | deferredForeignKeys, repositoryValidation, killPoints, full unit | none — `better-sqlite3` already defaults it ON |
| 1b | `journal_mode = WAL` pragma removed | **NOT CAUGHT** | killPoints, singleWriterAndLocking, migrate | none |
| 2 | Activity-log write order inverted | CAUGHT | killPoints, activityLogHook, reconcileActivityEvents | kill point 15; `activityLogHook` |
| 3a | `fsync` deleted | **NOT CAUGHT** by tests | killPoints, activityLogHook, reconcileActivityEvents | lint only (unused import) |
| 3b | `fsync` deferred to `close()` | **NOT CAUGHT** | same three + eslint + tsc | none |
| 4 | Checksum mismatch → warning | CAUGHT | migrate | "a checksum mismatch … is a hard error" |
| 5 | Orphan identity → PID only | CAUGHT | reconcile, reconcileActivityEvents | "PID reuse guard" |
| 6 | `memory_fts` UPDATE trigger deleted | CAUGHT | ftsVacuum, memory/ | "an update is reflected … (sync trigger)" |
| 7 | `memory.rowid INTEGER PRIMARY KEY` removed | CAUGHT **incidentally** | ftsVacuum, memory/, killPoints | `MemorySchema`'s Zod field — **not** ftsVacuum, which passes 4/4 |
| 8 | Second write connection allowed | CAUGHT | singleWriterAndLocking | "refuses a second connection …" |
| 9a | Router sender check removed | CAUGHT | unit/ipc | "rejects an unrecognised sender …" |
| 9b | `isKnownSender()` → `return true` | **NOT CAUGHT** | full unit (613), integration/ipc, liveCheckpointPatch | none |
| 10 | Output-schema validation removed | CAUGHT | full unit | "…does not match its output schema…" |
| 11a | Handler throws | CAUGHT | ipc/settingsZeroCostGate | ×3, but via direct handler calls |
| 11b | Router try/catch removed | CAUGHT | unit/ipc | ×4 |
| 12 | `idx_worktree_lease` dropped | **NOT CAUGHT** | workspace/leaseAcquire, killPoints | none |
| 13 | `noUncheckedIndexedAccess: false` | **NOT CAUGHT** | typecheck, eslint, full unit | none |
| 14 | `registerSchemesAsPrivileged` after `whenReady` | CAUGHT | packaged e2e (repackaged) | all 3 packaged specs time out |

**11 of 18 caught. Six survived, and one was caught only by accident.**

> **Status after fix session 1 (2026-09-10).** This table stays as the
> record of the run. Five of the six survivors are now caught — 1b, 3a, 3b,
> 9b, 12 and 13 each re-applied one at a time and each confirmed failing
> against `tests/integration/configurationIsInForce.test.ts`,
> `tests/integration/activityLogFsyncOrdering.test.ts` and
> `tests/e2e/security/s13WebPreferences.spec.ts`. **1a remains NOT CAUGHT
> and is not fixable by any assertion**: deleting `foreign_keys = ON` has
> no observable effect, since `better-sqlite3` defaults it ON. A *weakening*
> of it is caught (`foreign_keys = OFF` fails). A new mutation 1c — remove
> the `synchronous = FULL` pragma added by #8 — is caught. See the Outcome
> column on #5, #8, #12, #13, #14 and #15.

The six survivors — 1a, 1b, 3a/3b, 9b, 12, 13 — are each written up as a
missing test in the findings table: 1a/1b → **#13** (pragmas), 3a/3b → **#8**
(`fsync`), 9b → **#5** (`isKnownSender`), 12 → **#14** (lease index), 13 →
**#15** (`noUncheckedIndexedAccess`).

**The shape of the survivors.** They are not randomly distributed. Every one is
a **declaration rather than a behaviour**: a pragma, a compiler flag, an index,
an `fsync`, a function whose result is injected as a parameter. The suite is
strong wherever a test can call something and assert on what comes back, and
blind wherever correctness rests on a setting being in force. Nothing in this
repo asserts a *configuration* — not one pragma, not one tsconfig flag, not one
index's existence, not one `webPreferences` value. That is the single
structural gap Phase 3 found, and it is one cheap test file away from closed.

---

## Phase 2 — gate evidence, run fresh (not remembered)

All commands run today at `3af75d9`, against a `dist-package/` rebuilt from
this exact tree (`npm run package`, exit 0, zero source files newer than the
binary). `ELECTRON_RUN_AS_NODE` was unset in the same command as every
packaged-app run — this shell has it set, and it is the trap recorded in
`PROGRESS.md`'s Known Issues.

| Gate | Command | Result |
|---|---|---|
| **M0** — CI green | `.github/workflows/ci.yml` runs lint → format:check → typecheck → check:ipc-surface → unit → package → integration → contract → e2e | structure verified; local equivalents below all green |
| **M0** — packaged app opens a window via `app://` | `npx playwright test tests/e2e/packaged-window.spec.ts` | **ok** (9.5 s) — asserts the first window's URL starts with `app://` |
| **M0** — `better-sqlite3` + `node-pty` load **inside the packaged app** | `npx vitest run -c vitest.integration.config.ts tests/integration/native-modules.test.ts` | **1 passed** (3.0 s) |
| **M0** — no orphaned child on hard kill | `tests/integration/job-object.test.ts` | **1 passed** (3.0 s) |
| **M1** — kill at every scripted point reconciles cleanly | `npx vitest run -c vitest.integration.config.ts tests/integration/killPoints.test.ts` | **22 passed** (23.9 s) |
| **M2** — S13 | `npx playwright test tests/e2e/security/` | **ok** (3.2 s) |
| **M2** — S14 | same | **ok** (3.2 s) |
| **M2** — every §17.1 method exists | `npm run check:ipc-surface` | `IPC surface matches: 20 namespaces, 109 methods, 7 events.` |
| — | `npm test` | **73 files, 613 tests passed** |
| — | `npm run test:integration` | **103 files, 688 tests passed** (851 s) |
| — | `npm run lint` / `npm run typecheck` | clean |

### Could these gates pass while the real behaviour is broken?

**M0's native-module gate: no, it is a real gate.** `smoketest/nativeModules.ts`
runs inside the packaged `Bureau.exe`, opens a real `better-sqlite3` database
and runs `SELECT 1+1`, and spawns a real `node-pty` `cmd.exe /c echo hi` and
asserts on its output. It checks that the modules *work*, not that files exist.

**M1's kill-point gate: mostly, with one real hole.** Phase 4 below. It kills a
real OS process and reconciles from a genuinely fresh connection — but for 12
of the 22 points the only assertion is `integrity_check` + `foreign_key_check`,
neither of which checks that the step's own committed state survived, which is
what the gate's wording promises. And Phase 3's M3b shows the durability it
proves is process-death durability, not power-loss durability.

**M2's gate: yes, in one specific way, and Phase 4 measured it.** "S13 and S14
pass" is satisfied by tests that drive the real packaged binary — but S13 does
not discriminate `sandbox: true`, which §28 M0 item 4 requires alongside the
two flags it does discriminate. Detail in Phase 4.

**The `check:ipc-surface` gate is narrower than "every §17.1 method exists"
sounds.** Phase 1 established, by reading `scripts/checkIpcSurface.mjs`, that it
compares bare method *names* against §17.1 and checks nothing else: not that a
handler is registered, not that a Zod schema exists, not that the preload
exposes it, not arity or shape, not whether a method is real or a stub, and not
whether an `on.*` event has any producer. Those gaps are real but each is
mitigated elsewhere (a missing handler or schema is a boot crash; the preload is
generated from the same list). The unmitigated one is finding **#11** — five of
seven `on.*` events have no producer and the surface check reports them present (finding **#11**).

---

## Phase 4 — the tests this region leans on hardest

### `tests/integration/killPoints.test.ts` — M1's entire gate

**Does it kill a real OS process?** Yes. `runToKillPoint` spawns
`process.execPath` with an esbuild-bundled worker (`killPoints.test.ts:71`),
waits for exactly *k* `STEP_DONE` markers over a real OS pipe, then calls
`child.kill()` — `TerminateProcess` on Windows, no graceful shutdown. The
worker blocks on a **synchronous** `readSync(0, ...)` after each step, so the
kill point is pinned rather than raced.

**Fresh start, or reused in-memory state?** Genuinely fresh. After the kill the
test calls `openConnection(outcome.dbPath)` and `ActivityLog.open(...)` on the
files the dead process left behind. Nothing in-process survives.

**Production `reconcile()`, or a harness shaped like it?** Production —
`import { reconcile } from '../../src/main/db/reconcile'`, the same function
`src/main/index.ts:83` calls at startup. **Lens 1 passes.** The worker likewise
drives real repositories, the real `ActivityLog.logEvent()` (pinned at its
internal boundary by the `afterFileWrite` seam), the real `ChatStreamRegistry`,
and the real `writeMemory`. Phase 3's M2 confirmed this empirically: inverting
the write order fails kill point 15 for exactly the right reason.

**Do the 22 points exercise genuinely different states?** Less than the number
suggests. Ten of them — 1, 2, 6, 7, 9, 10, 11, 12, 13, 20 — are the same
transition (one repository INSERT) against different tables. The genuinely
distinct kinds are: transaction atomicity (3–5), an UPDATE (8, 14, 18, 19), the
file→mirror boundary (15–16), a mid-stream chat write (17), and the
file→index boundary (21–22).

**What is not covered — the gaps:**

1. **No kill during a migration.** `runMigrations` completes before step 1 and
   is never a kill point. A crash mid-migration is the most dangerous crash a
   schema-versioned app has, and the gate does not go near it.
2. **No kill during a DELETE or a cascade.** Every step is INSERT or UPDATE, so
   no `ON DELETE CASCADE` path is exercised under crash at all.
3. **No kill during `reconcile()` itself.** Crash-during-recovery is untested,
   and `reconcile()` is not obviously idempotent — a second run after a partial
   first would re-emit events.
4. **Only one kill per run.** No double-crash sequence.
5. **No second connection, and no kill under contention.**
6. **The assertion asymmetry, which is the important one.** For 12 of the 22
   points the *only* assertions are `assertBaseInvariants` (integrity_check +
   foreign_key_check) plus "reconcile did not throw". Neither checks that the
   step's own committed row is still there. Kill at step 19 asserts nothing
   about `general.notifications`; kill at step 20 asserts nothing about the
   `usage` row. **The gate is worded "no lost committed state" and for most of
   its points nothing looks for lost committed state.** A repository that
   silently failed to commit would pass. Recorded as finding **#9**.
7. **`reconcile()`'s other eight behaviours are no-ops here.** The worker never
   creates an employee with a PID, a parked employee, a pending permission
   checkpoint, or drifted usage counters — so the orphan sweep, resume
   promotion, checkpoint cancellation and counter reconciliation all run over
   empty sets at all 22 points. They are covered by `reconcile.test.ts`
   separately; they are not covered *by the gate*.

### S13 and S14 — M2's gate

**S14 passes lens 4, and does so convincingly.** The probe: remove the router's
input validation entirely (`router.ts:73-77`), repackage, run S14.

```
> 52 |     expect(malformed).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
1 failed  s14RejectsBadPayload.spec.ts
```

Nothing cheaper rejected the payload first. The reason the assertion
discriminates is that it names the specific code: `settingsHandlers.set` also
re-validates internally (`SettingsSchemas.set.input.parse`, a *throwing*
parse), so with the router's step gone the call still fails — but as
`INTERNAL_ERROR`, not `VALIDATION_FAILED`. Had S14 asserted only `ok: false`
it would have passed and proved nothing. This is defence-in-depth doing exactly
what it should while a well-chosen assertion still isolates the layer under
test.

**S14 does not assert the "logged" half of its own name.** §4.2 and §11.7 both
say malformed IPC is "dropped **and logged**". The test asserts dropped (the
error code) and not-coerced (state byte-identical), and asserts nothing about
logging. Production logging is `console.error` in the main process
(`router.ts:75`), which in a packaged app goes nowhere a user or a support
bundle can see. Recorded as finding **#20**.

**S13 does NOT pass lens 4, and its own header says so.** The file's comment
admits it "would pass identically if `sandbox`/`nodeIntegration`/
`contextIsolation` had never been set at all", and points at an out-of-band
mutation proof that is not in the repo. Measured, with two repackaged probes:

| `webPreferences` probe | S13 |
|---|---|
| `sandbox: false` (contextIsolation + nodeIntegration unchanged) | **passes** — NOT CAUGHT |
| `contextIsolation: false` + `nodeIntegration: true` + `sandbox: false` | **fails** — CAUGHT |

So S13's real coverage boundary is now known rather than assumed: it catches
the classic insecure configuration, and it is **blind to `sandbox: false`**.
That matters because §28 M0 item 4 names all three flags, and dropping the
sandbox is a genuine weakening — the preload regains full Node access in the
renderer process — that leaves `window.require`, `process` and `ipcRenderer`
undefined in the main world, which is all S13 looks at. Recorded as finding
**#12**.

---

## Phase 5 — hygiene

**Clean, with two exceptions, and the sweep is cheap enough that it belongs in
CI rather than in an audit.**

| Sweep | Result |
|---|---|
| `.only` | **none** |
| `.todo` | **none** |
| commented-out tests | **none found** |
| `.skip` / `.skipIf` | 4, all legitimate: `realAgentGate.test.ts:112`, `realEngineSpawn.test.ts:206,246`, `ptySession.test.ts:151` — every one is `skipIf` on a real-engine opt-in or a detected CLI path, and `realEngineSpawn.test.ts:246` emits a *visible* skip line naming the reason rather than silently vanishing |
| `TODO` / `FIXME` / `HACK` / `XXX` in `src/` | **1**, and it is a false positive: `scaffoldPack.ts:21` uses the word `TODO` inside prose explaining why a scaffold should *not* contain TODOs |
| `any` outside `*.d.ts` in `src/` | **none.** `eslint.config.mjs:34` sets `@typescript-eslint/no-explicit-any: 'error'` for `src/**` *and* `tests/**`, with the `.d.ts` override at `:55-57`. §28 M0 item 3 satisfied |
| `any` in `tests/` | **1**, documented and justified: `chatStream.test.ts:74` wraps the real `db.prepare` to count real UPDATEs, with an explicit `eslint-disable-next-line` and a comment saying why |
| `@ts-ignore` / `@ts-expect-error` | **none anywhere** |
| `as unknown as` in `src/` | 5, each with a stated reason: `router.ts:31`, `redactor.ts:168-169`, `mergeTree.ts:72`, `preload/index.ts:43` |
| empty / swallowed catch | **none unexplained.** Every `catch` that returns a bare value carries a comment saying why the failure is the answer (`pathGuard.ts:15` fails closed on an unparseable URL; `activityLog.ts:172` is the torn-trailing-line tolerance the August audit's finding #8 narrowed) |
| functions returning a hardcoded value where real logic was intended | **1, and it is a real finding** — `TitleBar.tsx:31` renders `🔔 0` as a literal in both the visible text and the `aria-label` (finding **#7**) |

**Stale stub milestones (audit #22) — confirmed, and the correct owner
identified.** Six `stub()` calls still name closed milestones:

```
3 stub('M3')   src/main/ipc/handlers/tasks.ts:28-30      cancel / retry / reassign
3 stub('M5')   src/main/ipc/handlers/workspace.ts:5-7    diffForTask / diffForEmployee / fileTree
```

Both belong to **M14**, per §28 M14: item 1 is "Board view: phases, tasks,
dependency DAG, **task detail**" (which is where cancel/retry/reassign live) and
item 2 is "Inspector tabs: … **Files with diffs**" (which is
`workspace.diff*`/`fileTree`). The label is user-visible —
`ipcNotImplemented(owningMilestone)` puts it in the error message — so the app
currently tells a user a feature is coming in a milestone that already shipped.
The four `employees.*` Inspector stubs are the counter-example done right: they
were deliberately re-tagged M7 → M14 with a written reason.

**Standing rules: there are seven, not eight.** `PROJECT-CHECKLIST.md` §7 is
numbered 1, 2, 3, 4, 5, 6, **8** — rule 7 does not exist. Traced with
`git log -S`: rule 8 was added by `66609a3` (M9) numbered "8" when the highest
existing rule was 6. **No rule was lost**; it is an off-by-one at authoring
time. Worth fixing because the number is now cited as fact — this audit's own
brief refers to "§7's eight standing rules". Finding **#30**.

### Coverage — audit #24, open since M6, now closed

**It is stood up, and here are the numbers.** No coverage tooling existed
anywhere in this project: `@vitest/coverage-v8` was not installed and no
`coverage` key appears in either vitest config or `package.json`. Installed for
this audit with
`npm install --no-save --no-package-lock @vitest/coverage-v8@2.1.9` —
**`git status` confirmed unchanged**, so nothing is committed and the fix
session can reproduce it with one command.

M0–M2's data layer, measured across the 21 M0–M2 integration files (143 tests,
all passing):

| Module | % Stmts | % Branch | Notable uncovered |
|---|---|---|---|
| `db/migrate.ts` | **98.1** | 88.9 | 65-66 |
| `db/reconcile.ts` | **94.7** | 96.8 | 150-162 (`cancelStalePermissionCheckpoints` body) |
| `db/connection.ts` | **90.7** | 88.9 | 85-88 (`checkForeignKeys` row mapping) |
| `db/paths.ts` | 90.5 | 100 | 37-38 |
| `repositories/settings.ts` | **100** | 100 | — |
| `repositories/counters.ts` | **100** | 100 | — |
| `db/backup.ts` | **13.6** | 100 | **19-28 (`listBackups`), 36-52 (`restoreFromBackup`)** |

From the unit suite: `pathGuard.ts` **100%**, `shared/settings/schema.ts`
**100%**, `shared/models/**` **97.7%**, `main/protocol.ts` **0%**.

Two things the numbers say that reading did not:

- **`backup.ts` at 13.6% is the sharpest single number in the region**, and it
  corroborates finding **#3** independently: `listBackups` and
  `restoreFromBackup` are not merely uncalled by production, they are unexecuted
  by anything at all. §28 M1 item 8's recovery half has never run, once, in any
  context.
- **`main/protocol.ts` is 0% under the unit suite** and is only ever exercised
  through the packaged app, which is why Phase 3's M14 needed a repackage to
  produce a verdict. That is correct design, not a gap — but it means the
  `app://` handler's 403 branch (`protocol.ts:41`) has no direct test, while the
  guard behind it (`pathGuard.ts`) has 100%.

**One honest note on method:** the first coverage run reported
`1 failed | 142 passed`. Re-run without coverage: **143/143**. Re-run with
coverage: **143/143**. V8 instrumentation slows the kill-point worker enough to
occasionally graze its 15 s marker timeout. The failure is an artifact of
measurement, not a defect — recorded rather than quietly dropped, because a
one-off red that gets re-run until green is exactly the shape this project's own
Known Issues warn about.
---

## Phase 6 — handoff

Two audits follow this one — an **M3–M6 regression check** (that region was
audited on 2026-09-02→05: 30 findings, 5 BLOCKERs, fixes landed, so it needs
confirmation the fixes held and a verdict on the 7 untouched MINORs, not a
re-audit) and a full-depth **M7–M10 audit**. Then M11. This section exists
because a finding that dies in its own report is wasted.

### (a) Patterns to hunt downstream

Four of this audit's findings are **instances of patterns**, not one-offs. Each
is named with where it would recur.

**Pattern A — "the same decision in two places", via raw SQL outside
`repositories/`.** Finding #4 is one instance and it is a *regression* of a
fix the record calls complete. There are ~40 `db.prepare` sites outside
`repositories/`. Where to look:

- **M3–M6:** `engine/parkedEmployeeResumeTick.ts` (`UPDATE employees SET
  status='off', resume_at=NULL`) and `checkpoints/taskBlocking.ts` (two
  `UPDATE tasks SET status`) both write columns that `repositories/employees.ts`
  and `repositories/tasks.ts` already own. Check whether either has drifted from
  its repository twin.
- **M7–M10:** `handlers/memory.ts:123,166` — two different `UPDATE memory SET
  pinned` in one file, one setting `updated_at` explicitly (suppressing
  `trg_memory_updated_at`, which fires only `WHEN NEW.updated_at =
  OLD.updated_at`) and one letting the trigger fire. Same column, same handler,
  two behaviours. This is the highest-value single check on the list.
- **Everywhere:** grep for a column name that appears in both a repository and a
  non-repository `UPDATE`. Spend counters, `status`, `pinned` and `updated_at`
  are the ones already known to have two writers.

**Pattern B — a validator that exists, is tested, and guards nothing.**
Finding #2 (`ActivityLogEntrySchema` / `NewEventInputSchema`, zero production
callers) and finding #5 (`isKnownSender`, zero coverage) are the same shape:
the schema or guard is unit-tested in isolation while the production path calls
something else or nothing. Where to look:

- **M3–M6:** the policy layer is the obvious candidate — the M3–M6 audit already
  found `deny.subagent_spawn`'s pattern could never match and that the one test
  touching it locked in the broken parse as expected. Re-check that fix, and
  apply the same question to every other rule term: *what calls this, on the
  real path?*
- **M7–M10:** `terminalBroadcaster.ts:128-160`'s `fromSeq`/`resync` protocol has
  no caller at all (finding #11). Every M7 pack validator and every M8
  checkpoint validator deserves the same question.
- **The general test:** for any exported function, `grep` its name across `src/`
  excluding its own file. If the only hits are in `tests/`, it is an instance.

**Pattern C — a test whose name claims a property it does not exercise.**
Findings #6 (`ftsVacuum` covering a rebuild the handler never does), #21 (the
same file's VACUUM case discriminating nothing) and #12 (S13 blind to the flag
it is named around) are all this. It is the M3–M6 audit's central finding one
step further on: not "the test uses a stand-in" but "the test asserts something
adjacent to its own title". Where to look:

- **M3–M6:** the S-numbered security tests are the highest-stakes place for it.
  S4 was already found re-implementing the outbound path rather than exercising
  it. Apply lens 4 to S1, S2, S3, S5–S12 individually: mutate the *named guard*,
  not the feature.
- **M7–M10:** any test whose title contains "is", "cannot", "never" or "must" —
  those are property claims — and check the property is what fails when the
  property is broken.

**Pattern D — configuration is asserted nowhere.** Findings #13 (pragmas), #15
(`noUncheckedIndexedAccess`), #14 (the lease index) and #12 (`webPreferences`)
are one pattern with four faces: **this repo has no test that asserts a
setting is in force.** Every one of Phase 3's six survivors is of this kind. It
spans every region and it is the cheapest thing on this list to fix — one test
file asserting pragmas, compiler options, index existence and window flags
would close all four findings and immunise all future regions.

Two findings are **one-offs** and need no downstream hunt: #17 (the splitter,
simply not built) and #30 (a numbering typo).

### (b) Every NOT CAUGHT, translated into a mutation for the next audit

Six mutations survived here. Each has a direct analogue downstream. These are
written to be pasted into the next audit's Phase 3 list.

**For the M3–M6 regression check:**

1. *Config-assertion probe.* Change `autonomy.default` in
   `src/shared/settings/schema.ts` from `guided` to `autonomous` and run the
   security suite. If nothing fails, the autonomy floor is in the same class as
   the pragmas here — a setting nothing asserts.
2. *Weaken an immutable deny's identity.* The M0–M2 analogue of M5: drop one
   term from one of §11.3's seven immutable denies (not the whole rule) and see
   whether any test fails for the right reason, or only because the rule count
   changed.
3. *Remove the fail-closed default on transport failure.* §11.3 says an
   unreachable policy check denies. Make it allow. This is M0–M2's mutation 3
   translated: a durability/safety promise that may be written down and never
   exercised.
4. *Break the lease index's M5 analogue.* Drop `git worktree prune`'s
   post-condition or the worktree lease TTL check, and confirm the concurrency
   test still passes because the transaction — not the constraint — is what it
   actually proves.

**For the M7–M10 audit:**

5. *`jsonColumnSchema`'s siblings.* Finding #1's mechanism is generic. For every
   `jsonColumnSchema(inner)` where `inner` accepts a string, check idempotency
   under double-parse. `checkpoints.preview` (`z.unknown()`) is the one live
   instance; verify no M7–M10 column joined it — `role_options`
   (`z.record(z.unknown())`) and `director_state_data` are safe today because a
   record rejects a bare string, but any new `z.unknown()` or
   `z.union([z.string(), …])` column is a new instance of finding #1.
6. *Make `isKnownSender`'s analogue always-true.* The control channel has the
   same shape: `originCheck.ts` and `authorization.ts` compute a boolean that is
   then passed to the thing that acts on it. Make each *computing* function
   return the permissive value, leaving the caller intact, and see whether
   anything fails. Predicted survivor by analogy with M9b.
7. *Remove an `fsync`/ordering guarantee in the memory write path.* §12.1's
   file-then-index ordering is kill-point-tested (points 21–22), but the
   *durability* of the file write is not. Defer `writeMemory`'s flush the way
   M3b defers `ActivityLog`'s and see whether anything notices.
8. *Turn off a tsconfig or eslint rule that M7–M10 relies on* — e.g.
   `exactOptionalPropertyTypes`, or `no-explicit-any` for `src/**`. Predicted
   survivor, same class as #15.

### (c) What M11 specifically inherits and this audit could not prove

M11 writes M1's tables, streams through M2's IPC, and assembles context from
M10's memory. In descending order of how much it matters:

1. **Finding #1 — checkpoint previews are mangled on the way to the renderer.**
   M11's Director is the main producer of checkpoints. Any preview it supplies
   that is a JSON-looking string arrives at the card as a different type, and a
   preview of exactly `null`/`true`/valid-JSON is dropped from the card
   entirely. This is the surface on which the user approves the Director's
   plans. **Fix before M11 writes its first checkpoint.**
2. **Finding #2 — nothing validates an event at write time.** M11 will emit more
   event types than any milestone so far (brief, plan, phase, task lifecycle).
   The taxonomy is enforced only by the typecheck, and `reconcile`'s repair path
   will insert whatever the JSONL holds, fabricating a `seq` if one is missing.
3. **Finding #9 — the kill-point gate does not check for lost committed state at
   most of its points.** M11 adds brief/plan/phase/task writes, which is exactly
   the state whose durability the gate is supposed to certify. Adding M11's
   steps to a gate with this hole extends the hole rather than testing the new
   code.
4. **Finding #22 — no IPC rate limiting.** M11 is the milestone where an IPC
   method starts spending money on every call (`chat.send` → Director turn). The
   §17.2 MUST is unimplemented and there is a reserved `RATE_LIMITED` code with
   no producer.
5. **Finding #23 — `projects` and `tasks` reach the renderer only on window
   load.** M11 is the first milestone that writes tasks while a window is open.
   Today they would not appear until reload.
6. **Findings #13/#15 — the foundation's configuration is unasserted.** Not
   M11-specific, but M11 is a three-session milestone that will touch these
   files; a silent pragma or compiler-flag regression during it would be
   invisible.
7. **Could not prove correct, and M11 depends on it:** that a crash *during*
   `reconcile()` is safe. `reconcile()` is not obviously idempotent — it emits
   events as it repairs — and no test kills it mid-run. M11 lengthens
   `reconcile()`'s work by adding task and phase reconciliation, which widens
   this window.

### (d) Audit #13 — §10.6 rules 5 and 6, and the deferral that expires now

**Confirmed still entirely absent.** Verified today:

- No push path of any kind: a grep of `src/main` for `git push`, `'push'` and
  `--force-with-lease` returns nothing.
- `base_ref` is written in exactly one place — `repositories/projects.ts:32-44`,
  at project creation — and is otherwise only *read*
  (`employeeWorktree.ts:93,263`, `gitWorktree.ts:188`). Nothing merges into it.
- No phase-acceptance merge exists.

The deferral's stated reason was that *"both rules are triggered by M8/M11
events that do not exist"*. **M8 shipped, and M11 is next, so the reason expires
at the start of M11.** §10.6 rule 5 ("a phase accepted at review merges its
integration branch into `base_ref`; this is the only write to the base branch,
and it is done by the Core") is triggered by §8.5.1's Director phase-acceptance
flow, which is M11 item work. Rule 6 ("pushing to a remote is an `approval`
checkpoint, always") now has its trigger too, since M8 built approval
checkpoints.

**Flag for M11 planning:** rule 5 must be built in the same session as phase
acceptance, or phase acceptance will ship with no integration step and the
branch topology in §10.6 becomes decorative. Rule 6 should be built or
explicitly re-deferred *with a new reason*, because the old reason is no longer
true. Note also that §10.6's own prerequisite — git 2.38+ for
`merge-tree --write-tree` — is still unenforced anywhere, and M13's
`Prerequisite.detect()` is where it belongs.

---

## What is genuinely clean

This cost real work to establish and a report that reads as uniformly negative
gets skimmed. All of the following was verified mechanically, most of it by the
independent Phase 1 subagent, and it is in genuinely good shape.

- **§5.1 ↔ migrations ↔ Zod models: zero real divergence in three directions**,
  across 26 tables and ~300 columns. Every post-`0001` column is attributable to
  the migration §5.1 itself names. The two apparent diffs were extractor
  artifacts (`roles.full_key` is a STORED generated column that `PRAGMA
  table_info` hides; `task_deps`' two columns are described in prose) and both
  were chased down rather than waved away.
- **§16.1 ↔ `schema.ts` ↔ registry metadata: 51/51 exact**, on keys, groups,
  scopes *and* defaults, including the decimal→micros conversion happening
  exactly once. The named precedent (`review.trivialTaskMaxChangedLines`, once
  missing from both sides) is fixed and has no siblings.
- **§5.2 ↔ `eventTypes.ts`: 139/139 exact, both directions.** M9's closure of
  this enum is real at the type level.
- **§17.1 ↔ `methodList.ts` ↔ schemas ↔ handlers ↔ preload: zero divergence on
  all four hops**, with the preload generated from the canonical list so two of
  the hops cannot drift structurally.
- **§5.0's pragmas: one connection-opening function, one exemption** (`:memory:`
  running `SELECT 1+1` in the native-module smoketest), zero real-file opens
  without all three pragmas.
- **§5.1.1 / §5.1.2:** all four cyclic FKs `DEFERRABLE INITIALLY DEFERRED`, the
  bootstrap performed in one transaction, and counters incremented inside
  `BEGIN IMMEDIATE` with the row that consumes them. Input is validated *before*
  the transaction opens, so an invalid input cannot consume a counter value.
- **`killPoints.test.ts` is a real gate mechanism**, whatever its assertion
  gaps: a real spawned OS process, a real `TerminateProcess`, a genuinely fresh
  connection afterwards, and the production `reconcile()` and production
  repositories throughout. Phase 3's M2 proved this empirically rather than by
  reading the doc comment.
- **`migrate.test.ts`'s checksum test is the best-built test in the region.** It
  tampers with real bytes in a real copy of the real migrations directory, and
  its own comment explains that it copies *every* file so that
  `MissingMigrationFileError` cannot fire first and mask the behaviour under
  test — a test author defending against lens 4 before lens 4 had a name.
- **S14 discriminates the layer it names**, because it asserts the specific
  error code rather than just `ok: false`. Defence-in-depth in the handler would
  have hidden a weaker assertion.
- **§17.2's never-throw rule and its output-schema validation are both directly
  and specifically pinned** — four tests fail when the router's try/catch is
  removed, one when the output parse is.
- **Seven of the August audit's nine BLOCKER/SERIOUS fixes survive intact**, and
  #3 (single-writer + `BEGIN IMMEDIATE`) has been *strengthened* since. Two of
  those fixes were re-proved by mutation in this audit: #4's `afterFileWrite`
  seam catches an inverted write order, and #5's PID-reuse test catches a
  weakened identity check.
- **Hygiene is genuinely clean**: no `.only`, no `.todo`, no commented-out
  tests, no `@ts-ignore` or `@ts-expect-error` anywhere, no `any` outside
  `.d.ts` in `src/`, and every swallowed error carries a comment saying why the
  failure is the answer.
- **Coverage of M1's core is high and real**: `migrate.ts` 98.1%,
  `reconcile.ts` 94.7%, `connection.ts` 90.7%, `repositories/settings.ts` and
  `counters.ts` 100%, `pathGuard.ts` 100%, `shared/settings/schema.ts` 100%,
  `shared/models/**` 97.7%.

---

## Things I believe are correct but could not prove

1. **That a crash during `reconcile()` is recoverable.** No test kills it
   mid-run, and it is not obviously idempotent — it emits an event per repair,
   so a second run after a partial first would re-emit. I believe the individual
   steps are each safe to re-run; I did not demonstrate it.
2. **That the `fsync` actually reaches the disk platter.** Finding #8 shows
   nothing tests it. `fsyncSync` is called in the right place today; whether
   Windows honours it through to durable media on this hardware is untested and
   untestable here.
3. **That `better-sqlite3` will keep defaulting `foreign_keys` to ON.** Finding
   #13 rests on a probe of the installed version. Referential integrity across
   all 26 tables currently depends on this and nothing asserts it.
4. **That the 22 kill points leave no lost committed state.** They pass, and
   `integrity_check`/`foreign_key_check` are clean at every one — but for 12 of
   them nothing looks at the step's own row, so I can say the database is
   *consistent* after every kill and cannot say nothing was *lost*.
5. **That the packaged app behaves identically on a machine without this
   sandbox's environment.** `ELECTRON_RUN_AS_NODE` and
   `NoDefaultCurrentDirectoryInExePath` are set in this shell and stripped by
   `packagedAppEnv()`. Everything green here was green with them stripped; a
   genuinely clean machine was not available.
6. **That the August audit's MINOR findings were harmless.** They cannot be
   checked at all — the list exists only in a chat transcript that no longer
   exists (see below).
7. **That §5.1's explicit-rowid rationale is right.** Finding #21: the claim is
   plausible and SQLite's documentation supports keeping the declaration, but
   this build does not exhibit the failure the claim describes, so I could
   neither confirm nor refute the causal statement.

## Things I would do differently starting M0–M2 again

**Blunt, in the order I would change them:**

1. **Write one `config.test.ts` on day one.** Assert the three pragmas on a real
   connection, assert `strict` and `noUncheckedIndexedAccess` from
   `tsconfig.base.json`, assert the three `webPreferences` flags, assert
   `idx_worktree_lease` exists. Ten minutes of work would have closed findings
   #12, #13, #14 and #15 — four of this audit's six mutation survivors, and
   every one of them a thing the project believes is true and cannot check.
2. **Make the gate's wording and the gate's assertions the same sentence.** "No
   lost committed state" and `integrity_check` are not the same claim, and the
   gap between them survived two audits (finding #9). If a gate says a thing,
   the test should assert *that* thing.
3. **Never let a test re-implement the step it covers, even in a fixture.**
   `ftsVacuum.test.ts` inlines the VACUUM+rebuild that `compactDb` was supposed
   to do, which is how a MUST went unimplemented with a green test named after
   it (finding #6). The August audit caught this exact shape once (finding #4,
   the kill worker hand-rolling `logEvent`) and fixed that instance without
   looking for siblings.
4. **Stand up coverage at M0, not at the M11 boundary.** Audit #24 sat open
   since M6. It took one `npm install` and produced finding #3's strongest
   single piece of evidence (`backup.ts` at 13.6%) in the first run. Reading had
   already suggested that function was dead; the number made it undeniable.
5. **Write the audit report to a file, not to chat.** The August audit's nine
   BLOCKER/SERIOUS survived only because someone summarised them into
   `docs/progress/M0-M2.md`. Its MINOR findings are simply gone. An audit whose
   output is not a file is an audit that will be run again from scratch.
6. **Put the amendment log in §0.1 from the first commit.** Finding #19's
   24 unrecorded spec changes are not carelessness — the log did not exist until
   M9, and a retrospective reconstruction caught 5 of 27. The cost is that §5.1
   and §5.2, the two sections most likely to be treated as authoritative, have
   the worst change records in the document.
7. **Do not let a doc comment carry a claim no test carries.** Three separate
   findings here (#2, #5, #29) are comments asserting a safety property that
   nothing exercises, and one of them (#29) asserts a premise that is factually
   false today. A comment saying "this is safe because X" should be required to
   name the test that checks X.

## What the August audit missed, and why

**Two confirmed misses, and they have the same cause.**

**Miss 1 — `jsonColumnSchema` (already known).** Not idempotent under
re-parsing, while §17.2's dispatcher re-parses every success payload against the
same row schemas. `checkpoints.listPending` and `checkpoints.get` returned
`INTERNAL_ERROR` for every checkpoint with options — every type except
`information` — and nothing failed for seven milestones.

**Miss 2 — finding #4, and it is worse, because it is a regression of the
August audit's own fix.** Its record states that `reconcile.ts`'s raw SQL "was
eliminated entirely". Three direct spend-counter `UPDATE`s were added back at
M6, on columns that already have a repository writer. **A fix the record says is
done, undone in the file the record names.** The next auditor reads the record
and moves on — which is exactly what happened, twice.

**What the two audits have in common, and therefore what this one is also
missing.**

Both prior audits — and this one, until Phase 3 — verified **that a mechanism
exists**, not **that anything reaches it**. Every one of this audit's most
interesting findings is of that shape: a schema with no production caller (#2),
a guard with no coverage (#5), a MUST whose test re-implements it (#6), an index
whose test proves the transaction instead (#14), a pragma that restates a
library default (#13), a test that passes under the mutation it is named for
(#21, #12). In every case the *thing* is present and correct in isolation. What
is absent is the connection between it and the running system — and reading
cannot see an absence. Only mutation can, which is why Phase 3 found six
survivors that Phase 1's careful 17-finding trace did not name.

**So the specific thing this audit is also missing is the same thing:
everything I verified by reading and did not mutate.** Concretely, that is most
of Phase 1's Section A. I traced §14.1, §14.6, §14.7, §17.3 and §18.1.1 by
reading, and mutated only two of them (`app://` privileges, `webPreferences`).
The renderer findings (#7, #10, #16, #17) were all found by reading, which means
there are probably renderer-side equivalents of #6 and #21 — tests named for UI
properties they do not exercise — that no one has looked for, because the
renderer has no mutation testing at all and the e2e suite is three specs.

The second, smaller commonality: **both audits trusted a doc comment as
evidence at least once.** The August audit accepted "one write connection" as a
doc comment until it checked (finding #3), and this audit found three more
comments asserting properties nothing exercises. `PROJECT-CHECKLIST.md` §7's
standing rules 1 and 2 exist because of this exact failure, and they were
written *after* the August audit — which is why this audit found instances the
August one could not have been looking for.

---

## Appendix — the two probe scripts

Both were run under `node` from the repo root against the installed
`better-sqlite3` / `zod`. They lived under `dist/audit-scratch/`, which
`npm run package` wipes, so they are reproduced here in full rather than cited
as paths that will not exist.

### A1 — `jsonColumnSchema` idempotency (finding #1)

```js
const { z } = require('zod');
// verbatim transcription of src/shared/models/json.ts
function jsonColumnSchema(inner) {
  const fromStoredText = z.string().transform((raw, ctx) => {
    try { return JSON.parse(raw); }
    catch { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid JSON' }); return z.NEVER; }
  }).pipe(inner);
  return z.union([fromStoredText, inner]);
}
const nullableJsonColumnSchema = (inner) => z.union([z.null(), jsonColumnSchema(inner)]);
const toJsonColumn = (v) => JSON.stringify(v);
const PreviewCol = nullableJsonColumnSchema(z.unknown()); // checkpoints.preview

for (const [name, original] of [
  ['plain string', 'git commit -m x'],
  ['JSON-object string', '{"file":"a.ts"}'],
  ['JSON-array string', '[1,2,3]'],
  ['numeric string', '123'],
  ['"null" string', 'null'],
  ['"true" string', 'true'],
  ['real object', { file: 'a.ts' }],
]) {
  const stored = toJsonColumn(original);   // what the repository writes
  const first  = PreviewCol.parse(stored); // read back from DB TEXT
  const second = PreviewCol.parse(first);  // dispatchIpcCall re-parse (§17.2)
  console.log(JSON.stringify(first) === JSON.stringify(second) ? 'OK' : 'FAIL', name, first, second);
}
```

### A2 — does VACUUM desynchronise `memory_fts`? (finding #21)

```js
const Database = require('better-sqlite3');
const os = require('os'), path = require('path'), fs = require('fs');

function run(explicitRowid, doRebuild) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-'));
  const db = new Database(path.join(d, 'x.db'));
  db.exec(`CREATE TABLE memory (${explicitRowid ? 'rowid INTEGER PRIMARY KEY,' : ''}
             id TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
             tags TEXT NOT NULL DEFAULT '[]');
    CREATE VIRTUAL TABLE memory_fts USING fts5(title, body, tags,
      content='memory', content_rowid='rowid', tokenize='porter unicode61');
    CREATE TRIGGER t_i AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid,title,body,tags) VALUES (new.rowid,new.title,new.body,new.tags); END;
    CREATE TRIGGER t_d AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,title,body,tags)
        VALUES ('delete',old.rowid,old.title,old.body,old.tags); END;`);

  const ins = db.prepare('INSERT INTO memory (id,title,body) VALUES (?,?,?)');
  for (let i = 1; i <= 5; i++) ins.run('m' + i, 'T' + i, 'greenfield body ' + i);
  db.prepare("DELETE FROM memory WHERE id IN ('m2','m4')").run(); // rowid gaps

  const before = db.prepare('SELECT rowid FROM memory ORDER BY rowid').all();
  db.exec('VACUUM');
  if (doRebuild) db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  const after = db.prepare('SELECT rowid FROM memory ORDER BY rowid').all();
  const joined = db.prepare(`SELECT m.id FROM memory m
      JOIN memory_fts ON memory_fts.rowid = m.rowid WHERE memory_fts MATCH 'greenfield'`)
    .all().map((r) => r.id);
  console.log(explicitRowid, doRebuild, before, after, joined);
  db.close();
}
for (const er of [true, false]) for (const rb of [true, false]) run(er, rb);
```
