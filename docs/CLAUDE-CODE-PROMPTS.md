# Claude Code prompts for building Bureau

Everything you need to run the build, session by session. Copy the blocks verbatim.

---

## Before your first session — 5 minutes of setup

```powershell
mkdir E:\Bureau-dev
cd E:\Bureau-dev
git init
mkdir docs
# copy BUREAU-BUILD-SPEC.md into E:\Bureau-dev\docs\BUILD-SPEC.md
git add . && git commit -m "docs: add build specification"
claude
```

Two things that matter here:

- **Put the spec in the repo**, not in the chat. It is ~36,000 words. Pasting it into the conversation burns a large share of the context window before any work starts. In the repo, Claude Code reads only the sections it needs, when it needs them.
- **Commit it first.** Every later session starts from a known state, and you can diff what changed.

---

## Session 1 — M0 (Skeleton)

Paste this as your first message.

```
I'm building a Windows desktop app called Bureau. The complete specification is
at docs/BUILD-SPEC.md in this repo. Read it before doing anything else.

## What Bureau is

An Electron + TypeScript desktop app where one user chats with a "Director" AI
agent. The Director interviews them, writes a project brief, plans the work,
and assigns it to a team of AI "employee" agents — real terminal coding CLIs
supervised as child processes, each in its own git worktree. The team's state is
rendered as a pixel-art office floor. Everything runs locally; there is no server.

## This session: M0 only

Build Milestone M0 (Skeleton), specified in §28 of the spec. Supporting detail is
in §3 (stack), §4 (architecture and process boundaries), §18.1 and §18.1.1 (build
pipeline and the app:// protocol), and §18.3 (native modules).

Do NOT implement any other milestone. Do NOT stub future features. M0 is
deliberately small: it exists to prove the three things that otherwise break late
and expensively.

## Before you write any code

1. Read §0, §1, §2, §3, §4, §18 and the M0 block in §28 in full. Skim §5 and §21
   so you know what is coming.
2. Enter plan mode. Produce a file-by-file plan: every file you will create, what
   goes in it, and in what order.
3. Tell me anything in the spec that is ambiguous, wrong, or that you would do
   differently — with your reasoning. I would rather argue now than refactor later.
4. Wait for my approval before writing code.

## M0 is not done until all four of these are true

1. CI is green on GitHub Actions: install, lint, typecheck, test, and a packaged
   build.
2. The PACKAGED app — not dev mode — opens a window that loads through the custom
   `app://` protocol. Dev mode working proves nothing here; this is the failure
   that only appears after packaging.
3. Inside that packaged app, both `better-sqlite3` and `node-pty` load
   successfully, proven by an automated smoke test in CI rather than by eye.
4. Killing Bureau while a dummy child process is running leaves no surviving
   child process. This is the Job Object containment in §4.4 — verify it
   behaviourally, not by reading the code.

## My environment

Windows 11. Node LTS and git are installed. Assume nothing else is. If you need a
tool, stop and tell me what and why, and I will install it.

## How I want you to work

- TypeScript strict everywhere. No `any` outside .d.ts files.
- Small, focused commits with conventional commit messages.
- Where the spec and your instinct disagree, follow the spec and record the
  disagreement in PROGRESS.md. Do not silently deviate.
- If something in the spec is wrong or impossible, STOP and tell me. Do not
  quietly work around it — the spec is the shared source of truth and a silent
  workaround makes it a lie.
- Verify third-party details against current documentation before using them:
  Electron APIs, electron-builder config, package names and versions. The spec
  says itself that anything quoted in it may have drifted.

## Ending the session

1. Create CLAUDE.md at the repo root using the content in §21 of the spec.
2. Create PROGRESS.md with the first entry, in the format at the end of §28:
   what landed, what is stubbed, what surprised you, what is next.
3. Run the four gate checks and show me the actual output.
```

---

## Sessions 2 onward — the reusable template

Replace the two bracketed parts each time.

```
Continue building Bureau.

1. Read PROGRESS.md.
2. Read CLAUDE.md — the invariants there are not negotiable.
3. Read §28 of docs/BUILD-SPEC.md for milestone [Mx], and every section that
   milestone references.

This session: milestone [Mx] only.

Before coding: enter plan mode, give me a file-by-file plan, and flag anything
ambiguous or that you would do differently. Wait for approval.

Do not start work belonging to a later milestone, even if it seems small or
convenient. The build order in §28 is deliberate and §28.0 explains why.

Before you finish:
- Every gate item listed for [Mx] passes, demonstrated with real output.
- `npm run lint && npm run typecheck && npm test` are clean.
- Any documented interface you changed is updated in docs/BUILD-SPEC.md in the
  same commit.
- PROGRESS.md updated.
```

---

## Situational prompts

### When you want the spec challenged rather than followed

Use this at the start of a milestone you are unsure about.

```
Before implementing [Mx], review its section of docs/BUILD-SPEC.md adversarially.

Find: anything unimplementable as written, anything that contradicts another
section, anything that depends on something not built yet, and anything where
a materially simpler approach exists.

Report findings only — do not fix anything or write code yet. If the section is
sound, say so briefly rather than inventing problems.
```

### When something is failing and you are going in circles

```
Stop implementing. Diagnose only.

What I expect: [expected]
What actually happens: [actual]
What we have already tried: [attempts]

Work out the actual root cause before proposing any fix. If you are not
confident, say so and tell me what evidence would settle it. Do not try
another speculative change.
```

### At the end of each phase (after M2, M6, M11, M15)

```
We have finished [phase]. Before moving on, audit what we actually built
against docs/BUILD-SPEC.md.

Report: which specified behaviours are implemented, which are partially
implemented, which are stubbed, and which are missing entirely. Include
anything that drifted from the spec without the spec being updated.

Be blunt. An honest gap list now is worth far more than an optimistic one.
```

### When you want to change direction

```
I want to change [thing] from [old] to [new] because [reason].

Before implementing: tell me everything in docs/BUILD-SPEC.md this affects,
what it costs to change now versus later, and whether you think it is a good
idea. Then update the spec and the code together in one commit.
```

---

## Things worth knowing while you run this

**One milestone per session, one session per branch.** Merge when the gate passes. Resist "while I'm in here" — it is how a 35-session plan becomes 60.

**Read every diff in `core/policy`, `core/secrets`, `core/sandbox` and the git logic yourself.** Plausible-but-wrong security code is the failure mode that a passing test suite will not catch for you.

**Write the test first for anything security-relevant.** The spec asks for this specifically, and it is the difference between a test that proves a side effect did not happen and one that only proves a log line was written.

**Do not let it build the office floor early.** It is the most rewarding-looking work and the least load-bearing. §28.0 explains the ordering; hold the line.

**Use it on something real after M11.** That is the first point where Bureau is a product rather than plumbing. A week of your own use will find things no specification predicts.

**Keep PROGRESS.md honest.** "Stubbed" and "surprised me" are the two fields that make the next session productive. Skipping them is the single most common reason agent-built projects stall around week three.
