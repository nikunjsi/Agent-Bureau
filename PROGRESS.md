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
- `CLAUDE.md` (§21, verbatim) and this file.

### Gate verification (all four, run from a clean `dist`/`dist-package`)

1. **CI green** — confirmed on real GitHub Actions, not just locally:
   [run 32458037364](https://github.com/nikunjsi/Agent-Bureau/actions/runs/32458037364)
   on `main`, all steps passing (`3m59s`). Pushed to
   `https://github.com/nikunjsi/Agent-Bureau` (branch `m0-skeleton`, PR #1,
   merged to `main` by the user). The *first* run failed at `npm ci` — see
   "What surprised me" for the real bug that surfaced and the fix.
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
