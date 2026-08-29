# How it works — a plain-English guide to the code

`PROGRESS.md` is a changelog for future coding sessions. This file is for
you: a walkthrough of what actually exists right now, why it's shaped the
way it is, and where to look when you want to change something. No prior
Electron knowledge assumed — every term gets explained the first time it
shows up, and there's a glossary at the bottom for when you forget.

This covers **Milestones M0 through M6** — Part One is M0 (the skeleton:
the app opens, packages, and launches safely), Part Two is M1 (the data
layer: everything the app remembers, surviving being killed at any
moment without losing anything), Part Three is the audit session between
M1 and M2, Part Four is M2 (the bridge between the window and the
background process, and the window itself), Part Five is M3 (the part
that actually talks to an AI coding tool, and the "supervisor" that
watches over it), Parts Six and Seven are M4 (the control channel an
employee's process uses to talk back to Bureau — nothing after this
point works without it), Parts Eight and Nine are M5 (every employee
gets their own real copy of the project, and their work becomes real,
safely-merged git history), and Part Ten is the first session of M6 (the
rules that decide what an employee is actually allowed to do). None of
it is something you'd sit down and *use* yet — no chat, no hiring, no
office view. What it proves is more boring and more important: the
foundation underneath all of that won't crack once real weight is put on
it, and, as of M6 session 1, that an employee's process is genuinely
confined to its own small corner of the disk — not just asked nicely to
stay there.

**Status: done through M6 session 1 of 3.** Everything described in this
file is built, tested, and green. That includes M3's own tests: CI never
spends real money or needs the AI engine actually installed, because the
real-engine tests are gated to skip themselves automatically whenever
that's not available (which it never is on a CI machine) — see Part Five
for how that gate works. You can run the real, built app yourself right
now; see the box near the end of this file for how.

---

# Part One — M0: the skeleton

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
| Understand the database | See Part Two below — it landed in M1 |
| Understand real AI agents, chat, etc. | None of that exists yet. `docs/BUILD-SPEC.md` describes all of it; `PROGRESS.md` tracks what's actually been built session by session. |
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
It'll also now create a real database the first time it runs — see Part
Two below.

---

# Part Two — M1: the data layer

Everything in Part One got the app *opening*. This part is about the app
*remembering things* — and specifically, never forgetting them, even if
Bureau is killed mid-action. This is the part of the spec that talks about
"durable state" and "surviving a crash," which sounds abstract until you
picture the actual failure it prevents: you're deep into a project, an
employee is mid-task, and the power goes out. Does Bureau come back up
knowing exactly where it left off, or does it wake up confused, or worse,
quietly corrupted? M1 is entirely about making the answer always be "knows
exactly where it left off."

## 10. What a database actually is here, and what a "repository" is

Bureau's memory lives in one file: `bureau.db`, sitting in
`%APPDATA%\Bureau\`. It's a **SQLite database** — not a server you'd install,
just a structured file that a library (`better-sqlite3`) knows how to read
and write safely, including while multiple things are happening at once.
Think of it as a very well-organized filing cabinet: every kind of thing
Bureau needs to remember (a project, a task, a chat message, a setting) gets
its own drawer (a **table**), and every item in a drawer has the same set of
labeled fields (**columns**).

Nothing in the rest of the app is allowed to reach into that filing cabinet
directly. Instead, each drawer has exactly one **repository** — a small file
under `src/main/db/repositories/` whose only job is reading and writing that
one drawer correctly. If some future feature wants to create a new task, it
doesn't write raw database instructions; it calls `insertTask(...)` from
`tasks.ts` and lets that function worry about the details. This is the same
idea as the preload's "short allowed list" from Part One, just applied to
the database instead of the renderer: one narrow, well-tested door into
each drawer, instead of a hundred call sites each doing it slightly
differently.

Before anything gets written or read, it also passes through a **schema** —
the same idea from Part One's "double-check on both ends," now applied to
every single row in the database. `src/shared/models/` has one of these per
table, so a malformed task (say, one with no definition of "done") gets
rejected before it's ever saved, not discovered later as confusing garbage.

## 11. "Every table, every column" — and the mistakes that would have shipped without a second pass

M1's database schema (`src/main/db/migrations/0001_initial.sql`) implements
**every single table and column** the spec describes — over 20 tables. That
sounds like a boring completeness exercise, but it's the part of this
milestone where the most actual bugs were found, because the spec itself
turned out to have a few small, genuine mistakes hiding in plain sight —
exactly the kind of thing that's cheap to catch now and expensive to catch
after other milestones have already built on top of it. Three examples,
because they're a good illustration of why "read it again, carefully" is
worth doing rather than trusting a first pass:

- **A rule that was written once, generally ("every table remembers when it
  was created and last changed"), but not consistently repeated on every
  single table's own listing.** Eight tables were missing it. The fix
  wasn't just in the code — the spec document itself got corrected, so the
  next person (or the next session) reading it doesn't have to rediscover
  this.
- **A "connect this to that" instruction that couldn't actually work as
  written** — it pointed at a piece of information that wasn't unique
  enough to point at reliably (a bit like trying to mail a letter using
  only someone's first name in a city where three people share it). The
  fix adds the missing "and last name" — a small computed field that makes
  the connection unambiguous.
- **A rule that looked like it required a specific safety mechanism, but
  the example given to justify it didn't actually exercise that mechanism**
  — the example would have worked even with the safety feature turned off,
  which means, left alone, nobody would ever have noticed if it quietly
  stopped working. A second, more deliberately adversarial test was added
  specifically to close that gap.

None of this needed guessing — every one of these was confirmed by actually
running the database and watching it succeed or fail, not just by reading
the code and assuming.

## 12. `reconcile()` — what actually happens when Bureau restarts

This is the heart of M1. Every time Bureau starts up, before you can even
see a window, it runs a function called `reconcile()` that asks: *"did I
get shut down mid-way through something last time, and if so, what do I
need to clean up?"* It checks four different things, each addressing a
specific way a crash could otherwise leave a mess:

1. **Did I leave an AI agent running in the background?** (This isn't fully
   wired up until a later milestone actually spawns real agents, but the
   detection mechanism is built and tested now.)
2. **Did I write something to the permanent log file but not finish saving
   the matching copy in the database?** (See section 13 — this is the one
   most worth understanding.)
3. **Did I "reserve" a folder for an employee to work in and then vanish
   before releasing it?** Any such reservation older than its expiry gets
   released automatically.
4. **Was anything marked "in progress" when the lights went out?** Any task
   still marked "running," or any chat reply still marked "being typed," is
   relabeled honestly — "interrupted," not silently resumed as if nothing
   happened.

## 13. The single most important trick in this milestone: write it twice, in a specific order

Bureau keeps two records of everything that happens: a permanent, append-only
log file (`activity.jsonl` — one line of text per event, never edited, only
added to) and a faster, searchable copy inside the database (the `events`
table). Why both? The log file is the *source of truth* — simple enough
that it's very hard to corrupt. The database copy is there so the app can
quickly answer questions like "show me everything that happened to this
project," which would be painfully slow to answer by re-reading a giant text
file every time.

Keeping two copies in sync is normally risky — what if you update one and
crash before updating the other? Bureau's answer: **always write to the log
file first, and only write to the database copy after the file write is
confirmed saved to disk.** If Bureau dies in between those two steps, you
end up with the log file knowing something the database doesn't — never the
other way around. And that specific, predictable kind of gap is exactly
what `reconcile()`'s step 2 (above) looks for and repairs on the next
startup, by replaying whatever the log file has that the database is
missing.

This ordering guarantee is tested about as directly as software testing
gets: a real, separate copy of Bureau's database code is deliberately
force-killed at the *exact* moment between writing the log line and writing
the database copy, then restarted, to confirm the repair actually happens.
Which leads to:

## 14. The 20-kill-point test — proving all of this rather than hoping it's true

Section §1.7 of the spec's design principles says "durable before fast" —
closing the laptop must lose nothing. M1's gate for that isn't a code
review, it's an actual experiment: a small standalone program
(`tests/integration/fixtures/dbKillWorker.ts`) performs twenty realistic
steps in a row — creating a company, a project, a task, acquiring a folder
reservation, writing to the activity log, sending a chat message, and so on
— and after *every single step*, a test harness force-kills it, the way
Task Manager or a power cut would, then checks the database from scratch:
is it still structurally sound? Did anything half-finish? Does `reconcile()`
clean up exactly what it should, no more and no less?

All twenty of those checks pass, every time (confirmed with multiple
repeated runs, not just one). Getting a reliable "every time" out of a test
like this took a real fix along the way — the little standalone program
runs so fast that the outside test almost lost the race trying to kill it
at exactly the right moment, so it was changed to pause and wait for
explicit permission after each step, guaranteeing the kill lands exactly
where intended rather than "probably around there."

---

# Part Three — the audit, and what it found

## 15. Why we stopped and checked, instead of just building M2

M0 and M1 were both "done" — every test green, every gate passed. But
"the tests pass" and "the thing the tests are supposed to prove is actually
true" aren't always the same statement. Before building M2 on top of M1, we
spent a session specifically trying to find out where they'd quietly come
apart — reading the spec and the code side by side again, running the real
gate commands again rather than trusting memory of them, and deliberately
breaking small pieces of the code on purpose to see whether the tests
actually noticed. That last part is the important one: a test that would
pass even if the thing it's testing were broken isn't really testing
anything. Part of this check was done by a second, independent AI session
that had never seen how M0/M1 were built — reading only the spec and the
code fresh, the way a new team member would, specifically because the
person who wrote something is bad at noticing what they got wrong in it.

## 16. What the audit actually found

Nine real problems, ranked by how bad they'd be to build on top of
un-fixed. The three worst ("BLOCKER") were all in the data layer:

- **Nothing checked its own homework before writing to the database.**
  Every "insert a new row" function was supposed to fill in sensible
  defaults for anything the caller left blank (an employee's status
  defaults to "off", a task's priority defaults to 50, and so on) and to
  reject obviously wrong values (like a fraction of a cent where the rule
  is "money is always a whole number of micro-dollars"). None of that
  checking was actually happening. Worse than just "it would crash" —
  for a bad money value specifically, the bad row got written to the
  database and only THEN did the code notice something was wrong, which
  means the bad row stayed there, permanently, corrupted, for anyone to
  trip over later.
- **The activity log — the record of "what did Bureau just do" that
  everything from cost tracking to the office floor's animations will
  eventually read from — was built correctly but never actually plugged
  in.** Nothing in the code ever called the one function that's allowed
  to write to it. It's like installing a security camera and never
  turning it on.
- **"Only one thing writes to the database at a time" was a comment, not
  a rule the code actually enforced.** Two things could have opened the
  database at once and both quietly written to it, which is exactly the
  kind of thing that causes very hard-to-reproduce corruption months
  later.

Six more, one notch less severe but still worth fixing before building
further: a test that was supposed to prove "we don't accidentally kill the
wrong process if Windows reuses a process ID" used a process ID that
didn't exist, so it never actually tested that; a durability test used a
hand-written stand-in for the real logging code instead of the real thing;
deleting a database migration file after it had already been applied went
completely undetected; a safety check meant for "the file got cut off
mid-write during a crash" was accidentally being applied to *any* unreadable
line anywhere in the file, which could silently hide real corruption; and
a few places wrote raw database queries directly instead of going through
the one designated "this code owns this table" module, which matters
because it's how two different pieces of code quietly drift out of sync
over time.

## 17. How each one got fixed

Same pattern every time, on purpose: first write a test that proves the
bug is real (and watch it actually fail, for the right reason — not just
assume it will), then fix the code, then watch the same test pass. That
loop is the only way to be sure the "fix" isn't just moving the bug
somewhere else. Every fix landed as its own small commit, so each one can
be reviewed, reverted, or pointed to on its own.

The database-validation fix (the first BLOCKER above) touched the most
files — about twenty repository files, one per database table — but was
mechanically the same change each time: call the validation function
first, and use *its* answer (which fills in the defaults) rather than the
raw thing the caller passed in. The activity-log fix meant teaching the
five different "something changed" moments in the startup-recovery logic
(a crashed employee process got cleaned up, a reserved folder's lease
expired, a task got un-stuck, a chat message got marked as interrupted) to
each write their own log entry, using the exact event names the spec
already defines for this. The "only one writer" fix added an actual guard
in code — trying to open the database a second time while it's already
open now throws an error instead of silently succeeding.

## 18. What's still open

One of the nine findings — a test proving that Bureau's process-
containment safety net reaches *grandchildren*, not just direct children
(an AI coding agent spawns its own subprocesses constantly, so this
matters) — is not fixed yet. While building it, something interesting
turned up: even a plain test process, with *none* of Bureau's own safety
code in it at all, got cleaned up correctly when its parent was killed —
but only when run from inside this coding session's own terminal tooling.
The likely, mundane explanation is that the coding tool itself already
cleans up after any process it spawns, for its own safety, which would
make this a property of the *development tool*, not of Bureau or this
machine — but it's still worth double-checking on an ordinary terminal
before fully trusting a new test built on top of it. The real,
already-existing safety-net test — the one that drives the actual packaged
app rather than a bare stand-in script — isn't affected by this at all and
still passes.

(A second thing that looked like a real problem earlier in this same
session turned out not to be one: the packaged app appeared to stop
launching entirely, which was worrying enough to investigate at length —
and the cause turned out to be a leftover setting in this coding session's
own terminal environment, not anything wrong with the app. Worth
mentioning here mainly as an example of the same lesson: check the boring,
already-documented explanation before assuming something's newly broken.)

---

# Part Four — M2: the bridge and the window

## 19. Why this milestone matters more than its size suggests

Everything built so far runs quietly in the background — a database, a way
to survive a crash, nothing on screen. M2 is the milestone that connects
the two halves of the app: the part that thinks (the "main process," the
one with real file and database access) and the part the user actually
looks at (the "renderer," a sandboxed web page with no access to anything
sensitive by design — see Part One's landmine section for why that
sandboxing exists). Every button, every list, every setting in the
finished product will eventually go through the bridge built this
session. That's also exactly why it was worth being unusually careful
about it: a mistake here would quietly ripple into every later milestone,
whereas a mistake in, say, one settings field only affects that field.

## 20. The one rule every button in Bureau will obey

Somewhere under the hood, clicking almost anything in Bureau turns into a
message that travels from the window to the background process and back:
"list my projects," "save this setting," "hire this employee." Rather
than let each of those hundred-plus messages invent its own way of saying
"it worked" or "it didn't," every single one is required to answer in
exactly the same shape: either "here's what you asked for," or "here's
what went wrong, in a sentence a person can read, and (where there's
something useful to do about it) a suggested next step" — never a raw
technical error message, and never something that just silently fails.
That shape is called the *envelope*, and a small piece of code called the
*router* is the one place that enforces it: even if the code handling a
particular request crashes outright, the router catches that and turns it
into a normal, well-formed "something went wrong" answer instead of
letting the whole window freeze or show a blank error.

Most of those hundred-plus buttons don't have anything to actually do
yet — hiring someone needs a whole system (packs and roles) that doesn't
exist until a later milestone, so clicking "Hire" today does something,
and answers honestly ("this isn't built yet"), rather than either doing
nothing with no explanation or pretending to succeed.

## 21. A real bug, and why finding it mattered

Partway through, every one of the "real" buttons in the app — the ones
that ARE supposed to work already, like reading your settings — quietly
returned garbled, double-nested answers instead of clean ones. Every
automated check available (the strict type checker, the linter, the full
test suite) said everything was fine, because none of those checks had
ever actually opened the real app and clicked anything. The only thing
that caught it was doing exactly that — launching the packaged
application and watching what happened. That's the same lesson this
project has run into more than once now: a green checklist is not the
same claim as "I watched it actually work." The fix itself was small, but
finding it required treating "did I run the real thing" as a genuinely
separate question from "did the automated checks pass" — which is
precisely why this project insists on both.

## 22. What's actually on screen now, and what still isn't

Opening Bureau today shows a real window: a title bar, a chat pane (empty,
since nothing creates a conversation yet), a spot reserved for the pixel
office (deliberately left as a plain "not built yet" placeholder — see
Part One's rule about not building the visual layer before the parts
underneath it exist), and a settings panel that genuinely reads and saves
real values. It is a shell — the frame a house is built on — not a
finished room. Nearly everything a user would actually want to do (hire
someone, chat with the Director, watch a task happen) still answers
honestly with "not built yet," because building any of those for real,
this early, would mean guessing at how a system that doesn't exist yet
(the Director, the packs system, real AI agents) is supposed to behave —
exactly the kind of guessing this project has tried hard to avoid from
the start.

## 23. A packaging problem that fought back, and what actually fixed it

Partway through proving the two security checks above, the tool that
packages the app into something runnable started failing — sometimes
with a file it couldn't move, sometimes with the freshly-built
application simply vanishing seconds after being created. Two genuinely
different causes turned out to be tangled together. The first: the
antivirus software was locking a generically-named helper file that
belongs to a Mac-only variant of a library Bureau uses — a file Bureau,
being Windows-only, was never going to run anyway. Excluding every
non-Windows version of these files from the packaged app removed the
problem outright, rather than just working around it. The second cause
was self-inflicted: at one point, an earlier packaging attempt had to be
force-stopped while it was still mid-write, and that left behind a
half-finished, corrupted copy of the app that a *later*, apparently
successful build didn't always fully replace — proven by comparing the
exact bytes of the freshly-built code against what actually ended up
inside the packaged copy. Once both were understood and fixed, every
check — including the two that had been stuck — ran cleanly, repeatedly,
independently. The lesson worth keeping: a security check "passing"
because the thing it was supposed to run against never actually launched
correctly is not a pass at all — it took getting genuinely curious about
*why* the packaging kept failing, not just retrying it, to actually
finish proving these two things rather than settling for "probably fine
once it's fixed."

---

# Part Five — M3: talking to an AI coding tool, and watching over it

## 24. What an "engine adapter" is, and why Bureau needs one at all

Bureau doesn't build or host any AI model itself — it's a manager for AI
coding tools you already have (Claude Code today; others later). But
every one of those tools has its own way of being started, its own way
of reporting what it's doing, and its own quirks. If every other part of
Bureau had to know the specifics of every tool it might ever talk to, the
whole app would be tangled up with one vendor's implementation details.
The fix is the same one used throughout this codebase: one narrow,
strict translation layer — the *adapter* — that turns "whatever this
specific tool does" into one shared, simple vocabulary everything else in
Bureau reacts to: "a session started," "here's some text," "a tool ran,"
"it's done." Nothing above the adapter ever needs to know which real tool
is underneath.

A second adapter — `FakeAdapter` — exists purely for testing. It behaves
exactly like a real one from the outside, but never spawns a real process
or spends a cent; a test hands it a scripted sequence of events and it
replays them on cue. Almost everything in this milestone was built and
proven against that fake first, precisely so building and testing the
rest of Bureau never needs a live AI subscription or real money.

## 25. Two ways to talk to an AI tool — and why the "watch a terminal" way is the fallback, not the default

The best way for Bureau to talk to a tool is *structured mode*: the tool
itself speaks a machine-readable format, so Bureau gets clean, labeled
information ("here's some reply text," "here's a tool call") instead of
having to guess. Claude Code supports this, and it's what Bureau uses for
it by default.

Not every tool does, though — some only offer the same interactive
terminal screen a person would type into by hand. For those, Bureau has
a fallback: it opens that same terminal interface itself, in the
background, and watches the raw text scroll by (this is *PTY mode* —
"pseudo-terminal," a fake terminal window a program can be given so it
behaves exactly as if a person had opened it). The catch, discovered and
confirmed empirically this milestone: reading meaning out of a scrolling
terminal screen is fundamentally less reliable than a tool telling you
directly. You can tell when a line of text arrives, but you generally
can't safely tell how much it cost, or reconstruct the exact arguments of
a tool call, from what's essentially a picture of a screen. So Bureau
never guesses at those numbers when it's watching a terminal — it shows
"cost not reported" rather than inventing a number, and such an employee
is limited to safer, coarser limits (a turn count, a time limit) instead
of a dollar budget it can't actually verify.

## 26. How Bureau logs in as an employee, without asking for a second account

Each employee's AI tool runs in its own isolated folder — its own
settings, its own memory of past conversations — so one employee's work
can never leak into another's. The open question this milestone had to
answer for real: can an employee actually log in from inside that
isolated folder, using the same paid subscription the user already has,
without Bureau having to store a raw API key and bill everything
separately? Confirmed empirically, by actually trying it: yes — copying
two specific files (the tool's own saved login session, which turns out
to live in two separate files rather than one, found the hard way) into
that isolated folder restores a genuinely working, already-logged-in
session. That's the mechanism a later milestone will use to actually
provision every employee's login; this milestone confirmed it's possible
and exactly what it takes.

## 27. The supervisor: the one thing allowed to manage an employee's process

Every employee that's actually running has a *supervisor* watching it —
one supervisor each, and it's the only thing permitted to touch that
employee's underlying process. Its job: keep track of whether the
employee is thinking, waiting, or stuck; write down what it actually
spent (in a running ledger, not a guess); and notice if it's gone
silent for too long.

That last part turned out to need real thought. An AI agent can
legitimately go quiet for several minutes while it's genuinely working
through something hard — that must never be mistaken for a crash. But an
agent that's actually hung needs to be caught and restarted, not left
running forever. The fix: "still alive" means something different
depending on how Bureau is talking to the tool — any labeled message in
structured mode, or literally any byte of output at all in terminal-
watching mode — and the patience allowed before giving up is tuned
separately for each, generous enough that real thinking never gets
mistaken for a hang.

## 28. A real decision, argued out loud: why terminal-watching mode was dropped for the main tool

Early on, the plan was for Claude Code to support both structured mode
and terminal-watching mode, falling back to the second automatically
whenever needed. Partway through, that got reconsidered and reversed:
structured mode already works and covers everything the main tool needs
to do, so terminal-watching mode for *that specific tool* was buying
nothing — while costing a fragile "is it ready for the next instruction"
detector, and a real, newly-discovered wrinkle: an interactive terminal
session shows a one-time "do you trust this project?" prompt the very
first time it sees a new folder, and every employee gets a brand-new
folder. Terminal-watching mode is still fully built and used for *other*
tools that genuinely have no structured mode — it's just no longer the
fallback for the one tool Bureau ships with by default. The one place
this will matter again: a future "take control" feature, letting a
person type directly into an employee's session — that's the one
genuine use for watching Claude Code's own terminal, and it's
deliberately saved for later rather than built on a foundation nothing
needs yet.

## 29. The terminal you'll eventually be able to watch — built, but not yet wired to a window

Part of this milestone builds the machinery behind a real terminal view
in the app — the kind where you could watch an employee's raw output
scroll by, the same way you'd watch it in a normal terminal window. What
exists now: the plumbing that collects that output efficiently (batching
rapid-fire text instead of flooding the window with it), replays recent
history to a window that opens partway through a task instead of
starting blank, and — importantly — defaults to read-only, so simply
looking at an employee's terminal can never accidentally interfere with
it; someone has to deliberately "take control" first. What doesn't exist
yet is the actual visible terminal panel in the window itself — that
plumbing has nothing connected to it in the UI yet, because there's no
way to actually hire and run a real employee until a couple more
milestones land. Building the pipe before there's a faucet to attach it
to would have meant guessing at requirements nothing real has tested
yet.

## 30. The most important bug this milestone found — and why it took connecting every piece to find it

Every individual piece above was built and tested carefully on its own.
But near the very end of this milestone, a deliberate check — "does the
whole sequence actually work end to end, not just piece by piece?" —
found something no amount of testing pieces individually had caught:
telling the supervisor to assign an employee a task never actually told
the *employee* what the task was. Every test had passed anyway, because
the fake test tool used throughout doesn't need to be told anything
correctly to play back its scripted responses — it was, in effect, a
car with a perfectly good engine, wheels, and dashboard, where nobody
had ever connected the key to the ignition, and every test so far had
only ever checked the dashboard lights, never actually tried to drive
it.

Fixed directly, and — just as important — a second, permanent test was
added specifically so this class of bug can't hide again: it drives a
real AI tool (a tiny, free, scripted stand-in, not the paid one) through
the supervisor exactly the way a real user's click eventually will,
start to finish, and checks that the tool actually receives and responds
to its task. That's the check this milestone closes on: not "were the
pieces tested," but "does turning the key actually start the car."

---

# Part Six — M4: the control channel (session 1 of 2–3)

## 31. The problem this milestone solves: an employee can't talk back yet

Up through M3, Bureau can spawn an AI tool and watch what it does — but
the AI tool has no way to *ask permission* before doing something, or to
*tell Bureau* it finished a task, or to *call one of Bureau's own tools*
(like "mark this task done"). All of that needs some communication
channel back into Bureau's main process, from a process Bureau spawned
and does not fully trust. M4 builds that channel.

The design (§7.9/§7.10 of the spec) is a small, private web server:
Bureau's main process opens a web server that only your own computer can
reach (never the internet, never even another device on your network),
each employee gets a secret password (a "token") nobody else knows, and
three specific requests are the only things that server understands:
"is this tool call allowed?", "run this Bureau tool for me," and "log
this thing that happened."

## 32. Why "only your own computer can reach it" needs more than just picking a local address

Binding a server to `127.0.0.1` (the address that only means "this same
computer") already makes it physically impossible for another computer
on the network to connect to it — the operating system enforces that.
But there's a subtler hole: a malicious web page open in your own
browser *can* make requests to `127.0.0.1` — browsers allow it. And a
trick called DNS rebinding can make that request's headers lie about
where it's "really" going. So the server also checks two things every
real request from Bureau's own tools would always have and a browser
request never would: no browser-style "Origin" header at all, and a
"Host" header that matches the server's own address exactly. A request
missing either check gets rejected and logged as a security event before
it ever reaches anything that matters.

## 33. The Windows password-file problem, and the tool that actually solves it

Each employee's secret token needs to live somewhere on disk so a
spawned process can read it — but if any other program on your computer
can read that file too, the "secret" isn't secret. The obvious fix on
Linux (`chmod 600`, "only the owner can read this file") **does nothing
at all on Windows** — it's a silent no-op, which is exactly the kind of
bug that looks fine until someone actually checks. The real fix, found
and proven this session, is a completely different Windows-only tool
called `icacls` that can genuinely lock a file down to just your user
account. Every claim about this in the code is backed by a test that
writes a real file, asks Windows for its real permissions afterward, and
checks the answer — not a test that assumes the command worked because
it didn't error.

## 34. "Fail closed": what happens when nobody answers

Some tool calls need a human to say yes or no before they proceed —
Bureau holds the employee's request open (a "long poll") until an answer
arrives, up to a configurable maximum. Three things can go wrong while
that request is being held open, and this milestone decides and tests
all three: if the human takes a genuinely long time to answer, that must
never be punished with an automatic "no" — the wait itself is fine, only
running past the maximum limit counts. If the employee's own process
dies while waiting, Bureau notices the connection dropped and cleans up
immediately instead of holding a conversation with nobody. And if
*Bureau itself* dies while holding the request open — the scenario this
milestone cares most about — the employee side must treat "I got no
answer at all" as a "no," never as a "the answer must have been yes."
That last one was proven by literally killing Bureau's own process for
real mid-conversation and checking what the waiting side concluded — not
by pretending to kill it.

## 35. What's still missing after this session

This session built the server and everything around it — but not the
two programs that will actually talk to it. `bureau-hook` (a small
program that intercepts a tool call and asks Bureau for permission) and
`bureau-tools` (the program that lets an employee call Bureau's own
tools, like "I'm done") are session 2's job. Everything this session
built was proven with a plain, hand-written HTTP client standing in for
those two programs — deliberately, so the channel itself is trustworthy
before anything is built on top of it.

---

# Part Seven — M4 session 2: the two missing programs, and the gate

## 36. The two programs session 1 stood in for, now real

`bureau-hook` and `bureau-tools` both exist now, and both run the same
unusual way: not as their own standalone program, but as a plain
JavaScript file handed to Electron's own executable with a special flag
(`ELECTRON_RUN_AS_NODE=1`) that tells Electron "don't be a desktop app
this time, just be Node." This sounds like a strange trick, but it solves
a real problem for free: these two programs need *some* JavaScript
runtime to run in, and Bureau's own installer already carries one inside
Electron itself — so shipping a second copy of Node just for these two
small scripts would needlessly double the download for something already
sitting right there.

`bureau-tools` is how an employee actually *does* anything Bureau-specific
— report a status, ask the Director a question, finish a task. It speaks
a real, standard protocol called MCP (Model Context Protocol) that AI
coding tools already know how to talk to — Bureau doesn't invent its own
private language for this, it uses the same one many other AI tools
already support, via an official library rather than hand-writing that
protocol from scratch (a good way to get subtle wire-format bugs no one
would find until a real agent hit them).

`bureau-hook` is the actual permission check. Every time the AI tool
wants to use a tool — read a file, run a command, call one of Bureau's
own tools — this script is asked first: "should this be allowed?" It
calls back into Bureau's own control channel (session 1's work) to get a
real answer, and if it can't get one — Bureau is unreachable, or nobody
answers in time — it says no. Always no, never "I don't know, so go
ahead." That's the whole safety property this milestone exists to
guarantee, now finally connected to a real permission check instead of
just a server nobody was calling yet.

## 37. A gap found by testing this for real, not by reading the code twice

Once these two programs were wired up and actually run against a real
Bureau server, one of Bureau's own tests broke immediately — but not
because of a mistake in the tool logic. It broke because that test was
running under a plain testing tool (not the real Electron app), and one
of the new files reached for something only the real app has. The fix
was the same one already used elsewhere in this project for exactly this
shape of problem: make that one dependency swappable, so a test can hand
in a fake version instead of needing the real thing. This is a small
example of a pattern worth noticing — a change that looks purely
additive (two new files) can still ripple into code that never changed,
simply because everything shares one big web of "who imports what."

## 38. The gate: run for real, and it passed

Every piece up to this point had been tested individually and proven to
work — but none of it had ever been asked to work *together*, for real,
with a real AI model on the other end. The final proof this milestone
asked for was exactly that: one real employee, given one real task that
explicitly told it to report its status, ask the Director a question,
and mark its task finished — then checking, afterward, that all three
really happened. Not "the code looks right." Not "a fake stand-in played
along." Run for real, twice (the first run caught one more small
test-only bug, fixed in seconds, no real spend involved) — and the second
run is the one that counts: the actual database rows changed, the actual
activity log recorded it, and — the one detail every earlier version of
this system would have gotten wrong — the employee's status correctly
showed "finished and reported," not the safer-but-wrong "finished and
never said anything," which is exactly the bug this whole milestone
existed to close.

One more thing happened that nobody scripted: before the model called any
of the three intended tools, it first tried a completely different one —
a built-in tool-discovery feature, trying to look up Bureau's tools by
name rather than calling them directly. Bureau's permission gate denied
it, correctly, since it wasn't on the short list of tools this milestone
allows — and the model noticed, adjusted, and just called the real tools
directly instead. That unscripted moment is arguably better proof than
the planned one: it's the safety gate actually holding the line against
something real, not just against a scenario written in advance to make it
look good.

---

# Part Eight — M5 session 1: giving every employee their own copy of the project

## 39. The problem: everyone sharing one copy of the project doesn't work

Up through M4, an employee that gets spawned is pointed at the same
single folder: whatever project folder is actually open on your own
machine, the one you'd see if you opened it in your own editor. That's
fine for one employee at a time, but the whole premise of Bureau is
*several* employees working on the same project at once — and if two of
them shared that one folder, the second to start would find whatever the
first one had just done to it, mid-change, and might overwrite work that
isn't even finished yet. Worse, switching that shared folder to a
different branch for employee B would yank the rug out from under
employee A, who's relying on a completely different branch still being
checked out in that same place. M5 is about giving every employee a
genuinely separate place to work, without needing to duplicate the
entire project's history for each one.

## 40. What a git "worktree" actually is, and why every employee gets their own

Git already has a feature built for exactly this, called a **worktree**.
Normally, a git-tracked folder holds two things at once: the project's
entire history (every commit ever made) and one *live, on-disk copy* of
whatever branch is currently checked out. A worktree lets git keep that
one shared history but hand out several separate *live copies* at once —
each with its own folder on disk, its own independently-checked-out
branch, all pointing back at the same shared history underneath. Think of
it like a library with one card catalog (the shared history) but several
separate reading desks (worktrees), each of which can have a completely
different book open on it at the same time, without the desks
interfering with each other or needing their own private copy of the
whole library.

Bureau now creates one of these the moment an employee is hired, and
removes it the moment that employee is fired — a real `git worktree add`/
`git worktree remove`, run against the real project. Each one lives in
its own folder well away from your own project folder (under
`.bureau/worktrees/<employee>/`, never inside the project itself), so
it's structurally impossible for an employee's folder to collide with,
or be mistaken for, the one you'd actually open yourself. And a rule is
built directly into the one function allowed to run any git command at
all: if anything ever tries to change what's checked out in *your* copy —
the main one — it refuses, before even trying, rather than trusting every
future line of code across many more milestones to remember not to.

## 41. Why the Core is the only thing that's ever allowed to commit

Even though every employee now gets its own folder to freely edit files
in, none of them can turn those edits into a real, permanent point in the
project's history (a **commit**) themselves — not this session, not ever,
by design. Only Bureau's own background process ("the Core," the same
"kitchen" process from Part One) is ever allowed to do that. The
reasoning: a commit is the actual gate between "an AI wrote something"
and "this is now genuinely part of the project," and Bureau wants exactly
one place responsible for deciding what crosses that gate, so a later
session can put real checks in front of it (like scanning for an
accidentally-committed secret) without having to trust every employee
individually to run those checks honestly first.

Nothing this session actually crosses that gate yet — no employee task
produces a real commit, because nothing yet asks one to. What this
session *does* build is the mechanism the eventual commit will run
through: every git command Bureau's own code ever runs, for any reason,
funnels through exactly one function — the same "one narrow, well-tested
door" idea as the repository pattern from Part Two, section 10, just
applied to git instead of the database. When commits arrive, next
session, they inherit that same door rather than needing a new one.

## 42. The lease: the "no double-booking" rule from section 12, made concrete

Section 12 mentioned, in passing, that `reconcile()` checks whether
Bureau "reserved a folder for an employee and then vanished before
releasing it." Now you know what that folder actually is — the worktree
from section 40 — and this session makes the reservation itself, called a
**lease**, real and load-bearing. A lease is a simple rule: only one
employee may hold a given worktree at a time, and it's enforced by the
database itself, not by anyone remembering to be careful. The trick is a
single database instruction that says, in effect, "hand this worktree to
employee X, but only if nobody already holds it" — and because the
database only ever processes one such instruction at a time, even if
fifty requests for the same worktree somehow arrived in the exact same
instant, exactly one of them would ever succeed. This was proven directly
this session: 25 employees racing for the same worktree, 30 separate
times, and exactly one winner every single time — not "usually," every
time.

Leases also expire. If whoever's holding one goes silent for too long
(crashed, hung, whatever), Bureau can eventually hand that worktree to
someone else — but only after confirming, for real, that the process
which was using it is actually dead, never just quiet. It checks the
operating system directly for that specific process, kills it if it's
somehow still running, and only *then* releases the lease — proven this
session by spawning a real process, handing it a lease, deliberately
letting that lease expire, and confirming (by literally checking whether
the process was still alive afterward) that the kill genuinely happened
before the worktree was ever handed back to anyone else.

## 43. What the startup reconciler now catches — and the two new ways a crash could leave a mess

Every worktree creation and removal is actually two separate steps: tell
the database about it, and do the real thing on disk. Section 13
described why that's risky in general — whichever step happens first, a
crash between the two can leave the database and the real world
disagreeing — and this session adds worktrees to the list of things
`reconcile()` checks and repairs on every restart: section 12's fourth
check, made concrete for git.

Two specific crash windows exist, and both were tested by actually
killing a real process at the exact moment in between, not just reasoned
about. Creating a worktree writes the database row *first*, then creates
the real folder — so a crash in between can leave a database row
promising a folder that was never actually built (like a hotel's booking
system showing a reserved room that doesn't physically exist yet).
Removing one runs the opposite way — the real folder disappears first,
then the database row is deleted — so a crash there leaves the mirror
image: a real folder that's already gone, but a database row still
insisting it exists. `reconcile()` now checks every worktree the database
believes exists against what's actually on disk, in both directions, on
every single restart — a row with nothing to back it up gets removed; a
real folder the database has forgotten about gets cleaned up too — so it
doesn't matter which of the two ways a crash happened to interrupt
things, the next restart always resolves it to one consistent, correct
answer.

## 44. What's still missing after this session

This session gives every employee somewhere real to work, and makes sure
that "somewhere" survives a crash. It does not yet let anyone actually
*finish* a task in the git sense: no employee's edits ever become a real
commit, nothing merges one employee's finished work back into the shared
project, and nothing checks whether two employees' independent edits
would actually conflict once combined. There's also no way yet to hand a
worktree to someone else, or notice a crashed employee, *while Bureau is
still running* — all of today's cleanup only happens the moment Bureau
restarts, the same way section 12's other checks work. All of that —
commits, merging, conflict handling — is explicitly the next session's
job, not something this one quietly skipped.

---

# Part Nine — M5 session 2: turning an employee's work into real history

## 45. The problem: an employee's edits have to become real history, safely

Part Eight gave every employee a real folder to work in. It did not let
anyone actually *finish* — an employee could write files all day, and
none of it ever became a permanent, saved point in the project's real
history (a **commit**, section 41's glossary term). This session closes
that gap: when an employee reports a task done, Bureau checks the work,
saves it as a real commit, and — once that work is accepted — folds it
back into everyone else's shared copy of the project. Doing all three of
those safely, without ever letting an employee touch git directly, turns
out to need most of this session's actual engineering.

## 46. What actually happens when an employee says "I'm done"

Three things happen, in order, and any one of them can stop the process
before the next one starts. First, Bureau checks whether anything
*unexpected* has happened to this employee's folder since it was last
handed to them — section 50 explains exactly what "unexpected" means and
why it matters. Second, Bureau runs whatever checks the project has
configured — section 48 covers the one check that's always there no
matter what. Only if both of those pass does Bureau actually save the
work as a real commit, with a specific, readable message (which task,
which phase, who did it, what it cost) rather than a bare "wip." An
employee's own name goes on the commit as its author; Bureau's own name
goes on it as the one who actually saved it — the same split a real
company might use between "who wrote this" and "who's responsible for it
being here."

## 47. The same "write it down before you do it" trick, applied to committing

Section 13 described the single most important idea in this whole
project: before doing something that can't easily be undone, write down
that you're *about* to do it, first — so a crash in the middle leaves a
record of what was intended, not just a mysterious half-finished mess.
This session needed that same trick again, in a new place, and getting
it right the second time took catching a real mistake first.

The first version of the commit-saving code did the real work (asking
git to save the commit) *before* writing down that it had happened. That
sounds like a small detail, but it has a genuinely bad consequence: if
Bureau crashed in that exact gap, it would restart believing nothing had
been saved yet — while a real commit actually existed. The very next
safety check this session also builds (section 50, "did something
unexpected happen to this folder") would then look at that real commit,
not recognize it, and incorrectly treat *Bureau's own crash* as if an
employee had done something they weren't allowed to do. Caught and fixed
before it ever shipped: write down "I'm about to save commit for this
task" *first*, actually save the commit second, and only then mark that
note as done — in one single, uninterruptible database step, so there's
never a moment where "the commit exists" and "the note says it doesn't"
can disagree for long. On restart, Bureau checks for any leftover note:
if the commit it describes turns out to really exist, it was Bureau's
own interrupted work, and the note is simply completed as if nothing
went wrong; if it doesn't exist, nothing happened after all, and the
note is just cleared.

## 48. The secret scan: the one check that can never be turned off

Every project can configure its own checks before a commit is
accepted — the same kind of "does the code pass its tests" checks a
human developer would run. But one specific check is always there,
unconditionally, for every project, with no setting anywhere that turns
it off: a scan for the unmistakable *shape* of a real, leaked credential
(a cloud provider's access key, a source-control login token, the header
of a private encryption key, and a handful of other well-known
patterns) — because an AI agent accidentally saving a real secret into
the project's permanent history is exactly the kind of costly mistake
this project can't afford to leave optional.

Getting "can never be turned off" to actually be true, rather than just
written down as a rule, took a real correction mid-session. The first
version made the scan hard to leave out of the *list* of checks Bureau
normally builds — but a list is just a list; nothing stopped some other
piece of code from building its own, shorter list by hand and skipping
the scan entirely, with nothing to notice or object. The fix moved the
guarantee to the one place every check of any kind actually *runs*
through, no matter how the list was built, and made that place refuse to
run at all if the scan isn't in it. The difference matters: the first
version proved the normal path remembers to include the scan; the actual
fix proves nothing — not even a mistake — can skip it.

## 49. How two employees' work comes back together, without ever opening a folder

Once several employees' work is accepted, it has to be combined into one
shared line of history per phase of the project (an **integration
branch** — every employee's own branch feeds into it, and it eventually
feeds into the main project once a whole phase is accepted). Combining
two people's independent edits into one is normally something git does
by actually opening a folder, checking out both versions, and writing
the combined result to disk — exactly the kind of on-disk folder
juggling this project has been careful to avoid needing a *second*,
separate one for.

It turns out git can do the entire combination *without* ever touching a
real folder at all — computing what the combined result would be
directly from its own internal history, the same way it can tell you
"these two versions would conflict" without opening anything. Bureau
uses exactly that: the combination is computed, and if it's clean, a
real merge commit is created and the shared branch is moved to point at
it — all without a single folder ever being written to. This turned out
to be a real improvement discovered partway through this session: an
earlier plan would have needed a whole extra, dedicated folder just for
doing merges in, with its own set of the same "which employee, which
folder" bookkeeping questions Part Eight already answered once. Skipping
that folder entirely means there's nothing extra to keep track of, and
nothing extra that could ever collide with anything else.

Three employees' work landing on the very same shared branch at almost
the same instant was tested for real, not assumed safe: a hundred and
two real cycles of "write something, save it, combine it into the
shared branch," with three employees actually doing this at the same
time rather than one after another. Combining work onto a shared branch
this way can occasionally lose a very short race — two combinations
computed at almost the same moment, one wins, the other has to notice
and recompute against the new result — so this retries automatically,
a few times, before giving up loudly. It needed to retry for real,
routinely, under three-way concurrent load — not as a rare edge case.

## 50. What happens when two employees genuinely disagree

Sometimes two employees' edits to the very same part of a file can't be
combined automatically at all — a genuine conflict. Bureau's answer is
deliberately unglamorous: it does not guess. The task involved is marked
blocked, and a real question is raised for a person to answer (the same
"checkpoint" mechanism briefly mentioned back in Part Two's own
groundwork, still not fully connected to anything visible until a later
milestone) — showing exactly which files conflict and both versions'
actual content side by side, with real, honestly-described choices (ask
someone to fix it in a follow-up task, or resolve it yourself outside
Bureau entirely) rather than a button that promises to "resolve" it.

## 51. The one layer that didn't make it in — and why that's an honest answer, not a failure

Section 41 explained that only Bureau's own background process is
supposed to be able to save a real commit — employees only ever get to
edit files. This session tried to make that a genuine technical wall, on
Windows, using a real low-level security feature (a "restricted" version
of the same permission token every running program on Windows carries,
deliberately stripped of some of its own normal rights before an
employee's process is even started). It did not work: a process started
with that specific kind of restricted permission fails before it can
even finish starting up at all, on this machine — a real, known rough
edge of that particular Windows feature, confirmed directly (a nearly
identical test using an *unrestricted* copy of the same permission token
worked correctly, which is what proves the problem is specifically in
the restriction itself, not in how the process gets started).

Rather than pretend this wall exists when it doesn't, the honest
fallback already built earlier in this project's own rules kicks in: the
promise downgrades from "an employee literally cannot save a commit" to
"an employee is stopped by policy, and anything that slips past that
policy anyway gets noticed and flagged" — which is exactly what section
47's own crash-recovery check already does for real, regardless of
whether this stronger wall ever gets built. A weaker, honestly-labeled
guarantee that's actually true beats a stronger one that only sounds
true.

---

# Part Ten — M6 session 1: teaching Bureau to say no

## 52. The problem: nothing has ever actually stopped an employee yet

Every session so far has been about giving an employee more real
capability — its own folder (Part Eight), its own way to talk back to
Bureau (Parts Six and Seven), a real path to turning its work into
history (Part Nine). None of it has ever asked the question this session
answers: what happens the moment an employee's process tries to do
something it shouldn't? Until now, the honest answer was "nothing built
yet checks" — a placeholder stood in, allowing a small hardcoded list of
harmless-looking tools and denying everything else, with a comment on it
saying, plainly, "the real one is M6." This is that real one: a full set
of rules, checked before every single thing an employee's process tries
to do, that decides allow, deny, or "ask a person first" — and, for the
handful of rules that matter most, decides it in a way nothing else in
the system is allowed to override.

## 53. The seven rules that can never be changed, and why that has to be true today, not just eventually

Seven rules are wired directly into Bureau's own code, not read from any
settings file or configuration a project could supply: an employee may
only write inside its own folder (never even the project's shared
folder, which would let it sneak changes past everything Part Nine
built); an employee may read a bit more widely (its own folder and the
shared project) but still never anywhere else; credential-shaped files
(SSH keys, cloud config, `.env` files) are never readable; Windows
system folders and Bureau's own private data are never touched; the
handful of commands that would themselves count as "the employee
committing" or as flatly destructive (formatting a drive, force-pushing,
deleting a registry key) are refused outright; and, sub-agent tools —
several AI engines ship a "spawn a helper" tool of their own — are
refused too, because a process an employee starts on its own is a
process nothing in Bureau is watching, budgeting, or showing on the
office floor.

Why build this now instead of waiting for the real settings system that
will eventually let a project's own rule packs add more of their own
(that's M7, not yet built)? Because these seven aren't *more* rules on
top of a working system — they're the floor everything else stands on.
A rule pack that could somehow *loosen* one of them would matter more
the more of the rest of the app exists to be endangered by it, which is
exactly backwards from when you'd want to have tested it. So this
session also builds — and proves, with a real test — that nothing,
ever, gets to quietly replace one of these seven with a looser version
of itself. Not a project's future rule pack, not a role's own
permissions, nothing. The test constructs exactly that attempt by hand
(there's no real rule-pack file format to attempt it with yet, since
that's M7's job) and confirms it's rejected the moment Bureau tries to
load it — before any employee's request is ever actually checked against
it.

## 54. A path comparison that looks obviously correct and silently isn't

Here's a trap that's easy to miss entirely: Windows lets you refer to
the exact same folder several different ways — `C:\Program Files` and
its older, shorter alias `C:\PROGRA~1` genuinely point at the same real
place on disk, and a special kind of folder shortcut (a "junction") can
make one folder appear to live inside another folder entirely, when
really it's somewhere else. If Bureau's rule that says "never touch
Windows' own system folders" compares the *text* of a path an employee
asked for against the text `C:\Windows\...`, and the employee's request
happened to arrive as the shorter alias instead, the comparison would
never match — and the rule would silently do nothing, even though it's
supposed to be one of the seven that can never be gotten around. The fix
is to never compare raw text at all: every path gets resolved down to
the one real, canonical answer for "what folder does this actually
point to" first (a Windows tool built for exactly this), converted to a
consistent slash direction and lowercase, and only compared after that.
Tested against a real short-name alias and a real junction on this
actual machine — not a string with a backslash typed into it by hand,
which would prove nothing about whether the real Windows quirk is
actually handled.

One more wrinkle worth knowing: that same "what does this path really
point to" tool refuses to answer for a file that doesn't exist yet —
which is a problem, because the single most common thing an employee's
process asks to do is *create* a brand-new file. The fix walks up the
path to the nearest folder that *does* exist, resolves that part for
real, and tacks the new file's name back on unresolved (there's nothing
to resolve yet — it doesn't exist).

## 55. How an allow/deny/ask decision actually gets made

Every one of an employee's requests goes through the same short list of
checks, in order, every time: is this one of Bureau's own built-in tools
(the ones an employee uses to report status, ask a question, or say it's
done)? Those are always allowed outright — every engine reaches the same
small set of Bureau tools, so this check doesn't depend on which AI tool
the employee happens to be running. If not, do any of the seven
unbreakable rules from section 53 say no? If one does, that's the final
answer immediately, full stop — nothing checked afterward can talk it
back into a yes. If none of those forbid it, do any of the project's own
rules (from a role, eventually from a pack — real database columns
already exist for this, they just have nothing in them until M7 builds
the thing that fills them in) say yes or "ask first"? If more than one
rule would apply, the *first* one found wins and nothing checked later
is allowed to quietly overwrite that answer — a real bug this session
deliberately built a test to catch, by writing the version of the code
*without* that protection and confirming it really does let a later,
weaker answer sneak in ahead of an earlier, stronger one. And if nothing
at all has an opinion, Bureau falls back to a plain table based on how
cautious the employee is currently allowed to be (section 56) and what
kind of thing it's trying to do — reading is always fine, writing and
running commands depend on how much trust that employee currently has,
and anything Bureau doesn't recognize as one of its known categories is
refused outright rather than merely asked about, on the theory that an
unrecognized request deserves a hard no and a paper trail, not a prompt
a person eventually learns to click through without reading.

One honesty note worth being explicit about: "allowed to run commands"
only ever means *Bureau's own named tool* for running a command. It has
no way to watch what that command itself then does — an employee allowed
to run ordinary developer commands at all can, in principle, still reach
the internet through them. Bureau's own rules gate which *tools* an
employee gets, not what those tools can technically do once they're
already permitted to run. Nothing in this project claims otherwise.

## 56. "Trust it completely" has to mean something a person actually agreed to, every time

Every employee has one of three trust levels, and the most permissive of
them — described honestly in earlier sections but not yet real — is
supposed to always require a person to explicitly confirm it once,
before it ever actually takes effect. There was no way to check that had
happened before this session, which meant a saved preference of "trust
this employee completely" would have silently behaved as if it were
real the moment it was saved, dialog or no dialog. This session doesn't
build the confirmation dialog itself (that's later, alongside the rest
of the chat interface) — but it does build the one thing that has to
exist *before* a dialog can mean anything: a real, separate record of
whether that confirmation has actually happened, checked fresh every
single time, completely independent of the saved preference itself.
Until that record says yes, an employee saved as "trust completely"
quietly behaves as the next level down instead — not locked out
entirely, just not yet trusted with the one thing it hasn't actually
been confirmed for. And this computed, moment-of-use answer is never
written back over the person's own saved preference — a subtle trap
worth naming directly, since overwriting it would make a temporary,
one-time downgrade look like the person had actually changed their mind.

## 57. Catching a runaway employee before the bill does

One more thing lands this session, small but aimed at a real, specific
failure: an employee calling the exact same tool, with the exact same
arguments, over and over — a loop, whether from real confusion or a
model just getting stuck. Budgets (not yet built — that's the next M6
session) would eventually catch this too, but only after real money has
already been spent finding out. This session's fix is cheaper and
earlier: if the same request repeats too many times within a short
window, Bureau forces the *next* one to be asked about instead of
silently allowed again, and records that it happened. It only ever makes
an already-allowed request stricter — a request that was already going
to be refused, or already going to be asked about, is left exactly as it
was; there's nothing to gain by asking twice about something already
blocked.

## 58. What's still missing after this session

Nothing built this session controls how much an employee can spend, or
what happens once it goes over — that's the next M6 session. Nothing
here builds the actual "are you sure you want to trust this employee
completely" dialog from section 56, or the settings screen a person
would use to change any of this — those come later, alongside the rest
of the chat interface. And the project's own rules (role- and
pack-supplied, mentioned in section 55) genuinely have nothing in them
yet, because the thing that would fill them in — real installable rule
packs — doesn't exist until M7. What's real today is the floor
everything else will eventually stand on: the seven rules nothing can
loosen, a real decision made correctly every time regardless of how
Windows spells a path, and an honest, checked-not-assumed answer to "how
much does this specific employee get trusted right now."

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
- **SQLite** — the database engine Bureau's memory is built on; a single
  file on disk (`bureau.db`), not a server you install or run separately.
- **Table / column / row** — the "filing cabinet" from section 10: a table
  is one drawer (e.g. "tasks"), a column is a labeled field every item in
  that drawer has, a row is one actual item.
- **Repository** — the one file per table that's allowed to read/write it
  directly; see section 10.
- **Migration** — a numbered, one-way file describing a change to the
  database's structure. Bureau never edits an already-applied one; a new
  change is always a new migration file.
- **Transaction** — a group of database changes that either all happen or
  none do — there's no in-between state a crash could catch you in.
- **Foreign key** — a column that points at a row in another table (a
  task's `project_id` pointing at that project's row), enforced by the
  database itself so you can't accidentally point at something that
  doesn't exist.
- **WAL (Write-Ahead Log)** — SQLite's mode for handling many small writes
  safely and quickly, used throughout Bureau's database connection.
- **`reconcile()`** — the startup cleanup routine described in section 12, extended to worktrees in section 43.
- **Envelope** — the one required shape every answer to a button click or
  IPC request takes: "it worked, here's the result" or "it didn't, here's
  why in plain language." See section 20.
- **Router** — the piece of code that receives every one of those
  requests, checks it's well-formed, and makes sure a crash while
  handling it never escapes as anything other than a normal, readable
  "something went wrong" answer.
- **Zustand** — the small library the window's on-screen state is kept in
  (what's in the settings panel, what's in each list) — deliberately
  simple, since the window is never allowed to be the "source of truth"
  for anything; it only ever mirrors what the background process tells it.
- **stateDelta** — the message the background process uses to keep the
  window's copy of the state up to date: either a full refresh (sent right
  after the window opens or reloads) or a small incremental update.
- **Engine adapter** — the translation layer between Bureau and one
  specific AI coding tool; see section 24.
- **FakeAdapter** — a scripted stand-in for a real adapter, used
  throughout testing so nothing needs a live subscription or spends real
  money; see section 24.
- **Structured mode** — talking to an AI tool through its own
  machine-readable format, rather than watching its terminal screen; see
  section 25.
- **PTY / PTY mode** ("pseudo-terminal") — a fake terminal window handed
  to a program so it behaves exactly as if a person had opened it;
  Bureau's fallback for tools with no structured mode. See section 25.
- **Supervisor** — the one thing allowed to manage a given employee's
  running process: tracks its state, records what it spent, and notices
  if it's gone silent too long. See section 27.
- **Heartbeat** — the supervisor's ongoing check that an employee is
  still genuinely alive, tuned separately per mode so real thinking is
  never mistaken for a hang; see section 27.
- **`generic-pty`** — the config-driven adapter for wiring up any other
  terminal-based AI tool with no code changes; the one place PTY mode is
  still the *default*, not a fallback. See section 28.
- **Take control** — a future feature letting a person type directly into
  a running employee's terminal session; not built yet. See sections 28
  and 29.
- **Worktree** — a separate, real folder on disk holding its own live
  copy of one branch, while still sharing the same underlying project
  history as every other worktree of the same repository; Bureau gives
  one to every employee. See section 40.
- **Branch** — git's name for one independent line of work within a
  project's history; a worktree is what makes a branch's files actually
  show up as real files on disk. See section 40.
- **Commit** — git's word for a permanent, saved point in a project's
  history; only Bureau's own Core process is ever allowed to make one.
  See section 41.
- **Lease** — the rule that only one employee may hold a given worktree
  at a time, enforced directly by the database itself; expires
  automatically, and safely, if its holder goes silent for too long. See
  section 42.
- **Integration branch** — the one shared line of history a phase's
  employees all feed their accepted work into, before it eventually
  becomes part of the main project. See section 49.
- **Merge** — combining two independent lines of work into one. Bureau
  computes this without ever opening a real folder to do it. See section
  49.
- **Conflict** — when two edits to the same part of a file can't be
  combined automatically; Bureau never guesses at a resolution, and asks
  a person instead. See section 50.
- **Checkpoint** — a real question Bureau raises for a person to answer,
  with honestly-described choices; not yet connected to anything visible
  in the app. See section 50.
- **Secret scan** — the one pre-commit check that can never be turned
  off for any project, looking for the unmistakable shape of a real
  leaked credential. See section 48.
- **Policy evaluator** — the code that decides allow, deny, or "ask a
  person first" for every single thing an employee's process tries to
  do. See section 55.
- **Immutable global deny** — one of the seven rules wired directly into
  Bureau's own code, which nothing (no role, no future rule pack, no
  setting) is ever allowed to loosen. See section 53.
- **Path canonicalisation** — resolving a Windows path down to the one
  real, consistent answer for what it actually points to, before ever
  comparing it against a rule — the fix for short-name aliases and
  folder shortcuts silently defeating a plain text comparison. See
  section 54.
- **Trust level (autonomy)** — how much an employee is currently allowed
  to do without asking first; three levels, the most permissive of which
  requires a real, separately-recorded confirmation before it actually
  takes effect. See section 56.
- **Loop detector** — catches an employee calling the same tool with the
  same arguments too many times in a row and forces the next one to be
  asked about instead of silently allowed again. See section 57.
