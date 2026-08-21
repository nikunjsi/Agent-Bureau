# Contributing

## Windows build toolchain (required)

Bureau depends on native Node modules — `better-sqlite3`, `node-pty`, and the
in-repo `@bureau/job-object` Windows Job Object addon (see `docs/BUILD-SPEC.md`
§18.3 and §4.4). All three are compiled with `node-gyp`, which needs:

- **Visual Studio 2022 Build Tools**, with the **"Desktop development with
  C++"** workload (provides the MSVC compiler `node-gyp` calls). The Community/
  Professional/Enterprise editions of full Visual Studio also work if you
  already have one installed.
- **Python 3** (the `py` launcher is sufficient — `node-gyp` shells out to it
  during configure).

GitHub Actions' `windows-latest` runner already has both, so CI needs no extra
setup step. Verify locally with:

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
py --version
```

If either comes back empty, install the missing piece before running
`npm install` — a missing toolchain surfaces as an opaque `node-gyp rebuild`
failure, not a clear error.

## Native modules are rebuilt against Electron's ABI, not Node's

`npm install` runs `electron-rebuild` as a `postinstall` step. This is not
optional — a module built for the system Node crashes at runtime with a
`NODE_MODULE_VERSION` mismatch that looks like nothing to do with the real
cause (§18.3). If native modules ever seem stale after switching branches,
`npx electron-rebuild -f` forces a clean rebuild of all of them.

## Everyday commands

| Command                                           | What it does                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                     | Builds main+preload once, starts the Vite dev server, launches Electron against it. Re-run after changing main/preload source. |
| `npm run build`                                   | Compiles renderer (Vite), main and preload (esbuild), and `resources/bin/**` — no packaging.                                   |
| `npm run package`                                 | `build`, then `electron-builder --dir` → `dist-package/win-unpacked/Bureau.exe`.                                               |
| `npm run lint` / `npm run typecheck` / `npm test` | As named. `test` runs only `tests/unit` — fast, no packaged build required.                                                    |
| `npm run test:integration` / `npm run test:e2e`   | Exercise the **packaged** app (`npm run package` first) — see `tests/integration` and `tests/e2e`.                             |

## Rules

- TypeScript `strict` everywhere; no `any` outside `*.d.ts` files (enforced by
  ESLint).
- Small, focused commits with conventional commit messages.
- Read `docs/BUILD-SPEC.md` for the section you're touching and `PROGRESS.md`
  before starting work; update `PROGRESS.md` before ending a session.
