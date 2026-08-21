# Project checklist — the living version of §1.8 / §27 / §29

`docs/BUILD-SPEC.md` already contains a director-level exhaustive pass: §1.8 (what
"done" means), §27 (36-item risk register — what will go wrong and what we do
about it), and §29 (open questions only you can answer). That content is
frozen — it's the spec. This file is the **tracked, living version**: status
against every one of those items, updated every session, plus a parking lot
for things that come up in conversation and aren't in the spec yet.

Distinct from the other three tracking docs, on purpose:
- **`docs/BUILD-SPEC.md`** — the frozen spec. Changes only when a documented
  interface actually changes.
- **`PROGRESS.md`** — a changelog. One entry per session: what landed, what
  surprised us.
- **`CLAUDE.md`** — invariants. Rules that never change regardless of milestone.
- **`PROJECT-CHECKLIST.md`** (this file) — status. Updated whenever a risk
  gets mitigated, a milestone completes, or a new idea surfaces mid-session.

---

## 1. v1 definition of done (§1.8)

| # | Item | Status |
|---|---|---|
| 1 | Signed `.exe` installs on a clean Windows 11 machine and launches | Not started (M15) |
| 2 | Setup wizard: nothing installed → working first project, no terminal | Not started (M13) |
| 3 | Describe a project in chat → interview → brief/plan approval → deliverable, no terminal panel | Not started (M9/M11) |
| 4 | Three employees work in parallel, no git conflicts, 100-task soak | Not started (M5 soak, M15 full) |
| 5 | Office view: every sprite state maps to a real status, verified by test | Not started (M12) |
| 6 | Budgets and circuit breaker provably stop a runaway employee | Not started (M6) |
| 7 | Closing the app mid-task and reopening resumes cleanly, nothing lost | **In progress (M1)** |
| 8 | Two departments genuinely useful; a third definable via YAML alone | Not started (M7/M14) |
| 9 | Every claim in the app and README maps to a passing test | Not started (`claims.yaml`, M15) |

## 2. Milestones (§20/§28)

| Milestone | Goal | Status |
|---|---|---|
| M0 — Skeleton | Packaged app opens via `app://`, native modules load, Job Object containment | ✅ Done, CI green |
| M1 — Data layer | Durable state, survives a kill at any instant | 🔶 In progress |
| M2 — IPC + shell | Typed `window.bureau`, main-side validation, window layout, themes | Not started |
| M3 — Engine adapter + supervisor | `EngineAdapter`, `FakeAdapter`, Claude Code adapter, PATH resolution | Not started |
| M4 — Control channel + tool server | Agents can talk back to Bureau (nothing above this works without it) | Not started |
| M5 — Workspace + git | Worktrees, leases, commits, integration branches | Not started |
| M6 — Permissions + budgets | Policy evaluator, budgets, circuit breaker, redactor | Not started |
| M7 — Packs + roles + floor layout | Pack loader, engineering pack, director role, headless layout generator | Not started |
| M8 — Checkpoints | Full checkpoint system, message router | Not started |
| M9 — Chat UI | All message kinds, streaming, brief/plan/report/checkpoint cards | Not started |
| M10 — Memory | Retrieval packs, gated writes | Not started |
| M11 — Director core | Intake, brief, planning, assignment — first real end-to-end project | Not started |
| M12 — Floor rendering | Phaser scene, sprite states, floor-state test | Not started |
| M13 — Setup wizard | All eight steps, prerequisite install, engine connection | Not started |
| M14 — Board + Inspector + second pack | Board, Inspector, research-writing pack, operations pack | Not started |
| M15 — Package + harden | NSIS, signing, auto-update, E2E, soak, chaos, claim audit | Not started |

## 3. Risk register (§27) — tracked

Status legend: **Mitigated** (real code/test proves it) · **Designed-for**
(the schema/architecture already accounts for it, not yet exercised) · **Not
started** · **Accepted** (§27.4's honest no-full-mitigation risks — tracked,
not "fixed").

### 3.1 Will definitely happen in the first week (§27.1)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 1 | Native module ABI mismatch | M0 | ✅ Mitigated — `@electron/rebuild` postinstall, CI smoke test |
| 2 | Phaser assets 404 in packaged build | M0 | ✅ Mitigated — `app://` protocol, e2e-tested |
| 3 | `claude` not found after install | M3 | Not started |
| 4 | Preload can't `require` what you expect under `sandbox:true` | M0 | ✅ Mitigated — bundled preload, main-side validation |
| 5 | Windows path comparisons silently never match | M6 | Not started |
| 6 | PTY output arrives mid-escape-sequence | M3 | Not started |

### 3.2 Product risks (§27.2)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 7 | Director asks too many questions | M11 | Not started |
| 8 | Director asks too few, builds the wrong thing | M8/M11 | Not started |
| 9 | Plans too coarse | M11 | Not started |
| 10 | Agents report success on work that doesn't run | M8/M5 | Not started |
| 11 | Cost surprise | M6 | Designed-for — `budget_usd_micros` columns exist in M1's schema |
| 12 | Merge conflicts between parallel employees | M5 | Not started |
| 13 | The office feels like a gimmick | M12/M13 | Not started |
| 14 | Free-tier user hits a wall mid-project | M6 | Not started |

### 3.3 Technical risks (§27.3)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 15 | Engine CLI changes output format/flags | M3 | Not started |
| 16 | Director context exhaustion | M11 | Designed-for — `conversations.summary`, `director.compactAfterTurns` setting in M1 |
| 17 | Employee loops burning tokens | M6 | Not started |
| 18 | Orphaned agent processes after a crash | M0/M4 | ✅ Mitigated at the mechanism level (M0 Job Object); full loop needs M4's real supervisors |
| 19 | SQLite corruption | M1 | 🔶 In progress — WAL, single writer, backup-before-migration, `integrity_check` this session |
| 20 | FTS desync after `VACUUM` | M1 | 🔶 In progress this session |
| 21 | Very large repo makes worktrees slow/huge | M5 | Not started |
| 22 | Antivirus quarantines spawned CLIs | M15 | Not started |
| 23 | User edits files while an employee works on them | M5 | Not started |
| 24 | OneDrive/Dropbox sync corrupts a worktree | M13 | Not started |
| 25 | Long Windows paths break git | M5 | Not started |

### 3.4 Accepted — no full mitigation, stated honestly (§27.4)

| # | Risk | Position |
|---|---|---|
| 26 | Prompt injection from repo/fetched content | Contained via permissions, not prevented (§11.1 R3) |
| 27 | Shell commands can reach the network regardless of tool policy | No egress control at v1, documented |
| 28 | Model API keys are long-lived, unscopeable | Blast radius limited, not eliminated |
| 29 | A machine admin can do anything | Out of scope, as for any desktop app |
| 30 | Model quality not under our control | Process (criteria, validators, review), not magic |
| 31 | Agents can produce plausible, subtly wrong code | Reduced, not eliminated — user is the final reviewer |

### 3.5 Business and legal risks (§27.5)

| # | Risk | Owning milestone | Status |
|---|---|---|---|
| 32 | Non-commercial art licence poisoning the project | M12 | Not started — `ASSETS.md` + CI licence check |
| 33 | Trademark collision on the name | Before M15 | Not started |
| 34 | An engine's terms prohibiting orchestrated use | M3 | Not started — must read terms before listing an engine as supported |
| 35 | User believes Bureau is responsible for agent output | M9 (copy) | Not started |
| 36 | Copyleft dependency contaminating the licence | M15 (CI) | Not started |

## 4. Chaos scenarios to test explicitly (§27.6)

| # | Scenario | Covered by |
|---|---|---|
| 1 | Kill the app at 20 points across a task lifecycle | M1's kill-point test covers the **data-layer** version now; the full task-lifecycle version is `tests/chaos/`, M15 |
| 2 | Revoke API key mid-task | Not started (M6/M13) |
| 3 | Exhaust free-tier quota mid-task | Not started (M6) |
| 4 | Fill the disk during a commit | Not started (M5) |
| 5 | Corrupt `bureau.db` | 🔶 In progress this session — `integrity_check` + backup offer (mechanism only; no UI to "offer" from yet) |
| 6 | Delete a worktree externally while leased | Not started (M5) |
| 7 | Two employees write the same file | Not started (M5) |
| 8 | Employee produces a 500MB log file | Not started (M6) |
| 9 | Engine CLI uninstalled while running | Not started (M3) |
| 10 | Clock jumps backwards | Not started |
| 11 | README containing injection text | Not started (M6) |
| 12 | 10,000 events in one project, UI stays responsive | Not started (M9/M14) |

## 5. Open product-owner questions (§29) — unresolved

1. **Monetisation** — free/OSS, paid, or free-core + paid packs? Affects licence choice.
2. **Distribution name** — verify name/domain/GitHub org availability before M15.
3. **Telemetry** — default is none; stays none until you say otherwise.
4. **Voice** — push-to-talk + realtime mode, recommended v1.2, after text chat is excellent. See parking lot below — you raised this again today.
5. **Team/cloud features** — deliberately out of scope for v1.

## 6. Parking lot — ideas raised outside the spec, not yet implemented

| Date | Idea | Where it likely belongs | Status |
|---|---|---|---|
| 2026-08-21 | A spend-tracking "board" prop in the office floor — clickable, shows total spend, detail on click | M12 (floor props, §13) + M14 (Costs view, §16.1 already specs a Costs settings page) | Not started. Data it needs (`spend_usd_micros` columns, `usage` table) lands in M1. |
| 2026-08-21 | Chat/talk (voice) toggle when talking to the Director | Already §29 open question #4 — re-raised, not re-prioritized yet | Deferred per spec (v1.2) unless you want to move it up |

---

**How this file gets updated:** every session, before writing `PROGRESS.md`'s
entry, sweep this file — mark anything the session mitigated, add any new
risk or idea that came up, update milestone status. If a session doesn't
touch this file, that's a sign something worth tracking was missed.
