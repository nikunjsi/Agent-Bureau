---
name: bureau-fix-session
description: Work a Bureau closed-list plan file (e.g. docs/PRE-M11-PLAN.md) row by row — failing test first, one commit per row, status recorded in the plan, anything new logged to §F instead of fixed. Use when asked to run a fix session, continue a plan, or "follow the plan".
argument-hint: "[plan file] [notes for this session]"
---

# Bureau fix session

You are working a **closed list**. The plan file is the whole job. The rules
below never change between sessions; everything that does change lives in the
plan file or in this session's notes.

## This session's inputs

Arguments: `$ARGUMENTS`

- If the first argument ends in `.md`, that is the plan file.
- Otherwise, use the plan in `docs/` whose `**Status:**` line says OPEN. If
  there is none, or more than one, **stop and ask** which plan to work.
- Anything else in the arguments is **this session's notes** (e.g. "start
  with §D", "skip X-19, waiting on Nikunj"). Follow them. If a note conflicts
  with the plan's own rules, the plan's rules win: say so and continue.

## Before you touch anything

1. Read the whole plan file, especially its rules, its decisions section and
   its exit criterion. The plan's own text overrides anything generic here.
2. Read `CLAUDE.md` (the invariants) and the Known Issues section of
   `PROJECT-CHECKLIST.md`.
3. Find the **first row whose Status is OPEN**, in the order the plan states
   (otherwise in document order). Skip anything a previous session resolved.

## The rules — the same every session

- **Work the list and nothing else.** Do not look for new issues. Do not run
  an audit, a trace or a sweep.
- **Something new turns up?** Add one line to the plan's "Found while fixing"
  section (§F) with a proposed owner milestone, and keep going. Fix it now
  **only if** it would break the next milestone **and** it lives in a file
  you are already changing for a listed row.
- **Don't widen a fix beyond its row's "Done when".** A fix that grows is a
  new §F line.
- **Method per row:** write a failing test first and confirm it fails **for
  the right reason**. Then fix, and confirm it passes.
- **Standing rule 9:** before trusting a green run, show that the mutation
  actually changed behaviour (print the value, return or branch taken). A
  mutation that changes nothing proves nothing.
- **Documentation rows:** check the claim against the code before changing
  the prose.
- **One commit per row.** In the same commit, set the row's Status to
  `DONE <commit>`, `DECLINED: reason` or `MOVED: owner, reason`. A commit
  can't contain its own hash, so a `DONE` hash may be recorded in the next
  commit. If the row came from an audit report, fill that report's Outcome
  cell too (standing rule 8).
- **Decisions:** follow a filled Decision cell. Never decide a cell the plan
  reserves for Nikunj. If a row depends on one that is still empty, log it
  in §F and continue.

## Running tests

- **One suite at a time.** Two suites at once corrupt each other.
- **Never edit `src/` while a packaged-app suite is running.** The staleness
  gate will invalidate the run.
- Run `npm run package` before integration, and confirm the staleness gate
  fired by name.
- When reporting `test:security`, report **both** of its runs separately.

## Stopping partway

If you are running low on room, stop at a **row boundary** and commit. Then
report:

- rows resolved this session (ID → status)
- rows added to §F
- the next OPEN row

The next session runs this same skill and continues from there.

## Closing the plan

When every row the exit criterion names is resolved, run the plan's final
sweep and its coverage check exactly as written, and fill in its results
table with evidence. If a check fails, resolve that row and re-run only that
check. When everything passes, set the plan's status to CLOSED, update
`PROJECT-CHECKLIST.md` and `PROGRESS.md` as the plan says, and state plainly
that the plan is closed.

## Always

- Stage files **by name**. Never `git add -A` or `git add .`.
- In `docs/artifacts/`, only `REGENERATION.md` and `README.md` are tracked; the generated HTML pages and `coverage/` are ignored. Append to `REGENERATION.md`'s pending list, never regenerate pages, unless the plan says so.
- **Do not push.** Pushing is Nikunj's call.
