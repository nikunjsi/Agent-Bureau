-- 0002_add_engine_options.sql — adds roles.engine_options (§7.1.1/§6.5, M3
-- session 2). 0001 is already applied to a real dev DB — a new migration
-- file, not an edit to 0001, per §5.3 rule 1 and MigrationChecksumMismatchError.
--
-- A single, flat, per-role engine-options value — NOT array-wrapped (a role
-- runs under one engine; there is no multi-engine fallback), and NOT tagged
-- with its own `engine` field internally (the role's own `engine_preference`
-- is the one source of truth for which engine a role uses — duplicating it
-- inside this JSON value would let the two drift). Validated against the
-- specific engine's Zod schema at role-load time
-- (src/main/db/repositories/roles.ts's insertRole), keyed by
-- engine_preference[0], not re-validated generically here.

ALTER TABLE roles ADD COLUMN engine_options TEXT
  CHECK (engine_options IS NULL OR json_valid(engine_options));
