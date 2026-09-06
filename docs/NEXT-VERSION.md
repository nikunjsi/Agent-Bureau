# What v1 leaves out — the next-version backlog

**Snapshot: 2026-09-06.** M0–M6 closed and audited; M7 session 1 in progress.

This file is **not** the v1 build plan — that is `docs/BUILD-SPEC.md` §28, and
its live status is `PROJECT-CHECKLIST.md`. This is the other list: everything v1
deliberately defers, honestly accepts, or accidentally left behind, gathered in
one place so the next version starts from a real inventory rather than memory.

Three kinds of thing are in here and they should not be confused:

- **Deferred** — a decision was made to do it later. Scheduled or not, it is
  wanted.
- **Accepted** — v1 ships without it on purpose, and says so. Revisiting is a
  product decision, not a bug fix.
- **Debt** — something incomplete that nobody decided to leave incomplete. This
  is the section that should shrink, not grow.

---

## A. Already scheduled — the spec's own staged content

### A.1 Nine more roles across three packs

v1 ships **12 roles** (§6.6): engineering's five, research-writing's four,
operations' three. The staged remainder:

| Pack | Roles | Target | Why staged |
|---|---|---|---|
| **data** | Data Engineer, Analyst, ML Engineer | v1.1 | Natural second pack |
| **marketing** | Strategist, Copywriter, SEO, Social | v1.1 | Needs web access patterns and brand-voice memory |
| **design** | UX Designer, Visual Designer | v1.2 | Needs image tooling — deliberately last |

That is **21 roles total** at v1.2. The architecture claim is that all nine are
authorable in YAML with **zero engine changes** — and M14's gate is the moment
that claim gets tested, by authoring the research-writing and operations packs
without touching code. If code has to change at M14, this table's dates are
wrong and the abstraction needs fixing first.

Note the dependency: **design cannot ship until modalities exist** (§B.1). Its
"needs image tooling" line is the whole blocker.

### A.2 Voice

§29 item 4. Push-to-talk dictation plus a realtime voice mode. Recommended v1.2,
*after* the text conversation is excellent. Adds a provider dependency and
another key. Raised again by the product owner on 2026-08-21 and still deferred.

### A.3 Smaller scheduled items

- `.bureau` project file associations — §18, optional, v1.1.
- The spend-tracking board prop on the office floor (parking lot, 2026-08-21) —
  M12 for the prop, M14 for the Costs view. Its data already exists from M1.

---

## B. Capability gaps — what a user would expect and not find

### B.1 Modalities and multi-engine — the largest single gap

**Bureau never calls a model.** It runs *agent CLIs* as supervised child
processes. So "use the right model for the job" is an **engine** decision, and
every engine needs an adapter that passes §7.8's contract suite.

Today:

- **One engine has a real adapter**: `claude-code`. §7.12 records every other
  candidate as explicitly **NOT EVALUATED**, and §24.1's configuration table
  labels every row "a hypothesis, not a verified configuration."
- **Three models**, chosen by abstract tier: `fast` → Haiku 4.5,
  `balanced` → Sonnet 5, `capable` → Opus 5.
- **No image, video or audio anywhere.** Not a gap in the implementation — the
  concept does not exist in 3,900 lines of specification.

What a modality axis would need:

1. **An adapter per engine.** The easy half — the interface and its contract
   suite already exist for exactly this.
2. **A capability declaration on roles.** The missing half. A role declares what
   it *produces* (`deliverable_types`) and, from M7, what it *consumes*
   (`input_types`) — but nothing declares what it **requires of its engine**.
   Without that the Director has no basis for matching work to a capable engine.
3. **The engine side belongs on `EngineCapabilities`** — a TypeScript interface,
   already extended once in M6 session 1. No migration.

Deliberately **not** added during M7 because there is exactly one engine, so
nothing could match against it and no test could exercise it — the same test M7
itself used to justify `input_types` ("fully exercised the day it lands") rules
this out. The real prerequisite is a **second adapter**, not a column. See
§29 item 6 and the 2026-09-06 parking-lot row.

### B.2 Reference material, format-agnostic

Documents a team reads but never edits — a syllabus, a marking scheme, a brand
guide, a contract, a spec PDF. Reads inside `${project}` are already permitted
and proven (S2), so the *mechanism* works. What is missing is the *concept*: no
way to mark a file as read-only input, no guarantee it reaches every employee's
context, and no statement of which formats are supported.

M7 adds `roles.input_types`. Still outstanding for the next version:

- **Getting files in.** §14.2's composer "attach" is a *path reference*, not an
  upload. M9 builds the composer; nothing builds ingestion.
- **The folder scanner is code-shaped.** §15.2 detects `package.json`,
  `pyproject.toml`, `go.mod` and friends, and explicitly **skips binaries** — so
  a folder of PDFs or scans reports nothing useful. M13.
- **Honest format reporting.** Where an engine genuinely cannot read a format,
  Bureau must say so rather than behaving as though the file was read (§1.5).

M14's gate — "a research-only project runs end to end" — leans on this.

### B.3 PR integration

Not in v1, stated plainly (§10.6). `git.pr_opened` was removed from the event
taxonomy rather than left as a promise. Needs auth, an API client and UI for
GitHub/GitLab before it goes back.

### B.4 Team and cloud features

§29 item 5. Deliberately out of scope. Adding them means a server, accounts, and
a security model an order of magnitude larger than the local-only one v1 is
built around. This is the single largest architectural fork available.

### B.5 Semantic memory search

§12.1 Layer 3. Specified, off by default, behind a setting, using a local
embedding model so nothing leaves the machine. Everything works without it —
FTS5 is Layer 2 and is the real one. A quality upgrade, not a missing feature.

### B.6 `claude-code` in PTY mode, and "take control"

`claude-code` is structured-only (§7.7.1). PTY mode is rejected at role-load.
The stated trigger to revisit is **"take control" (§14.5) shipping** — an
interactive session a human can type into is the one real use for
claude-code-in-a-pty. Explicitly a later permission.

---

## C. Accepted limitations — shipped honestly, revisit as product decisions

These are not bugs and not debt. Each is documented in the product, and the
honesty around them is itself a v1 feature. Reopening any is a deliberate scope
decision.

| # | Limitation | v1's position |
|---|---|---|
| 26 | Prompt injection from repo or fetched content | **Contained** via permissions, not prevented. A hijacked agent still cannot exceed its grant. |
| 27 | Shell commands can reach the network regardless of tool policy | No egress control. Bureau gates *named network tools*; `Bash(curl *)` is beyond it. An OS capability an Electron app does not have. |
| 28 | Model API keys are long-lived and unscopeable | Blast radius limited, not eliminated. No provider offers scoped or short-lived keys. Recommendation is a separate low-limit key. |
| 29 | A machine administrator can do anything | Out of scope, as for any desktop app. |
| 30 | Model quality is not under our control | Addressed by process — acceptance criteria, validators, review — not by magic. |
| 31 | Agents produce plausible, subtly wrong output | Reduced, not eliminated. The user is the final reviewer and the UI is built to make that easy rather than to replace it. |

### C.1 The one downgraded invariant

**Employees cannot be *prevented* from committing — only stopped by policy and
caught afterwards.** §10.3.1's layer 1 (a Windows restricted token denying write
access to `.git`) was genuinely attempted in M5 part 2 and failed for a real
reason: a process spawned under a `RESTRICTED`-SID token fails its own
initialisation before it can run anything. Isolated with a control test, not
assumed.

The invariant was **rewritten downward** in `CLAUDE.md` and §21 to what the
mechanism supports: *"employees are prevented from committing by policy, and any
unexpected commit is detected and flagged."* Layer 4 (commit-time HEAD
reconciliation) ships and is S6-tested. Layers 2–3 await M7's roles.

Making layer 1 real needs either a weaker restriction that does not achieve
directory-level write denial, or extensive supporting ACL configuration across
system paths. Both are real, separate engineering.

### C.2 Budget granularity

Usage arrives only at turn boundaries, so a single expensive turn can overshoot.
Enforcement is **"no new turn starts once the limit is passed"** — not a hard
cap, and the UI says so. A true hard cap needs mid-turn usage reporting no
engine currently provides.

### C.3 Engines that do not report usage

`generic-pty` employees, and `claude-code` in PTY mode, cannot have cost computed
at all. They get wall-clock and turn-count limits only, and every surface must
read **"cost not reported by this engine"** — never `$0.00`.

---

## D. Debt — incomplete, and nobody decided it should be

This is the section to shrink.

### D.1 Six stubs inside closed milestones

Found by the M3–M6 audit (finding #22). Both milestones were declared "✅ Done"
with their own `stub()` markers still in place, and neither living-status doc
mentioned it:

| Stub | Tagged | File |
|---|---|---|
| `tasks.cancel`, `tasks.retry`, `tasks.reassign` | `M3` | `src/main/ipc/handlers/tasks.ts:26-28` |
| `workspace.diffForTask`, `diffForEmployee`, `fileTree` | `M5` | `src/main/ipc/handlers/workspace.ts:5-7` |

M4 and M6 have zero. **Process fix, cheap and permanent:** add a
`grep stub('M<n>')` check to every milestone close-out, so a milestone cannot
close while its own name is still in a stub marker.

### D.2 §10.6 rules 5 and 6

The phase→base merge on phase acceptance, and push-to-remote as an approval
checkpoint. Deliberately deferred in the audit fix session on sound reasoning —
their triggers are M8/M11 events that do not exist, so building them means
shipping code with no caller. Now explicitly tracked rather than silent.

### D.3 Eleven open MINOR audit findings

From `docs/AUDIT-M3-M6.md`, all deliberately untouched by the fix session, which
handled BLOCKER and SERIOUS only. The ones with real substance:

- **#20** Lease exclusivity is defended by a **white-box SQL-string spy only**.
  A change that kept the literal `BEGIN IMMEDIATE` string but lost exclusivity
  would pass. Needs a real multi-process contention test.
- **#23** Checkpoints created by the budget and breaker paths do not emit a
  `checkpoint.raised`-shaped event. A consumer filtering on it would miss them.
- **#25** Seven event types are emitted that §5.2 does not document; two
  documented types are unreachable. `EventTypeSchema` is `z.string().min(1)`, so
  taxonomy drift is silent. Narrowing it to a closed enum would fix the class.
- **#26** `usage.computed_cost_usd_micros` is written on every insert and read
  nowhere — the comparison it exists for was never built.
- **#28** `review.trivialTaskMaxChangedLines` (§16.1) is missing from the schema
  and registry, so `review.autoAcceptTrivialTasks` has no threshold.
- **#27, #29, #30** Spec and comment accuracy, plus an eslint `ignores` pattern
  that lints subagent worktrees.

**#21** (immutable-priority guard) is being closed during M7 session 1 — worth
recording *why*: it was ranked MINOR because the mutation was assessed
"genuinely inert," which was correct **when written**. Packs supplying their own
priorities is what made it live. See §G.3.

---

## E. Test and tooling debt

### E.1 No coverage tooling exists

Audit #24. No `@vitest/coverage-v8` or istanbul in any of the three configs.
"Which branches of the evaluator, commit path, redactor or breaker are never
hit" cannot be answered with data — only by reading code. Given the audit found
three tests that did not reach their production path at all, this is not
academic. **The highest-value item in this section.**

### E.2 Opt-in tests rot

`realEngineSpawn.test.ts` threw a live `TypeError` from M4 until the audit found
it, because it sits behind real spend and nobody re-ran it. Fixed, but the
*class* is unaddressed: a test nobody runs is not coverage. Needs a schedule, a
CI lane, or an explicitly tracked risk row.

### E.3 The soak's budget is now measured, and M15 inherits it

`soak.test.ts` timed out in three consecutive sessions and was attributed to
environment each time by inspection. Profiled in the audit fix session: it
completes in **348,776 ms** and passes inside the old 480 s limit. It was never
inherently slow — the three timeouts were a ~27% margin eaten by concurrent
load. Raised to 900 s on the measurement. **M15 inherits this exact test as its
100-task soak gate**, so the calibration matters beyond M5.

### E.4 Environmental preconditions that silently invalidate results

Two now have loud gates (audit fix #7/#14) after each bit repeatedly:
`ELECTRON_RUN_AS_NODE` contamination, and running integration evidence against a
**stale packaged app** (found 28 source files behind). The pattern is worth
remembering: any precondition that can silently invalidate a result should fail
loudly, not depend on a careful session noticing.

---

## F. Open product-owner decisions

From §29, none of which block the build but all of which shape the product:

1. **Monetisation** — free/OSS, paid, or free core with paid packs. Affects the
   licence choice and whether commissioned art needs redistribution rights.
2. **Distribution name** — verify name, domain and GitHub org availability
   before M15. Do not build brand assets first.
3. **Telemetry** — default is none, and stays none until decided otherwise.
   If added: opt-in only, with an exact list of what is sent.
4. **Voice** — see §A.2.
5. **Team and cloud** — see §B.4.
6. **Modalities and multi-engine** — see §B.1. Added 2026-09-06.

Business and legal items still open (§27.5): an engine's terms possibly
prohibiting orchestrated use (must be read before listing an engine as
supported), a copyleft dependency contaminating the licence (M15 CI check), and
user-facing copy about who is responsible for agent output (M9).

---

## G. Process improvements the build itself surfaced

Not product features — how the next version should be built.

### G.1 The standing test rule

The M3–M6 audit's central finding: four mutations survived the entire suite, all
for one reason — **a load-bearing test whose assertion path touches a stand-in
rather than the code that ships**, with a doc comment asserting a fidelity that
was not there. A `FakeAdapter` for two real adapters, a fixture reimplementing
an ordering, a test-side call standing in for a production path.

The rule that came out of it, now in `PROJECT-CHECKLIST.md`:

> A test may not re-implement the ordering, wiring, or call it exists to verify.
> If it cannot reach the production path, say so in the test **name**, not in a
> comment that reads like proof.

A sweep found no further instances — the class is bounded at four — but it is a
review question, not a solved problem, until §E.1 makes it measurable.

### G.2 Ordering assertions need a presence assertion first

`indexOf(a) < indexOf(b)` passes when `a` is absent, because `-1` is less than
any real index. The audit fix session reproduced the audit's own central mistake
this way and caught it **only by running the mutation** rather than trusting a
green run.

### G.3 MINOR findings can be inert by circumstance, not by nature

Audit #21 was ranked MINOR because the mutation was "genuinely inert" — correct
when written, and untrue the moment packs began supplying their own priorities.

**Proposed practice:** at every milestone close-out, re-read the open MINORs
with one question — *is this inert by nature, or inert by circumstance, and does
any milestone between here and M15 change that circumstance?* Anything in the
second category gets its triggering milestone named beside it, so it surfaces
then instead of being rediscovered by the next audit.

### G.4 Milestone close-out checklist additions

Each earned by something that actually went wrong:

- `grep stub('M<n>')` — a milestone may not close with its own name in a stub
  (§D.1).
- Confirm the packaged-app staleness gate **fires**, rather than assuming it
  (§E.4).
- Sweep `PROJECT-CHECKLIST.md`, not only `PROGRESS.md` — M5's close-out updated
  the risk rows and left the milestone row contradicting them, and M6 session 2
  did the same.
- Every new security test states whether its assertion path touches production
  code (§G.1).

---

## How to use this file

Add to it whenever something is deferred, accepted or discovered incomplete —
with the reason, not just the item. A deferral without its reasoning becomes a
mystery in three months, and the reasoning is usually the part that decides
whether it is still the right call.

Review it at every phase boundary alongside `docs/AUDIT-PROMPT.md`. The audit
asks "is what we built correct?" — this file asks "is what we left out still the
right thing to leave out?"
