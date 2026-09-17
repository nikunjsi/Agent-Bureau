# M7–M10 spec trace (E-7)

Read-only trace of docs/BUILD-SPEC.md §6.2–6.8, §8.0 (Director role definition), §7.9 (four employee tools), §9.1–9.7, §12.1–12.5, §13.3, §14.2, §14.4, §14.9, §22.4, §28 M7–M10 against the code. Tracer had no access to PROGRESS/HOW-IT-WORKS/CHECKLIST/NEXT-VERSION/plan/audits.

## Sections completed
- [x] §6.2 Pack layout
- [x] §6.3 pack.yaml
- [x] §6.4 department.yaml
- [x] §6.5 role.yaml
- [x] §6.6 Shipping plan
- [x] §6.7 Pack loading and validation
- [x] §6.8 Hiring
- [x] §8.0 Director role definition
- [x] §7.9 Employee tools (four)
- [x] §9.1 Types
- [x] §9.2 Anatomy
- [x] §9.3 Batching
- [x] §9.4 Surfacing
- [x] §9.5 Timeouts
- [x] §9.6 Answering
- [x] §9.7 Message router
- [x] §12.1 Layers
- [x] §12.2 What goes where
- [x] §12.3 Retrieval
- [x] §12.4 Writes
- [x] §12.5 Decision log
- [x] §13.3 Layout generation
- [x] §14.2 Chat view
- [x] §14.4 Checkpoints view
- [x] §14.9 Memory view
- [x] §22.4 One-shot client
- [x] §28 M7
- [x] §28 M8
- [x] §28 M9
- [x] §28 M10

## §6.2 Pack layout
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.2-1 | L817 | `pack.yaml` at pack root | MET | src/main/packs/loadPack.ts:35,74; packs/engineering/pack.yaml, packs/operations/pack.yaml | M7 |
| 6.2-2 | L818-819 | `departments/<key>.yaml` | MET | src/main/packs/loadPack.ts:36,86-98; packs/engineering/departments/engineering.yaml | M7 |
| 6.2-3 | L820-825 | `roles/<key>.yaml` (engineering: architect, developer, tester, reviewer, devops) | MET | src/main/packs/loadPack.ts:37,101-113; packs/engineering/roles/{architect,developer,tester,reviewer,devops}.yaml | M7 |
| 6.2-4 | L826-834 | `prompts/<role>.md` and `prompts/_shared/{engineering-standards,definition-of-done}.md` | MET | files present under packs/engineering/prompts/; referenced via system_prompt_path/shared_prompts and checked at src/main/packs/validatePack.ts:135-170 | M7 |
| 6.2-5 | L835-838 | `templates/` (brief-software.md, plan-software.md, deliverable-repo.md) | NOT MET | no `templates/` dir in packs/engineering; grep `templates` over src/main, src/shared finds no reader | none in §28 |
| 6.2-6 | L839-841 | `skills/*.yaml` (run-tests.yaml, scaffold-project.yaml) | NOT MET | no `skills/` dir in any pack; role `skills` is only a string list (src/shared/models/pack.ts:126); grep `skills/` in src finds no loader | none in §28 |
| 6.2-7 | L842-843 | `assets/sprites/` optional department-specific art | NOT MET | no `assets/` dir in packs; no loader (grep `'assets'`, `sprites/` in src/main, src/shared). Optional per spec | none in §28 |
| 6.2-8 | L844-845 | `memory-seed/engineering-conventions.md` | MET | packs/engineering/memory-seed/engineering-conventions.md; consumed at src/main/memory/seedPackMemory.ts:63-79,89; called from src/main/packs/installPack.ts:150; test tests/integration/packs/packMemorySeed.test.ts | M7 |

## §6.3 pack.yaml
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.3-1 | L851-857 | Fields `key, name, version, description, author, license, bureau_min_version` | MET | src/shared/models/pack.ts:51-63 (strict object, pack.ts:76) | M7 |
| 6.3-2 | L859 | `departments: [...]` | MET | src/shared/models/pack.ts:64; cross-checked against departments/ at src/main/packs/validatePack.ts:93-99 | M7 |
| 6.3-3 | L862 | `requires.tools` — "prerequisites this pack needs; surfaced in the wizard" | PARTIAL | parsed at src/shared/models/pack.ts:65-71; no consumer surfaces it (grep `requires.tools`/`manifest.requires` in src: no hits outside schema/scaffold). Wizard is M13 | M13 |
| 6.3-4 | L863 | `requires.engines` — "at least one must be available" | PARTIAL | parsed at src/shared/models/pack.ts:68; nothing checks engine availability against it (grep `requires.engines`, `manifest.requires` in src: none) | none in §28 |
| 6.3-5 | L865 | `project_kinds` | MET | src/shared/models/pack.ts:72 (parsed; no behaviour stated) | M7 |
| 6.3-6 | L867-875 | Optional `role_options_schema`: flat key→primitive-type map; omitted ⇒ role_options only checked to be an object | MET | src/shared/models/pack.ts:47,74; src/main/packs/validatePack.ts:265-290 (omitted branch :269-275; object-ness via pack.ts:162) | M7 |
| 6.3-7 | L878 | `version`/`bureau_min_version` strict `major.minor.patch`; prerelease/build metadata rejected at parse time | MET | src/shared/models/semver.ts:16-23; used at src/shared/models/pack.ts:58,63; test tests/unit/models/semver.test.ts | M7 |
| 6.3-8 | L880 | Shipped packs declare the real floor they need (not illustrative 1.0.0) | MET | packs/engineering/pack.yaml:11, packs/operations/pack.yaml:10 (`"0.0.1"` = package.json version) | M7 |

## §6.4 department.yaml
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.4-1 | L885-888 | `key, name, description, roles` | MET | src/shared/models/pack.ts:80-85; roles↔roles/ cross-check src/main/packs/validatePack.ts:111-118 | M7 |
| 6.4-2 | L889-890 | `room.preferred_size {w,h}` | MET | src/shared/models/pack.ts:86-90; persisted as preferred_w/h src/main/packs/installPack.ts:102-103 | M7 |
| 6.4-3 | L891-894 | `room.theme {floor, wall, props}` | MET | src/shared/models/pack.ts:91-98 (optional); persisted src/main/packs/installPack.ts:116-122 | M7 |
| 6.4-4 | L895 | `default_hires` — "who exists when this department is first added" | PARTIAL | parsed src/shared/models/pack.ts:102 and validated to name in-pack roles src/main/packs/validatePack.ts:119-125; nothing hires them: `company.addDepartment` is `stub('M13')` at src/main/ipc/handlers/company.ts:156 (grep `default_hires` in src: no runtime consumer) | M13 (per stub; not in §28 M13 list: none in §28) |

## §6.5 role.yaml
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.5-1 | L901-965 | Every field of the full reference is accepted (key…role_options); unknown keys rejected | MET | src/shared/models/pack.ts:115-164 (`.strict()` at :164); persisted src/main/packs/installPack.ts:219-250 | M7 |
| 6.5-2 | L909-911 | `system_prompt_path`, `shared_prompts` point at pack prompt files | MET | src/shared/models/pack.ts:123-124; existence checked src/main/packs/validatePack.ts:135-170 | M7 |
| 6.5-3 | L914 | `deliverable_types` — what the role produces | MET | src/shared/models/pack.ts:127 (RoleDeliverableKindSchema, src/shared/models/enums.ts:156) | M7 |
| 6.5-4 | L915-920 | `input_types` enum `code`/`document`/`spreadsheet`/`image`/`pdf`/`any`; empty = no declared restriction | MET | src/shared/models/pack.ts:30-37,128 (default `[]`) | M7 |
| 6.5-5 | L919-920 | `input_types` enforcement | LATER | spec L919-920: "Enforcement is M13/M14" | M13/M14 |
| 6.5-6 | L923 | `model_preference` is abstract tiers (§7.5) | MET | src/shared/models/pack.ts:19,131; tiers src/shared/models/enums.ts:33 | M7 |
| 6.5-7 | L924-927 | `engine_options` optional, flat, one engine's shape; omit ⇒ engine defaults | MET | src/shared/models/pack.ts:132 (nullable default null); validated against engine_preference[0]'s schema at src/main/db/repositories/roles.ts:23-27 (at insert, inside install transaction) | M7 |
| 6.5-8 | L937 | Reference role denies `Bash(git *)` — Bureau sole committer | MET | packs/engineering/roles/developer.yaml `tools_deny` (`Bash(git *)`) | M7 |
| 6.5-9 | L941-943 | `network_allow: []` = role gets no network tools at all | MET | src/shared/policy/ruleLoader.ts:83-96 (negated domain_matches deny, reason text :91-92), applied unconditionally at src/main/controlChannel/policy/policyEvaluator.ts:103 | M7 |
| 6.5-10 | L942-943 | Non-empty `network_allow` REQUIRED when granted WebFetch/WebSearch | see 6.7-9 | — | M7 |
| 6.5-11 | L945-946 | `memory_scopes`, `memory_budget_tokens` | MET | src/shared/models/pack.ts:144-145; consumed src/main/memory/memoryPack.ts:118-119,209-218 | M7/M10 |
| 6.5-12 | L948-952 | `autonomy_default, max_turns, max_attempts, wall_clock_timeout_s, budget_usd` | MET | src/shared/models/pack.ts:147-151; `budget_usd` → integer micros at src/main/packs/installPack.ts:243 | M7 |
| 6.5-13 | L954-962 | `escalate_when`, `reports.on_complete/on_block` | MET | src/shared/models/pack.ts:153-159 (required non-empty) | M7 |
| 6.5-14 | L964-965 | `sprite_key`, `role_options: {}` | MET | src/shared/models/pack.ts:161-162 | M7 |

## §6.6 Shipping plan
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.6-1 | L974 | engineering pack ships: Architect, Developer, Tester, Reviewer, DevOps | MET | packs/engineering/roles/*.yaml (5); packs/engineering/departments/engineering.yaml:4; test tests/integration/packs/shippedPacks.test.ts:55,68 | M7 |
| 6.6-2 | L975 | research-writing pack ships (Researcher, Analyst, Technical Writer, Editor) | LATER | no packs/research-writing; spec L3923 (§28 M14 item 5) assigns it | M14 |
| 6.6-3 | L976 | operations pack contains the Director's role definition, created at M7 | MET | packs/operations/roles/director.yaml, packs/operations/prompts/director.md; see 8.0 | M7 |
| 6.6-4 | L976 | operations pack's Project Manager and QA | LATER | absent (packs/operations/departments/operations.yaml `roles: [director]`); spec L976 "rest of the pack completed at M14", L3923 | M14 |
| 6.6-5 | L977-979 | data / marketing / design are NOT v1 | MET | only packs/engineering and packs/operations exist | M7 |
| 6.6-6 | L970 | "the app's copy MUST match this table exactly" | NOT MET | no copy describing the shipped/upcoming pack set anywhere in the app: case-insensitive grep for "pack", "research-writing", "marketing", "v1.1" over src/renderer/src returns nothing | none in §28 |
| 6.6-7 | L981 | `bureau pack scaffold <name>` command | NOT MET | no `bin` in package.json; no scaffold command in scripts/ (build.mjs, dev.mjs, check*.mjs, specLists.mjs); only reachable via IPC `packs.scaffold` (src/main/ipc/handlers/packs.ts:154-182) | M7 (item 8) |
| 6.6-8 | L981 | Settings → Packs → Create button | PARTIAL | IPC exists (src/main/ipc/handlers/packs.ts:154, method list src/shared/ipc/methodList.ts:71); renderer has no Packs UI — src/renderer/src/components/SettingsPanel.tsx is a generic registry editor (:15-24 groups, no Packs), grep "pack" in src/renderer/src: no hits | M7 (item 8) |
| 6.6-9 | L981 | Scaffold "generates a valid skeleton" | MET | src/main/packs/scaffoldPack.ts:58-238; test tests/integration/packs/scaffoldPack.test.ts:54-64 (zero errors, zero warnings) | M7 |

## §6.7 Pack loading and validation
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.7-1 | L985 | Validated on install | MET | src/main/packs/installPack.ts:56-80 | M7 |
| 6.7-2 | L985 | Validated on startup | MET | src/main/index.ts:211-218 → src/main/packs/revalidateInstalledPacks.ts:53-102. No test calls `revalidateInstalledPacks` (grep in tests/: none) | M7 |
| 6.7-3 | L985 | Failing pack disabled with a readable error, never partially loaded | MET | errors collected with file+field: src/main/packs/loadPack.ts:40-45, validatePack.ts:56-70; install returns them src/main/ipc/handlers/packs.ts:140-148; test tests/integration/packs/validatePack.test.ts:217,234; tests/integration/ipc/packsHandlers.test.ts:113 | M7 |
| 6.7-4 | L988 | Check 1: pack.yaml parses + Zod; `bureau_min_version` satisfied | MET | src/main/packs/loadPack.ts:80-83; validatePack.ts:74-80; test validatePack.test.ts:44 | M7 |
| 6.7-5 | L989 | Check 2: every role references an existing department and existing prompt files | PARTIAL | install path passes other packs' departments (installPack.ts:64, validatePack.ts:84-107) and checks prompts (validatePack.ts:147-150). But startup revalidation calls `validatePack` WITHOUT `installedDepartmentKeys` (revalidateInstalledPacks.ts:63), so a role whose department lives in another installed pack passes install and is marked `failed` on the next boot | M7 |
| 6.7-6 | L990 | Check 3: prompt non-empty, under 32 KB cap | MET | src/main/packs/validatePack.ts:27,152-167; tests validatePack.test.ts:99,106,114 | M7 |
| 6.7-7 | L991 | Check 4: `tools_allow`/`tools_deny` parse against §11.3 grammar | MET | src/main/packs/validatePack.ts:181-184 → src/shared/policy/patternSyntax.ts:20-73; test validatePack.test.ts:126 | M7 |
| 6.7-8 | L991,L1004 | Check 4: name no tool reserved to Bureau (`bureau_`/`mcp__bureau__`), using the same function as the short-circuit | MET | src/main/packs/validatePack.ts:193-201 (`isBureauTool` from src/shared/policy/evaluator); test tests/integration/packs/s3PackWidening.test.ts:108 | M7 |
| 6.7-9 | L992 | Check 4a: network tool ⇒ non-empty `network_allow` (error); non-empty list with no network tool ⇒ warning | MET | src/main/packs/validatePack.ts:208-223; tests validatePack.test.ts:133,140,151 | M7 |
| 6.7-10 | L993 | Check 5: no pattern widens an immutable global deny | MET | src/main/packs/validatePack.ts:229-242 → src/shared/policy/immutableWidening.ts:266-293; test tests/integration/packs/s3PackWidening.test.ts:75-108 | M7 |
| 6.7-11 | L994 | Check 6: `role_options` matches declared schema | MET | src/main/packs/validatePack.ts:265-290; tests validatePack.test.ts:165,173,181 | M7 |
| 6.7-12 | L995,L1019 | Check 7: sprite keys resolve or fall back with a warning (seam: known-key list, names fallback) | MET | src/main/packs/validatePack.ts:294-303; src/shared/floor/sprites.ts:20-40; test validatePack.test.ts:190. spec note: L1019 | M7 (atlas M12) |
| 6.7-13 | L996,L1019 | Check 8: room sizes fit the floor or floor expanded (bounds sanity + width vs floor) | MET | src/main/packs/validatePack.ts:327-345 using MAX_ROOM_WIDTH_TILES from src/shared/floor/layout; test validatePack.test.ts:199. spec note: L1019 | M7 |
| 6.7-14 | L998 | Whole pack validated before any DB write, AND writes in one SQLite transaction; 4 roles with 1 broken ⇒ zero rows | MET | src/main/packs/installPack.ts:62-80 (validate first), :89-142 (one `db.transaction`); test tests/integration/packs/s3PackWidening.test.ts:120 | M7 |
| 6.7-15 | L1000 | `packs.enabled` never rewritten by system; failing pack keeps enabled=1, records `last_validation_status='failed'` + readable error | MET | src/main/packs/revalidateInstalledPacks.ts:65-80 (only `recordPackValidation`); test tests/integration/ipc/packsHandlers.test.ts:121 | M7 |
| 6.7-16 | L1000 | Failing pack's roles and departments "withheld" | PARTIAL | withheld at hire/fire via `isPackAvailable` (src/main/company/hireEmployee.ts:156, fireEmployee.ts:148; revalidateInstalledPacks.ts:109-113). Not withheld from `company.listDepartments` (src/main/ipc/handlers/company.ts:141-142, unfiltered) nor from floor layout input (src/main/company/persistFloorLayout.ts:39 filters only `departments.enabled`, not pack validation) | M7 |
| 6.7-17 | L1000 | `packs.list` reports the pack as unavailable, **with the reason** | PARTIAL | unavailable reported as `enabled:false` (src/main/ipc/handlers/packs.ts:51); `PackInfoSchema` has no reason/error field (src/shared/ipc/schemas/packs.ts:11-18), so `last_validation_error` is not returned | M7 |
| 6.7-18 | L1000 | Fixing the pack and restarting restores it with no user action | MET | revalidation writes `ok` when errors clear: src/main/packs/revalidateInstalledPacks.ts:65-80; availability reads status at :112 | M7 |
| 6.7-19 | L1000 | Startup revalidation does not delete a failing pack's roles | MET | src/main/packs/revalidateInstalledPacks.ts:57-99 performs no delete (only `recordPackValidation`) | M7 |
| 6.7-20 | L1002 | Emits `company.pack_validated`/`company.pack_validation_failed` only when outcome changes | MET | src/main/packs/revalidateInstalledPacks.ts:73-96. No test (grep `revalidateInstalledPacks` in tests/: none) | M7 |
| 6.7-21 | L1006 | Check 4 well-formedness: balanced parens, no empty terms, tool name not parenthesised, no `Tool()` | MET | src/shared/policy/patternSyntax.ts:30-40, :45-47, :59-61, :65-69 | M7 |
| 6.7-22 | L1008 | Check 5 exemplar-based; error names both the pattern and the rule | MET | src/shared/policy/immutableWidening.ts:68-163, :281-285 | M7 |
| 6.7-23 | L1012 | Pattern variables set to a fixed canonical synthetic set; a test demonstrates the vacuity against the real matcher | MET | src/shared/policy/immutableWidening.ts:48-53,330; test tests/unit/policy/immutableWidening.test.ts:105-114 | M7 |
| 6.7-24 | L1013 | Every exemplar run through the real evaluator against its named rule; mismatch throws | MET | src/shared/policy/immutableWidening.ts:193-210, called at :267; test tests/unit/policy/immutableWidening.test.ts:16 | M7 |
| 6.7-25 | L1015 | Broad `**`/`*` argglob allow is not a widening; targeted one is | MET | src/shared/policy/immutableWidening.ts:232-235,326-329; test immutableWidening.test.ts:71; s3PackWidening.test.ts:142 | M7 |
| 6.7-26 | L1015 | Tool-identity denies: any allow reaching the tool rejected, name comparison both directions | MET | src/shared/policy/immutableWidening.ts:218-221,302-321; test s3PackWidening.test.ts:100; immutableWidening.test.ts:49,56 | M7 |
| 6.7-27 | L1017 | Check 5 runs derived rules through `buildRuleSet` (id-collision, tier floor) | MET | src/main/packs/validatePack.ts:255-259 | M7 |

## §6.8 Hiring
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 6.8-1 | L1023 | Hiring instantiates a role as a named employee with a desk | MET | src/main/company/hireEmployee.ts:142-326; test tests/integration/company/hireEmployee.test.ts:69 | M7 |
| 6.8-2 | L1025 | Director proposes hires as a `decision` checkpoint, never automatic | LATER | no caller raises a checkpoint before `hireEmployee`; IPC `company.hire` calls it directly (src/main/ipc/handlers/company.ts:44-57). spec note: L1030 (checkpoint-gated caller is M11); §28 M11 item 12 "hire proposals" (L3867) | M11 |
| 6.8-3 | L1026 | Names from a bundled, culturally/gender-varied list | MET | src/shared/company/nameList.ts (EMPLOYEE_NAME_POOL); src/main/company/allocateName.ts:98-113. spec note: L1036 (no gender metadata) | M7 |
| 6.8-4 | L1026,L1032 | No two employees share a first name (incl. archived; case-folded) | MET | src/main/company/allocateName.ts:49-82, called on hire src/main/company/hireEmployee.ts:169-173; tests hireEmployee.test.ts:146,155,164,169 | M7 |
| 6.8-5 | L1026,L1032 | User can rename anyone; first-name rule applies on rename | MET | src/main/company/hireEmployee.ts:333-358 (event `company.employee_renamed` :346); IPC src/main/ipc/handlers/company.ts:94-111; tests hireEmployee.test.ts:252,269,292 | M7 |
| 6.8-6 | L1027 | On hire: allocate a desk in the department's room | MET | src/main/company/hireEmployee.ts:209-234,243-244 | M7 |
| 6.8-7 | L1027 | On hire: pick a sprite variant | MET | src/main/company/hireEmployee.ts:245; src/shared/floor/sprites.ts:55 | M7 |
| 6.8-8 | L1027 | On hire: create employee memory | MET | src/main/company/hireEmployee.ts:272-284; test hireEmployee.test.ts:82 | M7 |
| 6.8-9 | L1027 | On hire: emit `company.employee_hired` (exactly one event) | MET | src/main/company/hireEmployee.ts:289-319; test hireEmployee.test.ts:94 | M7 |
| 6.8-10 | L1027 | Animate the character walking in through the office door | LATER | spec note: L1030 ("The 'animate…' half is M12's") | M12 |
| 6.8-11 | L1028 | Firing archives memory rather than deleting it | MET | src/main/company/fireEmployee.ts:87-92 (archive row; memory files untouched), event :99-116; test tests/integration/company/fireAndRehire.test.ts:126 | M7 |
| 6.8-12 | L1028 | Rehired into the same role ⇒ resume with what they learned | PARTIAL | `rehireEmployee` keeps id/memory (src/main/company/fireEmployee.ts:131-200; test fireAndRehire.test.ts:70), but nothing in the app calls it: grep `rehireEmployee` in src/ finds only its definition; no IPC method. A user hire via `company.hire` creates a new id with empty notes | M7 |
| 6.8-13 | L1034 | Name-pool exhaustion fails closed, names the escape hatch, no auto-suffix | MET | src/main/company/allocateName.ts:28-36,112; test hireEmployee.test.ts:179 | M7 |
| 6.8-14 | L1038 | The Director cannot be fired | MET | src/main/company/fireEmployee.ts:49-57,71; test tests/integration/company/fireAndRehire.test.ts:225, hireDirector.test.ts:147 | M7 |
| 6.8-15 | L1038 | Pausing the Director is allowed | MET | src/main/ipc/handlers/employees.ts:64 (pause deliberately does not refuse the Director) | M7 |

## §8.0 Director role definition
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 8.0-1 | L1664 | Role lives at `packs/operations/roles/director.yaml`, ships with operations pack | MET | packs/operations/roles/director.yaml:1-73; packs/operations/pack.yaml; Director identity = `operations:director` src/main/company/directorRole.ts:25-29; test tests/integration/packs/shippedPacks.test.ts:94 | M7 |
| 8.0-2 | L1661 | Engine: one with `mcpServers` + `sessionResume` (PTY acceptable) | MET | packs/operations/roles/director.yaml:22 `engine_preference: [claude-code]`; packs/operations/pack.yaml `requires.engines: [claude-code]` | M7 |
| 8.0-3 | L1661 | Engine without MCP ⇒ Bureau says so plainly at startup | LATER | runtime behaviour, not role data; nothing checks it (grep `requires.engines` in src: none). §28 M11 item 1 (L3860) | M11 |
| 8.0-4 | L1662 | Model tier `capable` by default | MET | packs/operations/roles/director.yaml:25; test shippedPacks.test.ts:116 | M7 |
| 8.0-5 | L1666 | Tools: §7.9 Director tools + `Read(${project}/**)`, `Grep`, `Glob`; **no Write, Edit, Bash** | MET | packs/operations/roles/director.yaml:34-42 (allow Read(${project}/**), Grep(**), Glob(**); deny Write/Edit/MultiEdit/Bash); Bureau tools allowed by §23.2 short-circuit, not listed; test shippedPacks.test.ts:109-113 | M7 |
| 8.0-6 | L1665 | Worktree: none | LATER | not expressible in role YAML; DirectorSession "no worktree" is §28 M11 item 1 (L3860) | M11 |
| 8.0-7 | L1667 | Desk: the corner office (§13.5) | MET | src/main/company/generateFloorLayout.ts:202,331 (Director excluded from department desks, placed separately); test tests/integration/company/hireDirector.test.ts:110 | M7 |
| 8.0-8 | L1668 | Spend: no per-employee-daily cap; reserve rules govern | MET | packs/operations/roles/director.yaml:60 `budget_usd: null`; test shippedPacks.test.ts:118 (reserve itself is M6/M11, out of this scope) | M7 |
| 8.0-9 | L1669 | Autonomy fixed at `guided`; not user-configurable | PARTIAL | role default packs/operations/roles/director.yaml:53 (test shippedPacks.test.ts:117). The YAML comment (:51-52) says immutability "is enforced in code", but `employees.updateSettings` writes any autonomy for any employee including the Director (src/main/ipc/handlers/employees.ts:166-173, no `is_director` check); grep `is_director`/`isDirector` in src/shared/policy and src/main/controlChannel: no hits | M7 (role) / M11 |
| 8.0-10 | L1657,L1671 | Director is a long-lived session, invocation/queueing/coalescing | LATER | out of role-definition scope; §28 M11 items 1,4 (L3860,L3863) | M11 |

## §7.9 Employee tools (four)
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 7.9-1 | L1515 | `bureau_raise_checkpoint {type,title,context,options[],preview?,urgency}` — args shape | MET | src/main/controlChannel/toolHandlers/schemas.ts:83-90; MCP registration resources/bin/bureau-tools.ts:72; handler map src/main/controlChannel/toolHandlers/index.ts:34 | M8 |
| 7.9-2 | L1515 | Creates a checkpoint (§9) | MET | src/main/controlChannel/toolHandlers/raiseCheckpoint.ts:47-96 → `askCheckpoint`; test tests/integration/controlChannel/toolHandlers.test.ts:348 | M8 |
| 7.9-3 | L1515 | Validation rejects options without `consequence` | MET | CheckpointOptionSchema used at schemas.ts:87; structured error raiseCheckpoint.ts:35-42; tests toolHandlers.test.ts:370, tests/integration/checkpoints/validationOnRealPath.test.ts | M8 |
| 7.9-4 | L1518 | `bureau_propose_memory {scope,path,content,rationale}` | MET | schemas.ts:103-108; resources/bin/bureau-tools.ts:84; index.ts:35 | M10 |
| 7.9-5 | L1518 | Free for `employee` scope (written immediately) | MET | src/main/memory/memoryProposals.ts:117-151 (`memoryScopeRequiresApproval` src/main/memory/memoryTarget.ts:114-116); test toolHandlers.test.ts:447 | M10 |
| 7.9-6 | L1518 | A `whenever` checkpoint otherwise | MET | src/main/memory/memoryProposals.ts:153-198, raises `urgency: 'whenever'` at :238; test toolHandlers.test.ts:409 | M10 |
| 7.9-7 | L1519 | `bureau_read_memory {query, k?}` — FTS search over the scopes this role may read | MET | schemas.ts:112-115; src/main/controlChannel/toolHandlers/readMemory.ts:35-107 (scopes from `role.memory_scopes` :61-65, FTS via searchMemory :85-89); test toolHandlers.test.ts:471. Note: filters by scope only, not `scope_ref` (no `scopeRef` passed at :85), so e.g. `project` scope searches every project's notes | M10 |
| 7.9-8 | L1520 | `bureau_send_message {to,kind,subject,body}` — handoff to another employee or role | MET | schemas.ts:94-99; src/main/controlChannel/toolHandlers/sendMessage.ts:20-59 (outbox row, `from_addr` from token :37); routing done by router (see 9.7); test toolHandlers.test.ts:389 | M8 |
| 7.9-9 | L1548 | Arguments Zod-validated; invalid call returns a structured error, never a crash (for these four) | MET | raiseCheckpoint.ts:35-42,69-79; sendMessage.ts:21-28; proposeMemory.ts:37-44,71-76; readMemory.ts:36-43 | M4/M8/M10 |

## §9.1 Types
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.1-1 | L1900-1907 | Six types: decision, approval, review, information, blocker, permission | MET | src/shared/models/enums.ts:113-120 | M8 |
| 9.1-2 | L1902-1906 | decision/approval/information/blocker block work (for the dependent task) | MET | agent-raised checkpoints set `blocksTask` when a task exists (src/main/controlChannel/toolHandlers/raiseCheckpoint.ts:66) → src/main/checkpoints/ask.ts:94-101 → src/main/checkpoints/taskBlocking.ts:44-94; unblocked on answer answerCheckpoint.ts:225-232; test tests/integration/checkpoints/answering.test.ts:112 | M8 |
| 9.1-3 | L1904 | `review` blocks the **next phase** | LATER | nothing blocks a phase on a checkpoint (taskBlocking.ts blocks tasks only); phase review is §28 M11 item 12 (L3867) | M11 |
| 9.1-4 | L1907 | `permission` — the agent is held (§7.10) | MET | src/main/controlChannel/server.ts:345 (createPermissionCheckpoint on `ask`), hold awaited :395, released by src/main/checkpoints/answerCheckpoint.ts:436-438; test tests/integration/checkpoints/m8Gate.test.ts:145 | M8 |
| 9.1-5 | L1909 | `permission` carries `tool_call_id`, `tool_name`, `args_preview` | MET | src/shared/models/checkpoint.ts:110-116 (required for permission); written src/main/checkpoints/permissionCheckpoint.ts:99-101 | M8 |
| 9.1-6 | L1909 | Renders compactly: allow once / allow this command for this employee / deny | PARTIAL | compact two-button render src/renderer/src/components/chat/kinds.tsx (isPermission branch, "Allow once"/"Deny"); row offers only `allow_once`/`deny` (src/main/checkpoints/permissionCheckpoint.ts:107-122). "Allow this command for this employee" not built (code comment permissionCheckpoint.ts:18-30) | M8 |
| 9.1-7 | L1909 | Answered with a single keypress | NOT MET | no keyboard shortcut for permission answers: grep `event.key`/`hotkey`/`accessKey` in src/renderer/src finds only Composer, BriefEditor, FloorPane handlers; permission answer is two `<button>`s in kinds.tsx | M8/M9 |
| 9.1-8 | L1909 | `permission` never batched | MET | src/main/checkpoints/batching.ts:62-63; test tests/unit/checkpoints/batching.test.ts:60 | M8 |

## §9.2 Anatomy
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.2-1 | L1913-1927 | Every checkpoint has type, urgency (`blocking`/`soon`/`whenever`), title, context, options, preview, default_action, expires_at | MET | src/shared/models/checkpoint.ts:140-161,176-184; urgency enum src/shared/models/enums.ts:124; single insert door src/main/db/repositories/checkpoints.ts:58-64 (`NewCheckpointInputSchema.parse`) | M8 |
| 9.2-2 | L1918 | `options` omitted only for pure `information` | MET | src/shared/models/checkpoint.ts:98-105 | M8 |
| 9.2-3 | L1919-1923 | Option = `{id, label, detail, consequence (REQUIRED), recommended}` | MET | src/shared/models/checkpoint.ts:17-23 | M8 |
| 9.2-4 | L1932 | Every option states its consequence; rejected by validation otherwise | PARTIAL | `consequence: z.string().min(1)` (src/shared/models/checkpoint.ts:21) rejects missing/empty; a whitespace-only consequence is accepted — documented by test tests/unit/checkpoints/checkpointAnatomy.test.ts:53 | M8 |
| 9.2-5 | L1922,L1933 | At most one option `recommended` | MET | src/shared/models/checkpoint.ts:66-74; test checkpointAnatomy.test.ts:64 | M8 |
| 9.2-6 | L1933 | The Director explains *why* it recommends | LATER | Director behaviour; §28 M11 item 14 (L3873) | M11 |
| 9.2-7 | L1925,L1934 | `default_action` is always the safe, reversible choice | PARTIAL | schema only enforces that `default_action` names a real option (src/shared/models/checkpoint.ts:87-96) and expiry ⇒ default (:130-133,163-166); options carry no reversibility flag, so "safe/reversible" is authored, not checked (stated at checkpoint.ts:43-52). Structural only for `permission` (default hardcoded `deny`, src/main/checkpoints/permissionCheckpoint.ts:124) | M8 |
| 9.2-8 | L1931 | Written for a non-expert | PARTIAL | system-authored checkpoints use plain language (src/main/checkpoints/permissionCheckpoint.ts:104-106; src/main/messages/deadLetter.ts raise text; src/main/memory/memoryProposals.ts:239-266); nothing checks agent-authored text (raiseCheckpoint.ts passes title/context through) | M8/M11 |
| 9.2-9 | L1935 | Never ask what memory, the brief, or the workspace already answers; creation runs a duplicate-check against answered checkpoints in the same project first | PARTIAL | duplicate check against answered checkpoints in same project exists (src/main/checkpoints/duplicateDetection.ts:119-200, called first in src/main/checkpoints/ask.ts:70-89; test tests/integration/checkpoints/duplicateDetection.test.ts). Limited to `decision`/`information` types (duplicateDetection.ts:70-73,123-125); system paths call `insertCheckpoint` directly (ask.ts:31-33); memory, brief and workspace are not consulted | M8 |
| 9.2-10 | L1936 | Free text always accepted alongside the options | MET | src/main/checkpoints/answerCheckpoint.ts:153-161,184-187; UI src/renderer/src/components/chat/kinds.tsx (freeText input, `onAnswer({ optionId, freeText })`); test answering.test.ts:211. (Permission card offers no free text — see 9.1-6) | M8 |

## §9.3 Batching
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.3-1 | L1940 | Pending checkpoints arriving within `checkpoints.batchWindowSeconds` (default 90) are grouped | MET | grouping decision src/main/checkpoints/batching.ts:53-121 (window from first member :91-117); setting src/shared/settings/schema.ts:116; read at src/main/checkpoints/surfacing.ts:109-112; tests tests/unit/checkpoints/batching.test.ts:77,91,103; tests/integration/checkpoints/surfacing.test.ts:176 | M8 |
| 9.3-2 | L1940 | Grouped **by the Director into one message** | PARTIAL | the grouping result is used only to decide desktop-notification timing (src/main/checkpoints/surfacing.ts:121-140); no chat message is written for a batch (no `appendChatMessage` caller passes a checkpoint: callers are src/main/messages/router.ts:220 and src/main/ipc/handlers/chat.ts:116,126). Director is M11 (§28 M11) | M8 (item 4) / M11 |
| 9.3-3 | L1940 | "from **different employees**" | PARTIAL | grouping keys on project only (src/main/checkpoints/batching.ts:73-79); employee identity is not considered, so two checkpoints from the same employee also batch | M8 |
| 9.3-4 | L1940 | Only when none is `blocking` | MET | blocking checkpoints go to `immediate`, never into a batch (src/main/checkpoints/batching.ts:61-67); test tests/unit/checkpoints/batching.test.ts:50. Note: implemented per-checkpoint (a blocking one is excluded, the rest still batch), not "no batch if any is blocking" | M8 |

## §9.4 Surfacing
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.4-1 | L1944 | All four surfaces reflect one piece of state | MET | Core: `listPendingCheckpoints` shared by surfacing (src/main/checkpoints/surfacing.ts:106) and `checkpoints.listPending`; renderer: one `checkpoints` slice read by badge (src/renderer/src/components/RightPanel.tsx:90), title-bar bell (src/renderer/src/components/TitleBar.tsx:51) and chat card lookup (src/renderer/src/components/chat/ChatView.tsx:33,225-228); test tests/integration/checkpoints/surfacing.test.ts:229 | M8 |
| 9.4-2 | L1945 | (1) As a message in the Director chat (primary) | PARTIAL | the card exists and renders a `checkpoint`-kind conversation message whose `checkpoint_id` is still pending (src/renderer/src/components/chat/MessageRow.tsx:212-224; CheckpointCard src/renderer/src/components/chat/kinds.tsx:609+). Nothing in the Core writes such a message: `appendChatMessage` callers (src/main/messages/router.ts:220, src/main/ipc/handlers/chat.ts:116,126) never pass `checkpointId` (grep `checkpointId`/`kind: 'checkpoint'` in src/main). A raised checkpoint therefore never appears in chat | M8 (item 6) |
| 9.4-3 | L1946 | (2) Badge on the Checkpoints view | MET | src/renderer/src/components/RightPanel.tsx:87-90,111-114,163-172 | M8 |
| 9.4-4 | L1947 | (3) Floor: raising employee shows `?` bubble, walks to Director's office if `blocking` | LATER | no floor rendering (src/renderer/src/components/FloorPane.tsx:4-9 placeholder). Speech bubbles/walking are §28 M12 items 5,7 (L3887,L3889). Note §28 M8 item 6 (L3808) also lists "floor signal"; a title-bar count (TitleBar.tsx:40-54) is the only substitute | M12 |
| 9.4-5 | L1948 | (4) Desktop notification if window unfocused and urgency `blocking` | MET | src/main/checkpoints/surfacing.ts:153-162 (skip rules), :132-139 (notify); Electron half src/main/checkpoints/desktopNotifier.ts:28-43; wired src/main/index.ts:284; tests tests/integration/checkpoints/surfacing.test.ts:109,123,135,149,162 | M8 |

## §9.5 Timeouts
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.5-1 | L1952 | `blocking` → `checkpoints.blockingTimeoutMinutes` (default 60) | MET | src/main/checkpoints/expiry.ts:115-116; setting src/shared/settings/schema.ts:117; test tests/integration/checkpoints/timeoutAndGrace.test.ts:128. Note: `permission` rows (urgency `blocking`) use `permissions.maxHoldMinutes` instead (expiry.ts:110-112) | M8 |
| 9.5-2 | L1952 | …then `default_action` applies and the event is recorded | MET | sweep src/main/checkpoints/checkpointsTick.ts:92-112 → `answerCheckpoint` with `source:'timeout'` emitting `checkpoint.auto_resolved` with `appliedDefault` (src/main/checkpoints/answerCheckpoint.ts:202-222); permission hold expiry recorded at src/main/controlChannel/server.ts (closeUnansweredPermissionCheckpoint); started at src/main/index.ts:277-287; test timeoutAndGrace.test.ts:196; tests/integration/checkpoints/m8Gate.test.ts:202 | M8 |
| 9.5-3 | L1953 | `soon` → 4 hours | MET | src/main/checkpoints/expiry.ts:117-118; setting src/shared/settings/schema.ts:118 | M8 |
| 9.5-4 | L1953 | `whenever` → no expiry | MET | src/main/checkpoints/expiry.ts:119-123 | M8 |
| 9.5-5 | L1954 | A timeout never results in an irreversible action; if only irreversible options, cannot time out, task parks | PARTIAL | no `default_action` ⇒ no `expires_at` ⇒ never swept (src/main/checkpoints/expiry.ts:108; src/main/db/repositories/checkpoints.ts listExpiredPendingCheckpoints `expires_at IS NOT NULL`); tests tests/integration/security/checkpointTimeoutIsSafe.test.ts:110,170. Whether the designated default is actually reversible is not checked — see 9.2-7 | M8 |

## §9.6 Answering
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.6-1 | L1958 | Answering writes the answer | MET | CAS write src/main/db/repositories/checkpoints.ts (recordCheckpointAnswer, `WHERE status='pending'`), called at src/main/checkpoints/answerCheckpoint.ts:190-199; IPC src/main/ipc/handlers/checkpoints.ts:29-76; test tests/integration/checkpoints/answering.test.ts:112,290,318 | M8 |
| 9.6-2 | L1958 | Emits `checkpoint.answered` | MET | src/main/checkpoints/answerCheckpoint.ts:201-222 (user) and :421-430 (permission) | M8 |
| 9.6-3 | L1958 | Unblocks the dependent task | MET | src/main/checkpoints/answerCheckpoint.ts:224-232 → src/main/checkpoints/taskBlocking.ts:107-134 (only if blocked on this checkpoint); test answering.test.ts:258 | M8 |
| 9.6-4 | L1958 | Injects the decision into the relevant employee's next turn | MET | outbox row to `employee:<id>` src/main/checkpoints/answerCheckpoint.ts:315-371, delivered by router at idle (src/main/messages/router.ts:156-175); permission answers release the hold (answerCheckpoint.ts:436-438); tests tests/integration/messages/answeredCheckpointDelivers.test.ts:90,173 | M8 |
| 9.6-5 | L1958 | When the decision has lasting relevance, writes it to project memory | MET | every answered/auto-resolved `decision` checkpoint with a project is appended to `project/<id>/decisions.md` (src/main/checkpoints/answerCheckpoint.ts:243-255 → src/main/checkpoints/decisionLog.ts:72-94). "Lasting relevance" is interpreted as `type === 'decision'`; `information` answers are not written | M8 |
| 9.6-6 | L1960 | After restart, auto-resolution suppressed for `checkpoints.postRestartGraceMinutes` (default 10) even if timer expired while closed | MET | src/main/checkpoints/checkpointsTick.ts:75-90; grace derivation src/main/checkpoints/expiry.ts:80-90; setting src/shared/settings/schema.ts:119; `appStartedAtMs` captured src/main/index.ts:277; also applied to memory-proposal expiry checkpointsTick.ts:148-151; tests tests/integration/checkpoints/timeoutAndGrace.test.ts:141,173 | M8 |
| 9.6-7 | L1960 | The Director surfaces them in its restart report | LATER | only a `suppressedByGrace` count is returned (checkpointsTick.ts:84-89); Director is §28 M11 (L3856-3873) | M11 |

## §9.7 The message router
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 9.7-1 | L1964 | Employees and the Director communicate only through the durable `messages` outbox; the router owns delivery | MET | producers write outbox rows: src/main/controlChannel/toolHandlers/sendMessage.ts:33-45, askDirector.ts (insertOutboxMessage), src/main/checkpoints/answerCheckpoint.ts:342-357; delivery only in src/main/messages/router.ts:117-184, started src/main/index.ts:300 | M8 |
| 9.7-2 | L1968-1971 | Producer: BEGIN IMMEDIATE, INSERT message, UPDATE task state, COMMIT | PARTIAL | message insert is its own statement; where a producer also changes task state it is not in the same transaction — `answerCheckpoint` unblocks the task (answerCheckpoint.ts:224-232) and inserts the message (:342-357) as separate writes; no `db.transaction`/`BEGIN IMMEDIATE` around them (grep `transaction` in src/main/checkpoints/answerCheckpoint.ts: none) | M8 |
| 9.7-3 | L1972-1975 | Producer signals the router in-process (latency optimisation) | NOT MET | no signal; tick-only (5 s) — src/main/messages/router.ts:24-36 comment, :357-393; searched `messageRouter`/`runNow` callers in producers: none | M8 |
| 9.7-4 | L1969-1970 | Router selects pending `WHERE next_attempt_at <= now ORDER BY priority DESC, created_at` | MET | src/main/db/repositories/messages.ts:78-93 (also selects `next_attempt_at IS NULL`); test tests/integration/messages/router.test.ts:132,146 | M8 |
| 9.7-5 | L1971-1973 | Resolve address, deliver, `UPDATE delivered`; on failure attempts++, backoff | MET | src/main/messages/addressing.ts:28-56; router.ts:130-181 (markMessageDelivered :164, recordFailure :279-308) | M8 |
| 9.7-6 | L1980 | Delivery = `adapter.send(body, 'message')` at the next `idle` (§7.4) | MET | idle gate src/main/messages/deliverability.ts:140; send src/main/engine/supervisor.ts:390-393; test router.test.ts:98,250 | M8 |
| 9.7-7 | L1980 | Marked `consumed` implicitly when the next turn starts — recorded by the supervisor | MET | src/main/engine/supervisor.ts:859-883 (`message.consumed` per message); test router.test.ts:165 | M8 |
| 9.7-8 | L1981 | Target `off`: held, not auto-started; delivered when that employee next starts | MET | src/main/messages/deliverability.ts:136-139 (hold writes nothing), router.ts:134-139; tests router.test.ts:201,230; answeredCheckpointDelivers.test.ts:173 | M8 |
| 9.7-9 | L1982 | `role:<key>` resolves to the least-loaded idle employee of that role | MET | src/main/messages/deliverability.ts:157-187; test router.test.ts:273 | M8 |
| 9.7-10 | L1982 | No such employee ⇒ message held **and the Director is notified** so it can propose a hire | PARTIAL | held with reason `no_idle_employee_for_role` (deliverability.ts:55-58,186; test router.test.ts:305); no notification of any kind is produced (hold "writes nothing at all", deliverability.ts:28-35; router.ts:134-139). Director is M11 | M8 (item 9) / M11 |
| 9.7-11 | L1983 | Retry 5 s → 30 s → 2 min → 10 min → 30 min, then `dead_letter` | MET | src/main/messages/router.ts:62-73,300-303; test tests/integration/messages/retryAndDeadLetter.test.ts:74,125 | M8 |
| 9.7-12 | L1984 | Dead letter emits `message.dead_lettered` | MET | src/main/messages/deadLetter.ts:56-74 (markMessageDeadLettered then `message.dead_lettered`) | M8 |
| 9.7-13 | L1984 | If `kind = 'question'`, also raise a `blocker` checkpoint | MET | src/main/messages/deadLetter.ts:76-81,102-148 (type `blocker`, urgency `blocking`, no default ⇒ never auto-resolved); unreachable addresses dead-letter immediately router.ts:141-148; tests retryAndDeadLetter.test.ts:158,229,247; tests/integration/checkpoints/m8Gate.test.ts:264 | M8 |
| 9.7-14 | L1985 | Every message carries `idempotency_key`; redelivery safe; no exactly-once attempted | MET | column `TEXT NOT NULL UNIQUE` src/main/db/migrations/0001_initial.sql:389; model src/shared/models/message.ts:7,30; send-then-mark + requeue of prior-run unconsumed deliveries router.ts:156-164,316-339; tests router.test.ts:337,375,405 | M8 |

## §12.1 Layers
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 12.1-1 | L2353-2362 | Layer 1 markdown tree `memory/{company,user,project/<id>,role/<key>,employee/<id>}/…` | MET | layout src/main/memory/memoryStore.ts:93-104; scope enum via MemoryScopeSchema; walker src/main/memory/memoryStore.ts:252-290. The listed file names (standards.md, preferences.md, glossary.md, …) are not pre-created; only `employee/<id>/notes.md` (src/main/company/hireEmployee.ts:272-284) and `project/<id>/decisions.md` (src/main/checkpoints/decisionLog.ts) have writers | M7 |
| 12.1-2 | L2366 | Layer 2 SQLite FTS5 index, rebuildable from Layer 1 at any time | MET | src/main/memory/rebuildMemoryIndex.ts:41-101 (one transaction); tests tests/integration/memory/memoryStore.test.ts:175, memoryReconcile.test.ts:75 | M7 |
| 12.1-3 | L2368 | Layer 3 optional semantic search, off by default, behind a setting, local embedding model; everything works without it | PARTIAL | setting `memory.semanticSearch` default false (src/shared/settings/schema.ts:180); with it on, state reported `unavailable` and FTS used (src/main/memory/memoryPack.ts:98-100; surfaced in memory.injected, memory.search, bureau_read_memory). No embedding model or semantic search exists (grep `embedding` in src/main: only comments) | M10 (item 6) |
| 12.1-4 | L2370 | Markdown file written first, index row second, always | MET | src/main/memory/memoryStore.ts:115-135; remove path file-then-row src/main/ipc/handlers/memory.ts:207-213 | M7 |
| 12.1-5 | L2370 | Tested by deleting every row and proving search works, and by indexing a text-editor-written file | MET | tests/integration/memory/memoryReconcile.test.ts:75,98; memoryStore.test.ts:175,193 | M7 |
| 12.1-6 | L2372 | Index reconciled at startup, before every memory-pack composition, before every search, and on `memory.read` | MET | startup src/main/index.ts:151; pack composition src/main/engine/supervisor.ts:694; search src/main/controlChannel/toolHandlers/readMemory.ts:80, src/main/ipc/handlers/memory.ts:231 (and list :55); read memory.ts:84 | M10 |
| 12.1-7 | L2372 | Stat before hash; stamp (`file_mtime_ms`/`file_size`) is a skip hint; `content_sha256` decides | MET | src/main/memory/syncMemoryIndex.ts:99-120,227-240; test memoryReconcile.test.ts:211 | M10 |
| 12.1-8 | L2372 | `memory.reindex` hashes unconditionally (repair for a stamp that lied) | PARTIAL | `reindex({full:true})` wipes and rebuilds, hashing everything but clearing pins (src/main/ipc/handlers/memory.ts:245-251); `reindex({full:false})` calls `syncMemoryIndexFromDisk` (`kind:'all'`, stamp-skipping) at memory.ts:255. The `{kind:'force'}` scope that hashes unconditionally without wiping (syncMemoryIndex.ts:60-62,81) has no production caller (grep `'force'` in src outside that file: none); only a test uses it (memoryReconcile.test.ts:234) | M10 |
| 12.1-9 | L2372 | Deliberately no OS file watcher | MET | grep `fs.watch`/`watchFile`/`chokidar` in src/main: none | M10 |
| 12.1-10 | L2374 | Scope refs path-shaped; role memory nests `role/<pack>/<key>/`; walker recursive | MET | src/main/memory/memoryStore.ts:48-51,258-279,343-355; test memoryReconcile.test.ts:118 | M7 |
| 12.1-11 | L2376 | `pinned` lost only on full rebuild; ordinary re-index does not unpin | MET | upsert omits `pinned` from UPDATE (src/main/memory/memoryStore.ts:186-202); rebuild counts `pinsCleared` (rebuildMemoryIndex.ts:53-55); tests memoryReconcile.test.ts:155,183 | M7/M10 |
| 12.1-12 | L2378 | Memory unreachable to an employee's own file tools (`deny.system_paths` covers `AppData/Roaming/Bureau/`) | MET | src/shared/policy/immutableRules.ts:61-73 (`**/AppData/Roaming/Bureau/**`); exemplar verified against real evaluator src/shared/policy/immutableWidening.ts:113-122,193-210 | M7 |
| 12.1-13 | L2380 | Search input quoted into OR-of-terms; no tokens matches nothing | MET | src/main/memory/searchMemory.ts:44-50,62; tests memoryStore.test.ts:324,330,335 | M7 |
| 12.1-14 | L2382 | Pack seeding mirrors the tree; bare file ⇒ company; idempotent by hash; user-edited files never overwritten; skipped files reported | MET | src/main/memory/seedPackMemory.ts:37-80,89-116; reported in src/main/packs/installPack.ts:176,186-187; test tests/integration/packs/packMemorySeed.test.ts | M7 |

## §12.2 What goes where
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 12.2-1 | L2388 | `user/` — written by the Director, from explicit statements only | LATER | Director writer (`bureau_write_memory`) not present (grep `bureau_write_memory` in src: none); §28 M11 (L3856-3873). Today `user/` is writable by a person via `memory.write` (src/main/ipc/handlers/memory.ts:88-186) and proposable (gated) by employees (src/main/memory/memoryTarget.ts:114-116) | M11 |
| 12.2-2 | L2389 | `company/` — User, and Director with approval | PARTIAL | user writes: src/main/ipc/handlers/memory.ts:88-186 (source `user_stated`); Director-with-approval path absent (M11) | M10 / M11 |
| 12.2-3 | L2390 | `project/` — Director and employees | PARTIAL | employees via gated proposal (src/main/memory/memoryProposals.ts:153-198); system decision log (src/main/checkpoints/decisionLog.ts:72-94); Director path absent (M11) | M10 / M11 |
| 12.2-4 | L2391 | `role/` — employees, with approval for the shared scope | MET | gated for every scope except `employee` (src/main/memory/memoryTarget.ts:114-116); queued at memoryProposals.ts:153-198 | M10 |
| 12.2-5 | L2392 | `employee/` — the employee, freely | MET | src/main/memory/memoryProposals.ts:117-151; confined to the caller's own id src/main/memory/memoryTarget.ts:171-201; tests tests/integration/memory/memoryProposals.test.ts:155; memoryWriteConfinement.test.ts | M10 |

## §12.3 Retrieval
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 12.3-1 | L2396 | On task assignment, the supervisor composes a memory pack | MET | src/main/engine/supervisor.ts:663-667 → composeTaskMessage :686-719 → src/main/memory/memoryPack.ts:113-206; test tests/integration/memory/m10Gate.test.ts:109 | M10 |
| 12.3-2 | L2396 | …pinned company standards | PARTIAL | pinned `company` notes only (src/main/memory/memoryPack.ts:132). Pack-seeded standards are written unpinned (src/main/memory/seedPackMemory.ts:103-111, no `pinned`), so e.g. packs/engineering/memory-seed/engineering-conventions.md enters only via keyword search, not this clause | M10 |
| 12.3-3 | L2396 | …role playbook | PARTIAL | only *pinned* notes under `role/<pack>/<key>/` (memoryPack.ts:133); an unpinned `playbook.md` is not included by this clause | M10 |
| 12.3-4 | L2396 | …project decisions | PARTIAL | pinned `project/<id>/` notes (memoryPack.ts:134-136); `decisions.md` is written pinned (src/main/checkpoints/decisionLog.ts:83-91). A full rebuild clears pins (rebuildMemoryIndex.ts:75-76), after which decisions.md drops out of this clause | M10 |
| 12.3-5 | L2396 | …top-K search hits for the task text | MET | src/main/memory/memoryPack.ts:138-147 (K=8, scopes from role). Note: search filters by scope only, no `scope_ref`, so hits can come from other projects/roles/employees within an allowed scope (searchMemory called without `scopeRef`) | M10 |
| 12.3-6 | L2396 | …relevant past lessons | MET | src/main/memory/memoryPack.ts:148-165 (lessons.md/lesson.md); test tests/integration/memory/memoryPack.test.ts:151 | M10 |
| 12.3-7 | L2396 | Capped at `memory_budget_tokens` | MET | src/main/memory/memoryPack.ts:117-120,173-197 (whole notes, dropped count); test memoryPack.test.ts:188 | M10 |
| 12.3-8 | L2396 | What was injected recorded as `memory.injected` | MET | src/main/engine/supervisor.ts:707-715 with payload src/main/memory/memoryPack.ts:259-273; test m10Gate.test.ts:109 | M10 |

## §12.4 Writes
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 12.4-1 | L2400 | Employees propose memory writes through `bureau_propose_memory` | see 7.9-4 | — | M10 |
| 12.4-2 | L2400 | Writes to `employee/` are free | see 7.9-5 | — | M10 |
| 12.4-3 | L2400 | Writes to `company/` and `project/` require approval, surfaced as low-urgency `whenever` checkpoints | see 7.9-6 | — | M10 |
| 12.4-4 | L2402 | Batched into a single "review N proposed notes" checkpoint | MET | src/main/memory/memoryProposals.ts:169-170,219-288 (one open review per (project, phase), proposals attach to it; N derived in UI src/renderer/src/components/memory/MemoryView.tsx); test tests/integration/memory/memoryProposals.test.ts:217 | M10 |
| 12.4-5 | L2402 | Accept/reject per item | MET | src/main/memory/memoryProposals.ts:314-353 (review_each / accept_all / reject_all; exhaustive per-item check src/main/checkpoints/answerCheckpoint.ts:163-180); tests memoryProposals.test.ts:269,297 | M10 |
| 12.4-6 | L2402 | Raised at most once per phase | PARTIAL | reuse is limited to a review that is still pending (src/main/db/repositories/memoryProposals.ts:92-117 requires `c.status='pending'`); once a phase's review is answered, the next proposal in the same phase raises a new review checkpoint (memoryProposals.ts:224-227) | M10 |
| 12.4-7 | L2402 | Auto-rejected after `retention.memoryProposalDays` (default 14) | MET | src/main/memory/memoryProposals.ts:469-500; setting src/shared/settings/schema.ts:188; run on the checkpoints tick src/main/checkpoints/checkpointsTick.ts:144-170,226 (grace-respecting); tests memoryProposals.test.ts:339,388,406 | M10 |
| 12.4-8 | L2402 | The rejection is recorded, not silent | MET | `memory.write_rejected` per proposal with reason src/main/memory/memoryProposals.ts:407-441; emptied review closed as `auto_resolved` with reason `all_proposals_expired` (checkpointsTick.ts:155-163); test memoryProposals.test.ts:367 | M10 |

## §12.5 The decision log
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 12.5-1 | L2406 | Every answered `decision` checkpoint appended to `project/decisions.md` | MET | src/main/checkpoints/answerCheckpoint.ts:243-255 → src/main/checkpoints/decisionLog.ts:72-94 (read existing file, append, write through `writeMemory`); applies to user answers and timeouts; tests tests/integration/checkpoints/answering.test.ts:112,190 (9.6-5 is the same mechanism) | M8 |
| 12.5-2 | L2408-2414 | Entry format: `## date — title`, **Asked because**, **Options** (·-joined), **Chosen** — why, **Consequence** | MET | src/main/checkpoints/decisionLog.ts:97-119 | M8 |
| 12.5-3 | L2416 | Every employee reads this | PARTIAL | reaches an employee only through the pinned-project clause of the memory pack (src/main/memory/memoryPack.ts:134-136), i.e. only for roles whose `memory_scopes` include `project`, only while the pin survives (cleared by a full rebuild — see 12.3-4), and only if within `memory_budget_tokens`; test tests/integration/memory/m10Gate.test.ts:109 | M10 |
| 12.5-4 | L2416 | The same question is never asked twice | see 9.2-9 | — | M8 |

## §13.3 Layout generation (headless)
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 13.3-1 | L2438 | Floor generated from the company's departments, not hand-authored | MET | inputs read from `departments` (enabledOnly) and active employees src/main/company/persistFloorLayout.ts:31-61; generator src/main/company/generateFloorLayout.ts:194-399. (Departments of a pack whose validation failed are not excluded — see 6.7-16) | M7 |
| 13.3-2 | L2441,L2463 | Deterministic, seeded by company id, stable | MET | pure function, no RNG, explicit sorts (generateFloorLayout.ts:196-197), companyId recorded (:393); tests tests/unit/floor/generateFloorLayout.test.ts:165,173,187,297; tests/integration/company/m7Gate.test.ts:124 (byte-identical across restart). spec note: L2463 | M7 |
| 13.3-3 | L2442 | Step 1: Director's corner office, top-left 6×5, with a door | MET | src/shared/floor/layout.ts:32; generateFloorLayout.ts:208,333-351 (door :339); Director seated there :331,346; test generateFloorLayout.test.ts:52,75 | M7 |
| 13.3-4 | L2443 | Step 2: meeting room (centre-top 8×5), break area, entrance | MET | src/shared/floor/layout.ts:34-36; generateFloorLayout.ts:207-232,352-378; test generateFloorLayout.test.ts:65 | M7 |
| 13.3-5 | L2444-2445 | Step 3: each enabled department gets a rectangle sized `max(preferred_size, ceil(employees/4) desks + walking space)` | MET | src/main/company/generateFloorLayout.ts:93-108,234-249; enabled filter persistFloorLayout.ts:39; tests generateFloorLayout.test.ts:84,88,95 | M7 |
| 13.3-6 | L2446 | Step 4: pack left-to-right, top-to-bottom, 1-tile corridors | MET | src/main/company/generateFloorLayout.ts:166-192 (CORRIDOR_TILES=1, src/shared/floor/layout.ts:39); test generateFloorLayout.test.ts:104 | M7 |
| 13.3-7 | L2447,L2465 | Step 5: floor full ⇒ expand downward and re-pack; width never grows | MET | src/main/company/generateFloorLayout.ts:251-262 (grid.w fixed :394); test generateFloorLayout.test.ts:123,130 | M7 |
| 13.3-8 | L2448 | Step 6: desks in a grid inside each room, leaving a 1-tile aisle | MET | src/main/company/generateFloorLayout.ts:110-127; test generateFloorLayout.test.ts:136,147 | M7 |
| 13.3-9 | L2449 | Step 7: department props from the theme at fixed anchors | MET | src/main/company/generateFloorLayout.ts:129-147,386 (props from `departments.theme.props`, persistFloorLayout.ts:44). Only the first four props are placed (four corner anchors, `.slice(0, anchors.length)` :145); the rest are dropped without report | M7 |
| 13.3-10 | L2450 | Step 8: persist in `companies.floor_layout` | MET | src/main/company/persistFloorLayout.ts:74-99 (one transaction, plus `departments.room_rect` and employee desks); shape src/shared/floor/layout.ts:118-131 | M7 |
| 13.3-11 | L2453 | User can drag employees between desks; the layout persists | MET | persistence: src/main/company/moveEmployeeToDesk.ts (pins target desk, swaps, one transaction, `company.floor_rearranged`); IPC `company.moveDesk` src/main/ipc/handlers/company.ts:115-133; test tests/integration/company/moveEmployeeToDesk.test.ts:63,84. The drag gesture itself is M12 (§28 M12 item 6, L3888) | M7 |
| 13.3-12 | L2457-2459 | Generator reads pins from previous layout; pinned seated first in id order, honoured if still a slot; others take lowest unclaimed slot | MET | src/main/company/generateFloorLayout.ts:264-329; tests generateFloorLayout.test.ts:203,223 | M7 |
| 13.3-13 | L2461 | A pin that no longer fits is dropped and reported in `company.floor_rearranged` `droppedPins` with employee and both coordinates | MET | generateFloorLayout.ts:301-313; event src/main/company/persistFloorLayout.ts:101-125 (emitted whenever pins drop, even when the caller suppressed the event); tests generateFloorLayout.test.ts:244,270 | M7 |

## §14.2 Chat view
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 14.2-1 | L2626 | `text` — Markdown bubble | MET | src/renderer/src/components/chat/kinds.tsx:89-126 (Markdown); default branch src/renderer/src/components/chat/MessageRow.tsx:226-227 | M9 |
| 14.2-2 | L2627 | `question` — bubble + inline option chips + a free-text box; chips keyboard-navigable | PARTIAL | bubble + chips as real `<button>`s (kinds.tsx:128-165). No inline free-text box on the card; the composer is used instead (comment kinds.tsx:142-149) | M9 |
| 14.2-3 | L2628 | `brief` — title, goal, scope, deliverables, assumptions highlighted, Approve / Edit / Discuss | MET | src/renderer/src/components/chat/kinds.tsx:296-370 (assumptions block :335-347; DocumentActions :180-240); Edit opens BriefEditor (src/renderer/src/components/chat/BriefEditor.tsx) | M9 |
| 14.2-4 | L2629 | `plan` — collapsible phase list, task counts, assignees, estimated cost, hires needed, Approve / Edit / Discuss | PARTIAL | kinds.tsx:372-457 (details per phase :401-425, assignee :414-416, cost :431-432, hires :434-439). "Edit" is relabelled "Ask for changes" and pre-fills the composer rather than editing (kinds.tsx:447-452) | M9 |
| 14.2-5 | L2630 | `report` — what happened, what changed (file list / diff link), what is next, cost so far | PARTIAL | kinds.tsx:459-483; "what changed" is a plain string list (FieldList) with no diff link; cost renders "cost not reported" for null via formatCost | M9 |
| 14.2-6 | L2631 | `checkpoint` — card per §9.2: context, options with consequences, preview, recommendation, timer | MET | kinds.tsx:609-770 (preview :650-661, recommended badge :701-705, consequence :712-716, countdown naming the default :750-755). Reachability: see 9.4-2 | M8/M9 |
| 14.2-7 | L2632 | `summary` — compact phase-completion card with a deliverable link | MET | kinds.tsx:485-507 | M9 |
| 14.2-8 | L2633 | `error` — distinct styling, plain-language explanation, concrete action button | MET | kinds.tsx:518-560 (raw detail behind disclosure) | M9 |
| 14.2-9 | L2635 | Composer multiline, `Enter` sends / `Shift+Enter` newline | MET | src/renderer/src/components/chat/Composer.tsx:185-203 | M9 |
| 14.2-10 | L2635 | File attach (path reference into the conversation) | MET | Composer.tsx:110-119,149-182 (path field, not a picker); confined Core-side src/main/chat/attachments.ts; test tests/integration/chat/attachmentConfinement.test.ts | M9 |
| 14.2-11 | L2635 | Slash commands `/status`, `/pause`, `/budget`, `/plan`, `/deliver`, `/help` | MET | names src/shared/chat/slashCommands.ts:22; parsed/executed in main src/main/chat/slashCommands.ts:77-88; tests tests/unit/chat/slashCommandParse.test.ts, tests/integration/chat/slashCommandsLive.test.ts | M9 |
| 14.2-12 | L2635 | Typing indicator while the Director is composing | PARTIAL | "typing…" rendered for `status === 'streaming'` rows (src/renderer/src/components/chat/MessageRow.tsx:138-149); nothing produces a Director stream yet (`ChatStreamRegistry` constructed at src/main/index.ts:238 with no producer — Director is M11) | M9 / M11 |
| 14.2-13 | L2637 | Director replies stream token-by-token | PARTIAL | streaming writer exists: row inserted `streaming`, flushed every 500 ms, finalised `complete`/`aborted` (src/main/chat/chatStream.ts:37-38,79,117,140,154); aborted on restart src/main/db/reconcile.ts:62; test tests/integration/chat/chatStream.test.ts. No caller streams a Director reply (M11). spec note: L3832 | M9 / M11 |

## §14.4 Checkpoints view
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 14.4-1 | L2645 | Pending checkpoints listed, `blocking` first | PARTIAL | pending list rendered (src/renderer/src/components/RightPanel.tsx:45-65) from the store slice fed by `listPendingCheckpoints`, which orders by `created_at` only (src/main/db/repositories/checkpoints.ts listPendingCheckpoints `ORDER BY created_at`); no urgency sort anywhere in RightPanel.tsx | M8 (item 6) |
| 14.4-2 | L2645 | Same card as in chat | NOT MET | each item shows only `title` and `context` (RightPanel.tsx:57-61); `CheckpointCard` (src/renderer/src/components/chat/kinds.tsx:609) is not used here — no options, consequences, preview, timer, or answer controls in this view | M8 (item 6) |
| 14.4-3 | L2645 | Keyboard-driven: `J`/`K` move, `1`–`9` choose, `Enter` confirm | NOT MET | no key handlers in RightPanel.tsx; grep `event.key` in src/renderer/src finds only Composer.tsx, BriefEditor.tsx, FloorPane.tsx | M8 / M9 (item 7) |
| 14.4-4 | L2645 | Answered checkpoints remain visible for the session with the decision shown | NOT MET | the view reads only the pending slice (RightPanel.tsx:46); answered rows leave it; no session history kept | M8 (item 6) |

## §14.9 Memory view
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 14.9-1 | L2673 | On-demand right-panel tab: appears while in use, leaves when another tab is chosen | MET | src/renderer/src/components/RightPanel.tsx:135-137,182; PERMANENT_TABS src/renderer/src/store/bureauStore.ts:30 | M10 |
| 14.9-2 | L2673 | Opened from the title bar | MET | src/renderer/src/components/TitleBar.tsx:78-90 (`setActiveTab('memory')`) | M10 |
| 14.9-3 | L2675 | Browse by scope, note's markdown rendered | MET | scope select src/renderer/src/components/memory/MemoryView.tsx:169-184 → `memory.list({scope})` :66; rendered :285 | M10 |
| 14.9-4 | L2675 | Pinned note marked with an icon *and* a label, never colour alone | PARTIAL | list shows 📌 icon plus a screen-reader-only "(pinned)" (MemoryView.tsx:237-239) — no visible label in the list; the detail pane shows a visible "Pinned — …" sentence (:275-279) | M10 |
| 14.9-5 | L2676 | Edit: plain textarea over the markdown; saving goes through the same Core-side confinement | PARTIAL | textarea + save via `memory.write` (MemoryView.tsx:82-100,287-303) → `resolveMemoryTarget` (src/main/ipc/handlers/memory.ts:92-103). Saving an `employee/` note always fails: the handler passes `employeeId: null` (memory.ts:99) and `resolveMemoryTarget` refuses employee scope without an owner (src/main/memory/memoryTarget.ts:171-185) | M10 |
| 14.9-6 | L2677 | Pin / unpin; view says how many pins a rebuild cleared | MET | MemoryView.tsx:102-115,255-261 → memory.ts:105-146; rebuild notice with `pinsCleared` MemoryView.tsx:131-150 | M10 |
| 14.9-7 | L2678 | Accept / reject proposals per item, per open review, answering through `checkpoints.answer` | MET | MemoryView.tsx:333-472 (`window.bureau.checkpoints.answer` :366, per-item Keep/Discard, Keep all / Discard all) | M10 |
| 14.9-8 | L2679 | Two repairs: *check for edits* reconciles and keeps pins; *rebuild from files* re-derives and clears them | MET | buttons MemoryView.tsx:186-204 → `memory.reindex({full:false/true})` src/main/ipc/handlers/memory.ts:242-257. ("Check for edits" is stamp-based, not an unconditional hash — see 12.1-8) | M10 |
| 14.9-9 | L2681 | Every sentence written in the renderer; Core returns rows | MET | Core handlers return rows/counts only (src/main/ipc/handlers/memory.ts:70-73,232-239,250,256); sentences composed in MemoryView.tsx:96,140-147,380-383 | M10 |

## §22.4 The one-shot client
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| 22.4-1 | L3225,L3228 | Lives at `src/main/ai/oneshot.ts`, separate from `EngineAdapter` | MET | src/main/ai/oneshot.ts:206-272 (plain `fetch`, no adapter) | M7 |
| 22.4-2 | L3231-3238 | `OneShotConfig {provider: anthropic/openai/google/openai-compatible/none, baseUrl?, secretKey, model, timeoutMs, maxRetries}` | MET | src/main/ai/oneshot.ts:38-51; wire formats :106-198 | M7 |
| 22.4-3 | L3234 | `secretKey` is a key NAME in `secrets_meta`, never a value | MET | resolved at call time via `retrieveSecret` src/main/ai/oneshot.ts:218-227; name constant src/main/ai/oneshotConfig.ts:36 | M7 |
| 22.4-4 | L3235 | `model` resolved from `engines.modelTiers['fast']` | PARTIAL | resolved via `resolveModelTier(['fast'], engineKey: engines.default)` (src/main/ai/oneshotConfig.ts:61-75) — i.e. the *main engine's* fast-tier model, not a model for the one-shot provider; an `openai`/`google` provider would be sent the main engine's model id | M8 |
| 22.4-5 | L3236-3237 | `timeoutMs` default 15000; `maxRetries` default 1 | MET | src/main/ai/oneshot.ts:53-54,232-269; tests tests/integration/ai/oneshot.test.ts:188,203 | M7 |
| 22.4-6 | L3241 | `engines.oneshotProvider` defaults to "same as the main engine" | PARTIAL | setting defaults to `''` (src/shared/settings/schema.ts:175, dynamic default src/main/db/settingsLoader.ts:23), which resolves to `provider:'none'` (oneshotConfig.ts:48-53). Net behaviour matches the spec's stated consequence for subscription/CLI logins, but the stated default is not what is stored | M7 |
| 22.4-7 | L3243 | With no usable key, `provider:'none'`; every use has a working fallback; no feature depends on it | MET | 'none' returns a result, never throws (oneshot.ts:214-227); only caller is duplicate detection, whose fallback is "not a duplicate" (src/main/checkpoints/duplicateDetection.ts:209-248); test oneshot.test.ts:121,135 | M7/M8 |
| 22.4-8 | L3244 | Settings offers "Add a key for small helper tasks (optional — a few cents a month)" with an honest note | NOT MET | grep "oneshot"/"helper task" in src/renderer/src: none; SettingsPanel is a generic key/value editor (src/renderer/src/components/SettingsPanel.tsx) with no secret entry | none in §28 |
| 22.4-9 | L3248 | Intent classification fallback: keyword/structure rules; ambiguity ⇒ treat as chat | LATER | no intent classification exists (grep `intent` in src/main: none relevant); §28 M11 item 6 (L3865) | M11 |
| 22.4-10 | L3249 | Checkpoint duplicate confirmation fallback: FTS similarity threshold alone | MET | src/main/checkpoints/duplicateDetection.ts:137-158,214-215 (near-miss ⇒ not duplicate when provider 'none') ; test tests/integration/checkpoints/duplicateDetection.test.ts | M8 |
| 22.4-11 | L3250 | Error-message rewriting fallback: curated static message per known error code; unknown errors show raw text plus "report this" | NOT MET | no one-shot error rewriting and no "report this" action (grep `report this` in src: none); errors are translated by handler-authored `UserFacingError` messages (src/shared/errors/userFacing.ts) | none in §28 |
| 22.4-12 | L3251-3252 | Memory consolidation skipped; conversation summarisation n/a | MET | no memory-consolidation feature exists (grep `consolidat` in src/main: none) | — |
| 22.4-13 | L3254 | `usage.source` (`turn`/`oneshot`); `employee_id`, `task_id`, `turn_index` nullable | MET | src/main/ai/oneshot.ts:282-296; test oneshot.test.ts:229 | M7 |
| 22.4-14 | L3254 | Spend counts against current project's budget, or the Director reserve when no project | PARTIAL | the usage row carries `project_id` (oneshot.ts:295; src/main/db/repositories/usage.ts insertUsage `attribution.projectId`) but no cost is computed or passed (`cost_usd_micros`/`computed_cost_usd_micros` default null, src/shared/models/usage.ts:52-53), so project spend is incremented by 0; nothing charges the Director reserve when no project is active beyond the event flag `againstDirectorReserve` (oneshot.ts:313) | M7 |
| 22.4-15 | L3254 | Emits `cost.oneshot_recorded` | MET | src/main/ai/oneshot.ts:298-315; test oneshot.test.ts:243 | M7 |
| 22.4-16 | L3254 | Budget exhaustion does not block one-shot calls | MET | no budget check in src/main/ai/oneshot.ts; test oneshot.test.ts:269 | M7 |

## §28 M7 — Packs, roles, memory store, and floor layout
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| M7-1 | L3784 | Pack loader and §6.7 validator; failing pack disabled with a readable error, never partially loaded | see 6.7-3, 6.7-14 (and 6.7-5, 6.7-16, 6.7-17 for the partial parts) | — | M7 |
| M7-2 | L3785 | `roles.key` unique **per pack**; address roles as `pack:key` everywhere | MET | `UNIQUE (pack_id, key)` and generated `full_key` with unique index src/main/db/migrations/0001_initial.sql:81,107,110; `employees.role_key REFERENCES roles(full_key)` :124; hire takes `pack:key` src/main/company/hireEmployee.ts:120-121,148; router `role:` resolves by full key src/main/messages/deliverability.ts:158; Director identity src/main/company/directorRole.ts:25 | M7 |
| M7-3 | L3786 | Engineering pack: five roles with real prompts, plus shared standards and definition-of-done | MET | packs/engineering/roles/*.yaml (5); prompts 1.7–2.0 KB each and _shared/engineering-standards.md (2.1 KB), _shared/definition-of-done.md (1.4 KB); validated test tests/integration/packs/shippedPacks.test.ts:55,68 | M7 |
| M7-4 | L3787 | `packs/operations/roles/director.yaml` — the Director's role definition | see 8.0-1 | — | M7 |
| M7-5 | L3788 | Hiring: name allocation, desk allocation, sprite variant, memory creation, events | see 6.8-3, 6.8-4, 6.8-6, 6.8-7, 6.8-8, 6.8-9 | — | M7 |
| M7-6 | L3789 | Floor layout generator (§13.3) as headless plain code — deterministic, seeded, persisted to `companies.floor_layout`; no Phaser | see 13.3-2, 13.3-10 | — | M7 |
| M7-7 | L3790 | Firing archives memory rather than deleting it | see 6.8-11 | — | M7 |
| M7-8 | L3791 | `bureau pack scaffold` and validation exposed in Settings | PARTIAL | scaffold + validate exist as IPC methods (src/main/ipc/handlers/packs.ts:93-120,154-182); no CLI command (6.6-7) and no Settings UI for scaffold or validate (6.6-8; grep "pack" in src/renderer/src: none) | M7 |
| M7-9 | L3792 | The markdown memory store and the FTS5 index | see 12.1-1, 12.1-2, 12.1-4 | — | M7 |
| M7-10 | L3793 | The one-shot client (§22.4) with its `provider:'none'` fallbacks | see 22.4-1, 22.4-7 | — | M7 |
| M7-G1 | L3795 | Gate: hire three employees across two departments | MET | tests/integration/company/m7Gate.test.ts:62-122 (engineering developer + tester, operations Director; distinct desks, names, three hire events). Only reachable in the app once a company row exists — `company.hire` returns NOT_FOUND without one (src/main/ipc/handlers/company.ts:24-32), and company creation is M13 | M7 |
| M7-G2 | L3795 | Gate: layout is stable across restarts | MET | tests/integration/company/m7Gate.test.ts:124 (byte-identical after reopen); generator purity see 13.3-2 | M7 |
| M7-G3 | L3795 | Gate: a deliberately broken pack is rejected with a clear message | MET | tests/integration/company/m7Gate.test.ts:159,193; message assembly src/main/ipc/handlers/packs.ts:140-148 | M7 |

## §28 M8 — Checkpoints and the router
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| M8-1 | L3803 | Checkpoint model, including `permission` with `tool_call_id` (§9.1) | see 9.1-1, 9.1-5 | — | M8 |
| M8-2a | L3804 | Validation: every option needs a `consequence` | see 9.2-4 | — | M8 |
| M8-2b | L3804 | Validation: at most one `recommended` | see 9.2-5 | — | M8 |
| M8-2c | L3804 | Validation: `default_action` nullable only when no reversible option exists | NOT MET | nothing ties a null `default_action` to the options' reversibility: options have no reversibility attribute (src/shared/models/checkpoint.ts:17-23) and the only related refinement is expiry ⇒ default (:130-133,163-166). A checkpoint whose options are all reversible is accepted with `default_action: null` and then never expires (src/main/checkpoints/expiry.ts:108) | M8 |
| M8-3 | L3805 | Duplicate detection against answered checkpoints — FTS first, one-shot only on a near-miss | MET | src/main/checkpoints/duplicateDetection.ts:119-200 (FTS candidates :168-200, Dice thresholds :59-62,137-147, one-shot only in near-miss band :149-158); test tests/integration/checkpoints/duplicateDetection.test.ts. Scope limits: see 9.2-9 | M8 |
| M8-4 | L3806 | Batching within `checkpoints.batchWindowSeconds`; `blocking` and `permission` never batched | see 9.3-1, 9.3-4, 9.1-8 | — | M8 |
| M8-5 | L3807 | Timeouts by urgency; post-restart grace (§9.6); timeout resolves to the safe default and is recorded | see 9.5-1, 9.5-3, 9.5-4, 9.6-6, 9.5-2 (safety caveat 9.5-5) | — | M8 |
| M8-6 | L3808 | All four surfaces: chat card, Checkpoints view, floor signal, desktop notification | see 9.4-2, 9.4-3, 9.4-4, 9.4-5, 14.4-2 | — | M8 |
| M8-7 | L3809 | Answering: unblock the task, inject into the employee's next turn, record the decision | see 9.6-3, 9.6-4, 12.5-1 | — | M8 |
| M8-8 | L3810 | Decision log (§12.5) — every answered `decision` appended to `project/decisions.md` | see 12.5-1 | — | M8 |
| M8-9 | L3811 | Message router — outbox, addressing, backoff, dead-letter, `role:` resolution, held messages for `off` employees | see 9.7-1, 9.7-5, 9.7-11, 9.7-12, 9.7-9, 9.7-8 | — | M8 |
| M8-10 | L3812 | Security tests S12 and S15 | MET | S12 tests/integration/security/checkpointTimeoutIsSafe.test.ts:110,170,216,236; S15 tests/integration/security/promptInjectionContained.test.ts:211,241,294; both listed in `test:security` (package.json scripts) | M8 |
| M8-G1 | L3814 | Gate: a permission checkpoint holds an agent, is answered **from the UI**, and the agent proceeds | PARTIAL | hold + answer + proceed proven at the IPC handler (tests/integration/checkpoints/m8Gate.test.ts:145-200, via `checkpoints:answerPermission`). No production UI path reaches that handler for a real permission checkpoint: the chat card that calls it (src/renderer/src/components/chat/ChatView.tsx:139-142) only renders for a `checkpoint` conversation message, which nothing writes (9.4-2), and the Checkpoints view has no answer controls (14.4-2) | M8 |
| M8-G2 | L3814 | Gate: an unanswered blocking checkpoint resolves safely | MET | tests/integration/checkpoints/m8Gate.test.ts:202; tests/integration/security/checkpointTimeoutIsSafe.test.ts:110,170 | M8 |
| M8-G3 | L3814 | Gate: a question to a dead employee ends in a blocker checkpoint, not silence | MET | tests/integration/checkpoints/m8Gate.test.ts:264; mechanism see 9.7-13 | M8 |

## §28 M9 — Chat UI
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| M9-1 | L3822 | Message list with all `kind` renderers: text, question, brief, plan, report, checkpoint, summary, error | see 14.2-1 to 14.2-8 (PARTIAL parts: 14.2-2, 14.2-4, 14.2-5) | — | M9 |
| M9-2a | L3823 | Streaming: insert row as `streaming`, throttle updates to ~500 ms, finalise at completion | MET | src/main/chat/chatStream.ts:37-38,79,117,154; test tests/integration/chat/chatStream.test.ts. No production producer yet — see 14.2-13 | M9 |
| M9-2b | L3823 | `aborted` rendering after a restart | MET | stale `streaming` rows aborted at startup src/main/db/reconcile.ts:62; labelled marker src/renderer/src/components/chat/MessageRow.tsx:53-64,163-175; e2e tests/e2e/chatAborted.spec.ts:125 | M9 |
| M9-3 | L3824 | `chat.stop` | MET | src/main/ipc/handlers/chat.ts:223-232; Stop button src/renderer/src/components/chat/Composer.tsx:205-211; test tests/integration/chat/chatStream.test.ts:210,228 | M9 |
| M9-4a | L3825 | Brief and plan cards with Approve / Edit / Discuss | PARTIAL | brief: all three (see 14.2-3); plan: Approve and Discuss, "Edit" replaced by "Ask for changes" (see 14.2-4) | M9 |
| M9-4b | L3825 | Edit opens the markdown in an editor and saves a new version | PARTIAL | brief: BriefEditor → `brief.saveEdit` inserts next version and supersedes the old one in one transaction (src/main/ipc/handlers/brief.ts:101-140; test tests/integration/chat/documentApproval.test.ts:168,198). Plan: no editor and no `plan.saveEdit` (src/renderer/src/components/chat/kinds.tsx:447-452) | M9 |
| M9-5 | L3826 | Composer: multiline, attach, typing indicator | see 14.2-9, 14.2-10, 14.2-12 | — | M9 |
| M9-6 | L3827 | Slash commands parsed in the main process (§17.2) so `/pause`, `/budget`, `/status` work when the Director cannot respond | MET | src/main/ipc/handlers/chat.ts:97 (`parseSlashCommand` before the message reaches the Director) → src/main/chat/slashCommands.ts:77-88; tests tests/unit/chat/slashCommandParse.test.ts, tests/integration/chat/slashCommandsLive.test.ts | M9 |
| M9-7a | L3828 | Unread badges | MET | src/renderer/src/components/RightPanel.tsx:107-120 (shared `isUnreadForUser`); `chat.markRead` test tests/integration/chat/markRead.test.ts:125 | M9 |
| M9-7b | L3828 | Keyboard navigation | PARTIAL | chat controls are native buttons/`<details>` (kinds.tsx:142-165,401-425); Composer Enter/Shift+Enter (Composer.tsx:192-201). §14.4's J/K/1–9/Enter checkpoint navigation absent (see 14.4-3); permission single-keypress absent (see 9.1-7) | M9 |
| M9-7c | L3828 | Accessibility pass | PARTIAL | icon+label markers and aria attributes present (MessageRow.tsx:146-175; RightPanel.tsx:163-172; MemoryView.tsx:237-239). Visible pinned label missing in the memory list (see 14.9-4). Only accessibility-related test found is contrast (tests/unit/renderer/themeContrast.test.ts) | M9 |
| M9-G1 | L3830 | Gate: a full conversation including approving a brief works end to end against `FakeAdapter` | LATER | spec note: L3832-3836 assigns this sentence to M11 (no Director producer, nothing writes `briefs`); M9's substitute gate tests/integration/chat/m9Gate.test.ts:137,212 | M11 |
| M9-G2 | L3830 | Gate: killing the app mid-stream leaves a clearly marked aborted message | MET | tests/e2e/chatAborted.spec.ts:125 (fixture tests/e2e/fixtures/chatStreamKillWorker.ts); spec note L3834 | M9 |

## §28 M10 — Memory retrieval and writes
| ID | Spec line | Requirement (short quote/paraphrase) | Verdict | Evidence / what's missing | Owner |
|---|---|---|---|---|---|
| M10-1a | L3844 | Detection of out-of-band edits via `content_sha256` | see 12.1-6, 12.1-7, 12.1-9 (no OS watcher by design, spec L2372) | — | M10 |
| M10-1b | L3844 | `reindex` | see 12.1-8 | — | M10 |
| M10-2a | L3845 | Memory pack composition (§12.3) with a token budget | see 12.3-1 to 12.3-7 | — | M10 |
| M10-2b | L3845 | Log `memory.injected` with what was included | see 12.3-8 | — | M10 |
| M10-3 | L3850 | (no item 3) | — | spec note: L3850 (numbering slip, not a lost requirement) | — |
| M10-4 | L3846 | Gated writes (§12.4) with proposal batching and expiry | see 7.9-5, 7.9-6, 12.4-4 to 12.4-8 | — | M10 |
| M10-5 | L3847 | Memory view: browse, edit, pin, accept/reject proposals | see 14.9-3, 14.9-5, 14.9-6, 14.9-7 | — | M10 |
| M10-6 | L3848 | Optional semantic layer behind a flag, degrading to FTS5 | see 12.1-3 | — | M10 |
| M10-G1 | L3852 | Gate: a decision recorded in one session is present in the next session's context, verified via `memory.injected` | MET | tests/integration/memory/m10Gate.test.ts:109 (decision answered through real `answerCheckpoint`, then a different employee's `Supervisor` assignment; asserts the `memory.injected` payload and the adapter's received text); spec note L3852 | M10 |

## Tally
Requirements traced: 270 · MET 196 · PARTIAL 46 · NOT MET 13 · LATER 15

(Counts are independent verdicts only. A further 31 rows are cross-references — "see <ID>" — or the empty M10-3 placeholder, and are not counted.)

## All PARTIAL and NOT MET (index)
| ID | Spec line | Verdict | One-line gap |
|---|---|---|---|
| 6.2-5 | L835-838 | NOT MET | No `templates/` in any pack; nothing reads templates |
| 6.2-6 | L839-841 | NOT MET | No `skills/*.yaml` in any pack; no skill loader; `skills` is a string list |
| 6.2-7 | L842-843 | NOT MET | No optional `assets/sprites/` support (no dir, no loader) |
| 6.3-3 | L862 | PARTIAL | `requires.tools` parsed but not surfaced anywhere |
| 6.3-4 | L863 | PARTIAL | `requires.engines` parsed but engine availability never checked |
| 6.4-4 | L895 | PARTIAL | `default_hires` validated but never hired (`company.addDepartment` is a stub) |
| 6.6-6 | L970 | NOT MET | No in-app copy of the pack shipping table exists |
| 6.6-7 | L981 | NOT MET | No `bureau pack scaffold <name>` CLI command |
| 6.6-8 | L981 | PARTIAL | `packs.scaffold` IPC exists; no Settings → Packs → Create UI |
| 6.7-5 | L989 | PARTIAL | Startup revalidation omits other packs' departments, so cross-pack role references fail on boot |
| 6.7-16 | L1000 | PARTIAL | Failed pack withheld at hire/fire only; still in `company.listDepartments` and floor layout |
| 6.7-17 | L1000 | PARTIAL | `packs.list` returns `enabled:false` but no failure reason |
| 6.8-12 | L1028 | PARTIAL | `rehireEmployee` exists but has no production caller or IPC method |
| 8.0-9 | L1669 | PARTIAL | Director autonomy changeable via `employees.updateSettings`; no guard |
| 9.1-6 | L1909 | PARTIAL | Permission card has allow once / deny only; "allow this command for this employee" missing |
| 9.1-7 | L1909 | NOT MET | No single-keypress answer for permission checkpoints |
| 9.2-4 | L1932 | PARTIAL | Whitespace-only `consequence` passes validation |
| 9.2-7 | L1925,L1934 | PARTIAL | `default_action` reversibility not checked (only that it names an option) |
| 9.2-8 | L1931 | PARTIAL | No check that agent-authored checkpoint text is non-expert-friendly |
| 9.2-9 | L1935 | PARTIAL | Duplicate check only for decision/information types; memory, brief and workspace not consulted |
| 9.3-2 | L1940 | PARTIAL | Batches only affect notification timing; no single grouped chat message |
| 9.3-3 | L1940 | PARTIAL | Batching ignores "from different employees" (keys on project only) |
| 9.4-2 | L1945 | PARTIAL | Chat checkpoint card exists but nothing writes a `checkpoint` chat message |
| 9.5-5 | L1954 | PARTIAL | Timeout applies the authored default, whose reversibility is unverified |
| 9.7-2 | L1968-1971 | PARTIAL | Producers do not insert the message and update task state in one transaction |
| 9.7-3 | L1972-1975 | NOT MET | No in-process router signal; 5 s tick only |
| 9.7-10 | L1982 | PARTIAL | `role:` with no idle employee is held, but the Director is never notified |
| 12.1-3 | L2368 | PARTIAL | Semantic flag reports `unavailable`; no local embedding search exists |
| 12.1-8 | L2372 | PARTIAL | `memory.reindex` never hashes unconditionally without wiping; `force` scope has no caller |
| 12.2-2 | L2389 | PARTIAL | `company/` Director-with-approval write path absent |
| 12.2-3 | L2390 | PARTIAL | `project/` Director write path absent |
| 12.3-2 | L2396 | PARTIAL | Only pinned company notes included; pack-seeded standards are unpinned |
| 12.3-3 | L2396 | PARTIAL | Only pinned role notes included; unpinned playbook not in this clause |
| 12.3-4 | L2396 | PARTIAL | Project decisions depend on pin, which a full rebuild clears |
| 12.4-6 | L2402 | PARTIAL | A second review can be raised in the same phase once the first is answered |
| 12.5-3 | L2416 | PARTIAL | Decision log reaches only roles with `project` scope, while pinned, within budget |
| 14.2-2 | L2627 | PARTIAL | Question bubble has no inline free-text box (uses composer) |
| 14.2-4 | L2629 | PARTIAL | Plan card "Edit" is "Ask for changes" (composer prefill), not an edit |
| 14.2-5 | L2630 | PARTIAL | Report card has no diff link |
| 14.2-12 | L2635 | PARTIAL | Typing indicator renders but no Director stream produces it |
| 14.2-13 | L2637 | PARTIAL | Stream writer exists; no Director reply producer (M11) |
| 14.4-1 | L2645 | PARTIAL | Checkpoints view ordered by `created_at`, not `blocking` first |
| 14.4-2 | L2645 | NOT MET | Checkpoints view shows title/context only, not the chat card |
| 14.4-3 | L2645 | NOT MET | No J/K/1–9/Enter keyboard handling |
| 14.4-4 | L2645 | NOT MET | Answered checkpoints disappear; no session history |
| 14.9-4 | L2675 | PARTIAL | Pinned list item has icon plus screen-reader-only label, no visible label |
| 14.9-5 | L2676 | PARTIAL | Editing an `employee/` note from the view always fails confinement (no owner id) |
| 22.4-4 | L3235 | PARTIAL | One-shot model is the main engine's fast-tier model, not the provider's |
| 22.4-6 | L3241 | PARTIAL | `engines.oneshotProvider` defaults to `''`, not "same as main engine" |
| 22.4-8 | L3244 | NOT MET | No Settings UI to add a one-shot helper key |
| 22.4-11 | L3250 | NOT MET | No error-message rewriting fallback or "report this" action |
| 22.4-14 | L3254 | PARTIAL | One-shot usage records no cost; project spend +0; reserve not charged |
| M7-8 | L3791 | PARTIAL | Scaffold/validate only via IPC; no CLI, no Settings UI |
| M8-2c | L3804 | NOT MET | Null `default_action` not tied to absence of a reversible option |
| M8-G1 | L3814 | PARTIAL | Permission answer proven at IPC handler; no production UI path reaches it |
| M9-4a | L3825 | PARTIAL | Plan card lacks a real Edit action |
| M9-4b | L3825 | PARTIAL | Brief edit saves a new version; plan has no editor or new version |
| M9-7b | L3828 | PARTIAL | Checkpoint keyboard navigation and single-keypress permission absent |
| M9-7c | L3828 | PARTIAL | Only a contrast test exists; visible pinned label missing |

## Dedupe against `docs/PRE-M11-PLAN.md` (orchestrating session)

Done by the session that ran this trace, not by the tracer. It read the plan (§0–§D, §M11, §After), `docs/NEXT-VERSION.md`, the spec's in-place notes and its §0.1 amendment log. Each PARTIAL/NOT MET above went to exactly one place. Before any row was written, the code facts behind these rows were spot-checked (`employees.ts:166-173`, `revalidateInstalledPacks.ts:63`, `memory.ts:99,245-256`, `checkpoint.ts:21`, `batching.ts:73-79`, and `ChatView.tsx:225-228` / `MessageRow.tsx:212-224`: the card needs a `checkpoint` conversation message).

| Trace ID(s) | Outcome | Where |
|---|---|---|
| M7-8, 6.6-7, 6.6-8 | Already in plan | R-7 / E-5 (MOVED: M14) |
| 9.1-6 | Already in plan | R-8 (recorded deviation `NEXT-VERSION` §I.1) |
| 9.7-3 | Already in plan | R-8 (recorded deviation `NEXT-VERSION` §J.1) |
| 9.7-10 | Already in plan | §M11 8 (`NEXT-VERSION` §J.3) |
| 12.2-2, 12.2-3 | Already in plan | §M11 10 (Director memory tools, §M.4) |
| 14.2-12, 14.2-13 | Already in plan | §M11 4 (Director producer; spec §28 M9 gate note L3832) |
| 12.1-3 | RECORDED | `NEXT-VERSION` §M.1 and §B.5 (embedding model deliberately not built) |
| 12.3-4 | RECORDED | BUILD-SPEC §12.1 in-place note ("One thing loses on rebuild… a full rebuild clears [pins]") |
| 14.2-2 | RECORDED | `NEXT-VERSION` §K.3 closing note: §14.2's free-text box is the composer |
| 14.2-4, M9-4a, M9-4b | RECORDED | `NEXT-VERSION` §L.5 (a plan is not hand-editable; Edit opens the composer) |
| 9.3-2 | LATER, line added | §M11 14: the Director's grouped message is M11's (§9.3 "grouped by the Director") |
| 6.3-3 | LATER, line added | §After: `requires.tools` surfaced in the wizard (§6.3 names the wizard; §28 M13) |
| 14.2-5 | LATER, line added | §After: report card diff link, with M14's Files-with-diffs (§28 M14 item 2) |
| 6.2-7 | No row: not a gap | §6.2 marks `assets/sprites/` optional, so leaving it out complies |
| 6.6-6 | No row: not a gap today | No app copy describing packs exists, so none can disagree with the table. The enforcement mechanism is §1.5/§19.6's claims audit, already in §After (M15) |
| 9.2-8 | No row: no concrete "done when" | "Written for a non-expert" for agent-authored text can't be checked mechanically. It is prompt content and Director behaviour (§28 M11 item 14's behaviour tests) |
| 9.3-3 | No row: not a gap | Grouping by project is a superset of "from different employees". Nothing in §9.3 forbids batching two non-blocking checkpoints from one employee, and the failure it prevents ("five separate pings") is still prevented |
| 6.2-5, 6.2-6 | New row | X-1 |
| 6.3-4 | New row | X-2 |
| 6.4-4 | New row | X-3 |
| 6.7-5 | New row | X-4 |
| 6.7-16, 6.7-17 | New row | X-5 |
| 6.8-12 | New row | X-6 |
| 8.0-9 | New row | X-7 |
| 9.2-4 | New row | X-8 |
| 9.2-7, 9.5-5, M8-2c | New row | X-9 |
| 9.2-9 | New row | X-10 (type scope only; "never re-asks" from memory/brief/workspace is §28 M11 item 14) |
| 9.4-2, M8-G1 | New row | X-11 (also: `NEXT-VERSION` §J.5's outcome says surface 1 is built, which the code does not support) |
| 9.7-2 | New row | X-12 |
| 12.1-8 | New row | X-13 |
| 12.3-2, 12.3-3, 12.5-3 | New row | X-14 |
| 12.4-6 | New row | X-15 |
| 14.4-1, 14.4-2, 14.4-3, 14.4-4, 9.1-7, M9-7b | New row | X-16 |
| 14.9-4, M9-7c | New row | X-17 |
| 14.9-5 | New row | X-18 |
| 22.4-4, 22.4-6 | New row | X-19 |
| 22.4-8 | New row | X-20 |
| 22.4-11 | New row | X-21 |
| 22.4-14 | New row | X-22 |

**Counts over the 59 PARTIAL/NOT MET:** already in plan 10 · recorded deviations 6 · LATER with a line added 3 · no row (reason given) 4 · covered by new §B5 rows 36, in 22 rows. The 15 LATER verdicts were each checked against their cited §28 M11/M12/M13/M14 item, and all are owned there, so no line was added for them.

## Out of scope, noticed
- `bureau_send_message` and `bureau_ask_director` emit `message.sent` again when an idempotent retry returns the existing row (`insertOrFetchByIdempotencyKey` gives no "already existed" signal), so a retried call records two events for one state change (src/main/controlChannel/toolHandlers/sendMessage.ts:33-56; askDirector.ts).
- `company.fire` returns `(err as Error).message` for every error, not only `UserFacingError`, unlike `hire`/`rename` (src/main/ipc/handlers/company.ts:86-90); same in `moveDesk` (:130-132).
- `packs.setEnabled` changes state but emits no activity event (src/main/ipc/handlers/packs.ts:184-191).
- Role `system_prompt_path`/`shared_prompts` are validated but never read into any employee's launch text (grep in src/main outside packs/repositories/smoketest: none); prompt assembly is M11 per supervisor.ts:657-662.
- `proposeMemoryWrite` inserts the proposal, raises or attaches the review, and links them in separate statements with no transaction (src/main/memory/memoryProposals.ts:156-170).
- `rehireEmployee` un-archives and re-lays out the floor outside a transaction (src/main/company/fireEmployee.ts:174-175).
