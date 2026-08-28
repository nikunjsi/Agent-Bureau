# Phase-boundary audit prompt

Run this at every phase boundary — after M2, M6, M11, and M15 — and any time you suspect a milestone was declared done optimistically.

**The principle:** an agent auditing its own work re-asserts what it believed while building. This prompt breaks that with three mechanisms — **independence** (a subagent with no memory of the build), **evidence over assertion** (commands and output, not claims), and **mutation checks** (break the code deliberately; if no test fails, the test was theatre).

**Always run the audit and the fixes as two separate sessions.** An agent that fixes as it goes never shows you the complete list, and you lose the ability to judge how healthy the codebase actually is.

---

## The audit prompt

Replace the bracketed parts. The mutation list in Phase 3 must be rewritten for each phase — it is the part that carries the value, and generic mutations catch nothing.

```
Do not write any implementation code this session. This is an audit.

[Mx] through [My] are complete. Before we build [Mz] on top of them, I want to
know what is actually true about this codebase versus what we believe is true.

Assume the implementation is wrong until evidence shows otherwise. A passing
test is not evidence — a test only counts if you have confirmed it FAILS when
the behaviour it claims to cover is broken.

Work in five phases. Report at the end. Do not fix anything as you go, even
something small and obvious — I want the complete list first.

═══ PHASE 1 — Two-directional trace ═══

Spec → code: go through [list the spec sections these milestones implement].
For EVERY requirement, state: implemented / partially implemented / stubbed /
missing, with the file and line that proves it.

Where the spec contains an enumerable list — a schema, a settings registry, an
event taxonomy, an IPC surface, a tool inventory — extract both sides with a
script and diff them. Do not eyeball a long list; that is exactly where items
go missing.

Code → spec: list anything implemented that the spec does not describe, or that
contradicts it. Undocumented behaviour is a finding, not a bonus.

═══ PHASE 2 — Evidence for every gate claim ═══

PROGRESS.md asserts that the gate items for these milestones pass. For each,
produce the actual command and its actual output, run now, not remembered.

For each gate test, also ask: could this test pass while the real behaviour is
broken? A test that checks a file exists rather than that a packaged app runs,
or that a function was called rather than that its effect landed, is not a gate.

═══ PHASE 3 — Adversarial: try to break it ═══

This is the important phase. For each item below, deliberately introduce the
break, run the test suite, record whether it caught it, then revert.

[List 6-10 specific mutations, each corresponding to a guarantee the spec makes.
Target invariants, ordering, and enforcement — not arithmetic. Good candidates:
remove a per-connection pragma; invert a write ordering the spec requires;
weaken an identity check to a weaker one; delete a trigger; skip a cleanup step
in a recovery path; bypass a policy check; violate a single-writer or
single-committer rule; return the wrong type where a guard is assumed.]

Report each as CAUGHT or NOT CAUGHT. Every NOT CAUGHT is a missing test, and I
want it listed as such.

═══ PHASE 4 — Interrogate the most important test ═══

[Name the single test these milestones lean on hardest.] Open it and tell me
honestly:
- Does it exercise genuinely different states, or the same one repeatedly?
- Does it test the real mechanism, or a simulation of it? (Killing a process
  versus throwing an exception in-process; a packaged app versus a dev build;
  a real child process versus a mock.)
- Does it verify state after a genuine fresh start, or reuse in-memory state
  that the failure it simulates would have destroyed?
- What cases does it not cover? List the gaps.

═══ PHASE 5 — Hygiene sweep ═══

- Every `.skip`, `.only`, `.todo`, or commented-out test.
- Every TODO, FIXME, HACK, XXX comment.
- Every `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`.
- Every empty catch block or swallowed error.
- Every function returning a hardcoded value where real logic was intended.
- Coverage per module, and which branches of the critical paths are never hit.
- Does PROGRESS.md accurately describe what is stubbed? Anything it claims is
  done but is not?

═══ HOW TO REPORT ═══

Use a subagent for Phases 1 and 3 — one that has not seen our build
conversation and is reading only the spec and the code. Independent eyes catch
what the author's eyes skip. Tell me which findings came from the subagent.

Then give me a single table, most severe first:

  # | Severity | Area | Finding | Evidence | Suggested fix | Effort

Severity: BLOCKER (the next milestone would be built on something broken) /
SERIOUS (real gap, fix before it compounds) / MINOR (tidy up when convenient).

End with two explicit statements:
1. "Things I believe are correct but could not prove:" — list them.
2. "Things I would do differently if starting these milestones again:" — be blunt.

If everything is genuinely sound, say so plainly and briefly. Do not manufacture
findings to look thorough. But do not tell me it is clean because checking
properly is tedious — the mutation phase is not optional.
```

---

## The fix prompt — a separate session

```
Work through the audit findings. BLOCKER and SERIOUS only for now.

For each: write the failing test FIRST, confirm it fails for the right reason,
then fix, then confirm it passes. Commit each fix separately, referencing the
finding number.

Do not fix MINOR items yet, and do not refactor anything the audit did not
flag. Report anything you disagree with rather than fixing it silently.
```

---

## Writing good mutations

The mutation list is the part that has to be authored fresh each time. A useful mutation has three properties:

1. **It corresponds to a promise the spec makes.** If the spec says "fail closed", mutate the failure path to fail open. If it says "single committer", add a second one.
2. **It would survive code review.** Mutations that look obviously wrong prove nothing — a reviewer would have caught them. The valuable ones look like reasonable refactors.
3. **Its absence is silent.** Prefer things that produce no error, just wrong behaviour, until the day they matter.

Mutations by phase, as a starting point:

| Phase | Guarantees worth attacking |
|---|---|
| **M0–M2** | Per-connection pragmas, write-ordering for durability, migration checksums, PID-reuse identity checks, FTS trigger completeness, single-writer enforcement, IPC schema validation, renderer isolation |
| **M3–M6** | Fail-closed policy on transport failure, path canonicalisation before comparison, immutable deny rules being genuinely un-overridable, worktree lease exclusivity, secret redaction on every output path, budget enforcement points, turn-boundary queueing |
| **M7–M11** | Director tool argument validation, plan validation rejecting cycles and empty acceptance criteria, checkpoint timeout resolving safe, memory write gating, assignment determinism, completion evaluation actually reading criteria |
| **M12–M15** | Visual state derivation totality, one-shot fallbacks when no provider is configured, packaged-app asset resolution, update artifact signing |

---

## A note on frequency

Every phase boundary is right. More often than that and the audits start finding nothing, which trains you to skim them — which defeats the point. Less often and you get compounding drift, where a wrong assumption at M4 has three milestones built on it before anyone looks.

The exception: audit immediately, out of schedule, if a milestone went suspiciously smoothly. Foundational work that produces no surprises usually means something was skipped rather than that it went well.
