# What v1 leaves out — the next-version backlog

**Snapshot: 2026-09-07.** M0–M7 closed; M3–M6 audited; the M7→M4 boundary checked and its finding fixed. M8 (checkpoints) is next.

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

### B.6 An optional prompt composer for the Director

Raised by the product owner, 2026-09-07: a tool where you describe a task in
your own words and get back a structured message to paste into the Director
chat — on the reasoning that a better prompt gets a better result.

**Rejected for v1 as a requirement, kept for a later version as an option.** The
distinction is the whole entry, because the two framings are not the same idea:

- **As something you need in order to use Bureau, it contradicts invariant #1** —
  "the conversation is the product; a user who only uses the chat must be able to
  complete a project." If Bureau needs a composer in front of it, the Director's
  intake is broken, and the fix is Appendix A's system prompt and M11's intake
  design, not a tool outside the product. A composer also cannot see the brief,
  the memory, the workspace or the plan — which is precisely what lets the
  Director ask a *specific* question rather than a generic one.
- **As an optional path for a user who already knows exactly what they want, it
  breaks nothing.** The chat alone still completes a project; this is an extra
  door for people who prefer to be precise up front, the same way a power user
  might prefer a form to an interview. That version does not touch invariant #1.

**Do not build it before M11's real-use gate.** §28's M11 block says to use
Bureau on something real before moving on, and risks #7 and #8 ("Director asks
too many questions" / "too few, builds the wrong thing") are already tracked
against that milestone. Running that gate is the experiment that says whether
this is wanted — building the workaround first pre-empts the test and risks
fixing a problem the Director does not have.

Two cheaper things sit between here and there, and may remove the need entirely:
**M9's composer placeholder text** (agreed 2026-09-07 — a hint about what a good
first message looks like, a UI affordance rather than a tool), and the fact that
the highest-leverage prompt work in the product is **internal**: Appendix A's
Director system prompt decides whether the interview is good, and Appendix B's
employee prompt template is generated for every single task an employee ever
receives.

### B.7 `claude-code` in PTY mode, and "take control"

`claude-code` is structured-only (§7.7.1). PTY mode is rejected at role-load.
The stated trigger to revisit is **"take control" (§14.5) shipping** — an
interactive session a human can type into is the one real use for
claude-code-in-a-pty. Explicitly a later permission.

### B.8 Non-Anthropic employees — the cost, recorded so it is not mistaken for configuration

**Product owner's decision, 2026-09-07: v1 uses the three Anthropic tiers
only.** Recorded here with its real cost, because `generic-pty` makes this
look like a configuration change and it is not.

`GenericPtyAdapter` is real, works, and can drive any terminal-based CLI.
Its capabilities are what matter:

| Capability | `generic-pty` | Consequence |
|---|---|---|
| `mcpServers` | `false` | **No `bureau_*` tools at all.** The employee cannot report status, cannot ask the Director, cannot signal `bureau_task_done`. |
| `hookInterception` | `false` | Bureau cannot gate its tool calls. |
| `permissionCallback` | `false` | Nor via the other mechanism. |
| `usageReporting` | `false` (permanently) | Its cost cannot be computed at all. |

So an employee on `generic-pty` **runs and produces work, unsupervised and
unmeterable**. It cannot tell you it is finished, you cannot stop it doing
something you would have denied, and you cannot see what it cost. That is a
different product promise from the one §1 makes, not a degraded version of
the same one.

This is why §24.1 labels every non-`claude-code` configuration "a
hypothesis, not a verified configuration", and why §7.12 records every
other candidate as NOT EVALUATED. **A real second engine means a real
adapter passing §7.8's contract suite** — the work is the adapter, not a
setting.

What a second engine would need, in dependency order:
1. An adapter implementing `EngineAdapter` with genuine `mcpServers` and
   either `hookInterception` or `permissionCallback`. Without the first
   there is no control channel; without one of the second two there is no
   §11.3 enforcement.
2. `usageReporting`, or an honest `metered`/"cost not reported" story
   (§24.5 and §11.5.1 already have the machinery; the adapter has to be
   truthful about which case it is in).
3. Its own row in `settings.engines.modelTiers`, since tiers are per-engine
   — the cheap part, and the part that looks like the whole job.
4. §7.8's contract suite passing against it, which is the actual gate.

Related: §B.1's modality axis needs this first. A role cannot usefully
declare "this work needs image generation" while there is one engine to
match against.


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

**Its sibling, from M7 session 1, and the sharper of the two:**

> **A guard is not a guard until something on the real path calls it.**

A passing unit test tells you a guard works *if invoked*. It tells you nothing
about whether anything invokes it. M7 session 1 added a tier floor to
`validateRuleSet`, wrote a test, watched it pass — and the mutation it existed
to catch survived the whole suite, because the pack install path went
`roleRulesFrom → assertNoImmutableWidening` and never touched `validateRuleSet`
at all. A lock on a door nobody walks through.

This is the more dangerous of the pair, because §G.1's failure mode leaves a
test that *looks* wrong on close reading, while this one leaves a test that is
genuinely correct about a function that is genuinely correct — and the gap is
between them, where nothing is written down. **The only thing that finds it is
reintroducing the mutation and watching what happens**, which is why that step
is mandatory rather than a nicety.

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

### G.5 A cache keyed by the obviously-right thing can still be wrong

M7 session 2's `ProbeCache` keyed by `adapter.key`, on reasoning that reads as
airtight: installed version, binary path and auth status are properties of the
**machine**, not of the employee asking, so every `claude-code` adapter learns
the same thing.

It is wrong, and the adapter's own source says why: `claudeCodeAdapter.probe()`
honours `CLAUDE_CONFIG_DIR` — that is exactly how its own "unauthenticated" test
points a probe at a fresh identity. Two adapters with the same key genuinely
have different answers, and a string key hands one adapter's result to another.

The symptom was five unrelated suites failing impossibly. The fix was keying by
adapter **identity** (a `WeakMap`), which still collapses N hires to one probe
and cannot leak. **The tell that it was the right fix: no test needed changing
to accommodate it.**

Generalisable: a process-global cache keyed by a *name* is shared mutable state
between callers that never agreed to share. Prefer identity.

---

## H. M7's own deferrals, with their reasoning

Gathered here rather than left in commit messages, because a deferral without
its reasoning becomes a mystery in three months.

### H.1 The one-shot client has no caller, deliberately

§28 places `src/main/ai/oneshot.ts` in M7 because M8's checkpoint duplicate
confirmation and M11's intent classification both need it, and it appears in no
other milestone. Nothing invokes it today.

The audit fix session **refused** §10.6 rules 5/6 on exactly these grounds, so
the difference has to be argued rather than asserted:

- Rules 5/6 would have been **behaviour** whose triggers did not exist —
  unreachable code paths that rot silently, which is how `realEngineSpawn.test.ts`
  broke for a whole milestone without anyone noticing.
- This is a **library with a defined interface** and no trigger to invent.

That distinction is real but **not sufficient on its own**, because it is what
unexercised code always sounds like. So the part that makes it verifiable: its
tests drive the **real HTTP path against a real loopback `http.createServer`** —
real request, real headers, real timeout, real retry, real usage row — rather
than a mocked `fetch`. The principle worth carrying: *unexercised code rots;
exercised code does not, caller or no caller.*

If M8 arrives and does not use it, that is the moment to delete it rather than
carry it further.

### H.2 The name pool is finite and refuses rather than suffixes

§6.8 requires a bundled, culturally varied name list with no two employees
sharing a first name, and archived employees keep their names (which is what
makes a rehire unambiguous). The pool is therefore exhaustible — 56 names, and
enough hire/fire cycles will empty it.

v1 **refuses to hire** and names the escape hatch (supply a name explicitly)
rather than generating "Ravi 2". The reasoning is product, not technical:
auto-suffixing is exactly what makes software feel like a database, and §6.8's
whole premise is that these read as colleagues.

For a later version, in preference order:
1. A larger pool. Cheapest, and 56 was chosen for authorability, not as a limit.
2. Surnames, making the uniqueness rule a full-name rule. Changes §6.8's stated
   rule, so it is a spec decision rather than a content one.
3. Nothing — 56 concurrent-plus-archived employees is already an unusual
   company, and refusing loudly is a defensible permanent answer.

### H.3 §7.1's 5-second probe deadline is tight for a process spawn

§7.1 requires `probe()` to finish in under 5s, and a real probe took **5064ms**
under concurrent load — a process spawn plus a `--version` plus an auth check,
on a machine already busy.

M7 session 2 did **not** raise the deadline. Quietly relaxing a spec deadline to
fit an implementation is how a contract stops meaning anything, and the real
defect was N employees each spawning a process to learn the same machine-level
fact. Caching (single-flight, per adapter) removes the N.

What is left for a later version to decide: whether 5s is the right number *at
all* for a call that spawns a process on a loaded Windows machine, given that a
single cold probe can still approach it. That is a spec question about §7.1, not
a bug, and it should be answered with a measurement rather than a guess.

### H.4 What the layout generator leaves to M12

The generator produces complete, deterministic, persisted data. Everything
visual is M12's, and none of it is stubbed here:

- **Rendering.** No Phaser, no sprites, no tilemap — CLAUDE.md's "do not build
  the Floor before the Director works" is explicit.
- **The drag interaction.** `moveEmployeeToDesk` persists a placement and pins
  it; the drag that calls it is M12's.
- **Surfacing a dropped pin.** When a re-pack cannot honour a manual placement,
  `company.floor_rearranged` carries `droppedPins` naming the employee and both
  coordinates. Today that is a durable record, **not a notification** — nothing
  shows it to a person until M9 has somewhere to put it and M12 has a floor.
- **`deriveVisualState`.** §13.4's normative ordered function does not exist
  yet; `src/shared/floor/` holds only the layout shape and sprite vocabulary.
- **The real sprite check.** §6.7 check 7 warns against a known-key list and
  falls back to `generic`; resolving against a loaded texture atlas needs the
  atlas, which is M12's.
- **Prop anchors are naive.** Props sit at the room's inner corners, clockwise
  from top-left. Deterministic and adequate for data; M12 may want a real
  placement pass once rooms have visual weight.

### H.5 ~~The model an employee is hired on is not the model it runs on~~ — FIXED

**Resolved 2026-09-07**, in a short session between M7 and M8. Recorded
rather than deleted, because the shape it belongs to outlived it.

Chosen: **the employee's choice wins, stored as a TIER.** Migration 0008
adds `employees.model_tier_override`; hiring stores the choice;
`Supervisor.assign()` is the only place that resolves; `employees.model`
becomes a record of what launched, read by nothing.

Neither of the two options this section originally offered was taken
unchanged. Option 1 ("the employee row wins") was right about WHO decides
and wrong about WHAT is stored — pinning a resolved id would have frozen
every existing employee against later changes to the role's tier or to
`settings.engines.modelTiers`, and would be meaningless if the employee's
engine changed, since tiers are per-engine. Option 2's instinct — that a
resolved id is a record and not an input — was right, and survives as the
new meaning of `employees.model`.

The lesson was promoted to **standing rule 6** (PROJECT-CHECKLIST §7): the
same decision must not be made in two places.

### H.6 There is no production path from a hired employee to an EmployeeContext

Also from the boundary check, and not a defect today — nothing is supposed to
spawn an employee autonomously until M11.

Nothing in `src/` composes an `EmployeeContext`. Every builder is a test, and
`spawnSupervisedEmployee` explicitly disclaims the job ("the caller still owns
the role/task/worktree/memory parts of the context"). The boundary test's own
composition is therefore test-owned, and its header says so.

Recorded because **that absence is where §H.5 lives**, and it is where the
next join gets built. Whoever writes the real composer — M11's assignment
flow, most likely — inherits the question of which tier resolution wins, and
should settle §H.5 before rather than after.
### H.7 `EmployeeContext.effectiveAutonomy` is read by nothing

Found by the same grep that closed §H.5, looking for other instances of the
write-only-decision-input shape. **Reported, not fixed** — it is a trap
rather than a live bug, and fixing it belongs with whoever next touches
that interface.

`EmployeeContext` declares `effectiveAutonomy: Autonomy`, every caller sets
it, and **no adapter or supervisor code reads it.** The real autonomy
decision is made independently and correctly at policy-check time:
`contextBuilder.ts` calls `computeEffectiveAutonomy(employee)` from the DB
row, and `policyEvaluator.ts` then applies two live overrides (§7.3's
ungateable-engine floor and §11.5's breaker constraint, the latter read
from the live Supervisor via the registry). All of that works.

So the consequence today is nil — unlike §H.5, where the stale value was
read by the wrong thing, here it is read by nothing. The hazard is a future
caller reasonably believing that setting the field does something. Two
honest options:

1. **Remove it from the interface.** Cleanest, and says plainly that
   autonomy is resolved at policy-check time from persisted state plus
   live overrides, never carried on the spawn context.
2. **Keep it and make the adapter use it** — only if an adapter ever needs
   to know the autonomy level at launch (none does today; `claude-code`'s
   permission mode is derived from capabilities, not autonomy).

Worth doing before M11 builds the context composer, so that composer is not
written to populate a field that does nothing.

## I. M8 session 1's own deferrals, with their reasoning

### I.1 A permission checkpoint offers two options, not §9.1's three

§9.1 describes the compact render as "allow once / **allow this command for
this employee** / deny". The middle option is not built.

The reason is structural, not schedule pressure. §11.3 names exactly three rule
sources — the immutable globals, the role, and (M7) the pack — and there is no
store anywhere for a rule a *user* granted. Building one inside M8 would put a
policy decision outside the policy layer: a second place deciding what an
employee may run, one milestone after standing rule 6 was earned by precisely
that shape of bug.

The gate is unaffected. "A permission checkpoint holds an agent, is answered,
and the agent proceeds" passes with allow-once and deny, both real, both
carrying the consequence §9.2 requires.

Two honest ways to build it later, in preference order:

1. **A persisted `grants` table, compiled into `Rule` objects.** Employee-scoped
   rows loaded by `ruleLoader` alongside the role and pack rules, so they flow
   through the one `evaluate()` and cannot widen an immutable deny (the deny-wins
   short-circuit already guarantees that). Survives a restart, which matters:
   "allow this for this employee" that evaporates on quit is a worse promise
   than not offering it.
2. **A session-scoped in-memory registry**, same compilation, no migration.
   Cheaper, but it means the option's own `consequence` has to say "until Bureau
   restarts", and an option whose consequence is a caveat is a weak option.

Whoever builds it should note the ordering constraint the current code already
respects: the grant must be a *rule source*, never a check the evaluator
consults separately. A second decision point is the bug, not the table.

### I.2 Batching decides, but nothing yet surfaces

`src/main/checkpoints/batching.ts` implements §9.3's grouping completely and is
fully tested — and has no caller. §9.3's grouping is done "by the Director into
one message"; the Director is M11 and the message is M9, so the consumer is M8
session 2's surfacing at the earliest.

Recorded here rather than left as a quiet gap, and justified by the same
distinction §H.1 drew for the one-shot client: this is a **pure function with a
defined interface**, not behaviour whose trigger does not exist. It has no
side effects to rot, and its tests drive it directly rather than through a
stand-in. If session 2's surfacing does not use it, that is the moment to
delete it rather than carry it further.

### I.3 The post-restart grace suppresses; nothing yet reports

§9.6: suppressed checkpoints are ones "the Director surfaces in its restart
report instead." The suppression is real, tested against a genuinely
expired-while-closed row, and returns `suppressedByGrace` — a real count with
nothing yet reading it.

The Director is M11. This is deliberately *not* solved by inventing a restart
report in M8: a report with no Director to write it, no chat to show it in, and
no other content to sit alongside would be a shape M11 then has to undo.

### I.4 An answered decision is queued, not delivered

`answerCheckpoint` writes the decision to the `messages` outbox (§9.7). Nothing
delivers it until session 2 builds the router.

The alternative considered and rejected: call the live `Supervisor` directly.
§9.7 is explicit that a message to an `off` employee is **held, not dropped**,
so a direct call silently discards the answer whenever the employee happens to
be off — which for a `soon` or `whenever` checkpoint answered hours later is the
normal case, not the edge one. Adding direct injection *as well* would put "has
this been delivered" in two places.

The honest cost until session 2: an answered decision reaches the employee late
rather than never. The row is durable, keeps its `pending` status across
restarts, and needs no migration or rework when the router lands.

## How to use this file

Add to it whenever something is deferred, accepted or discovered incomplete —
with the reason, not just the item. A deferral without its reasoning becomes a
mystery in three months, and the reasoning is usually the part that decides
whether it is still the right call.

Review it at every phase boundary alongside `docs/AUDIT-PROMPT.md`. The audit
asks "is what we built correct?" — this file asks "is what we left out still the
right thing to leave out?"
