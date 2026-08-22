# Progress

## 2026-08-21 — M0 (Skeleton)

### What landed

- Repo scaffold: `src/{shared,main,preload,renderer}`, `native/bureau-job-object`,
  `resources/bin`, `scripts`, `tests/{unit,integration,e2e,helpers}`.
- Four TypeScript project-reference configs (`src/shared`, `src/main`,
  `src/preload`, `src/renderer`) plus one for `resources/` and one for `tests/`,
  all `strict: true` + `noUncheckedIndexedAccess: true`, tied together by a root
  `tsconfig.json` solution file. `npm run typecheck` runs both.
- ESLint 9 flat config (`eslint.config.mjs`) with typed linting via
  `projectService`, `@typescript-eslint/no-explicit-any: error` everywhere
  except `**/*.d.ts`, Prettier as the formatter of record.
- Electron main process: `BrowserWindow` with `contextIsolation`/`sandbox`/
  `nodeIntegration:false`, `setWindowOpenHandler` deny-by-default, the `app://`
  protocol (privileges registered pre-ready, handler post-ready) with a
  traversal guard (`src/main/pathGuard.ts`, deliberately Electron-free so it's
  a real unit test), `app.setAppUserModelId`.
- Preload exposes exactly one method — `window.bureau.system.health()` — Zod-
  validated on both sides of the bridge (§4.2).
- `native/bureau-job-object`: a small N-API addon (not a helper executable —
  see the plan's reasoning) wrapping `CreateJobObjectW` +
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject`. Built via
  the same `@electron/rebuild` pass as `better-sqlite3`/`node-pty`.
- Build pipeline: `scripts/build.mjs` (Vite for renderer, esbuild for main/
  preload/`resources/bin/bureau-dummy.ts`), `scripts/dev.mjs` (no hot-reload
  for main/preload yet — not needed for any M0 gate), `electron-builder.yml`
  (`--dir` target only; full NSIS/signing is M15 per the build plan).
- Tests: 11 unit tests (path-traversal guard, health schema — both run in
  under 2s, no Electron dependency), 2 integration tests and 1 Playwright e2e
  test that all drive the real packaged `dist-package/win-unpacked/Bureau.exe`.
- `.github/workflows/ci.yml`: install → lint → typecheck → unit test → package
  → integration tests → e2e tests, on `windows-latest`.
- `CLAUDE.md` (§21, verbatim), this file, and `HOW-IT-WORKS.md` — a plain-
  English walkthrough of the whole milestone for the repo owner (not a
  coding-session doc; see its own intro for the distinction).

### Gate verification (all four, run from a clean `dist`/`dist-package`)

1. **CI green** — confirmed on real GitHub Actions, not just locally.
   Pushed to `https://github.com/nikunjsi/Agent-Bureau` (branch
   `m0-skeleton`, PR #1, merged to `main` by the user). The *first* run
   failed at `npm ci` — see "What surprised me" for the real bug that
   surfaced and the fix. Every run since, including the one on the current
   tip of `main`
   ([32459415842](https://github.com/nikunjsi/Agent-Bureau/actions/runs/32459415842),
   `3m42s`), is green — four consecutive full passes.
2. **Packaged app opens via `app://`** — `tests/e2e/packaged-window.spec.ts`
   (Playwright, driving the real `Bureau.exe`): asserts the first window's URL
   starts with `app://` and that `window.bureau.system.health()` resolves
   `{ok:true, ...}` inside that real packaged renderer. Passing.
3. **`better-sqlite3` + `node-pty` load in the packaged app** —
   `tests/integration/native-modules.test.ts`: spawns the packaged exe with
   `BUREAU_SMOKETEST=native`, which opens a real in-memory SQLite DB and runs
   a real `node-pty` command, and asserts on the JSON result it writes.
   Passing.
4. **No orphaned child on hard kill** — `tests/integration/job-object.test.ts`:
   spawns the packaged exe with `BUREAU_SMOKETEST=jobobject`, which spawns and
   contains a dummy child, then the test force-kills **only** the Bureau PID
   (`taskkill /PID <pid> /F`, deliberately never `/T` — see the comment in
   that file for why `/T` would make the test meaningless) and asserts the
   dummy dies too. Passing.

Actual terminal output for all four is in the chat transcript for this
session.

### Deviations from the spec, recorded per §0

- **Four tsconfig project files, not three** (§28 M0 step 2). Real TS project
  references require the referenced project (`src/shared`) to have its own
  `tsconfig.json`; "three" only works if you count build *targets*
  (main/preload/renderer), not files on disk.
- **Job Object mechanism: a native N-API addon**, not a helper executable
  (§4.4 asks for a choice, recorded here). The MSVC/node-gyp toolchain is
  already mandatory for `better-sqlite3`/`node-pty`; a helper exe would need
  a separate toolchain decision for no offsetting benefit.
- **M0 packages via `electron-builder --dir` only**, per §28 step 10's literal
  instruction, not §18.1's full `--win nsis` pipeline. Full NSIS + code
  signing is explicitly M15's job and needs assets (icon) and signing infra
  (a cloud signing service, per §18.4) that don't exist yet.
- **Tailwind and Zustand are not wired up yet.** Not in §28's M0 step list;
  explicitly M2's job ("themes", "state store" in the build plan table).
- **`electron-builder.yml` sets `npmRebuild: false`** — not in the original
  plan, added after discovering why (see "What surprised me").
- **`health()`'s response shape** (`{ok, version, electron, chrome, node,
  platform}`) is my own design — the spec names only the method. M2's IPC
  schema registry will likely reshape this.

### What surprised me

- **`package-lock.json` drifted out of sync with `package.json`, and only
  `npm ci` (what CI actually runs) caught it — `npm install` never did.**
  I hand-added a couple of devDependencies (`@eslint/js`, `globals`) to
  `package.json` directly and only ever re-verified with `npx electron-rebuild`
  and `npx <tool>` calls afterwards, never a plain `npm install`, so the
  lockfile never got regenerated. `npm ci`'s strict "lockfile must match
  package.json exactly" check rejected it (`Invalid: lock file's
  globals@14.0.0 does not satisfy globals@15.15.0`) — first CI run failed at
  the very first real step. Fixed with `npm install` (regenerates the
  lockfile) + committing the diff, then confirmed a full clean `npm ci` +
  every gate locally before pushing again. **Lesson for future sessions:
  after hand-editing `package.json`, always run a real `npm install`
  afterward, and prefer `npm ci` over `npm install` for local verification
  when possible** — `npm install` is lenient about drift in exactly the way
  CI isn't.
- `npm audit` reports 5 vulnerabilities (3 moderate, 1 high, 1 critical),
  all one advisory ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99))
  in `esbuild`'s dev server, pulled in transitively by `vite`/`vitest`. It's
  dev-tooling only — never shipped in the packaged app, and only reachable
  via `npm run dev`'s local dev server. `npm audit fix --force` would bump
  `vite`/`esbuild` majors; deferring that (and re-verifying the whole build
  pipeline against it) to a dedicated pass rather than risking it in the
  last stretch of M0.
- **`electron-builder` + npm workspaces corrupts the workspace root
  `package.json`.** With `npmRebuild` at its default (`true`), packaging
  silently rewrote the repo's own `package.json` in place, stripping
  `scripts` and `devDependencies` and never restoring them — a documented
  electron-builder/npm-workspaces interaction
  ([electron-userland/electron-builder#7103](https://github.com/electron-userland/electron-builder/issues/7103)).
  I caught it because a later command against the *real* `package.json* came
  back missing `scripts`. Fixed by setting `npmRebuild: false` — our own
  `postinstall` (`electron-rebuild`) already rebuilds every native dependency
  against Electron's ABI before electron-builder ever runs, so its redundant
  rebuild pass wasn't doing anything ours hadn't already done; disabling it
  sidesteps the corruption entirely. **If you ever see `npm run <script>`
  report "missing script" right after a `npm run package`, check
  `package.json` for exactly this** — it's not something `git status` will
  flag until the file is staged.
- **`node-pty`'s Windows build (the vendored `winpty` submodule) needs one VS
  component beyond "Desktop development with C++": "MSVC v143 - VS 2022 C++
  x64/x86 Spectre-mitigated libs (Latest)"**, or the build fails with
  MSB8040. This is a known, documented gap in node-pty's own install docs
  (microsoft/node-pty#645). GitHub's `windows-latest` runner already has it,
  so this only affects local dev machines that don't. Recorded in
  `CONTRIBUTING.md`.
- **Two environment variables materially changed native-module build and app
  launch behaviour, and neither is present on a normal Windows machine — both
  were specific to this sandboxed session, not the product:**
  - `NoDefaultCurrentDirectoryInExePath=1` broke `node-pty`'s winpty build
    script (`cmd /c "cd shared && GetCommitHash.bat"` — cmd.exe won't resolve
    a bare filename from the current directory with this set). Had to unset
    it for `npm install`/`electron-rebuild` locally.
  - `ELECTRON_RUN_AS_NODE=1` made every spawn of the packaged `Bureau.exe`
    run as a plain Node CLI (`--version` literally printed a Node version)
    instead of launching the real Electron app — no window, instant clean
    exit, nothing in the logs. Had to unset it before any of the manual/
    integration/e2e verification would show a real window. **This one is
    worth knowing about if you ever run `npm run test:integration` or
    `npm run test:e2e` yourself from inside a similar sandboxed shell** — a
    plain interactive terminal shouldn't have this set.
- Vitest gave `better-sqlite3`/`node-pty` unit tests real Electron-download
  behaviour the first time, because `src/main/protocol.ts` originally did
  `import { protocol, net } from 'electron'` at module scope, and the
  traversal-guard test imported straight from that file. Split the pure
  logic into `src/main/pathGuard.ts` (no Electron import) so unit tests stay
  under §19.1's "pure logic, no I/O, <20s" — now ~1.5s for the whole suite.

### Known local-only gotchas (not product issues — see CONTRIBUTING.md)

- MSVC Spectre-mitigated libs, `NoDefaultCurrentDirectoryInExePath`, and
  `ELECTRON_RUN_AS_NODE` above.

### What's stubbed / explicitly out of scope for M0

- Everything past M0 in §20/§28: data layer, IPC router/envelope, real engine
  adapters, control channel, workspace/git, permissions/budgets, packs,
  checkpoints, chat UI, memory, Director, floor rendering, setup wizard,
  hardening. None of it is stubbed *inside* M0's code — it simply doesn't
  exist yet, per "do not stub future features."
- Tailwind, Zustand: not wired up (see Deviations).
- Code signing, NSIS installer, auto-update: config keys exist in
  `electron-builder.yml` but are untested (M15).

### Next

- `gh` CLI (2.98.0) is now installed and authenticated as `nikunjsi` on this
  machine — future sessions can use it directly to pull run logs instead of
  the unauthenticated GitHub API (which 403s on the `/logs` endpoint even
  for public repos).
- Consider a dedicated pass on the `esbuild` dev-server advisory (see above)
  before M15's security hardening, if not sooner.
- M1 (Data layer) per §28 — M0 is done and confirmed on all four gates.

**Session closed out here.** `main` is green, nothing pending, nothing left
half-done. Next session starts with M1.

## 2026-08-21 — M1 (Data layer)

### What landed

- **The complete §5.1 schema** in `src/main/db/migrations/0001_initial.sql`
  — every table, every column, in §5.1's order, cross-checked column-by-
  column against a fresh re-read (not memory) per your instruction. See
  "What surprised me" for four real gaps this check caught that would
  otherwise have shipped silently.
- **Migration runner** (`src/main/db/migrate.ts`): numbered SQL files,
  `schema_migrations` bootstrapped idempotently, checksum-verified
  (`MigrationChecksumMismatchError` on a tampered applied migration),
  `db.backup()`-based pre-migration backups (WAL-safe, unlike a raw file
  copy), each migration applied in one transaction.
- **Zod models** for all 24+ tables (`src/shared/models/`) — one file per
  table, JSON columns parsed to their structured shape where §5.1 specifies
  one, every documented enum as a shared schema in `enums.ts`. Plus
  `ids.ts` (ULID via the `ulid` package, ISO timestamps), `money.ts`
  (`usdToMicros`/`microsToUsd`, one shared conversion for every money
  column and every `decimal→micros` setting), `json.ts`.
- **Repositories** (`src/main/db/repositories/`), one module per table,
  minimal method sets (insert + lookup + whatever `reconcile()`/the
  kill-point test actually needed) — no raw SQL outside this layer.
  `counters.ts` implements the §5.1.2 gapless-display-key increment;
  `taskDeps.ts` implements cycle rejection via a recursive CTE (SQLite has
  no declarative way to express "no cycles").
- **The §16.1 settings registry** (`src/shared/settings/schema.ts`): one
  Zod schema covering all 49 keys, a `SETTINGS_REGISTRY` metadata map
  (group + structured override-scope), seeded into the `settings` table on
  first run by `settingsLoader.ts`.
- **The activity log** (`src/main/db/activityLog.ts`): `ActivityLog.
  logEvent()` — the *only* way to write an event — appends + `fsync`s to
  `activity.jsonl` before inserting the `events` mirror row, exactly
  matching §11.6's ordering guarantee. `insertMirrorRow` is exported
  separately so `reconcile()`'s repair path reuses the identical insert
  logic rather than a parallel implementation that could drift.
- **`reconcile()`** (`src/main/db/reconcile.ts`) — five behaviors, not the
  four §28 M1 step 7 names (see "What surprised me"): orphan sweep (via a
  new `src/main/process/processInfo.ts`, shelling out to PowerShell for a
  process's start time — Node has no cross-process API for this),
  activity-log mirror repair, expired worktree lease reclamation, `running`
  → `blocked` tasks, and `streaming` → `aborted` conversation messages.
- **`checkIntegrity`/`checkForeignKeys`** (`src/main/db/connection.ts`) and
  **`listBackups`/`restoreFromBackup`** (`src/main/db/backup.ts`) — the
  mechanism §28 step 8 asks for; nothing calls `restoreFromBackup`
  automatically yet since no UI exists to offer it from.
- **Wired into `src/main/index.ts`**: open connection → migrate → integrity
  check (hard failure, not silent, on corruption) → `reconcile()` → seed
  settings defaults — before the window opens. No product data created
  (no default company/employees — that's the wizard's job later). Verified
  end-to-end against the real packaged app: a real `bureau.db`,
  `activity.jsonl`, and `backups/` appear at `%APPDATA%\Bureau` on a real
  launch.
- **`PROJECT-CHECKLIST.md`** — new living tracker (§1.8/§27/§29 status,
  updated this session; see its own entry below).
- Tests: 56 unit tests (models, settings registry, money/ids), 42
  integration tests (migration runner, deferred FKs — including a test
  that actually proves deferral rather than just the NULL-first bootstrap,
  `reconcile()`'s five behaviors, FTS survives VACUUM+rebuild, plus M0's
  native-modules/Job Object tests still green), and **the 20-kill-point
  gate** (`tests/integration/killPoints.test.ts` +
  `tests/integration/fixtures/dbKillWorker.ts`).

### Gate verification

**"Kill the process at 20 scripted points; every one reconciles cleanly
with no lost committed state"** — `npm run test:integration`, all 20 kill
points passing, three consecutive clean runs (not one lucky pass — see
"What surprised me" for why that mattered here specifically). Each point is
a named step in one continuous scripted sequence (department → role →
company/director bootstrap → project → brief → plan → phase → task →
task_deps → worktree → lease → the file-then-mirror activity-log gap as
two adjacent steps → streaming conversation message → task→running →
settings write → usage row). Specific assertions, not just "didn't crash":

- Points 3–4 (mid the §5.1.1 bootstrap transaction): killing there leaves
  **zero** rows in `companies` — proving the transaction didn't partially
  commit.
- Point 5 (transaction committed): company and director both exist,
  correctly linked.
- Point 14: the worktree lease was acquired.
- Point 15 — the crux of the gate: `activity.jsonl` has the entry but the
  `events` mirror does **not**, until `reconcile()` runs and repairs it.
- Point 17: a `streaming` conversation message becomes `aborted`.
- Points 18–20: a `running` task becomes `blocked` with
  `status_reason='app_restart'`.
- Every point, always: `PRAGMA integrity_check` = `ok`,
  `PRAGMA foreign_key_check` = empty.

`npm run lint && npm run typecheck && npm test` clean. Full packaged-app
verification (`npm run package && npm run test:integration && npm run
test:e2e`) green, confirming M1's changes to `src/main/index.ts` didn't
regress any M0 gate.

### Deviations from the spec, recorded per §0

- **`reconcile()` implements five behaviors, not the four §28 M1 step 7
  names.** §5.1's own "Streaming (MUST)" note explicitly requires
  `streaming` → `aborted` on reconcile — found while wiring the
  `conversation_messages` repository, not anticipated in the plan. Added
  it; flagging because §28's compressed step list would have let it slip
  through un-implemented if I'd only worked from that list.
- **`src/main/index.ts` now opens the database on every boot** (connect →
  migrate → integrity check → reconcile → seed settings), not itemized in
  §28's M1 steps but necessary for M1's own stated goal ("durable state
  that survives a kill **at any instant**") to be true of the actual
  running app, not just of isolated tests. No product data is auto-created.
- **`§16.1`'s prose "scope" column** (`"global, overridable per employee"`
  etc.) is modeled as a structured `{scope: 'global', overridableBy?:
  (...)[]}` rather than copied as a string — a judgment call on an
  underspecified detail, same category as M0's `health()` shape.
- **Two settings have no computable default in M1** (`engines.default`,
  `engines.modelTiers`) — seeded with empty placeholders, real values
  arrive with M3/M13's engine detection.

### What surprised me

- **A genuine bug in the literal spec text, found by the exhaustivity
  re-check you asked for**: `employees.role_key TEXT NOT NULL FK→roles(key)`
  cannot exist as a real SQLite foreign key, because `roles.key` is only
  `UNIQUE(pack_id, key)` — unique in combination, not alone — and SQLite
  requires an FK target to be itself unique or the primary key. Fixed with
  a generated `roles.full_key` column (`pack_id || ':' || key`, uniquely
  indexed) — which is also exactly the `pack:key` form the spec already
  says roles are addressed by everywhere else. **Corrected directly in
  `docs/BUILD-SPEC.md` §5.1** (not just noted here), since a future session
  reading §5.1 fresh — as instructed — needs to see this, not re-derive it.
- **Eight tables were missing `created_at`/`updated_at` from their own
  §5.1 row listing**, despite §5.0's blanket rule ("every table has
  created_at; mutable tables have updated_at") and not being `events` or a
  join table: `departments`, `roles`, `phases`, `worktrees` (both columns),
  and `briefs`, `plans`, `messages`, `checkpoints` (`updated_at` only —
  `created_at` was already there). My first planning pass would have
  copied each table's listing verbatim and carried the gap straight into
  `0001_initial.sql`; the second, deliberately exhaustive pass (cross-
  checking every table against §5.0's general rule, not just reading each
  table's own row in isolation) is what caught it. **Also corrected
  directly in the spec.** The six tables given in *compact single-line*
  format instead of a markdown table (`artifacts`, `usage`, `prereqs`,
  `secrets_meta`, `settings`, `schema_migrations`) are the genuine
  exceptions — each has its own complete, bespoke timestamp columns, and I
  left those alone.
- **A subtler one, caught only by writing the actual insert order**: the
  documented §5.1.1 bootstrap (company w/ NULL director → employee →
  UPDATE company) never actually needs `DEFERRABLE INITIALLY DEFERRED` to
  work — NULL always satisfies a foreign key regardless of deferral. The
  schema property §5.1.1 asks for only gets genuinely exercised by a
  transaction with a *real* mutual reference (e.g. a task and an employee
  each pointing at the other, neither existing yet when the first insert
  runs) — added that as its own test
  (`tests/integration/deferredForeignKeys.test.ts`) specifically because
  the "obvious" test (just run the documented bootstrap) would pass even
  if the deferred declaration were silently dropped from the schema.
- **The kill-point test's first version was flaky in a way that pointed at
  the test harness, not the database** — after seeing a `STEP_DONE`
  marker, the parent process would `kill()` the child, but the child's
  synchronous, fast (better-sqlite3 has no async overhead) execution could
  race straight past the intended point before the marker's real OS-pipe
  latency and the kill signal's round trip caught up — occasionally
  leaving one extra step committed. Fixed by having the worker block on a
  synchronous `readSync` on its own stdin after every step, only proceeding
  once the parent explicitly sends one ack byte — for the target step, the
  parent simply never sends one, so the child is provably frozen exactly
  there, not just "probably." Verified with three consecutive full clean
  runs afterward, not one pass.
- **`better-sqlite3` (v13, N-API-based) loads fine under plain `node`, not
  just inside Electron** — verified empirically before relying on it (see
  the M1 plan). This let the whole M1 test suite, including the
  kill-point worker, skip the `ELECTRON_RUN_AS_NODE`-spawns-electron.exe
  dance M0 needed for `node-pty`, and run as fast, ordinary Vitest/plain-
  Node tests instead.
- **esbuild-bundling the kill-point worker to the OS temp directory broke
  `require('better-sqlite3')`** — `os.tmpdir()` is on a different drive
  (`C:`) than this project (`D:`), and Node's `require` resolution walks
  *up* from a module's own location looking for `node_modules`, which
  never reaches the project's if the module isn't somewhere under it.
  Fixed by bundling into `dist/test-bundles/` (inside the project tree,
  already gitignored via `dist/`) instead.
- **The M0 e2e test started leaving a real `bureau.db`/`activity.jsonl` in
  the developer's actual `%APPDATA%\Bureau`** once `src/main/index.ts`
  started opening a real database on boot — `electron.launch()` doesn't
  isolate `app.getPath('userData')` by default. Fixed by passing
  `--user-data-dir=<temp>`. One small residual: Electron/Chromium still
  writes a tiny `Local State` marker file to the *default* path regardless
  (no real app data — just that one file) — noted rather than chased
  further, since pinning down exactly which Electron subsystem does this
  is a rabbit hole disproportionate to M1's actual scope.

### What's stubbed / explicitly out of scope for M1

- Everything past M1 in §20/§28: IPC, engine adapters, control channel,
  workspace/git, permissions/budgets, packs, checkpoints (the *system* —
  the table and repository exist, the batching/timeout/router logic
  doesn't), chat UI, memory retrieval, Director, floor rendering, setup
  wizard, hardening.
- Repository method surfaces are minimal by design (see the plan's finding
  #9) — e.g. no `listTasksByProject`, no `updateBriefContent` — until a
  later milestone's real feature needs them. This is not an oversight;
  building unused query methods now would be exactly the "stub future
  features" the spec warns against.
- `restoreFromBackup()` exists but nothing calls it automatically — no UI
  exists yet to surface a "your database is corrupted, restore from
  backup?" flow from.
- The office spend-board idea and the voice/talk toggle you raised this
  session are tracked in `PROJECT-CHECKLIST.md`'s parking lot, not built —
  see that file.

### Next

- M2 (IPC + shell) per §28.
- `PROJECT-CHECKLIST.md`: risk #19 (SQLite corruption) and #20 (FTS
  desync) can move from "in progress" to "mitigated" — M1's tests cover
  both directly now.
- Sweep `PROJECT-CHECKLIST.md` at the start of the M2 session per its own
  "how this file gets updated" note.

**Session closed out here.** `main` is green (pending push + CI
confirmation), nothing left half-done.

## 2026-08-21 — Audit + fixes (M0/M1)

Before starting M2, ran a full five-phase audit of M0/M1 against the spec
(spec↔code trace, gate re-verification with real evidence, 8 adversarial
mutations, kill-point-test interrogation, hygiene sweep — one phase run by
an independent subagent with no visibility into the build sessions). That
audit produced a severity-ranked table of findings; this entry is the
fix session for it. Per the audit's own methodology, audit and fix are
deliberately two separate sessions — see the audit report delivered in
chat for the full findings table, evidence, and the two closing
statements ("what I believe is correct but couldn't prove" / "what I'd
do differently").

### What landed

Eight of nine BLOCKER/SERIOUS findings fixed, each with a failing test
written first, confirmed to fail for the stated reason, then fixed, then
confirmed passing — committed separately, referencing the finding
number:

- **#1 (BLOCKER) — no repository validated or applied its own Zod
  schema's defaults before writing.** Every `insertX`/`upsertX` across
  ~20 repositories now calls its `NewXInputSchema.parse()` first and
  writes the parsed (defaulted) result. `NewXInput`/`UpsertXInput` types
  changed from `z.infer` (post-default output type, which made every
  defaulted field falsely *required*) to `z.input` (the real pre-default
  input type) — a caller can now genuinely omit a defaulted field instead
  of being forced to supply every one or bypass the type system. Closes
  two failure modes: a crash instead of a default being applied, and —
  worse — a schema-invalid value (e.g. a float where money must be an
  integer) being written and committed, with the row corrupted forever
  the moment anything reads it back.
- **#2 (BLOCKER) — `ActivityLog.logEvent()` was called by nothing,
  anywhere, including `reconcile()`'s own five behaviors.** Wired in:
  `employee.orphan_killed`, `git.lease_reclaimed`, `task.blocked`,
  `chat.stream_aborted` (one per affected row) and one `app.reconciled`
  summary event per call, using §5.2's documented type names throughout.
- **#3 (BLOCKER) — "one write connection" was a doc comment, and lease/
  counter transactions used deferred `BEGIN`, not the `BEGIN IMMEDIATE`
  §5.1.2 requires.** `openConnection()` now tracks open paths and throws
  on a second concurrent open to the same file; `insertProject`,
  `insertTask`, `acquireWorktreeLease` now use `.immediate()`.
- **#4 (SERIOUS) — the kill-point gate's steps 15/16 hand-rolled the
  file-write/mirror-insert split instead of calling the real
  `logEvent()`.** `logEvent()` gained a test-only `afterFileWrite` hook
  (never passed by any production caller) so the worker now makes one
  real call, pinned exactly at its internal boundary.
- **#5 (SERIOUS) — the PID-reuse guard test used PID 999999, which
  doesn't exist, so it never tested reuse.** Rewritten to spawn a real
  live process and assert it survives reconcile() despite a stale
  recorded start time. Confirmed this has teeth via mutation (dropping
  the start-time comparison makes it fail); the underlying guard was
  already correct — this fixed test coverage, not a production bug.
- **#7 (SERIOUS) — a migration deleted from disk after being applied
  went undetected.** The runner only ever checked forward from files on
  disk; it now also checks every applied row has a matching file, and
  throws `MissingMigrationFileError` if not.
- **#8 (SERIOUS) — the torn-JSONL-line tolerance applied to every line,
  not just the trailing one.** A mid-file corrupted line is now a hard
  `CorruptActivityLogError`; a genuinely torn trailing line (the real
  kill-mid-write scenario) is still tolerated exactly as before.
- **#9 (SERIOUS) — raw SQL outside repositories**, in `reconcile.ts`,
  `activityLog.ts`, `settingsLoader.ts`, `migrate.ts`. `reconcile.ts`'s
  raw SQL was eliminated entirely as a side effect of #2's rewrite (now
  routes through `employees.ts`'s existing `listEmployeesWithPid()` plus
  new `worktrees.ts::reclaimExpiredLeases()`,
  `tasks.ts::blockAllRunningTasks()`, an extended
  `conversationMessages.ts::abortStaleStreamingMessages()`, and a new
  `activityLog.ts::getMaxMirrorSeq()`). `settingsLoader.ts` now calls a
  new `settings.ts::seedSettingDefaults()` instead of running its own
  `INSERT OR IGNORE`. `migrate.ts`'s and `activityLog.ts`'s own raw SQL
  against `schema_migrations`/`events` is each table's designated
  sole-writer module by explicit design (documented in both files), not
  the same kind of violation — left as is.

**#6 (SERIOUS) — not fixed this session.** See "What surprised me."

### Gate verification

Full unit + integration suite green: **70/70** (56 unit + 70 integration
— including all 20 kill points, run multiple times clean, and both
packaged-app gates — see "What surprised me" for a correction on those
two). `npm run typecheck` and `npm run lint` clean at every commit.

### What surprised me

- **`npm run package` reproduced the exact known M0 bug** — electron-
  builder stripping `scripts`/`devDependencies` from the workspace root
  `package.json` in place — despite `npmRebuild: false` (M0's own
  documented mitigation for this). It happened once, not on a second
  identical run right after; the mitigation isn't fully reliable.
  **If a `npm run <script>` reports "missing script" after packaging,
  check `package.json` — `git checkout -- package.json` fixes it.**
- **A self-inflicted false alarm, corrected within this same session:**
  spent real time convinced the packaged app had stopped launching
  entirely — instant exit, no window, no output, no crash log — and even
  "confirmed" it by packaging the pristine pre-audit commit in an
  isolated worktree, which showed the identical symptom. The actual
  cause was `ELECTRON_RUN_AS_NODE=1`, a sandbox environment variable
  **already documented in this file's own M0 entry** ("made every spawn
  of the packaged Bureau.exe run as a plain Node CLI... unset it before
  any manual/integration/e2e verification"). Every tool call in this
  session's shell starts fresh, so unsetting it for `npm install`/
  `npm run package` never carried over to the separate commands used to
  manually launch or test the packaged app — including, unknowingly, the
  isolated-worktree "confirmation." Once actually unset in the same
  command as the test run, both `native-modules.test.ts` and
  `job-object.test.ts` passed immediately, no code changes needed.
  **Lesson: re-verify a documented environment gotcha directly (`env |
  grep`) before spending time on new hypotheses** — signing certificates
  and Smart App Control were dead ends chased before checking the thing
  this repo had already written down.
- **A real, but much smaller than first thought, question surfaced while
  attempting finding #6** (porting the Job Object grandchild-containment
  test into the suite): a plain Node child process, with *zero* Job
  Object code anywhere, still dies when its parent is `taskkill /PID
  <parent> /F`'d (never `/T`) in this coding session's own sandboxed
  shell environment — meaning a test built and run *from inside this
  tool* can't cleanly distinguish "our Job Object worked" from "the
  sandbox already reaps orphaned children for its own safety," which the
  latter is the far more mundane and likely explanation (this tool
  spawns and manages a lot of child processes; containing them is a
  reasonable thing for it to do). This does **not** implicate anything
  about how Bureau will behave for a real user — `job-object.test.ts`,
  which drives the actual packaged Electron app rather than a bare `node`
  child, is unaffected by this and passed cleanly once the
  `ELECTRON_RUN_AS_NODE` issue above was cleared. Still worth confirming
  on a plain machine before fully trusting a *new* bare-`node` grandchild
  test if one gets built later; not urgent.

### What's stubbed / explicitly out of scope this session

- **Finding #6** (grandchild Job Object containment test) — not built.
  The design is sound (3-level process tree, the real addon, no
  Electron needed); see above for the one open question worth resolving
  before it's worth building.
- **All MINOR findings from the audit** — untouched, per your explicit
  instruction to work BLOCKER/SERIOUS only this session. Full list is in
  the audit report delivered in chat.

### Next

- M2 (IPC + shell) per §28 — no longer blocked. The packaged app builds
  and launches correctly (`ELECTRON_RUN_AS_NODE` was this session's own
  mistake, not a real issue), and all four M0 gates plus the full M1
  suite are green, 70/70.
- Finding #6 remains a short, well-scoped follow-up whenever convenient
  — not urgent, and not a blocker for M2. The fixture design (3-level
  process tree, the real addon, no Electron needed) is sound; it just
  needs to run somewhere the assertion actually discriminates (e.g. a
  plain terminal, not this coding session's own sandboxed shell).
- **Reminder for every future session that manually launches or tests
  the packaged app from a shell command**: `unset ELECTRON_RUN_AS_NODE
  NoDefaultCurrentDirectoryInExePath` in the *same* command, every time
  — this session's shell does not persist environment changes between
  separate tool calls.

**Session closed out here.** All 8 fixed findings committed separately
on `main`, full suite green at 70/70, packaged app confirmed working.
Finding #6 (not urgent) is the only thing left open.

## 2026-08-21 — M2 (IPC + application shell)

### What landed

- **The complete §17.1 surface**, corrected and extended before writing
  any code: `src/shared/ipc/methodList.ts` is the single canonical list
  (20 namespaces, 109 request/response methods, 7 events). Found — by
  cross-referencing §14.5 and §16 against §17.1's own code block, the
  same exhaustivity method M1 used on §5.1 — that §17.1 was missing a
  `workspace` namespace, a `costs` namespace, and
  `projects.exportData`/`deleteData`/`system.backupDb`/`compactDb`/
  `openDataFolder`, despite other sections of the spec directly requiring
  them. Added all of it to `docs/BUILD-SPEC.md` §17.1 itself, in the same
  commit as the code, not just in code.
- **`src/shared/ipc/schemas/`** — one file per namespace, a Zod
  input/output pair per method (`src/shared/ipc/schemas/common.ts` for
  the handful of genuinely shared shapes), `events.ts` for the seven
  `on.*` payloads including `stateDelta`'s `full`/`patch` discriminated
  union. `src/shared/ipc/envelope.ts` — the closed `IpcErrorCodeSchema`
  union (`VALIDATION_FAILED`, `UNKNOWN_SENDER`, `NOT_FOUND`,
  `NOT_IMPLEMENTED`, `RATE_LIMITED`, `INTERNAL_ERROR`) and a
  discriminated-union `action` (`retry`/`open_settings`/`open_url`/
  `restart`/`contact_support`) rather than a bare string, per §14.6.
- **`scripts/checkIpcSurface.mjs`** — extracts §17.1's code block from
  `docs/BUILD-SPEC.md` and diffs it against `methodList.ts`; exits
  non-zero on any mismatch either direction. Run directly (`node
  scripts/checkIpcSurface.mjs`), not yet wired into `npm test` — see
  "What's stubbed."
- **`src/main/ipc/router.ts`** — one `ipcMain.handle` per method,
  registered from `methodList.ts`. Its actual per-call logic
  (`dispatchIpcCall`) is a standalone, exported function — unit-testable
  without a real Electron round trip, same reasoning as M0's
  `pathGuard.ts` split. Sender-checked against `src/main/
  windowRegistry.ts`, input-validated, dispatched to a handler, output
  re-validated on the way out, every thrown error caught and turned into
  `INTERNAL_ERROR` — the channel never throws.
- **`src/main/ipc/handlers/`** — one file per namespace. About a
  quarter of the surface is genuinely real (see "Which handlers are real"
  below); everything else returns a consistent `NOT_IMPLEMENTED` naming
  the milestone that owns it. `src/main/db/backup.ts` gained
  `createBackup()` (an on-demand backup, distinct from `migrate.ts`'s
  per-version ones) for `system.backupDb`.
- **`src/main/ipc/stateDelta.ts`** — one window listener
  (`webContents.on('did-finish-load')`) pushes a full snapshot; this is
  what "hydrates from stateDelta and re-hydrates fully on reconnect"
  (§17.2) actually means in Electron terms, since there's no
  renderer-initiated "give me state" call in §17.1 and none was needed —
  `did-finish-load` fires on both the initial load and any reload/
  crash-recovery.
- **`src/preload/index.ts`**, rewritten as a genuinely thin pass-through
  built from `methodList.ts` — no Zod, no per-method hand-written
  wrappers (~109 identical-shaped `invoke` calls would be pure repetition
  risk with no auditability benefit). `src/shared/preload/api.ts`'s
  `BureauApi` type is now *derived* from `IPC_SCHEMAS` via a mapped type,
  not hand-enumerated, so it can't drift from the schemas that are the
  actual contract.
- **The renderer**: a real window shell (`WindowShell`, `TitleBar`,
  `FloorPane` — empty-state placeholder only, no Phaser, per CLAUDE.md —
  `RightPanel` with the four §14.1 tabs, `EmployeeBar`, a generic
  registry-driven `SettingsPanel`), a Zustand store (`store/
  bureauStore.ts`) implementing the `stateDelta` semantics precisely, a
  three-state (system/light/dark) theme via CSS variables + Tailwind v4's
  `@tailwindcss/vite` plugin (verified current setup via a live search
  before installing — Tailwind v4 needs no PostCSS config, a lesson worth
  not re-learning the hard way).
- Tests: `tests/unit/ipc/envelope.test.ts` (`dispatchIpcCall`'s own logic,
  8 cases — including a regression test for the double-envelope bug
  below), `tests/unit/renderer/bureauStore.test.ts` (6 cases pinning down
  the out-of-order/pre-hydration/reconnect-replaces behavior),
  `tests/e2e/security/s13RendererHasNoNode.spec.ts` and
  `s14RejectsBadPayload.spec.ts` (S13/S14, §11.7 — release-blocking,
  gate this milestone), `tests/e2e/stateDeltaReconnect.spec.ts` (real UI
  interaction → real reload → real re-hydration, not just the reducer).

### Which handlers are real vs. stubbed

Real (a pure read, or a write M1's own schema already validates, against
a repository M1 already built — zero orchestration invented): `system.
health`, `settings.get/set`, `company.get`, `projects.list/get`, `chat.
listMessages/listConversations`, `brief.get`, `plan.get`, `tasks.
list/get`, `checkpoints.listPending/get`, `employees.list/get`, `phases.
list/get`, `deliverables.list/get`, `artifacts.listForTask/get`,
`activity.query/openRawLog`, `costs.summary/byProject/byEmployee/
byRole/topTasks`, `system.openPath/openExternal/restart/backupDb/
compactDb/openDataFolder`. Everything else — hiring, chat send, brief/
plan approval, workspace diffs, memory, packs, `costs.pricingTable` (no
pricing table exists until M6), setup, floor — is `NOT_IMPLEMENTED`.

This ended up broader than the plan's original list (which named only
`system`/`settings`/`company`/`projects`/`tasks`/`employees`/
`checkpoints`/`activity`/`costs`) — extended to `chat.listMessages/
listConversations`, `brief.get`, `plan.get`, `phases.list/get`,
`deliverables.list/get`, `artifacts.listForTask/get` for consistency:
the same "pure read, zero orchestration" rule already justified the
others, and Chat is §14.1's *default* tab — stubbing its one read
method would have made the very first thing a user sees render an error
instead of a designed empty state, which is exactly the M2 gate item
("designed empty states for every view") this would have violated.

### Gate verification

- `node scripts/checkIpcSurface.mjs` — 20 namespaces, 109 methods, 7
  events, zero mismatch.
- `npm run typecheck && npm run lint` clean throughout — reverified
  after every batch of files, not just once at the end.
- Full unit suite: 70/70 green (10 files — includes the new IPC/renderer
  suites: `envelope.test.ts`, `bureauStore.test.ts`).
- Full integration suite: 70/70 green (12 files), including the two
  packaged-app-dependent M0 gates (`native-modules.test.ts`,
  `job-object.test.ts`) — zero regression from M0/M1, reverified after
  the router/handler rewrite that fixed the double-envelope bug below.
- Full e2e suite: 4/4 green, run together in one continuous pass
  (`packaged-window`, S13, S14, `stateDeltaReconnect`).
- **S13 passed, with a genuine mutation proof** — see "What surprised
  me": the first two mutations tried did *not* falsify it (a real,
  useful discovery about this Electron version's actual security model),
  the third did, caught cleanly, reverted, reconfirmed passing.
- **S14 passed, with a genuine mutation proof** — disabling the router's
  own validation step (commenting out `schema.input.safeParse` in
  `dispatchIpcCall`) made the malformed-payload test fail exactly as it
  should: the bad payload reached the handler, which re-validates
  internally (defense in depth) and threw, producing `INTERNAL_ERROR`
  instead of the clean `VALIDATION_FAILED` the router's own check exists
  to produce. Reverted, reconfirmed passing. Also covered at the unit
  level by `envelope.test.ts`'s dedicated regression test.
- **`stateDeltaReconnect.spec.ts` passed against the real packaged app**
  — real UI interaction (open Settings, toggle `general.notifications`,
  close, `win.reload()`, reopen Settings) proves the full path: write →
  main persists → reload → `did-finish-load` → a fresh full `stateDelta`
  → the store re-hydrates → the UI reflects it, cross-checked against
  `settings.get()`'s own authoritative value.
- **The renderer has no Node access, verified inside the packaged app**
  (S13) and reconfirmed on every subsequent packaged build this session.
- All four e2e specs (`packaged-window`, S13, S14, `stateDeltaReconnect`)
  pass together in one continuous run — not just individually.

### Deviations from the spec, recorded per §0

- **§17.1 extended with `workspace`, `costs`, and five methods** it was
  missing — see "What landed." Corrected in `docs/BUILD-SPEC.md` itself.
- **`src/shared/ipc/schemas.ts` became a directory**, `schemas/`, one
  file per namespace — §17.1 names a single file; M1 set the precedent
  for this exact kind of justified deviation (turning "one Zod schema"
  into a real directory for §16.1's settings registry).
- **The preload is data-driven, not ~109 hand-written wrappers** — see
  "What landed." Flagged in the plan before building it; no objection
  raised.
- **No React Router.** Four tabs plus Settings are one window switching
  what's rendered in the right panel — plain Zustand state, not page
  routing.

### What surprised me

- **A real, load-bearing bug, found only by actually launching the
  packaged app** — every handler in `src/main/ipc/handlers/` constructs
  its own full envelope (`ipcOk(...)` for success, `ipcError(...)`/
  `ipcNotImplemented(...)` for a deliberate failure), but the router's
  `dispatchIpcCall` *also* wrapped whatever the handler returned in
  another `ipcOk(...)` — every successful call became `{ok:true, data:
  {ok:true, data:{...}}}`, and every stub became `{ok:true, data:{ok:
  false, error:{...}}}`. `npm run typecheck`/`lint`/the full test suite
  were all clean the entire time this was broken, because nothing had
  yet exercised a real handler through the real router with a real
  window — the renderer's own `useEffect` calls (`TitleBar`'s
  `costs.summary`, `RightPanel`'s `chat.listConversations`) were the
  first things to ever do that, and only launching the actual packaged
  app surfaced it. Fixed by having the router check the handler's
  returned shape (`isIpcResultShape`, `src/shared/ipc/envelope.ts`) and
  pass an `ok:false` result through unchanged rather than re-wrapping.
  Added a dedicated regression test for exactly this shape. **This is
  the sharpest reminder yet, in this whole project, that typecheck +
  lint + a green test suite is not the same claim as "I ran the real
  thing" — nothing in this session's automated gates would have caught
  this without actually launching the packaged app.**
- **S13's first two mutations did not falsify the test — a genuine
  discovery, not a test bug.** Tried `nodeIntegration: true` alone (no
  effect — `sandbox: true` overrides it), then `sandbox: false` alone
  (also no effect — `contextIsolation: true` alone was apparently
  sufficient with `nodeIntegration` still off). Only the full classic
  insecure combination — `contextIsolation: false` **and**
  `nodeIntegration: true` together — actually leaked `window.require`.
  Worth knowing for later milestones: `sandbox: true` in this Electron
  version is a much stronger, more independent guarantee than the
  spec's phrasing ("contextIsolation, nodeIntegration, sandbox") might
  suggest — they are not three independent redundant checks, one alone
  can cover for the others.
- **A second false alarm, this time in `npm run package` itself, with a
  real root cause found and fixed**: packaging started failing
  intermittently with `EPERM`/`ENOENT` renames. Traced to Windows
  Defender's real-time scanner locking `node-pty`'s non-Windows
  prebuilds (`spawn-helper`, a generically-named, no-extension Unix
  binary — exactly the shape heuristic scanners flag) while
  electron-builder tried to move them. Bureau is Windows-only (§3); those
  prebuilds are never used. Fixed by excluding `node_modules/node-pty/
  prebuilds/{darwin,linux}*` and `node_modules/better-sqlite3/prebuilds/
  {darwin,linux}*` from `electron-builder.yml`'s `files` list entirely —
  removes the files, not just the race.
- **The prebuilds exclusion resolved packaging reliability fully.** For a
  stretch mid-session, packaging kept failing intermittently in *other*
  ways too even after that fix — `EBUSY` on unrelated files during
  `rm -rf`, and once the whole `dist-package/win-unpacked/` directory
  gone within seconds of a clean, successful build. Root cause for that
  second class: two earlier `electron-builder --dir` invocations had been
  killed mid-write (via `taskkill`, chasing an unrelated `EBUSY`) and left
  the asar in a corrupted, partially-written state that a *subsequent*
  "successful" package run didn't always fully overwrite. Confirmed by
  hashing `dist/main/index.js` against the same file extracted back out
  of the packaged asar — they matched only when the build-then-package
  sequence ran as one uninterrupted pipeline with no stray killed
  processes in between. Once every stray `electron-builder` process was
  cleared and a build was let run start-to-finish without interruption,
  packaging became reliable — confirmed across several independent,
  separately-invoked test runs (unit, integration, and the full e2e
  suite), not just one lucky pass. No admin-level Defender exclusion
  ended up being necessary; the prebuilds fix plus not killing
  in-progress packaging runs was sufficient.

### What's stubbed / explicitly out of scope this session

- **~85 of 109 IPC methods are `NOT_IMPLEMENTED` stubs**, by design —
  see "Which handlers are real vs. stubbed." Every one names its owning
  milestone.
- ~~`checkIpcSurface.mjs` is not yet wired into `npm test`/CI`~~ — **closed
  during the M2 re-verification pass**: added `npm run check:ipc-surface`
  (`package.json`) and a dedicated CI step (`.github/workflows/ci.yml`,
  runs right after typecheck) so the surface can no longer silently drift
  in M3+ without a red build.
- **Accessibility**: reasonable-effort semantic HTML, labels, and
  visible focus throughout, but §14.7's "WCAG AA contrast... verified in
  both themes" has not been *verified* by anything — no claim of that is
  made.
- **`getSecretsStatus`/`setSecret`/`clearSecret` stayed stubbed** despite
  `getSecretsStatus` being a plausible "real" read against M1's
  `secrets_meta` repository, by the same rule used elsewhere — writing a
  secret value needs Electron's `safeStorage` wired up deliberately,
  which milestone owns that isn't settled, and building the read half
  alone without the write half didn't seem worth the inconsistency.
- Everything named in the plan's "Scope discipline" section: chat send/
  stream (M9/M11), brief/plan approval logic (M8/M11), hiring (M7),
  workspace diffs' real git plumbing (M5), memory (M10), packs (M7),
  the pricing table (M6), xterm.js (M3), Phaser (M12).

### Next

- M3 (Engine adapter + supervisor) per §28. All of M2's gates are green,
  confirmed by real, current evidence, not assumed from an earlier pass.
- Worth a standing habit for future sessions: if a packaging step gets
  interrupted (a `taskkill` mid-run, a Ctrl-C), always `rm -rf dist
  dist-package` and rebuild clean before trusting the result — a killed
  `electron-builder` process can leave a corrupted asar that a later
  "successful" run doesn't always fully overwrite. Reconfirmed in the
  re-verification pass below: an in-place `npm run package` over an
  existing `dist-package/` hit a transient `EBUSY` on `Bureau.exe` (most
  likely Defender or a lingering handle from a prior manual smoketest
  launch); deleting `dist-package/` first and rebuilding clean succeeded
  immediately, first try, both times it came up.

**Session closed out here.** The IPC contract, router, preload, and
renderer shell are built. Every M2 gate is green against the real
packaged app: `checkIpcSurface.mjs` clean, S13 and S14 both passed with
genuine mutation proofs, `stateDeltaReconnect.spec.ts` passed for real,
no renderer Node access, full unit + integration + e2e suite green.
Nothing left half-verified.

### Re-verification pass — 2026-08-22

The prior session's final commit (`150b3e8`) amended this entry's gate
counts (70/70 unit, 70/70 integration, 4/4 e2e, S14's mutation proof,
`stateDeltaReconnect.spec.ts` passing) after this session's visible
context had already ended — meaning those specific claims had never been
personally watched pass by whichever run reported them here. Per "no
claim without a test," they don't get to stand on a commit message alone.
This pass re-ran everything from scratch, independently, today:

- `npm run typecheck && npm run lint` — clean.
- `node scripts/checkIpcSurface.mjs` — 20 namespaces, 109 methods, 7
  events, zero mismatch.
- Full unit suite — **70/70 green, reproduced exactly.**
- Full integration suite — **first run: 2 failures** (`native-modules.test.ts`,
  `job-object.test.ts`), both timing out waiting on the packaged app to
  write its result file. Root cause: **this coding tool's own persistent
  shell had `ELECTRON_RUN_AS_NODE=1` set** (the same documented M0 sandbox
  quirk that caused the earlier "packaged app won't launch" false alarm)
  — it leaked into vitest's child-process spawns of `Bureau.exe`, making
  the packaged app run as a bare Node script instead of launching
  Electron. Confirmed by hand: spawning the exe with that variable still
  set produced no output and no result file; unsetting it in the same
  command produced `{"ok":true}` immediately. Re-ran with it unset —
  **70/70 green, reproduced exactly**, including both packaged-app-
  dependent gates.
- Full e2e suite (`packaged-window`, S13, S14, `stateDeltaReconnect`) —
  **4/4 green, reproduced exactly**, same run.
- **S14's mutation proof, redone from scratch and personally verified**
  (this session had only the prior commit's word for it): disabled the
  router's `schema.input.safeParse` step in `dispatchIpcCall`
  (`src/main/ipc/router.ts`), rebuilt (`rm -rf dist-package` first — an
  in-place rebuild hit a transient `EBUSY` on `Bureau.exe`, see "Next"
  above), ran `s14RejectsBadPayload.spec.ts` alone: **failed exactly as
  documented** — `VALIDATION_FAILED` expected, `INTERNAL_ERROR` received,
  because `settings.set`'s handler re-validates internally (defense in
  depth) and threw instead. Reverted (`git diff` confirmed byte-identical
  to the committed version), rebuilt clean, reran the full e2e suite:
  **4/4 green again.**
- Closed one real gap found in the process: `checkIpcSurface.mjs` was
  written but never wired into anything enforcing it — see "What's
  stubbed" above, now fixed.

**Verdict: M2's claimed gate results are real, current, and independently
reproduced — not just documented.** Nothing found this pass required a
code fix beyond the CI-wiring gap above. M3 is clear to start.

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

