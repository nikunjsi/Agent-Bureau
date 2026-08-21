# How it works — a plain-English guide to the code

`PROGRESS.md` is a changelog for future coding sessions. This file is for
you: a walkthrough of what actually exists right now, why it's shaped the
way it is, and where to look when you want to change something. No prior
Electron knowledge assumed — every term gets explained the first time it
shows up, and there's a glossary at the bottom for when you forget.

This describes **Milestone M0**, the very first slice of Bureau. It doesn't
do anything useful yet — no chat, no AI, no office view. What it proves is
much more boring and much more important: *the app can be built, packaged,
and launched on a real Windows machine without the three things that
usually break a project like this right when you're about to ship it.*
More on those three things below.

**Status: done.** Everything described in this file is built, tested, and
green on GitHub Actions (`main` branch, `windows-latest`) — not just "works
on this one laptop." You can run the real, built app yourself right now;
see the box at the very bottom of this file for how.

---

## 1. The big picture: three programs pretending to be one app

Every Electron app — and Electron is the toolkit Bureau is built on, the
thing that lets a bunch of web technology (HTML/CSS/JavaScript) run as a
real Windows `.exe` with a window, a taskbar icon, and full access to your
files — is actually **three separate programs running at once**, wired
together. Think of it like a restaurant:

| Process | Restaurant analogy | What it actually is |
|---|---|---|
| **Main** | The kitchen — has all the equipment, prepares everything, nobody from the dining room is allowed back there | A regular Node.js program. Full access to your filesystem, can run other programs, talk to the database, etc. There is exactly **one** main process. |
| **Renderer** | The dining room — where the customer (you) actually sits and sees things | A Chromium browser tab, basically. It draws the window you see and interact with. Deliberately **not allowed** to touch your files or run programs directly — more on why below. |
| **Preload** | The waiter — the only one allowed to walk between the kitchen and the dining room, and only carries specific pre-agreed orders | A tiny go-between script. It hands the renderer a small, fixed menu of things it's allowed to ask the kitchen for — nothing more. |

Why bother with this much separation? Because the renderer is, under the
hood, a web page — and web pages can end up loading content you didn't
write (an ad, a pasted link, a compromised dependency). If that web page
had direct access to your filesystem the way the kitchen does, a single bad
script could read or delete anything on your computer. So Bureau locks the
dining room down hard (this is the `contextIsolation` / `sandbox` /
`nodeIntegration: false` settings you'll see in the code) and makes the
waiter carry only a very short, explicit list of allowed requests. Right
now that list has exactly **one item** on it — you'll see it below.

There's also a **fourth thing** in this picture, which isn't a process but
is worth knowing about: a small **native addon**, a tiny piece of code
written in C++ instead of JavaScript, compiled specifically for this
machine and this exact copy of Electron. Bureau has one of these
(`native/bureau-job-object`), explained in section 4.

---

## 2. A guided tour of the folders

```
src/
  main/       ← the kitchen (Node.js, full privileges)
  preload/    ← the waiter (the only bridge between the two)
  renderer/   ← the dining room (what you actually see — a React web page)
  shared/     ← recipe cards both the kitchen and the waiter read from,
                so they always agree on the format of an order

native/
  bureau-job-object/   ← the C++ "kill switch" addon (section 4)

resources/
  bin/        ← small standalone scripts, not part of the app's normal
                code — right now just a test helper (section 4)

scripts/
  build.mjs   ← turns all the source code above into a runnable app
  dev.mjs     ← a faster loop for iterating while developing

tests/
  unit/         ← fast checks with no real app involved (section 6)
  integration/  ← checks that launch the actual built app and inspect it
  e2e/          ← checks that click around the actual built app like a user would

.github/workflows/ci.yml   ← what GitHub does automatically on every push
electron-builder.yml       ← recipe for turning the app into a .exe
docs/BUILD-SPEC.md         ← the full spec this whole project is built from
```

A few naming things worth knowing:

- **`.ts` files** are TypeScript, not plain JavaScript. TypeScript is
  JavaScript with an extra layer that checks your types (e.g. "this
  function expects a number, you just passed it a string") *before* the
  code ever runs, catching a whole category of bugs while you're still
  typing instead of when a user hits them. It gets converted to plain
  JavaScript before it actually runs.
- **`tsconfig.json` files** are TypeScript's own settings files. There are
  several of them (one per folder in `src/`, roughly) instead of one big
  one — mainly so the main/preload/renderer code all stays properly
  separated even at the type-checking level, matching the "kitchen /
  waiter / dining room" separation from section 1.

---

## 3. Follow one click all the way through

The single most useful way to understand how the pieces connect is to
trace the *one* real feature this milestone has: when the app window opens,
it asks "are you healthy?" and displays the answer. Here's the entire
round trip, file by file:

1. **The window opens** (`src/main/window.ts`). The kitchen creates a
   browser window and tells it to load a page.
2. **The waiter is handed the menu** (`src/preload/index.ts`). Before the
   page even finishes loading, this script runs and does exactly one
   thing: it puts a single function, `window.bureau.system.health()`, onto
   the page — this is the *entire* menu the dining room gets.
3. **The page asks its question** (`src/renderer/src/App.tsx`). As soon as
   the page loads, it calls `window.bureau.system.health()` and waits for
   an answer.
4. **The waiter relays the order to the kitchen.** Behind that one
   function, the preload script sends a message called `system.health`
   through Electron's messaging system (this cross-process messaging is
   called **IPC** — Inter-Process Communication — you'll see that term a
   lot).
5. **The kitchen answers** (`src/main/ipc/health.ts`). The main process
   receives the `system.health` request, looks up some real facts (what
   version of Electron/Chrome/Node is running, what version of Bureau this
   is), and sends them back.
6. **Everyone double-checks the order was written correctly.** Both the
   kitchen (step 5) and the waiter (step 4, on the way back) run the
   answer through a **schema** — a strict description of exactly what
   shape the data must be, written with a library called **Zod**
   (`src/shared/ipc/health.ts`). If the data doesn't match, it's rejected
   rather than silently passed along. This "check it on both ends" rule
   applies to *everything* that ever crosses between the kitchen and the
   dining room, forever — it's one of the project's non-negotiable rules
   (see `CLAUDE.md`).
7. **The dining room displays it.** The page shows "Bureau 0.0.1, Electron
   43.4.1, ..." on screen.

That's the whole feature. It looks like overkill for something this small
— and it is, on purpose. Every future feature (hundreds of them, per the
full spec) will reuse this exact same pattern: preload exposes a function,
main handles it, Zod checks the data both ways. Getting this pattern right
once, now, while it's the only thing in the app, is much cheaper than
fixing it later across hundreds of call sites.

---

## 4. The three landmines this session defused

The spec was explicit that M0's whole job is to prove three specific
things *before* any real feature gets built on top of them — because all
three are the kind of problem that works fine while you're developing and
only blows up right when you try to ship. Here's each one in plain terms.

### Landmine 1: "It works on my machine, but not once I package it"

While you're developing, Electron loads your web page from a local dev
server (`http://localhost:5173`) — completely normal, browsers do this all
day. But the *shipped* app can't depend on a dev server; it has to load its
own files straight off the user's disk. The obvious way to do that is a
`file://` link, but Chromium (the browser engine inside Electron) treats
`file://` pages as extra-untrusted and blocks a bunch of things they're
allowed to do — including things a later part of Bureau (the pixel-art
office view) will need.

The fix: Bureau invents its own address scheme, `app://`, and teaches
Electron how to serve files through it (`src/main/protocol.ts`). It behaves
like a normal, trusted page instead of a suspicious local file. There's
also a security check bundled in here (`pathGuard.ts`) that makes sure a
request for `app://bureau/../../../some/other/file` can never sneak outside
the folder it's supposed to be confined to — this is tested directly in
`tests/unit/pathGuard.test.ts`.

### Landmine 2: native modules — code that has to be recompiled for this exact copy of Electron

Two pieces of Bureau's toolkit aren't plain JavaScript — they're compiled
C/C++ code wrapped so JavaScript can call it, because some things (talking
to a real terminal, running a real database) are much better done in a
lower-level language:

- **`better-sqlite3`** — the database Bureau will store all its state in.
- **`node-pty`** — lets Bureau run a real terminal window (this is how it
  will eventually supervise the AI coding agents).

Here's the trap: compiled code is compiled *for a specific version of
Node.js*. Electron ships with its own copy of Node bundled inside it, and
that copy is a slightly different build than the plain Node.js you'd
install yourself. If you compile `better-sqlite3` against regular Node and
then try to load it inside Electron, it doesn't politely say "wrong
version" — it just crashes the app on startup with a cryptic error. This
is a famous, well-documented Electron gotcha, and the only fix is: **always
recompile native modules specifically for Electron**, using a tool called
`electron-rebuild` — which is exactly what happens automatically every time
you run `npm install` (see the `postinstall` line in `package.json`).

To prove this actually works — not just "the install step didn't
crash" — M0 includes a real, automated check: the finished, packaged app
can be launched with a special flag that makes it open the database and
run a real terminal command, then report whether both worked
(`src/main/smoketest/nativeModules.ts`, checked by
`tests/integration/native-modules.test.ts`).

### Landmine 3: orphaned processes — AI agents left running after Bureau dies

This is the landmine most specific to what Bureau actually *is*. Later
milestones will have Bureau launch real AI coding-agent programs as child
processes and supervise them. Those child processes cost real money per
token while they run. If Bureau ever crashes, gets force-closed, or the
user hits Ctrl+Alt+Del and kills it from Task Manager — the children must
**not** be left running in the background, silently burning through the
user's API budget forever.

Node.js (what Electron's main process runs on) has no built-in way to say
"if I die, kill everything I started." Windows itself does have this
capability, though — it's called a **Job Object**: you put a group of
processes "in a box," and when the box's owner goes away, Windows itself
(not our code) guarantees everything in the box dies too, even if our own
cleanup code never got a chance to run. That's the one guarantee we
actually need.

There's no ready-made, well-maintained package for this on npm, so this
project includes a small hand-written one:
`native/bureau-job-object/src/binding.cc`, about 100 lines of C++ that ask
Windows to create this "box" and put processes in it. It's built the exact
same way as `better-sqlite3`/`node-pty` above (recompiled for Electron
automatically on `npm install`), so it doesn't add any new setup burden.

Proving this works needed a real test, not just reading the code: the test
(`tests/integration/job-object.test.ts`) launches the real packaged app,
has it spawn a harmless dummy child process and put it "in the box," then
**force-kills the app itself** the same brutal way Task Manager would —
and then checks that the dummy child died too. The test is deliberately
careful *not* to use a shortcut that would fake a pass here (see the long
comment in that file about why it never uses `taskkill /T`) — the point is
that Windows itself is cleaning up, not our own kill command.

---

## 5. How the code becomes an actual app you can run

Nothing in `src/` runs directly — it all has to be translated and stitched
together first. `npm run build` (which calls `scripts/build.mjs`) does
three translations at once:

- **The dining room** (`src/renderer`) is handed to a tool called **Vite**,
  which bundles all the React/TypeScript code into the small set of plain
  HTML/CSS/JS files a browser can actually run — the same way you'd zip up
  a folder of ingredients into one ready meal.
- **The kitchen and the waiter** (`src/main`, `src/preload`) are handed to
  a faster, simpler bundler called **esbuild**, which does the same kind of
  translation but for the Node.js side.

The result of `npm run build` lands in a `dist/` folder — this is a real,
runnable copy of the app, just not yet wrapped up as a Windows `.exe`.

`npm run package` does one more step on top: it hands `dist/` to a tool
called **electron-builder**, which copies everything (including the
recompiled native modules from Landmine 2) into a proper folder structure
Windows expects, and produces `dist-package/win-unpacked/Bureau.exe` — a
real, launchable, "packaged" copy of the app, as close to what a user would
eventually install as this milestone gets. (The very last step —
wrapping *that* into a signed installer file someone can double-click to
install — is deliberately saved for a much later milestone, once there's
an actual icon and a code-signing certificate to use.)

Why does the distinction between "dev mode" and "packaged" matter so much?
Because Landmines 1–3 above are all things that **only show up once the
app is packaged** — dev mode papers over all three (it uses a real dev
server so `app://` is never even tested, native modules are more forgiving
about version mismatches during development, and nobody's stress-testing a
force-kill mid-development). That's exactly why every test in this
milestone insists on running against the real packaged `.exe`, never
against dev mode.

---

## 6. How we know it actually works — the tests

There are three tiers of tests, each answering a different question:

- **Unit tests** (`tests/unit/`) — "does this one small piece of logic do
  the right thing?" These don't launch Electron at all; they just call a
  function directly with a bunch of inputs and check the outputs. Fast
  (under two seconds for all of them). Example: does the `app://`
  address-guard correctly reject a sneaky path that tries to escape its
  folder?
- **Integration tests** (`tests/integration/`) — "does the real, packaged
  app actually behave correctly?" These launch the real `Bureau.exe` (built
  by `npm run package`) with special flags, and check what happens. This is
  where Landmines 2 and 3 get their real proof.
- **End-to-end (e2e) tests** (`tests/e2e/`) — "does this look right from a
  user's point of view?" This one uses a tool called **Playwright** to
  actually open the real packaged app's window and check what's on screen,
  the same way a person clicking around would experience it.

All three tiers, plus two more checks (does the code follow the style
rules — **lint** — and does TypeScript's type-checking pass with no
errors) run automatically every time code is pushed to GitHub, via
`.github/workflows/ci.yml` — this is what "CI" (Continuous Integration)
means: a robot re-verifies everything, on a clean machine, every single
time, so nothing can quietly slip through because it happened to work on
one particular laptop.

---

## 7. The tools quietly watching your back

A few things run constantly in the background of development that are
worth knowing about even though they don't do anything visible:

- **TypeScript** (mentioned above) — catches type mistakes before the code
  ever runs.
- **ESLint** — catches style and correctness issues TypeScript doesn't,
  like "you imported something you never used" or "you used the banned
  `any` escape hatch that turns off type-checking." Run with `npm run
  lint`.
- **Prettier** — auto-formats code so every file looks consistent, so
  reviewing a change is about what changed, not how someone likes to space
  their curly braces.

---

## 8. Where to look when you want to change something

| I want to... | Look at |
|---|---|
| Change what the window looks like | `src/renderer/src/App.tsx` |
| Add a new thing the page can ask the kitchen for | Add a schema in `src/shared/ipc/`, a handler in `src/main/ipc/`, and expose it in `src/preload/index.ts` — see section 3, that's the whole pattern |
| Change the window's size/title/behaviour | `src/main/window.ts` |
| Understand the database, real AI agents, chat, etc. | None of that exists yet — this milestone is deliberately just the skeleton. `docs/BUILD-SPEC.md` describes all of it; `PROGRESS.md` tracks what's actually been built session by session. |
| See what CI actually runs | `.github/workflows/ci.yml` |
| See exactly how the .exe gets built | `electron-builder.yml` and `scripts/build.mjs` |

---

## 9. Can I actually run it?

Yes — a real, built copy already exists on your machine right now, at:

```
D:\Projects\Agent-Bureau\dist-package\win-unpacked\Bureau.exe
```

Double-click it (or find it in File Explorer). A window titled "Bureau"
should open showing the version numbers from section 3's health check.

Two things you'll likely see, both expected at this stage, not bugs:

- **Windows may show a blue "Windows protected your PC" SmartScreen
  warning.** That's because this `.exe` isn't code-signed yet — proving
  your identity to Windows so it trusts your app costs money and takes
  setup (a certificate), and that's deliberately saved for much later
  (Milestone M15, "package and harden"), once there's an actual finished
  product worth signing. Click **"More info" → "Run anyway"** to open it.
- **This isn't an installer.** There's no Start Menu shortcut, nothing to
  uninstall — it's just a folder with the app in it, the fastest way to
  prove the app works without the extra ceremony of a real installer. A
  proper installer you'd double-click to *install* Bureau (with an icon,
  Start Menu entry, etc.) is also M15's job.

If you ever delete this folder (it's not saved in git — everything under
`dist-package/` and `dist/` is regenerated from source, on purpose, so the
repo itself only ever holds source code, never build output), you can get
it back any time by opening a terminal in the project folder and running:

```
npm run package
```

That rebuilds everything from source and recreates
`dist-package/win-unpacked/Bureau.exe` from scratch, in a minute or two.

---

## Glossary

- **Electron** — the toolkit that lets web technology (HTML/CSS/JS) become
  a real desktop app with a window, full file access, etc.
- **Main process** — the one privileged "kitchen" process; plain Node.js.
- **Renderer** — the "dining room"; a sandboxed web page, no direct file
  access.
- **Preload** — the small "waiter" script bridging the two, with a
  deliberately short list of allowed requests.
- **IPC** (Inter-Process Communication) — the messaging system the three
  processes use to talk to each other.
- **contextBridge** — the specific Electron API the preload script uses to
  safely expose its short list of functions to the renderer.
- **Native module / native addon** — code written in C/C++ instead of
  JavaScript, compiled specifically for this machine and this exact Node/
  Electron version.
- **N-API** — a stable interface Node.js provides for writing native
  addons so they don't have to be recompiled quite as often.
- **ABI** (Application Binary Interface) — the low-level contract compiled
  code depends on; mismatched ABIs are why native modules have to be
  rebuilt specifically for Electron.
- **Job Object** — a Windows OS feature for grouping processes so they can
  all be guaranteed to die together.
- **asar** — the single-file archive format electron-builder packs all the
  app's code into.
- **Zod** — the library used to strictly check that data crossing between
  processes is exactly the shape it's supposed to be.
- **Vite / esbuild** — the tools that translate/bundle the source code in
  `src/` into files that can actually run.
- **electron-builder** — the tool that packages the built app into a real
  `.exe`.
- **CI** (Continuous Integration) — automatically re-running all checks on
  a clean machine every time code is pushed, so nothing only-works-on-my-
  laptop slips through.
- **Unit / integration / e2e tests** — see section 6.
