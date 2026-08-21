-- 0001_initial.sql — the complete §5.1 schema.
--
-- Bootstrap note (§5.1.1): `companies.director_employee_id`,
-- `employees.current_task_id`, `tasks.assignee_employee_id`, and
-- `employees.worktree_id` are declared DEFERRABLE INITIALLY DEFERRED
-- because they form cycles. Company bootstrap must happen inside a single
-- transaction in this order: insert the company with director_employee_id
-- = NULL, insert the Director employee, then UPDATE the company to point
-- at it. Deferred checking additionally allows genuinely simultaneous
-- mutual references within one transaction (see
-- tests/integration/deferredForeignKeys.test.ts).
--
-- `schema_migrations` is created here (§5.1 lists it as a real table) AND
-- bootstrapped independently by migrate.ts before this file ever runs —
-- the runner has to query it to know whether 0001 has been applied, which
-- only works if it exists first. The CREATE TABLE IF NOT EXISTS below is a
-- harmless no-op by the time it executes.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum   TEXT NOT NULL
);

-- companies ------------------------------------------------------------

CREATE TABLE companies (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  home_path            TEXT NOT NULL,
  director_employee_id TEXT REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED,
  floor_layout         TEXT NOT NULL CHECK (json_valid(floor_layout)),
  settings             TEXT NOT NULL CHECK (json_valid(settings)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TRIGGER trg_companies_updated_at
AFTER UPDATE ON companies FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE companies SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- departments ------------------------------------------------------------
-- created_at/updated_at are not in §5.1's own row-listing for this table,
-- but §5.0's blanket rule applies (mutable via `enabled`, and this isn't
-- `events` or a join table) — see PROGRESS.md's M1 entry.

CREATE TABLE departments (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  pack_id    TEXT,
  room_rect  TEXT NOT NULL CHECK (json_valid(room_rect)),
  theme      TEXT CHECK (theme IS NULL OR json_valid(theme)),
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER trg_departments_updated_at
AFTER UPDATE ON departments FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE departments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- roles ------------------------------------------------------------
-- `key` is UNIQUE(pack_id, key), not globally unique — two packs may both
-- ship an "analyst". Roles are addressed everywhere as `pack:key`, so
-- `full_key` is a generated column giving that composite a genuinely
-- unique target for employees.role_key to reference (§5.1's literal
-- `FK→roles(key)` cannot exist as a real constraint: `key` alone isn't
-- unique). created_at/updated_at: same §5.0 blanket-rule note as departments.

CREATE TABLE roles (
  id                   TEXT PRIMARY KEY,
  key                  TEXT NOT NULL,
  full_key             TEXT GENERATED ALWAYS AS (pack_id || ':' || key) STORED,
  department_key       TEXT NOT NULL REFERENCES departments(key),
  pack_id              TEXT NOT NULL,
  priority             INTEGER NOT NULL DEFAULT 50,
  version              TEXT NOT NULL,
  title                TEXT NOT NULL,
  description          TEXT NOT NULL,
  system_prompt_path   TEXT NOT NULL,
  skills               TEXT NOT NULL CHECK (json_valid(skills)),
  deliverable_types    TEXT NOT NULL CHECK (json_valid(deliverable_types)),
  engine_preference    TEXT NOT NULL CHECK (json_valid(engine_preference)),
  model_preference     TEXT CHECK (model_preference IS NULL OR json_valid(model_preference)),
  tools_allow          TEXT NOT NULL CHECK (json_valid(tools_allow)),
  tools_deny           TEXT NOT NULL CHECK (json_valid(tools_deny)),
  network_allow        TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(network_allow)),
  memory_scopes        TEXT NOT NULL CHECK (json_valid(memory_scopes)),
  autonomy_default     TEXT NOT NULL,
  max_turns            INTEGER NOT NULL DEFAULT 40,
  max_attempts         INTEGER NOT NULL DEFAULT 2,
  wall_clock_timeout_s INTEGER NOT NULL DEFAULT 2400,
  budget_usd_micros    INTEGER,
  sprite_key           TEXT NOT NULL,
  role_options         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(role_options)),
  enabled              INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (pack_id, key)
);

CREATE UNIQUE INDEX idx_roles_full_key ON roles(full_key);

CREATE TRIGGER trg_roles_updated_at
AFTER UPDATE ON roles FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE roles SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- employees ------------------------------------------------------------

CREATE TABLE employees (
  id                         TEXT PRIMARY KEY,
  name                       TEXT NOT NULL UNIQUE,
  role_key                   TEXT NOT NULL REFERENCES roles(full_key),
  is_director                INTEGER NOT NULL DEFAULT 0,
  desk_x                     INTEGER NOT NULL,
  desk_y                     INTEGER NOT NULL,
  sprite_variant             TEXT NOT NULL,
  status                     TEXT NOT NULL,
  status_detail              TEXT,
  engine                     TEXT NOT NULL,
  engine_mode                TEXT,
  engine_version             TEXT,
  model                      TEXT,
  session_id                 TEXT,
  pid                        INTEGER,
  process_start_time         TEXT,
  worktree_id                TEXT REFERENCES worktrees(id) DEFERRABLE INITIALLY DEFERRED,
  current_task_id            TEXT REFERENCES tasks(id) DEFERRABLE INITIALLY DEFERRED,
  autonomy                   TEXT NOT NULL,
  daily_budget_usd_micros    INTEGER,
  resume_at                  TEXT,
  heartbeat_at               TEXT,
  consecutive_failures       INTEGER NOT NULL DEFAULT 0,
  lifetime_spend_usd_micros  INTEGER NOT NULL DEFAULT 0,
  hired_at                   TEXT NOT NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TRIGGER trg_employees_updated_at
AFTER UPDATE ON employees FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE employees SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- projects ------------------------------------------------------------

CREATE TABLE projects (
  id                TEXT PRIMARY KEY,
  display_key       TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  path              TEXT NOT NULL,
  repo_initialised  INTEGER NOT NULL DEFAULT 0,
  base_ref          TEXT NOT NULL DEFAULT 'main',
  protected_refs    TEXT NOT NULL DEFAULT '["main","master"]' CHECK (json_valid(protected_refs)),
  kind              TEXT NOT NULL,
  stage             TEXT NOT NULL,
  brief_id          TEXT REFERENCES briefs(id),
  plan_id           TEXT REFERENCES plans(id),
  budget_usd_micros INTEGER,
  spend_usd_micros  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TRIGGER trg_projects_updated_at
AFTER UPDATE ON projects FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- briefs ------------------------------------------------------------
-- Versioned; never edited in place. updated_at not in §5.1's own listing
-- (only created_at + approved_at are) but status is mutable — §5.0 rule.

CREATE TABLE briefs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id),
  version      INTEGER NOT NULL,
  content      TEXT NOT NULL CHECK (json_valid(content)),
  markdown     TEXT NOT NULL,
  status       TEXT NOT NULL,
  approved_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TRIGGER trg_briefs_updated_at
AFTER UPDATE ON briefs FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE briefs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- plans ------------------------------------------------------------
-- Same versioning approach as briefs; same updated_at note.

CREATE TABLE plans (
  id                         TEXT PRIMARY KEY,
  project_id                 TEXT NOT NULL REFERENCES projects(id),
  brief_id                   TEXT NOT NULL REFERENCES briefs(id),
  version                    INTEGER NOT NULL,
  content                    TEXT NOT NULL CHECK (json_valid(content)),
  estimated_cost_usd_micros  INTEGER,
  status                     TEXT NOT NULL,
  approved_at                TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TRIGGER trg_plans_updated_at
AFTER UPDATE ON plans FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE plans SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- phases ------------------------------------------------------------
-- created_at/updated_at not in §5.1's own listing; §5.0 rule applies
-- (status is mutable).

CREATE TABLE phases (
  id              TEXT PRIMARY KEY,
  plan_id         TEXT NOT NULL REFERENCES plans(id),
  ordinal         INTEGER NOT NULL,
  name            TEXT NOT NULL,
  goal            TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TRIGGER trg_phases_updated_at
AFTER UPDATE ON phases FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE phases SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- tasks ------------------------------------------------------------

CREATE TABLE tasks (
  id                         TEXT PRIMARY KEY,
  display_key                TEXT NOT NULL UNIQUE,
  project_id                 TEXT NOT NULL REFERENCES projects(id),
  phase_id                   TEXT REFERENCES phases(id),
  parent_task_id             TEXT REFERENCES tasks(id),
  title                      TEXT NOT NULL,
  body                       TEXT NOT NULL,
  acceptance_criteria        TEXT NOT NULL CHECK (json_valid(acceptance_criteria)),
  required_skills            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_skills)),
  deliverable_type           TEXT,
  assignee_employee_id       TEXT REFERENCES employees(id) DEFERRABLE INITIALLY DEFERRED,
  excluded_employees         TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(excluded_employees)),
  status                     TEXT NOT NULL,
  status_reason              TEXT,
  priority                   INTEGER NOT NULL DEFAULT 50,
  attempts                   INTEGER NOT NULL DEFAULT 0,
  reassignments              INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd_micros  INTEGER,
  spend_usd_micros           INTEGER,
  result_summary             TEXT,
  started_at                 TEXT,
  finished_at                TEXT,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);

CREATE TRIGGER trg_tasks_updated_at
AFTER UPDATE ON tasks FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- task_deps ------------------------------------------------------------
-- Join table (§5.0 exception — no timestamps). Cycle rejection is
-- application logic (a graph walk before insert; SQLite has no
-- declarative way to express "no cycles"), enforced in
-- db/repositories/taskDeps.ts, not here.

CREATE TABLE task_deps (
  task_id             TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);

-- worktrees ------------------------------------------------------------
-- created_at/updated_at not in §5.1's own listing; §5.0 rule applies
-- (status is mutable).

CREATE TABLE worktrees (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  path              TEXT NOT NULL UNIQUE,
  branch            TEXT NOT NULL,
  base_commit       TEXT NOT NULL,
  lease_holder      TEXT REFERENCES employees(id),
  lease_expires_at  TEXT,
  status            TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- One live lease per employee — this is what makes "one employee, one
-- worktree" structural (§5.1).
CREATE UNIQUE INDEX idx_worktree_lease
  ON worktrees(lease_holder) WHERE lease_holder IS NOT NULL;

CREATE TRIGGER trg_worktrees_updated_at
AFTER UPDATE ON worktrees FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE worktrees SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- conversations ------------------------------------------------------------

CREATE TABLE conversations (
  id                    TEXT PRIMARY KEY,
  company_id            TEXT NOT NULL REFERENCES companies(id),
  project_id            TEXT REFERENCES projects(id),
  title                 TEXT NOT NULL,
  director_session_id   TEXT,
  summary               TEXT,
  director_state        TEXT,
  director_state_data   TEXT CHECK (director_state_data IS NULL OR json_valid(director_state_data)),
  status                TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TRIGGER trg_conversations_updated_at
AFTER UPDATE ON conversations FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE conversations SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- conversation_messages ------------------------------------------------------------
-- Streaming (MUST, §5.1): inserted with status='streaming' before the
-- first token, updated on a throttle and once at completion. On reconcile,
-- any row still 'streaming' from before the app started becomes 'aborted'.

CREATE TABLE conversation_messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  project_id       TEXT REFERENCES projects(id),
  author           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  body             TEXT NOT NULL,
  payload          TEXT CHECK (payload IS NULL OR json_valid(payload)),
  checkpoint_id    TEXT REFERENCES checkpoints(id),
  status           TEXT NOT NULL DEFAULT 'complete',
  seq              INTEGER,
  read_at          TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TRIGGER trg_conversation_messages_updated_at
AFTER UPDATE ON conversation_messages FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE conversation_messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- messages ------------------------------------------------------------
-- Employee<->employee and employee<->Director handoffs. Durable outbox
-- pattern. updated_at not in §5.1's own listing; §5.0 rule applies
-- (status/attempts are mutable).

CREATE TABLE messages (
  id                     TEXT PRIMARY KEY,
  idempotency_key        TEXT NOT NULL UNIQUE,
  from_addr              TEXT NOT NULL,
  to_addr                TEXT NOT NULL,
  resolved_employee_id   TEXT REFERENCES employees(id),
  task_id                TEXT REFERENCES tasks(id),
  thread_id              TEXT,
  kind                   TEXT NOT NULL,
  priority               INTEGER NOT NULL DEFAULT 50,
  subject                TEXT,
  body                   TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  attempts               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        TEXT,
  delivered_at           TEXT,
  consumed_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

-- The router's hot query (§5.1).
CREATE INDEX idx_messages_router ON messages(status, next_attempt_at, priority DESC);

CREATE TRIGGER trg_messages_updated_at
AFTER UPDATE ON messages FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE messages SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- checkpoints ------------------------------------------------------------
-- updated_at not in §5.1's own listing; §5.0 rule applies (status is
-- mutable).

CREATE TABLE checkpoints (
  id               TEXT PRIMARY KEY,
  project_id       TEXT REFERENCES projects(id),
  task_id          TEXT REFERENCES tasks(id),
  employee_id      TEXT REFERENCES employees(id),
  type             TEXT NOT NULL,
  urgency          TEXT NOT NULL,
  tool_call_id     TEXT,
  tool_name        TEXT,
  args_preview     TEXT,
  title            TEXT NOT NULL,
  context          TEXT NOT NULL,
  options          TEXT CHECK (options IS NULL OR json_valid(options)),
  preview          TEXT CHECK (preview IS NULL OR json_valid(preview)),
  default_action   TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
  answer           TEXT CHECK (answer IS NULL OR json_valid(answer)),
  answered_by      TEXT,
  expires_at       TEXT,
  answered_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- A checkpoint whose every option is irreversible has no safe default,
  -- so it simply never expires (§9.5) — a non-null expires_at with no
  -- reversible option is invalid.
  CHECK (default_action IS NOT NULL OR expires_at IS NULL)
);

CREATE TRIGGER trg_checkpoints_updated_at
AFTER UPDATE ON checkpoints FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE checkpoints SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- deliverables ------------------------------------------------------------

CREATE TABLE deliverables (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id),
  phase_id    TEXT REFERENCES phases(id),
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  path        TEXT,
  summary     TEXT NOT NULL,
  status      TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TRIGGER trg_deliverables_updated_at
AFTER UPDATE ON deliverables FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE deliverables SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- artifacts ------------------------------------------------------------
-- Compact single-line definition in §5.1 — taken as complete (no
-- updated_at; intermediate outputs aren't edited in place).

CREATE TABLE artifacts (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tasks(id),
  employee_id     TEXT REFERENCES employees(id),
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  path            TEXT,
  content         TEXT,
  content_sha256  TEXT,
  bytes           INTEGER,
  mime            TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);

-- memory ------------------------------------------------------------
-- Index over markdown files (files are the source of truth). Explicit
-- INTEGER PRIMARY KEY rowid — required so VACUUM cannot desynchronise the
-- FTS index (§5.1).

CREATE TABLE memory (
  rowid            INTEGER PRIMARY KEY,
  id               TEXT UNIQUE NOT NULL,
  scope            TEXT NOT NULL,
  scope_ref        TEXT,
  path             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  body             TEXT NOT NULL,
  content_sha256   TEXT NOT NULL,
  tags             TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
  source           TEXT NOT NULL,
  pinned           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TRIGGER trg_memory_updated_at
AFTER UPDATE ON memory FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE memory SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, body, tags, content='memory', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Kept in sync by triggers (§5.1).
CREATE TRIGGER trg_memory_fts_insert AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

CREATE TRIGGER trg_memory_fts_delete AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;

CREATE TRIGGER trg_memory_fts_update AFTER UPDATE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO memory_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

-- events ------------------------------------------------------------
-- The activity log mirror. Authoritative record is activity.jsonl (§11.6).
-- `ts` is the event's own original time (from the JSONL entry, immutable);
-- `created_at` is when this mirror row was inserted, which can be later
-- than `ts` when reconcile() repairs a gap after a crash (finding #3).
-- No updated_at — events are never updated, only inserted (§5.0 exception).

CREATE TABLE events (
  seq            INTEGER PRIMARY KEY,
  id             TEXT NOT NULL,
  ts             TEXT NOT NULL,
  actor          TEXT NOT NULL,
  type           TEXT NOT NULL,
  severity       TEXT NOT NULL,
  project_id     TEXT,
  task_id        TEXT,
  employee_id    TEXT,
  checkpoint_id  TEXT,
  payload        TEXT CHECK (payload IS NULL OR json_valid(payload)),
  created_at     TEXT NOT NULL
);

-- counters ------------------------------------------------------------
-- §5.1.2: gapless, unique display keys under concurrent creation.
-- Incremented inside the same BEGIN IMMEDIATE transaction that inserts
-- the row using it (P-003, T-0042, ...).

CREATE TABLE counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);

-- usage ------------------------------------------------------------
-- cost_usd_micros and the token columns are nullable, not defaulted to 0:
-- §21 — "do not show $0.00 for an engine that does not report usage. Show
-- 'cost not reported'." A real NULL is what makes that distinction
-- representable.

CREATE TABLE usage (
  id                    TEXT PRIMARY KEY,
  employee_id           TEXT REFERENCES employees(id),
  task_id               TEXT REFERENCES tasks(id),
  engine                TEXT NOT NULL,
  model                 TEXT,
  tokens_in             INTEGER,
  tokens_out            INTEGER,
  tokens_cache_read     INTEGER,
  tokens_cache_write    INTEGER,
  cost_usd_micros       INTEGER,
  turn_index            INTEGER,
  source                TEXT NOT NULL DEFAULT 'turn',
  ts                    TEXT NOT NULL
);

-- prereqs ------------------------------------------------------------
-- Cached detection results. Compact single-line definition in §5.1.

CREATE TABLE prereqs (
  key          TEXT PRIMARY KEY,
  status       TEXT NOT NULL,
  version      TEXT,
  path         TEXT,
  detected_at  TEXT,
  notes        TEXT
);

-- secrets_meta ------------------------------------------------------------
-- No values, ever (§11.4). Compact single-line definition in §5.1.

CREATE TABLE secrets_meta (
  key            TEXT PRIMARY KEY,
  provider       TEXT,
  storage_ref    TEXT,
  last_set_at    TEXT,
  last_used_at   TEXT
);

-- settings ------------------------------------------------------------
-- §16.1's registry is the typed contract; this is just the storage shape.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  TEXT NOT NULL
);
