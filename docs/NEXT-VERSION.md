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

### C.4 Chat renders a markdown subset, not CommonMark (M9)

`src/renderer/src/components/chat/markdownParser.ts` is hand-rolled and
supports paragraphs, headings, bold/italic, inline code, fenced code blocks,
ordered and unordered lists, and `http(s)` links. **Tables, images,
blockquotes, nested lists and reference links render as their literal source
text.** Director-authored prose will contain tables, so this will be visible.

The reason it is hand-rolled rather than a dependency: every mainstream markdown
library produces an HTML string, which means `dangerouslySetInnerHTML` plus a
sanitiser. Message bodies are agent-authored — the least trustworthy content in
the product — so that would be adding an HTML-injection surface at precisely the
wrong place, for two dependencies and their licences. Producing React elements
instead means no HTML string exists anywhere in the path and there is nothing to
sanitise. Links are allow-listed to `http`/`https`; anything else (`javascript:`
above all) renders as text with its destination shown, pinned by
`tests/unit/renderer/markdown.test.ts`.

The honest failure mode is **ugly, never lossy**: an unsupported construct shows
its source rather than disappearing, which is also asserted. If tables become
worth supporting, add them to this parser — the thing not to do is swap in a
library and accept the sanitiser.

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

**Run once at pre-M11 P-9 (2026-09-17), and it had rotted again.** With `BUREAU_RUN_REAL_ENGINE_TESTS=1` against Claude Code 2.1.238: `realEngineSpawn.test.ts` passed. `realAgentGate.test.ts` (the M4 gate) FAILED. The CLI now defers MCP tool schemas behind a `ToolSearch` meta-tool, which the adapter classified as `other` and denied, so the agent could not load `bureau_task_done` and the task ended without a report. Fixed (`ToolSearch` is a `read`, pinned by `tests/unit/engine/claudeCodeToolSearch.test.ts`), and the gate re-ran green. Spend: three gate runs at $0.094, $0.077 and $0.123, and one spawn run. The class this section names is unchanged: nothing schedules these runs, and the cost of that is now demonstrated twice. A second finding from the same run went to the pre-M11 plan's §F: the version-drift check warns on every spawn because the probe reports `2.1.238 (Claude Code)` and the pin is `2.1.238`.

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

### H.3 ~~§7.1's 5-second probe deadline is tight for a process spawn~~ — ANSWERED (2026-09-10)

The original entry asked "whether 5s is the right number *at all* for a call
that spawns a process on a loaded Windows machine", and said it "should be
answered with a measurement rather than a guess."

**It was, and the answer was that the question was slightly wrong.** 5s was not
too small; it was one constant doing two jobs. §7.8.0 now separates them: a 30s
liveness ceiling (the guard — `probe()` may never hang) and a 2.5s
responsiveness budget taken from the caller (the promise — only to a call site
with a human waiting). Measured: warm p50 1785ms / p99 2024ms (n=148), cold
3875–4372ms, a single Defender-scanned launch of the 318.7 MB `claude.exe` to
9846ms. The distribution is bimodal and 5000ms sat in the gap.

The entry's instinct — do not quietly raise a spec deadline to fit an
implementation — held, and is why the fix is two named bounds in the spec
rather than a bigger number. What it did not anticipate is that the collapse
also hid a **shipped bug**: `probe()` reported a working CLI as
`installed: false` whenever it ran out of time, which on a cold start it
reliably did.

### H.3.1 Probe results are not persisted across restarts

`ProbeCache` is in-memory. The first probe after every Bureau start therefore
always misses, and a restart is exactly when the page cache is coldest — so the
one probe most likely to be slow is the one that can never be served from cache.
§7.8's `indeterminate` state makes that *honest*; it does not make it *fast*.

The deeper fix is persisting the last known-good probe result (engine version,
binary path, auth status) and serving it stale-while-refreshing on the next
start. **Deliberately not done as part of a flake fix**, because it is a design
decision, not a bug: it turns §7.8's bound from a smoke-test bound into a real
product commitment about startup responsiveness, and it needs answers to
"how stale is too stale", "what invalidates it besides the TTL" and "what does
the UI show while the refresh is in flight". Those belong with whoever owns the
startup experience.

**Not urgent, and here is why:** the only caller that would benefit today is
`canEnableZeroCostMode`, which cannot use a cache at all (see §H.8), and
`spawnSupervisedEmployee` — the path that would make probes frequent — **has no
production caller yet**. It gets one at the milestone that wires hiring, and
that is the point at which this stops being a nicety.

### H.3.2 `claude auth status` costs 1279ms against `--version`'s 512ms — unmeasured why

The profiling that produced §7.8.0 flagged a residual it did not chase: the two
launches are not equally expensive, and `auth status` costing 2.5x a
`--version` suggests it does more than read a local file. **If it touches the
network, that is a second independent tail source** — one that would not be
fixed by anything in §7.8, would not correlate with page-cache coldness, and
would behave differently on a bad connection than on a busy disk.

Recorded, not chased, and deliberately: the session that found it was fixing a
deadline, and confirming this needs a packet capture or a strace-equivalent, not
a stopwatch. Worth knowing before anyone concludes that probe latency is now
fully explained by binary size.

### H.3.3 Parallelising `probe()`'s two launches

The two launches (`--version`, `auth status`) are independent and run
sequentially. Parallelising them saves ~470ms warm and **measurably does not
help cold** — cold time is dominated by first-touch page-cache and Defender
cost on a 318.7 MB image, which both launches share and neither avoids.

Fine on its own merits; it was not done as part of the deadline fix because a
470ms answer to a 3-second problem is the kind of change that looks like a fix
and is not.

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

### H.8 The one user-facing probe cannot use the probe cache

`canEnableZeroCostMode` is the only genuinely user-facing `probe()` caller — a
person holding a settings toggle — and it is structurally unable to hit
`ProbeCache`. It does `new ClaudeCodeAdapter().probe()`, and the cache keys on
adapter **identity** via a `WeakMap` (deliberately: `probe()` honours
`CLAUDE_CONFIG_DIR`, so two differently-configured adapters genuinely have
different answers, and keying by the `'claude-code'` string would serve one
adapter's result to another). Every lookup misses; every store is written under
a key that is garbage before the next call.

**Left as-is on purpose, 2026-09-10, for a reason beyond the mechanics:** this
is the exact moment a stale answer is worst. A user reaching that toggle has
plausibly *just* logged in or installed the CLI, and a 60s-old "metered, could
not confirm" would refuse the setting for a minute after they fixed the very
thing it complains about. A fresh probe is the right behaviour here even if a
hit were possible.

What would change that: a process-wide shared `ClaudeCodeAdapter` instance, so
the toggle and `Supervisor.assign()` are asking the same object. That is a
wiring change and it belongs with the milestone that wires hiring — the same
milestone §H.6 is waiting on, and the first point at which more than one caller
probes often enough for sharing to matter.

### H.9 `Supervisor.assign()` does not refuse a determined "not installed" — **RESOLVED (pre-M11 P-2, 2026-09-17)**

**Decided: `assign()` refuses it.** The setup flow (§15.4) confirming the engine long before a hire does not make a second check wrong: engines get uninstalled after setup (chaos #9). `assign()` now throws `EngineNotInstalledError` (a `UserFacingError` with a plain sentence) before `transition('starting')`, and the test that pinned the old asymmetry asserts the refusal. A spawn that fails with `ENOENT` mid-session is translated in the `employee.crashed` payload (raw text kept as `detail`), and the probe cache forgets its answer so the next probe reports the engine absent (`engineUninstalledMidSession.test.ts`). One consequence recorded in the pre-M11 plan's §F: a `GenericPtyAdapter` must be constructed with `boundCommand`, or it cannot be assigned. The original note follows.


`assign()` refuses an `indeterminate` probe (§7.8, 2026-09-10) but has never
gated on `installed: false` itself — a genuinely absent CLI still reaches
`adapter.start()` and fails at the spawn.

That asymmetry is deliberate for now and is asserted by a test so it cannot
drift silently, but it is not obviously right: refusing early with "claude-code
is not installed" is a better error than whatever `start()` produces. It was not
changed in the deadline session because it is a **behaviour change with its own
question** — whether `assign()` should validate the engine at all, or whether
that belongs to the setup flow (§15.4) that is supposed to have confirmed it
long before a hire — and answering it in passing, inside a fix for something
else, is how the two-owners-for-one-decision problem (standing rule 6) starts.

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

### I.2 ~~Batching decides, but nothing yet surfaces~~ — RESOLVED (M8 session 2)

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

**Outcome:** session 2's surfacing uses it. `CheckpointSurfacer` (§9.4) is
its caller, and `tests/integration/checkpoints/surfacing.test.ts` drives
§9.3's rules through it against real rows — a window that holds two
checkpoints and then hands them over as one batch, and `blocking`/
`permission` never batched. The delete-it branch was not taken.

### I.3 The post-restart grace suppresses; nothing yet reports

§9.6: suppressed checkpoints are ones "the Director surfaces in its restart
report instead." The suppression is real, tested against a genuinely
expired-while-closed row, and returns `suppressedByGrace` — a real count with
nothing yet reading it.

The Director is M11. This is deliberately *not* solved by inventing a restart
report in M8: a report with no Director to write it, no chat to show it in, and
no other content to sit alongside would be a shape M11 then has to undo.

**Still open after M9 session 1, and worth stating precisely.** M9 built two of
§9.4's surfaces — the chat card and the Checkpoints tab count — and both are now
live rather than load-time-only, so a user who reopens the app **can see** the
backlog the grace is protecting. That is genuinely better than M8's position and
it is **not** what §9.6 asks for. Seeing it is not being told about it: the
grace exists because the app was closed, and the person who was away is exactly
the person who needs the backlog narrated rather than left to be noticed. The
restart report is still the Director's, and still M11. What M9 changes is that
M11 now has somewhere to put it.

### I.4 ~~An answered decision is queued, not delivered~~ — RESOLVED (M8 session 2)

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

**Outcome:** the router landed and needed neither. `tests/integration/
messages/answeredCheckpointDelivers.test.ts` is the join: a real checkpoint
answered through the real `checkpoints.answer` IPC handler, the row session 1
writes, the real started router, and the employee receiving the decision, its
consequence and the free text through `send(_, 'message')`. The case that
motivated the outbox decision is tested too — an answer given while the
employee is `off` is held with `attempts` still 0, no engine started, and
delivered the moment the employee starts.

## J. M8 session 2's own deferrals, with their reasoning

### J.1 §9.7's in-process signal is not built — a deliberate spec deviation

§9.7's diagram ends its producer column with:

```
signal router (in-process;
 SQLite is the source of
 truth, the signal is only
 a latency optimisation)
```

**The signal is not built.** The router's `setInterval` (5 s) is its only
trigger, and there is a test that proves a started router delivers with
nothing ever signalling it.

This is a deviation from the spec's own diagram and is recorded as one. The
reasoning:

1. **What it would cost.** The router handle would have to reach three
   producers, through five constructors: `AnswerDeps` (built in
   `main/index.ts`, in `checkpointsHandlers.answer`, and in the checkpoints
   tick) → `HandlerContext` → `registerIpcRouter`'s parameter list →
   `ToolHandlerContext` → `ControlChannelServer`'s options. Every one of
   those would have to be **optional**, because tests construct those
   contexts without a router.
2. **Why optional is the problem.** An optional dependency that degrades
   silently when omitted is exactly the shape standing rule 2 names: it
   reads as wired long before anyone checks that it is. A missing signal
   produces no error and no test failure — just five seconds of latency
   nobody notices until they are looking for it.
3. **What it would buy.** Latency bounded by the tick: at most five seconds,
   against agent turns that take tens of seconds. §9.7 itself calls the
   signal "only a latency optimisation" and names SQLite as the source of
   truth, so deferring it contradicts the diagram and not the design.

**If a later session builds it**, the constraints the current code already
respects:

- The tick must remain authoritative. A signal that becomes the primary
  trigger, with the tick demoted to a backstop, reintroduces "did this get
  delivered" as a question with two answers. Keep the test that proves the
  tick alone delivers.
- `startMessageRouter` already returns `runNow()`, already single-flights,
  and already handles a request arriving mid-pass (`rerun`). The signal is
  `runNow()`; nothing inside the router needs to change.
- Wire **all three** producers or none. Two of three is worse than zero,
  because the fast path then exists for some messages and not others, and
  which ones is invisible.

### J.2 A message addressed to `director` is held, because there is no Director — **SUPERSEDED (M9 session 2)**

`hireEmployee` hardcodes `is_director: false`. Nothing else writes the
column, so no Director employee has ever existed; `fireEmployee`'s refusal
is its only reader. Every `bureau_ask_director` call therefore addresses
nobody.

The router **holds** those rather than dead-lettering them. That is a
judgement call and it could have gone the other way: dead-lettering would
raise a blocker checkpoint for each one, which is arguably better for a user
today, since the question does reach a human.

It was rejected because M11 creates the Director, and dead-lettering a
target that is *going to exist* would generate a blocker for every agent
question asked in the meantime — turning "the Director is not built yet"
into a stream of alarms. Held is the honest state: not delivered, not lost,
not given up on.

**What M11 must not have to undo:** nothing. The held rows are ordinary
`pending` messages. The moment an `is_director` employee exists and is idle,
the existing router delivers them with no migration and no code change.

**✅ Superseded by M9 session 2 (2026-09-09), and the prediction above held
exactly.** `hireEmployee` now derives `is_director` from the role, so a Director
*can* exist, and `m9Gate.test.ts` walks a real message from the composer through
the outbox to a real hired Director's own adapter — with no migration and no
change to the router. What remains true is the *reason* rows may still be held:
`no_director_yet` no longer means "nothing can create one", it means "nobody has
hired one yet", which is an ordinary data state.

### J.3 §9.7's "the Director is notified" for an unfillable role

§9.7: "`role:<key>` resolves to the least-loaded idle employee of that role.
If none exists, the message is held **and the Director is notified so it can
propose a hire** — it does not silently vanish."

The resolution and the hold are real. The notification is not: there is no
Director. `routeOnce`'s report carries `held: [{ messageId, reason:
'no_idle_employee_for_role' }]`, which is a real signal with no reader yet —
the same shape session 1 gave `suppressedByGrace` (§I.3), and for the same
reason. Inventing a "propose a hire" flow in M8 would be a shape M11 then
has to undo.

Deliberately **not** solved by raising a checkpoint: a role with nobody idle
resolves itself the moment somebody goes idle, and pinging the user about a
condition that clears on its own is how a notification system becomes noise.

### J.4 A message addressed to `user` has nowhere to go — **CLOSED (M9 session 2)**

`user` parses, and is held with `no_user_inbox_yet`. The user's inbox is
§9.4's first surface — the Director chat — which is M9.

Nothing writes such a message today (`answerCheckpoint` uses `user` as the
*sender*, not the recipient), so this is a seam rather than a gap. It is
handled explicitly rather than falling through to `unparseable`, because
"there is nowhere to deliver this yet" and "this address is nonsense" are
genuinely different and only one of them should dead-letter.

## ✅ CLOSED — M9 session 2 (2026-09-09)

`deliverabilityOf` no longer holds a `user` address, and `no_user_inbox_yet` is
gone from `HoldReason` entirely. It resolves a conversation — the message's
project's, else the most recent (`resolveConversationForDelivery`) — and the
router appends through `appendChatMessage`, the same door session 1 built and
M11 will use. Proven in `tests/integration/messages/userInboxDelivery.test.ts`.

**Three decisions were made in closing it, all stated in the code:**

- **`author: 'system'`.** `MessageAuthorSchema` is a closed enum of
  `user | director | system`, and an employee is none of them. `director` would
  be a lie — `bureau_send_message` lets *any* employee address the user — and a
  fourth value is a migration plus an enum M11 inherits, for a distinction
  `payload.delivered.fromAddr` already carries as a fact.
- **`kind: 'text'`.** The outbox row carries prose and a subject; nothing in it
  is a brief, a plan, a report or a decision. Session 1's rule holds: if
  something seems to want a ninth kind, the payload is what is wrong.
- **The write is atomic, unlike every other delivery**, and that is a deliberate
  departure. §9.7's "send then mark" exists because delivery crosses a process
  boundary; here both halves are writes on the same SQLite connection, so
  `appendChatMessage` gained an `alsoCommit` callback running inside the insert's
  own transaction. Its contract is documented at the signature — **a synchronous
  DB write on the same connection, nothing else** — because it runs inside an
  open write transaction, which is the opposite bargain from the one
  `ActivityLog.onEvent` makes by deferring to `setImmediate`.

**One hold reason replaced another, and it is not the same shape.**
`no_conversation_yet` means "this company has no conversation row" — a real data
state that resolves itself once M11's intake or M13's wizard creates one — not
"the mechanism does not exist". It writes nothing and consumes no retry budget,
like every other hold.

**`consumed_at` is deliberately not set.** §9.7 defines consumption as an
employee's next turn starting, and the user has no turn. What the user does is
*read* it, and that is `conversation_messages.read_at` — a different, real column
which as of this session finally has a writer.

### J.5 The other three §9.4 surfaces

The chat card, the Checkpoints view badge and the floor signal are M9, M9/M14
and M12. `CheckpointSurfacer` is where they should read from: it already
owns "which pending checkpoints are surfaceable now", including §9.3's
batching, and it reads `listPendingCheckpoints` — the same function
`checkpoints.listPending` calls. §9.4's "all four reflecting one piece of
state" is a property of sharing that call, not of four queries agreeing.

Two things a UI session should know:

- **`checkpoints.listPending` and `checkpoints.get` only started working
  this session.** They returned `INTERNAL_ERROR` for every checkpoint with
  options — every type except `information` — because `dispatchIpcCall`
  re-validates handler output against the row schema and the JSON column
  schemas were not idempotent. Fixed in `src/shared/models/json.ts`, pinned
  by `tests/unit/models/jsonColumnRoundTrip.test.ts`.
- **The "already notified" set is in memory and session-local.** A restart
  re-announces whatever is still pending. That is the right direction — the
  alternative is a user who closes the laptop on an unanswered blocking
  question and is never told again — but a UI that adds its own "seen" state
  should not assume the notifier's matches it.

**Corrected (pre-M11 X-11, 2026-09-18): surface 1 was half-built, and the
outcome below said "built".** Everything it claims about the *rendering* was
true — the card, the shared slice, the live patch. What none of it needed, and
what nothing in the Core did, was **write the `checkpoint` conversation
message the card renders from**. The only `kind: 'checkpoint'` row in the tree
was in `tests/e2e/fixtures/chatSeed.ts`, so a checkpoint raised by a real agent
never appeared in the conversation §9.4 calls the primary surface; it reached
the user only through the Checkpoints tab and the desktop toast. X-11 makes
`CheckpointSurfacer` write it for `blocking` and `permission` (the ones §9.3
never batches), idempotently against the row's `checkpoint_id`. The rest —
grouping the batched ones into one Director message — is still M11's, which is
what the outcome below should have said. Read the paragraph that follows as
about the *reader*, which is what it actually tested.

**Outcome (M9 session 1): surfaces 1 and 2 are built, and they share state
rather than agreeing.** The chat card renders from the store's `checkpoints`
slice and the Checkpoints tab count reads the same array; that slice is built by
`buildFullSnapshot`, which now calls `listPendingCheckpoints` — the same
function `checkpoints.listPending` and `CheckpointSurfacer` call. It had its
own inline `WHERE status = 'pending'` query until this session, which was a
second definition of "pending" free to drift (standing rule 6). §9.4's "one
piece of state" is now literally one function with four callers.

They are also **live**: `src/main/ipc/liveState.ts` subscribes to the activity
log and broadcasts a fresh `checkpoints` patch on any `checkpoint.*` event, so a
checkpoint raised while the window is open appears, and one answered leaves.
Subscribing to the events rather than pushing from each of the five call sites
is deliberate — invariant #3 already guarantees each of them emits exactly one
event, so one subscription cannot fall behind the code the way five remembered
calls would.

Surface 3 (the floor) is still M12. The advice above about the notifier's
in-memory "already notified" set still stands and the chat deliberately keeps no
"seen" state of its own — unread badges are session 2's, and they will read
`read_at`, which is durable.

### J.6 §11.7 and §11.2 disagree about S15, and §11.2 won

§11.7's table row for S15 says it asserts "denied calls **and zero egress**".
§11.2 says, in the same document:

> **S15 asserts what is actually true:** an injected instruction produces
> denied filesystem calls and denied network-tool calls. It does **not**
> assert zero egress, because that is not implemented and testing for it
> would produce a false assurance.

S15 as written follows §11.2. It is the specific, later-reasoned statement,
and it is the one that is true of the shipped system: Bureau gates named
network tools and ships no proxy and no network namespace, so a shell
command reaches the internet regardless (risk row 27).

**The spec is left as-is rather than edited.** `docs/BUILD-SPEC.md` is
frozen and "changes only when a documented interface actually changes"; this
is a documentation inconsistency, not an interface. Whoever does the next
spec pass should reconcile §11.7's table row with §11.2's paragraph — and
the paragraph is the one that is right.

S15 additionally pins the gap as a fact: an exfiltrating `Bash(curl …)` and
a harmless one get the identical verdict, because nothing inspects the
command. If someone ships egress control, that assertion fails and asks to
be updated, which is the correct direction for a test documenting an
absence.

## K. M9 session 1's own deferrals, with their reasoning

### K.1 The chat writer has no production caller, and that is the milestone's shape

`appendChatMessage` and `ChatStreamRegistry` are real, tested against a real
database, wired into `main/index.ts` and reachable by `chat.stop` — and nothing
in the shipped app calls them. The Director writes the Director's messages and
the Director is M11; the composer writes the user's and that is M9 session 2.

Recorded rather than glossed, and justified the way §H.1 justified the one-shot
client: this is a **module with a defined interface and real tests driving it
directly**, not behaviour whose trigger does not exist. The difference from a
stub is that everything downstream of it — persistence, the two events per
stream, the push, the gap-detected recovery, the eight renderers, the aborted
marker — is real and proven end to end against the real packaged app. What is
missing is the thing that decides *what to say*.

**What a later session must not do:** add a test-only IPC method to start a
stream. `tests/e2e/chatAborted.spec.ts` deliberately kills a separate real
process rather than asking the app to stream something, precisely so no such
path exists in the shipped product.

### K.2 One conversation, no switcher

`ChatView` shows the most recently created conversation and offers no way to
change it. Nothing creates a second one today (conversations are bound to
projects, and project creation is M11), so a switcher would be a control with
one item in it.

The seam is honest: `chat.listConversations` is real and already returns them
all, and the view re-reads it on every re-hydrate. When M11 makes second
conversations possible, this becomes a list, not a rewrite.

### K.3 Question chips render disabled — **CLOSED (M9 session 2)**

`kind: 'question'` renders its option chips as real, keyboard-reachable buttons
that are **disabled**, with a title saying answering arrives with the composer.
They are disabled because answering a question means `chat.send`, which is
session 2's.

The alternative — chips that look live and silently do nothing — is the failure
§14.6 names. The alternative in the other direction, omitting the chips until
they work, would have left the `question` renderer untested against real data
for a milestone. Rendering them inert and saying so is the honest middle, and it
is a two-line change in session 2 to make them live.

**✅ Closed (M9 session 2).** It was two lines. A chip now sends its own label
through `chat.send`, because answering a question *is* sending a message —
there is deliberately no separate "answer" method, which would have been a
second door onto the conversation. §14.2's free-text box alongside them is the
composer itself. Proven by keyboard in `chatCompose.spec.ts`.

### K.4 Three error remedies have nowhere to go yet

`ErrorPayloadSchema.remedy.kind` has five values. `answer_checkpoint` switches to
the Checkpoints tab and `open_path` opens a folder, both real. `reconnect_engine`,
`raise_budget` and `retry` log a warning and do nothing, because the settings
panels they would open are M13 and `retry` needs the composer.

The button still renders. That is deliberate and is the lesser of two evils: the
Core is already able to say what needs to happen, and a card that hides the
remedy because the view cannot honour it yet would make the payload look
optional to whoever builds M13. The console warning names the missing
destination.

### K.5 `chat.listMessages` is not redacted, while the push is — **RESOLVED (pre-M11 N-2, 2026-09-17)**

**Decided: invoke responses are a redaction choke point.** `dispatchIpcCall` redacts every validated success payload once, after output-schema validation, so all ~20 handlers are covered without any of them remembering to. S4 (`canarySecretNeverLeaks.test.ts`) gained a request/response leg through the real router and the real `tasks.get` handler, and it fails with the redaction removed. The original note follows.


`electronChatBroadcaster` runs `redactDeep` before sending — the same treatment
`stateDelta` gives pushed rows (§11.4 choke point 4/6). The `chat.listMessages`
**invoke response** does not, because no IPC handler in the tree does:
`checkpoints.listPending`, `tasks.list` and the rest all return rows straight
from their repositories.

So one message can reach the renderer redacted (pushed) and unredacted
(fetched). Nothing is currently at risk — the same rows go to the same window,
and the canary test (S4) covers the push path it names — but it is an
inconsistency with a real shape, and fixing it properly means deciding whether
invoke responses are a redaction choke point at all, then applying that to ~20
handlers at once. That is a decision, not a chore, and it did not belong inside
a UI session. Recorded here so it is a decision someone makes rather than a gap
someone finds.

### K.6 The message router's `user` address, and `chat.send`/`markRead` — **CLOSED (M9 session 2)**

Both were `stub('M9')` in `src/main/ipc/handlers/chat.ts`, tagged for session 2
rather than M11. See §J.4 above for the delivery half. The re-tagging was the
point: they were `stub('M11')`, which was wrong — M11 owns the *producer* of the
Director's replies, not the methods for sending to it, reading it, or
interrupting it.

**✅ Closed (M9 session 2).** Both are real, `grep "stub('M9')" src/` returns
nothing, and the re-tagging turned out to be right: neither needed the Director.

## L. M9 session 2's own deferrals, with their reasoning

### L.1 §28's M9 gate is M11's, and this is the record of why

§28's M9 gate reads: *"a full conversation including approving a brief works
end to end against `FakeAdapter`."* It cannot pass in M9 and was **not**
claimed. Three things are needed and this milestone owns one:

| Needed | Owner | State after M9 |
|---|---|---|
| A Director employee row | M9 session 2 | **built** — `hireEmployee` derives `is_director` from the role |
| Director output → `conversation_messages` (the producer) | M11 | does not exist |
| A tool or handler that writes a `briefs` row | M11 | does not exist |

The third is the decisive one and it is checkable: `grep -rn
"write_brief\|bureau_write" src/` returns nothing. **No tool, no handler, no
path of any kind writes a brief.** So "approving a brief" has no legitimate
producer, and a test that inserted one and called the result an end-to-end
flow would be asserting a claim the product cannot make.

`docs/BUILD-SPEC.md` now says this at the gate itself rather than only here,
because a gate is read at the start of a milestone and this file is read at
phase boundaries.

**The substitute gate M9 did meet** (`tests/integration/chat/m9Gate.test.ts`,
nothing seeded): a message typed in the composer persists, appears in the
conversation, is addressed to `director`, and is delivered by M8's real
router to a real Director hired through the real `hireEmployee` path,
running `FakeAdapter`, which receives it.

**What M11 must not do:** treat the deferral as permission to seed the brief
and declare the gate passed. The gate is about a *producer*; the row is not
the point.

### L.2 An attachment reaches the payload, not the Director

§14.2's file attach stores its paths as `payload.attachments` on the `text`
message — **structured data, never formatted into `body`** — because how an
attached path reads to a person is the renderer's decision, and a stored row
is the one place presentation must not be baked in.

The consequence is real and is deliberately left for M11 rather than solved
by breaking that boundary. Stated precisely, because "the Director reads
`body`" undersells it: an attachment reaches **neither** of the two things
that carry a user's words onward. Not `conversation_messages.body`, and not
the `messages` outbox row `chat.send` writes — whose body is a copy of the
same text.

**M11 owns the decision, and has two reasonable places to make it:** compose
the outbox body from `payload.attachments` at send time (the shape
`bureau_ask_director` already uses when it appends its own "Context:"
block), or fold them into the Director's context when it reads the
conversation. Either is legitimate. Picking one is M11's, because M11 is the
first thing that knows what the Director is actually given.

That instruction is written at the schema
(`src/shared/models/chatPayloads.ts`) in a block addressed to M11, so it is
found by someone editing the thing rather than only by someone reading this
file.

Solving it now by writing the paths into `body` would have been formatting
in a row — the exact boundary session 1 held twice and the product owner
corrected this session's plan on, before any code was written.

### L.3 There is no file picker, and §17.1 is why

The composer offers a **typed or pasted path**, not a native file dialog.
Two things block a picker and neither is a small fix:

- **Electron 43 removed `File.path`**, so a drag-and-drop or `<input
  type="file">` yields a `File` with no filesystem path. The supported route
  is `webUtils.getPathForFile` in the **preload**, and §17.3 deliberately
  keeps the preload a thin pass-through with no logic.
- **§17.1's namespace/method surface is fixed** and `scripts/checkIpcSurface.mjs`
  diffs it against the spec. A `system.pickFile` method is a spec amendment,
  not an implementation detail.

Neither was worth doing inside a UI session. **M13 has to solve it anyway** —
its setup wizard picks a home folder (`setup.setHomeFolder` takes a path from
somewhere) and `system.scanFolder` is already stubbed for it — so the picker
belongs there, added once, for both.

Note what did *not* change to accommodate this: `chat.send` gained an
`attachments` **field** on its existing input schema, not a new method. The
IPC surface check still reports 20 namespaces, 109 methods, 7 events.

### L.4 `requestEdit` needs a §5.2 event type before it can be real

`brief.requestEdit` and `plan.requestEdit` remain `stub('M11')`. This is not
an oversight and no §14.2 button depends on them — a brief's three are
Approve, Edit and Discuss, and all three are served by `brief.approve`,
`brief.saveEdit` and `chat.send`.

Two reasons, and the second is the blocking one:

- "Ask the Director to revise this with my feedback" is not a row state
  change; the revision is the Director's judgement. Its only durable half —
  a message carrying the feedback — is exactly what Discuss already writes,
  and a second producer of director-addressed messages differing only in a
  status side effect would be two doors onto one thing.
- **§5.2 has no event type for "changes requested" on a versioned
  document.** The taxonomy was closed in M9 session 1 (`EventTypeSchema` is a
  `z.enum`, so an undocumented emitter fails `typecheck`), so making
  `requestEdit` a real state change requires adding
  `project.brief_changes_requested` / `project.plan_changes_requested` to
  §5.2 **and** `eventTypes.ts`. That is a real decision about the taxonomy,
  and it belongs with the milestone that has a Director to act on it.

### L.5 A plan cannot be hand-edited, and the schema says so

§28 M9 item 4 says "Edit opens the markdown in an editor and saves a new
version". That is implemented for the **brief**, which has a `markdown`
column and a `brief.saveEdit` method.

A **plan** has neither: `plans` stores `content` JSON and §17.1 has no
`plan.saveEdit`. That is not an omission — a plan is phases, tasks and
dependencies, and hand-editing its JSON is not something to offer a person.
So a plan's `Edit` button opens the composer prefilled with the plan as
context, which is `chat.send`.

If M11 ever wants a structured plan editor, it needs a new method in §17.1
and a decision about what editing a plan means when tasks are already
assigned — neither of which a UI session should have invented.

### L.6 `chat.markRead` emits no activity event

Invariant #3 gives every state change exactly one activity event, and this
one deliberately emits none. The argument, so it can be overturned
deliberately rather than by accident:

- `conversation_messages.read_at` is the one column in the schema that
  records something about the **viewer** rather than about the company's
  work. Nothing downstream reads it.
- There is no side effect to order the commit against — the whole point of
  invariant #3's "committed before the side effect".
- §5.2's taxonomy, closed in session 1, has no type for it. Adding one would
  put a row in the activity stream for **every message a person's eyes
  passed over**, in the same stream §14.5 requires to stay "genuinely
  readable".

The push is not an event: other windows have to stop showing the message as
unread, and they learn that the way they learn everything else.

**If this is overturned**, the change is one `logEvent` call plus a §5.2
entry — but the volume argument does not go away, and a `chat.message_read`
type would want a batching story before it earned its place.

### L.7 The badge's count assumes an unpaginated `chat.listMessages` — **RESOLVED (pre-M11 P-4, 2026-09-17)**

`chat.listMessages` is now paginated (measured unresponsive at 10,000 messages; see chaos row #12). The badge's assumption moved as this note said it must: `selectChatUnreadCount` adds the Core's `unreadOlderCount` (the unread messages older than anything loaded, counted with `UNREAD_FOR_USER_SQL`, the predicate's own SQL spelling) to the shared predicate over the loaded messages. Still one rule, written twice beside each other, and tested against each other over 10,000 real rows. The original note follows.


The Chat tab's unread count is `chat.messages.filter(isUnreadForUser).length`
— the renderer counting rows the Core already sent, using the **shared**
predicate that `chat.markRead` also guards with.

The alternative, a Core-computed integer pushed on its own slice, was
rejected because it would be a second source for one number that could
disagree with the messages already on screen — standing rule 6 pointing the
other way.

**That is correct only while `chat.listMessages` returns the whole
conversation, which it does today** (no `LIMIT`, no cursor — verified). If a
future session paginates it, the count silently *undercounts*, and the fix
is to move the computation into the Core. The assumption is written at
`isUnreadForUser` as well as here, because that is where someone would be
standing when it mattered.

## M. M10's own deferrals, with their reasoning

### M.1 The semantic layer's flag and degradation are built; the model is not

§12.1's layer 3 is *"optional semantic search. Off by default, behind a
setting… Everything works without it — **this is the degrade-loudly principle
in practice**."* §28's item 6 says the same: "behind a flag, degrading to
FTS5."

**Built:** the flag (`memory.semanticSearch`, already in the settings schema
since M6), `semanticSearchState()`, and the degradation path. With the
setting on and no provider, search still returns FTS results and **says so** —
`semantic: 'unavailable'` travels in `memory.search`'s output, in
`bureau_read_memory`'s result, and in the `memory.injected` payload. `'off'`
and `'unavailable'` are distinct values on purpose: a silent FTS fallback
looks exactly like a semantic search that worked, which is the failure
"degrade loudly" names.

**Not built:** the embedding model. Three reasons, and the third is the one
that settles it:

- It is a dependency and a several-hundred-megabyte download, on a product
  whose §15 setup wizard is its highest-leverage screen.
- Its licence is a real question, and **invariant #14 is absolute** — no
  asset with a non-commercial licence, ever. That is a decision needing an
  actual model chosen and its terms read, not a session's spare hour.
- **Nothing else in M10 needs it.** Every §12.3 clause is served by FTS5
  today, and the pack composition would not change shape if embeddings
  arrived — only the ranking inside one of its five inputs would.

Whoever picks it up: the seam is `composeMemoryPack`'s `task_match` clause
and `searchMemory`'s options. `semanticSearchState` returning a third value
(`'on'`) is the whole signalling change.

### M.2 There is no OS file watcher, and the compensation has its own cost

§28's item 1 reads "file watching for out-of-band edits via
`content_sha256`". Detection is built and tested — including §12.1's own
"index a file written with a text editor that Bureau never saw" — but the
*watcher* is not, and the choice has two halves that belong together.

**Why no watcher.** `fs.watch` would be a fourth runtime loop, and its only
effect beyond what the reconciler already does is pushing a change to the
renderer. The renderer has no memory `stateDelta` slice to receive one —
that slice belongs to M14 — so today a watcher would fire into nothing.

**What replaces it, and what that costs.** The index reconciles from disk at
startup, before every memory-pack composition, before every search and list,
and per-note on `read`. That is a recursive walk each time, and the memory
tree grows per project, per role and per employee. CLAUDE.md's rule is to fix
the performance rather than add a switch that disables the work, so the
compensation is **stat-before-hash**: `memory.file_mtime_ms`/`file_size`
(migration `0010`) let a reconcile that finds nothing changed open no files
at all. The residual is the case a stat cannot see — content changed with
mtime and size both preserved — which is why `memory.reindex` hashes
unconditionally and is reachable from the memory view.

If a watcher is ever built, it should *replace* the per-read reconcile rather
than sit alongside it. Two things deciding when the index is stale is
standing rule 6 in waiting.

### M.3 An interrupted accept can leave the file written and the proposal pending

§12.4's accept path writes in this order: the markdown file, then
`{ index row + proposal CAS }` in one transaction, then the event. §12.1
settles why the file comes first — layer 1 *is* the knowledge and the row is
a disposable index, so the reverse ordering would record an acceptance for
something never written down.

The window between step 1 and step 2 is real and is stated rather than
hidden: a crash there leaves the note on disk with its proposal still
`pending`, so it reappears in the review. **Re-accepting converges** —
`writeMemory` is an upsert and reports `changed: false`. The case that does
not converge is a user who then *rejects* it and finds the note already
there.

Closing it properly needs the file write and the row write in one atomic
unit, which SQLite and the filesystem cannot give without a write-ahead
scheme of our own — a large mechanism for a window that requires a crash
inside a few milliseconds of an accept. Recorded rather than built.

### M.4 The Director's own memory tools are M11's

§7.9 lists three Director tools that touch memory: `bureau_write_memory`
(direct write; `project` without approval, `company` still asks),
`bureau_read_memory`, and `bureau_record_decision`. None is built, because
**no Director tool of any kind is built** — the Director's 19 tools are
M11's, and `EMPLOYEE_TOOL_HANDLERS` says so.

Nothing about M10 blocks them: `proposeMemoryWrite` already takes a
`proposedBy` of `director`, `memoryScopeRequiresApproval` is the one place
the "project without approval, company still asks" rule would live, and
`appendDecisionLog` is what `bureau_record_decision` should call rather than
reimplement.

### M.5 The memory pack fills two Appendix B slots, not the prompt

`Supervisor.assign()` sends the memory pack followed by the task body.
Appendix B's employee template has six slots; M10 owns two of them
(`{{decision_log}}` and `{{memory_pack}}`, both filled from **one**
composition, because each pack item carries its `kind`). The role's system
prompt, the acceptance criteria and the brief summary are M11's, and nothing
in M10 assembles them.

That is why `composeMemoryPack` returns facts and `renderMemoryPack` is
separate: M11 replaces the rendering without touching the composition, and
`memory.injected` keeps recording ids and paths rather than a blob of
markdown nobody can query.

## N. Long operations with no job id (AUDIT M0–M2 #27)

§17.2 is a MUST: *"Long operations return a job id immediately and report
progress via `on.stateDelta`. Nothing blocks the UI thread."* No job-id
mechanism exists (`jobId` appears nowhere in `src/`), and building the
general one before any operation is actually long would be designing against
guesses. Recorded here instead, item by item, **against the milestone that
first makes each one slow**, so that milestone builds the mechanism with a
real case in hand.

All four are real, synchronous handlers today. Better-sqlite3 is synchronous,
so while each runs, **the main process is blocked** — every other IPC call,
every push, every control-channel request waits behind it. That is the real
cost, not the renderer's spinner.

### N.1 `system.compactDb` — `VACUUM` plus the FTS rebuild

Rewrites the entire database file; cost is linear in its size. The table
expected to grow fastest (not measured) is `events`, one row per state change,
which M11 multiplies.
**Owner: M15** (§28's hardening work, where `retention.eventTableDays` also
bites). Until then it is user-initiated and rare.

### N.2 `system.backupDb`

`db.backup()` copies every page. Same growth curve as N.1. **Owner: M15.**
The same `db.backup()` API also runs once per applied migration at startup,
in `migrate.ts`'s own `backupBeforeMigration` (not this handler), before any
window exists, where blocking is acceptable.

### N.3 `memory.reindex`

Walks and hashes every memory file (§12.1's stat-before-hash makes an
incremental pass cheap; `full: true` is not). Grows as the Director and
employees write memory, which starts at **M11**. **Owner: M15**, unless an
M11 session sees a full reindex take long enough to notice — then it moves.

### N.4 `packs.install`

Unpacks, validates every role and file, and installs all-or-nothing in one
transaction. Bundled packs are small. **Owner: M14**, which authors the
second and third packs and is the first time a large one exists.

### N.5 `buildFullSnapshot`'s `tasks` slice is unbounded — and M11 starts creating tasks

`stateDelta.ts` loads **every task row in the database** into one push, on
every window load. Nothing creates tasks yet; M11's `bureau_write_plan`
inserts a whole plan's worth in one transaction, and a user's task count only
grows from there.

**Made more pressing by the M0–M2 fix sessions, and stated so it is not
discovered as a mystery:** fix 3a (#23) made `liveState` push the `projects`
and `tasks` slices live, and it reads them **through `buildFullSnapshot`** —
deliberately, so there is one definition of what a slice contains. That means
each coalesced burst of `task.*` events now builds **all six slices** to send
one. Bursts are coalesced to one read, so a plan insert costs one rebuild,
not one per task — but that rebuild is O(all tasks + all projects + all
employees + all checkpoints + settings).

**Owner: M11.** The fix is not a job id: it is scoping the slice (the Board
shows one project at a time) and giving `projects`/`tasks` shared readers of
their own, so `liveState` stops reaching through the full snapshot. Both
should happen before any real project has more than a few hundred tasks.

## How to use this file

Add to it whenever something is deferred, accepted or discovered incomplete —
with the reason, not just the item. A deferral without its reasoning becomes a
mystery in three months, and the reasoning is usually the part that decides
whether it is still the right call.

Review it at every phase boundary alongside `docs/AUDIT-PROMPT.md`. The audit
asks "is what we built correct?" — this file asks "is what we left out still the
right thing to leave out?"
