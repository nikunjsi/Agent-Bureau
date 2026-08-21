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
