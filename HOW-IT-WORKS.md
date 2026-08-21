# How it works — a plain-English guide to the code

`PROGRESS.md` is a changelog for future coding sessions. This file is for
you: a walkthrough of what actually exists right now, why it's shaped the
way it is, and where to look when you want to change something. No prior
Electron knowledge assumed — every term gets explained the first time it
shows up, and there's a glossary at the bottom for when you forget.

This describes **Milestones M0 and M1** — Part One below is M0 (the skeleton:
the app opens, packages, and launches safely). Part Two is M1 (the data
layer: everything the app remembers, and how it survives being killed at
any moment without losing anything). Neither does anything you'd actually
*use* yet — no chat, no AI, no office view. What they prove is more boring
and more important: the foundation underneath all of that won't crack once
real weight is put on it.

**Status: done.** Everything described in this file is built, tested, and
green on GitHub Actions (`main` branch, `windows-latest`) — not just "works
on this one laptop." You can run the real, built app yourself right now;
see the box near the end of this file for how.

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
- **`reconcile()`** — the startup cleanup routine described in section 12.
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
