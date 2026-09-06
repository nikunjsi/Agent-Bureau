-- 0007_employee_archive_and_room_prefs.sql — M7 session 2. 0001-0006 are
-- already applied to real dev DBs, so this is a new file rather than an
-- edit to any of them, per §5.3 rule 1 and MigrationChecksumMismatchError.

-- employees.archived_at ------------------------------------------------
-- §6.8: "Firing an employee archives their memory rather than deleting it
-- — if rehired into the same role, they resume with what they learned."
-- Nothing represented that. `EmployeeStatusSchema` has ten values and none
-- of them means "no longer employed".
--
-- **Why a column and not an eleventh status.** Employment and process
-- state are ORTHOGONAL. Every existing status describes what the engine
-- process is doing — off, starting, idle, working, thinking, waiting,
-- blocked, parked, stopping, failed. "No longer employed" is not a process
-- state, and making it one breaks three things:
--
--   1. §13.4's `deriveVisualState` is a normative ordered function over
--      `status`; M12 would have to handle a value that is not about the
--      process at all.
--   2. Firing someone who is `working` would have to destroy the fact that
--      they were working, or impose a stop-then-fire ordering that
--      conflates two separate operations.
--   3. Rehiring would have to invent a status to restore to.
--
-- With a column, a fired employee is `status='off'` AND `archived_at` set,
-- and rehire is `archived_at = NULL`. The ROW SURVIVES, which is the whole
-- point: employee memory is markdown keyed by employee id
-- (`memory/employee/<id>/`), so a deleted row would dangle the id and make
-- §6.8's rehire promise impossible to keep.
--
-- Consequence worth knowing: an archived employee still owns their name.
-- `employees.name` is UNIQUE, and §6.8's first-name rule counts archived
-- rows too — that is correct, since it makes rehire unambiguous and stops
-- a second "Ravi" appearing while the first is merely archived.

ALTER TABLE employees ADD COLUMN archived_at TEXT;

-- Partial index: the overwhelmingly common query is "the active roster",
-- and indexing only the NULLs keeps it small.
CREATE INDEX idx_employees_active ON employees(archived_at) WHERE archived_at IS NULL;

-- departments.preferred_w / preferred_h ---------------------------------
-- §13.3 step 3 sizes each room to `max(preferred_size, ceil(employees / 4)
-- desks + walking space)`, so it needs the pack's preferred size on EVERY
-- run. It could not have it: `installPack` wrote the preferred size into
-- `room_rect`, so the first generator run — which overwrites `room_rect`
-- with the ALLOCATED rect — destroyed its own input.
--
-- The two values have different owners, and conflating them is what caused
-- the bug:
--
--   preferred_w/h   owned by the PACK (§6.4 `room.preferred_size`)
--                   — what this department asks for
--   room_rect       owned by the GENERATOR (§13.3)
--                   — what it actually got
--
-- Rejected: stuffing it into the `theme` JSON blob (a lie about what
-- `theme` is), widening `room_rect`'s own JSON (conflates them again), and
-- re-reading the pack directory per run (the pack can be uninstalled or
-- edited underneath us).
--
-- Defaults match §6.4's own example room so a pre-0007 department row
-- remains generatable rather than sizing to zero.

ALTER TABLE departments ADD COLUMN preferred_w INTEGER NOT NULL DEFAULT 8;
ALTER TABLE departments ADD COLUMN preferred_h INTEGER NOT NULL DEFAULT 6;
