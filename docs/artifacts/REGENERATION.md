# Artifact regeneration — schedule and pending log

The pages in this folder are **snapshots**, not living documents. Regenerating
them every milestone is waste: most milestones change one box on one diagram.
So instead, every session **appends what it changed** to the pending list below,
and the pages are rebuilt only at two points.

At a regeneration point, read the pending list, apply it, empty it, and add a
line to the history at the bottom. The pending list is the thing that makes
regeneration cheap — without it, each rebuild means re-deriving the whole
project from scratch.

## Schedule

| After | Regenerate | Why there |
|---|---|---|
| **M11** — the Director | **All three** | The first point where Bureau is a product rather than plumbing. Every page's central claim changes: the blueprint's join map fills in, the walkthrough's "nothing has ever done work" stops being true, and the business overview can finally claim the departments are useful. |
| **M15** — ship | **All three** | Final state. The walkthrough and business overview become the ones a stranger reads, so they have to be true at ship rather than true at M11. |

Anything outside those two points goes in the pending list, not into the pages.
M12–M14 change real things — the floor renders, a second pack proves the
abstraction — and all of it accumulates in the pending list until M15.

---

## Pending since the last regeneration

**Baseline: 7 Sep 2026.** All three pages were current at M7 plus the M7→M4
boundary check. Everything below is what has changed since.

### Affects the blueprint (`bureau-blueprint.html`)

Watch for: new tables or columns (the ERD), joins becoming proven or broken (the
join map), architecture changes (the system map), new standing rules, milestone
status.

- **Landed 7 Sep (`8bca2d2`)** — the tier fix. Migration `0008` adds
  `employees.model_tier_override`; `employees.model` is now a record of what
  launched. The ERD's `employees` box already shows "tier"; the red **"assigned
  to"** join and its "no code creates this yet" caption are now wrong, and the
  **"1 join known broken"** stat should read 0. The join is still unbuilt in
  production code (M11 owns the context composer) — so it becomes a dashed
  "not built" line, not a green one.
- **Landed 8 Sep (M8 session 1)** — migration `0009` adds `checkpoints_fts`
  (a standalone FTS5 table keyed by `checkpoint_id`, not external-content —
  `checkpoints.id` is a TEXT PK so its rowid is implicit and VACUUM-unsafe) and
  `idx_checkpoints_expiry`. The ERD needs the new virtual table alongside
  `memory_fts`, and `checkpoints.expires_at` is now a real, populated column
  rather than one nothing ever set.
- **Landed 8 Sep (M8 session 1)** — two joins change state on the join map.
  **`checkpoints → policy hold → agent` is now PROVEN**: an `ask` verdict
  raises a real `permission` row, the agent is held over real loopback HTTP,
  and the real `checkpoints.answerPermission` IPC handler releases it
  (`tests/integration/checkpoints/permissionHold.test.ts`). **`checkpoints →
  messages` is new and DASHED**: answering writes a durable outbox row, and
  nothing delivers it until session 2's router.
- **Landed 8 Sep (M8 session 1)** — architecture: `insertCheckpoint` is now the
  single door for checkpoint creation (validation, derived expiry, and the
  `checkpoint.raised` event all live inside it), and `blockTaskForCheckpoint`
  is the single way a task is blocked on a checkpoint. Two prior callers blocked
  tasks with no `task.blocked` event at all — a live invariant #3 violation the
  centralisation closed.
- **AUDIT #23 closed** (2026-09-08) — the first MINOR finding to close. If the
  blueprint shows audit status, it moves.

- **8 Sep (M8 session 2) — the join map moves, and this is the biggest single
  change since M7.** The `messages` outbox had three writers and **no reader**;
  it now has one. Every "written, nothing delivers it" caption on that table is
  wrong. New arrows, all proven by tests: `answerCheckpoint` → outbox → router
  → a live `Supervisor` → `adapter.send(_, 'message')`, and
  `bureau_send_message`/`bureau_ask_director` → outbox → the same router.
- **8 Sep — the system map gains a third periodic loop.** `startMessageRouter`
  (5 s) alongside `parkedEmployeeResumeTick` (60 s) and the renamed
  `startCheckpointsTick` (15 s, now two jobs: the timeout sweep AND §9.4's
  surfacing). If the map shows background timers, it is three, and the decision
  to keep them three rather than build a scheduler is worth a caption.
- **8 Sep — `timeoutTick.ts` is now `checkpointsTick.ts`.** Any file-level box
  naming it moves.
- **8 Sep — a message-lifecycle state machine now exists and did not before:**
  `pending → delivered → consumed`, with `held` as a non-state (nothing is
  written), `failed` looping back to `pending` on §9.7's ladder, and
  `dead_letter` as terminal. Worth its own small diagram; `held` being a
  non-state is the part a reader will get wrong.
- **8 Sep — `messages.consumed_at` gained its first reader.** If the ERD marks
  write-only columns, it stops being one. `employees.is_director` still has no
  writer, and that is now load-bearing (it is why a message to `director` is
  held).
- **8 Sep — two red boxes go green in the security column:** S12 and S15 are
  written and wired into `test:security`, so **S1–S15 are all present** and
  `NOT_YET_WRITTEN` is empty for the first time. If the blueprint shows the
  security-test grid, this is its completion.

### Affects the walkthrough (`building-bureau.html`)

Watch for: milestone gates passed, new glossary terms, notable bugs and the
lessons drawn from them.

- **8 Sep — M8's gate, half passed.** "A permission checkpoint holds an agent,
  is answered, and the agent proceeds" is real end to end today. Worth a
  glossary entry for **checkpoint** and for the **post-restart grace**, which is
  the most counter-intuitive rule in the product: after a restart Bureau
  deliberately does NOT apply the defaults of checkpoints that expired while it
  was closed.
- **8 Sep — a bug worth telling.** A guard copied from `bureau_task_blocked`
  refused to block a task in `review`, which silently broke merge-conflict
  handling: the conflict raised its checkpoint, the task stayed in `review`,
  and the conflict looked resolved. Caught by an existing M5 test. The lesson is
  about the difference between an agent saying "I am stuck" and the system
  discovering a decision is needed — the same status means different things to
  each.

- **8 Sep (M8 session 2) — M8's gate passes in full, and the milestone closes.**
  The third line is the one worth telling: a question sent to an employee who
  has been let go ends in a real blocker checkpoint addressed to the person who
  asked, not in silence.
- **8 Sep — a rule that looks like a bug and is the whole point.** A message to
  a switched-off employee is *held*, never delivered by starting them up:
  starting an engine costs real money and nothing about "a colleague sent you a
  note" justifies spending it. The subtlety worth a paragraph is that holding
  must not count as failing — retries top out after about forty-three minutes,
  so if it did, a message to someone on holiday would be thrown away.
- **8 Sep — who is allowed to say a message was read.** Bureau's own supervisor
  records it, from an observable event (the employee starting its next turn),
  because an agent reporting its own behaviour is not evidence. Same family as
  "an agent may not un-report that it finished".
- **8 Sep — glossary additions:** *the router*, *held*, *dead-lettered*,
  *at-least-once*. The last is the honest promise Bureau actually makes: a
  message may arrive twice after a crash and will not vanish.
- **8 Sep — two bugs worth telling, neither found by inspection.** A query
  copied faithfully from the specification would have ignored every message an
  employee ever sent, because "no next attempt scheduled" never satisfies "next
  attempt is due". And asking for the list of pending questions returned an
  error for every question that has options — found while proving that the
  notification and the list were looking at the same thing.

### Affects the business overview (`bureau-at-work.html`)

Watch for: anything moving from "completing the picture" to "working today", new
things a user could ask for, changes to what can honestly be claimed.

- **8 Sep — "Bureau can ask you a question, and remember your answer" moves
  toward working today.** An employee that hits a fork raises a real question
  with real options, each stating what it will do; an answered decision is
  appended to `project/decisions.md` in plain markdown the user can read and
  edit; and asking the same question twice is now prevented rather than
  discouraged. **State the honest limit:** there is no screen yet — the
  question and the answer are real, the place a person sees them is M9.
- **8 Sep — "it will not act behind your back while you are away" is now
  demonstrable.** An unanswered question resolves only to an option its author
  designated as safe, never to "proceed"; a question with no safe option never
  auto-resolves at all; and nothing auto-resolves in the first ten minutes after
  the app opens.
- **8 Sep (M8 session 2) — "your answer actually reaches the person waiting for
  it" moves to working today.** Previously the answer was recorded and went
  nowhere. It is now delivered, and — the part worth claiming — an answer given
  while that employee is switched off is held until they next start, rather than
  being lost. **The honest limit is unchanged:** there is still no screen; M9.
- **8 Sep — "Bureau will not lose your employees' questions" is now claimable.**
  A question that cannot be delivered is retried, and if it truly cannot be
  delivered it comes back to you as a question with the original text attached
  and two things you can do about it. It never expires on its own.
- **8 Sep — Bureau can now interrupt you, carefully.** A desktop notification
  fires only when the window is not focused and the question is genuinely
  blocking, once per question, and only if notifications are on. Proven working
  inside the real packaged app, not just in tests.
- **8 Sep — a limit to state plainly rather than imply away.** Bureau controls
  which network *tools* an employee may use. It does not stop a shell command
  from reaching the internet, and there is now a test that asserts that
  limitation as a fact. If the page says anything about safety, this is the
  sentence that keeps it honest.

---

---

## Pending, added 9 Sep 2026 (M9 session 1 — the chat read path)

Appended, not applied. Regeneration is still M11 and M15 only.

### Affects the blueprint (`bureau-blueprint.html`)

- **9 Sep — the system map gains a renderer that is no longer a stub.** There is
  a real chat view (`src/renderer/src/components/chat/`), a real Core-side chat
  writer (`src/main/chat/`), and a real push path from one to the other. If the
  map shows the renderer as an empty shell, that is now wrong.
- **9 Sep — a new arrow, and it is the first of its kind: the Core pushes
  state changes to an open window.** `src/main/ipc/liveState.ts` subscribes to
  the activity log and broadcasts a fresh `checkpoints` slice on any
  `checkpoint.*` event. Until this session the renderer hydrated once per window
  load and never heard about a change again (`pushPatch` had no callers). Worth
  drawing, because it is the mechanism M12's floor and M14's Board both inherit.
- **9 Sep — the `on.chatMessage` event now carries an envelope, not a bare row:
  `{ seq, message }`.** If the IPC diagram lists the seven pushed events, this
  one's payload shape changed and the reason is worth a caption: a per-window
  channel sequence is what lets the renderer notice a dropped push.
- **9 Sep — `conversation_messages` gains real writers, but only from
  `src/main/chat/`.** If the ERD marks that table as "no writer", it now has
  one; if it marks the `seq` column as in use, it is still not — that column is
  deliberately left unwritten (the gap detection lives on the channel instead).
- **9 Sep — the event taxonomy is a closed enum.** `src/shared/models/eventTypes.ts`
  is the list, and `EventTypeSchema` enforces it in both directions (a
  typecheck failure for an undocumented emitter, a schema failure for an
  undocumented row). If the blueprint shows §5.2's taxonomy, it can now be
  described as *enforced* rather than *documented* — and it gained seven
  `employee.*` types that had been emitted since M3 without being written down.
- **9 Sep — two joins change colour.** `checkpoints → the chat card` is now a
  real, live join (§9.4's surface 1). `employees.is_director` still has **no
  writer** — but session 2 is committed to giving it one through `hireEmployee`,
  so if the blueprint captions it as a permanent gap, that caption has a
  deadline now.
- **9 Sep — a fixed defect worth a note if the blueprint discusses the push
  mechanism at all:** sequence numbers were global across windows, which would
  have left a second window permanently and silently stale the moment anything
  pushed. Now per window and per channel.

### Affects the walkthrough (`building-bureau.html`)

- **9 Sep — the first milestone with something to look at.** Nine milestones of
  machinery, then a screen. The narrative beat is worth keeping precise: this
  session built the half where you can *read* a conversation, not the half where
  you can hold one, and the box you type into was left until second **on
  purpose** — a text box wired to a system that cannot reply is a worse lie than
  no text box.
- **9 Sep — a bug that had never happened and could not have happened yet.** The
  shared sequence counter (see the blueprint note above) is a good story for this
  page: a mechanism whose correctness was asserted in a code comment, exercised
  by nothing for four milestones, and wrong. The lesson generalises the M3–M6
  audit's central finding one step earlier — that finding was about tests that do
  not reach the production path; this is about a *mechanism* no production path
  reaches, where the comment is the only thing anyone ever checked it against.
- **9 Sep — the interrupted-reply story.** A real process killed mid-sentence,
  the app restarted on the wreckage, and the surviving half-sentence marked as
  incomplete. The point to land: the danger was never that the message would look
  ugly, it is that it would look **finished**.
- **9 Sep — new glossary terms:** *interrupted*, *streaming*, *remedy*, *pushed
  change*. All four are already written up in HOW-IT-WORKS Part Seventeen,
  sections 109–115.
- **9 Sep — a process beat:** the product owner amended the brief mid-session to
  add "the Core must not encode presentation", and it changed real code before it
  was written — a Core-authored button label and a UI route both came out of the
  design. Good illustration of a constraint arriving in time to be cheap.

### Affects the business overview (`bureau-at-work.html`)

- **9 Sep — "there is no screen yet" is no longer the honest limit, and the
  replacement moved twice in one day. This entry is the current version; do not
  add a third beside it.** Every M8-era entry on this page ends with some
  version of *the question and the answer are real, the place a person sees them
  is M9*. That clause is **wrong** and should be rewritten wherever it appears.
  Session 1's replacement — *"you cannot yet start one, because there is nothing
  to type into"* — is **also wrong now**, because session 2 built the box.
  **The current honest limit, after M9 session 2:** you can read a conversation
  and you can take part in one — type, attach a file, answer with a chip, run a
  command, approve a brief — **and nothing answers.** The gap is no longer the
  screen; it is that no Director produces a reply and nothing anywhere writes a
  brief. Both are the next milestone.
- **9 Sep — "Bureau asks you a question, and you answer it" moves to working
  today**, with the screen half now real: the question, every option with what
  choosing it would do, at most one recommendation with its reason, the deadline
  and what happens if it passes, and a box for the answer nobody offered.
- **9 Sep — a claim that can now be made and could not before: "it tells you
  when it did not finish."** A reply cut off by a crash comes back visibly
  marked rather than looking like a complete answer. Proven by killing a real
  process mid-sentence.
- **9 Sep — a claim to keep making carefully: "it never shows you a cost it
  does not know."** An engine that reports no usage renders *"cost not reported
  by this engine"*, never `$0.00`. This page can now point at a screen rather
  than at a rule.
- **9 Sep — and one claim NOT to make.** §1's definition-of-done line ("describe
  a project in chat → interview → brief/plan approval → deliverable") is
  **in progress, read half only**. Nothing on its happy path can be walked end to
  end by a person yet. If this page describes the flow, it must describe it as
  the thing being built toward.

## Pending, added 9 Sep 2026 (M9 session 2 — the chat write path)

Appended, not regenerated. Read this **together with** the M9 session 1 block
above: several of those entries were written when you could only read a
conversation, and session 2 moved the line again. Where the two disagree,
this block is current — and the session 1 business-overview entry was
**rewritten in place** rather than contradicted from below.

### Affects the blueprint (`bureau-blueprint.html`)

- **9 Sep — the join map's biggest single change since it was drawn.** The
  arrow from *the person* into the system now exists. Previously every arrow
  started inside Bureau; the user was a reader. The new line is: **composer →
  `chat.send` → conversation row → outbox → message router → a real
  Director's engine.** Six boxes, all of them already on the map, joined for
  the first time.
- **9 Sep — the Director stops being a dotted box.** It is a real employee
  row with a real desk in the corner office, hired through the same path as
  anyone else. Three things previously drawn as "written but unreachable"
  move to solid: the budget reserve, the circuit-breaker exemption, and the
  router's `director` lookup.
- **9 Sep — the return arrow is half real too.** A message addressed to
  `user` now lands in the conversation (§J.4 closed). So the router has both
  directions; what it does not have is anything *generating* the Director's
  own replies.
- **9 Sep — "the screen keeps itself current" is now true of two things, not
  one.** The blueprint's live-update arrow was drawn for pending decisions
  only. It now also carries the roster, which is what makes the Resume
  control disappear when it should. Small on the map; the difference between
  an undo that works and one that appears not to.
- **9 Sep — the boundary that has NOT moved, and it is the one the map is
  for.** There is still no producer of Director output and no writer of a
  brief. Drawn honestly, the picture is: a complete path in, a complete path
  back, and an empty box in the middle labelled M11.

### Affects the walkthrough (`building-bureau.html`)

- **9 Sep — M9 is done, and the milestone's own gate was deliberately not
  met.** This is the first time that has happened and it is worth explaining
  rather than glossing: the gate needed three things, two of which belong to
  a later milestone, and one of those is checkable in a sentence (nothing in
  the codebase writes a brief). The milestone closed on a *named substitute*
  gate that it did meet, with the original handed to M11 in the build plan
  itself. A good milestone-ordering story.
- **9 Sep — a new glossary-worthy idea for the ordering chapter: seeding.**
  Putting a row in the database by hand to test the thing that acts on it is
  ordinary. Doing it to make a flow *look* complete is not. And doing it for
  something the product's own code should be able to create is worst of all,
  because it hides a missing piece. All three came up this session.
- **9 Sep — the `/pause` story belongs here, in the chapter about why the
  order matters.** A safeguard's own comment claimed it was safe *because* an
  undo existed; nothing called the undo, and nothing had called the safeguard
  either, so neither half had ever been exercised. Adding the user-facing
  half would have shipped a trap. It was caught in review, before code.
- **9 Sep — four new glossary terms:** *the Director* (now a person, not an
  idea), *slash command*, *superseded version*, *unread*. All four are
  written up in HOW-IT-WORKS Part Eighteen, sections 118–130.

### Affects the business overview (`bureau-at-work.html`)

**Read the rewritten entry in the session 1 block above first** — it carries
the current honest limit and replaces both earlier versions.

- **9 Sep — "describe what you want built" moves from designed to
  half-working.** You can type it, attach a file to it, and it reaches a real
  Director. What does not happen is a reply. Any description of the flow must
  stop exactly there rather than trailing off optimistically.
- **9 Sep — a genuinely new claim, and a good one for a business reader:
  "the controls work when nothing else does."** `/pause` stops every employee
  while a reply is streaming; `/budget` answers when the day's money is
  already spent. Both are handled by Bureau itself rather than by the AI,
  which is why they still work in exactly the moments you would reach for
  them. This is the clearest example on the page of the product's safety
  story being structural rather than promised.
- **9 Sep — a claim to make carefully: "you can stop it, and you can start it
  again."** True now, and it was not true a day ago — pausing was reachable
  and un-pausing was not, in a way that survived restarting the app. Worth
  one sentence about the pause always having a visible way back, and no
  sentence at all about the near miss.
- **9 Sep — "nothing is built before you approve it" can now point at
  something.** Approving a brief is a real, recorded action, and a version
  you have replaced by editing it can no longer be approved. But the page
  must not imply the loop is closed: nothing writes a brief yet, so what
  exists is the *approval*, not the thing to approve.
- **9 Sep — a claim NOT to make.** Do not say Bureau "asks you what you
  want". It does not ask anything yet.
- **9 Sep — accessibility is now a claim this page can make honestly.** The
  chat is fully keyboard-operable, and no status anywhere in it is conveyed
  by colour alone — proven by removing every colour from the app and checking
  the states are still distinguishable. Scoped to chat; the product-wide pass
  is M14, so the sentence must say "the conversation", not "Bureau".

## What each page is for

Regenerating well means keeping each page's job distinct — they are not three
versions of the same document.

| Page | Job | Reader | Test of a good rebuild |
|---|---|---|---|
| `bureau-blueprint.html` | The system as diagrams. Almost no prose. | Anyone wanting the shape in one look | Could someone point at the boundary between built and unbuilt without reading a word? |
| `building-bureau.html` | The sixteen milestones in plain language, plus a glossary. | Someone new to the project | Could a non-programmer follow why the order is what it is? |
| `bureau-at-work.html` | What Bureau does and what you would use it for. No development detail. | A business reader | Does it claim only what is actually true today, with the rest clearly marked as designed? |

The blueprint's **join map** is the highest-value thing in the set: it is the only
place the proven-versus-unbuilt boundary is drawn in one picture, and that
boundary is what moves most.

---

## Regeneration history

| Date | Pages | Milestone | Notes |
|---|---|---|---|
| 29 Aug 2026 | walkthrough, business overview | M6 in flight | First versions |
| 7 Sep 2026 | blueprint | M7 + boundary check | First version; ERD redrawn once after review |

---

## Notes for the next regeneration — appended after M10 (9 Sep 2026)

All three pages rebuild after **M11**, not now: M11 is the Director, and it
changes the answer to "what can this actually do?" more than anything since
M5. These are the notes to fold in when that happens.

### For `bureau-blueprint.html`

- **`memory` and `memory_fts` stop being a store nothing reads from.** On the
  M7 blueprint they were drawn as built-but-unconsumed, which was accurate.
  They now have real readers on both sides: `Supervisor.assign()` composes a
  memory pack from them at task assignment, and `bureau_read_memory` searches
  them for an employee. The join map's proven-versus-unbuilt boundary moves
  around this.
- **One new table**, `memory_proposals` — §12.4's queue. Worth drawing with
  its arrow pointing *at* `checkpoints` rather than the other way, because
  that direction is a deliberate design decision (the checkpoint holds no
  copy of the proposal list, so a count cannot go stale) and the diagram is
  the only place that asymmetry is visible at a glance.
- **The memory write path is a second confinement boundary**, and the
  blueprint currently draws only one (the policy evaluator). For Bureau's own
  tools the evaluator short-circuits to allow, so the guard is in the
  handler — `resolveMemoryTarget`. If the blueprint has a "where is invariant
  #5 enforced?" element, it now has two answers, not one.

### For `bureau-at-work.html`

- *"Bureau remembers what you decided"* moves from designed toward working,
  **with an honest limit that has to be in the sentence**: a decision you
  answer is written down, and an **employee** starting a task afterwards is
  given it. The **Director** — the thing you actually talk to — cannot read
  memory yet, because it has no tools of its own until M11. So the true
  claim today is *"your team remembers"*, not *"Bureau remembers"*, and the
  page should not blur the two.
- The other genuinely user-facing thing: **memory is markdown files on your
  own disk**, editable in any text editor, and Bureau notices when you change
  them. That is a real differentiator for a business reader and it is fully
  true today — including the "if Bureau disappears, the knowledge does not"
  half, which is testable rather than aspirational.
- **Do not claim semantic search.** The setting exists and honestly reports
  that no model is installed. A page saying "semantic search, off by default"
  would read as "available", which it is not.

### For `building-bureau.html`

- M10's one-line story: *the milestone that makes "never ask twice" real.*
- Worth one sentence in the glossary: a **memory pack** is what an employee
  is handed when it starts work, and the activity log records which notes
  went in — so "what did it know?" is answerable rather than inferred.

---

## Notes for the next regeneration — appended after the M0–M2 audit fix session 3a, "the surface" (10 Sep 2026)

**Regenerate nothing now.** M11 is still the next regeneration point. This
session changed only what a user sees, but two of the changes contradict
sentences currently sitting in the pages, which is exactly what this list
is for.

### For `bureau-at-work.html`

- **"There is no screen yet" is over.** Whatever hedging the page carries
  about the interface being unbuilt is now wrong in a specific, checkable
  way: the window has a working title bar, a draggable persisted splitter,
  a minimum size, error states with real action buttons, and a palette that
  passes WCAG AA in both themes with a test that keeps it there. It is
  still provisional — the product owner expects to redesign it — but
  "provisional" and "absent" are different claims and the page should make
  the one that is true.
- **The title bar now tells the truth about cost, and that is a business
  claim, not a technical one.** It previously rendered a hardcoded `🔔 0`
  and an ellipsis that, on a fresh install, never resolved. It now shows
  the real pending-decision count, and distinguishes three states a money
  figure can be in: not asked yet, **"cost not reported"**, and a real
  `$0.00`. The middle one is the differentiator worth a sentence — Bureau
  refuses to print a dollar figure it cannot stand behind, and §14.1's
  disclosure ("cost not reported for 1 employee") is now expressible
  rather than aspirational.
- **A caution for whoever writes that sentence.** The unmetered count is a
  deliberate **superset**: it counts every unmetered employee on the
  roster, not only those that ran today, because an unmetered engine
  writes no usage rows at all and "ran today" is therefore unknowable for
  precisely the employees in question. Over-disclosing is the safe
  direction, but the page must not claim per-day precision it does not
  have.
- **Accessibility is now a checkable claim rather than a hopeful one.**
  §14.7's WCAG AA "verified on both themes" was marked done at M2 and was
  false — nothing verified anything. It is true now and mechanically
  enforced. If the page mentions accessibility at all, this is the one
  place it can point to.

### For `bureau-blueprint.html`

- **The error path is a real path now and it has a shape worth drawing.**
  `IpcErrorAction` existed and was rendered nowhere for nine milestones. If
  the blueprint draws the IPC envelope, the arrow now continues past the
  boundary into a single renderer component (`ErrorNotice`) rather than
  stopping at the bridge.
- **A second "translate, never leak" boundary joins the redactor.**
  `dispatchIpcCall` logs the raw thrown error and returns a fixed sentence;
  `UserFacingError` is the marker that lets a domain message through
  deliberately. If the blueprint has a "what crosses the boundary" element,
  raw error text is now explicitly one of the things that does not.
- **`liveState` watches five slices, not two** (`checkpoints`,
  `employees`, `projects`, `tasks`, `settings`). If the push path is drawn
  with named slices, three arrows are missing. `company` is deliberately
  absent and the reason is worth the footnote: no event that changes a
  company row exists to hang it on.

### For `building-bureau.html`

- One line, and it belongs to the audit rather than to a milestone: **the
  session where the UI stopped lying.** A hardcoded zero in a notification
  bell is the cleanest possible violation of "every visual state maps to a
  real system state", and it sat one selector away from the truth for nine
  milestones.
- Worth a glossary sentence if the page has one: **"cost not reported"** is
  a real state in Bureau, not a fallback string — the database stores NULL
  for it, the transport carries it, and the renderer now has three
  renderings where it used to have two.

---

## Notes for the next regeneration — appended after the M0–M2 audit fix session 3b, "the record" (17 Sep 2026)

**Regenerate nothing now.** M11 is still the next regeneration point. This
session closed the M0–M2 re-audit. Almost everything it changed is in the
spec and the checks rather than the product, but four things contradict or
extend what the pages would say.

### For `bureau-blueprint.html`

- **The IPC event list shrinks from seven to six**, and four of the six are
  **declared but not yet sent** (`terminalChunk` and `activityEvent` → M14,
  `floorEvent` → M12, `toast` unassigned). Only `stateDelta` and
  `chatMessage` are live. `checkpointRaised` is gone: every §9.4 surface is
  served by the `checkpoints` slice. If the blueprint draws `on.*` arrows,
  draw two solid and four dashed — drawing six solid is the exact false map
  this session removed.
- **Two new boundary behaviours worth a box**: IPC rejections are now
  `ipc.*` activity events (`severity: security`, alongside `control.*`), and
  `chat.send` / `memory.write` / `packs.install` are rate-limited.
- **Four spec lists are now pinned to code in CI**, not one: §17.1, plus
  §5.1's schema, §5.2's taxonomy and §16.1's settings. If the blueprint has
  a "how the spec stays true" element, it has four arrows now.

### For `building-bureau.html`

- One line: **the session where the record got checked.** The audit that
  checked the code turned out to need checking itself — eight of its own
  claims were wrong in ways the fix sessions found by verifying before
  acting. That is a better story about how this project works than any
  single fix.

### For `bureau-at-work.html`

- **Security claim correction, and it matters for a business reader.** The
  spec's security table used to say S15 proves "zero egress" for a
  prompt-injection attack. It never did, and the test never claimed to.
  Bureau blocks the named network tools; it does **not** stop a shell
  command reaching the network. Any page sentence implying "an injected
  agent cannot send your data anywhere" must not be written.
