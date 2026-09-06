-- 0006_packs_and_role_inputs.sql — M7. 0001-0005 are already applied to
-- real dev DBs, so this is a new file rather than an edit to any of them,
-- per §5.3 rule 1 and MigrationChecksumMismatchError.
--
-- Three things, one migration, because they are all "role YAML's shape is
-- being frozen at M7 and the DB has to be able to hold it".

-- packs ----------------------------------------------------------------
-- §5.1 had no `packs` table: departments and roles both carry a `pack_id`
-- TEXT with nothing on the other end of it. That was survivable while
-- nothing installed a pack. It stops being survivable at M7 for one
-- specific reason: §6.7 says a pack that fails validation "is disabled
-- with a readable error", and a readable error needs somewhere durable to
-- live — otherwise the only record of WHY a pack is unavailable is a log
-- line the user will never see, and `packs.list` can report neither
-- `enabled` nor `version`.
--
-- `enabled` records the USER'S INTENT and is never rewritten by the
-- system. A previously-installed pack that fails validation at boot keeps
-- `enabled = 1`, gets `last_validation_status = 'failed'` plus the
-- readable error, and simply has its roles and departments withheld. So
-- "disabled with a readable error" means *effectively unavailable, with a
-- reason* — not a silent flip of a user setting. Flipping it to 0 would
-- mean that fixing the pack leaves it off with nothing explaining why.
--
-- `source_path` is PROVENANCE — where the pack was installed FROM — and
-- explicitly not where it lives now. A user-installed pack is copied into
-- `%APPDATA%/Bureau/packs/<key>/`; a bundled pack is read from
-- `resourcesPath/packs/<key>/`. `origin` is what distinguishes them,
-- since only one of the two is writable.

CREATE TABLE packs (
  key                     TEXT PRIMARY KEY,
  name                    TEXT NOT NULL,
  version                 TEXT NOT NULL,
  origin                  TEXT NOT NULL CHECK (origin IN ('bundled', 'user')),
  source_path             TEXT NOT NULL,
  installed_at            TEXT NOT NULL,
  enabled                 INTEGER NOT NULL DEFAULT 1,
  last_validation_status  TEXT NOT NULL DEFAULT 'ok'
                            CHECK (last_validation_status IN ('ok', 'failed')),
  last_validation_error   TEXT,
  last_validated_at       TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE TRIGGER trg_packs_updated_at
AFTER UPDATE ON packs FOR EACH ROW
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE packs SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = NEW.key;
END;

-- roles: the four §6.5 fields §5.1 never had a column for ---------------
-- Found by writing the role.yaml Zod schema against §6.5's full reference
-- and diffing it against §5.1's `roles` listing. `shared_prompts`,
-- `memory_budget_tokens`, `escalate_when` and `reports` are all in §6.5 —
-- two of them REQUIRED and non-empty — and none of them had anywhere to
-- go. Installing a pack would have parsed them, validated them, and then
-- silently dropped them on the floor, which is precisely the class of
-- failure §6.7's validation exists to prevent.
--
-- They are added now rather than when their consumer lands (prompt
-- assembly is M11; the memory pack that spends `memory_budget_tokens` is
-- M10) because this is the session that freezes role YAML's shape and
-- authors the shipped packs against it. Adding them later means a second
-- migration AND re-validating every shipped pack against a changed
-- schema. This is schema, not behaviour: additive, defaulted, and
-- exercised the day it lands by the pack round-trip tests.

ALTER TABLE roles ADD COLUMN shared_prompts TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(shared_prompts));

ALTER TABLE roles ADD COLUMN memory_budget_tokens INTEGER NOT NULL DEFAULT 8000;

-- §6.5: "what makes an employee behave like a colleague rather than a text
-- generator". A JSON array of plain-language conditions, injected into the
-- system prompt at M11.
ALTER TABLE roles ADD COLUMN escalate_when TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(escalate_when));

-- §6.5's `reports: {on_complete, on_block}` — a JSON object, not two
-- columns, because it is one shape the pack author edits as a unit and the
-- Core never queries either half independently.
ALTER TABLE roles ADD COLUMN reports TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(reports));

-- roles.input_types -----------------------------------------------------
-- What a role CONSUMES, mirroring `deliverable_types` (what it produces).
-- The reference-material parking-lot entry: a user hands the company a
-- spreadsheet or a PDF and expects the right employee to be able to read
-- it. Enforcement and the format-aware folder scanner are M13/M14; the
-- column is added here so M14 needs no second migration and so the shipped
-- packs declare it from the start.
--
-- `[]` means "no declared restriction", NOT "nothing" — the same
-- convention `deliverable_types` already uses, and deliberately not the
-- one `network_allow` uses (where empty is a real, restrictive value).
ALTER TABLE roles ADD COLUMN input_types TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(input_types));
