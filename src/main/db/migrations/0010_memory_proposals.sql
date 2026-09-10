-- 0010_memory_proposals.sql — M10. Two things §12 needs and §5.1 did not
-- have: a queue for §12.4's gated writes, and the two stat fields that keep
-- §12.1's out-of-band edit detection from re-reading the whole tree.

-- ## 1. The proposal queue (§12.4)
--
-- `bureau_propose_memory` has been ROW ONLY since M4, and its own comment
-- said exactly why: "§12.4's real memory-write-proposal flow needs a
-- dedicated proposal-queue table that does not exist yet — designing one
-- was not M4's to do." This is that table.
--
-- §12.4 asks for four things and each maps to columns here: the proposed
-- content and where it would go (`scope`/`scope_ref`/`path`/`content`), who
-- proposed it and why (`proposed_by`/`employee_id`/`rationale`), the batch
-- it belongs to (`checkpoint_id`, plus `project_id`/`phase_id`, because the
-- batch is "at most once per phase"), and its state through
-- accepted/rejected/expired.
--
-- **`checkpoint_id` points from the proposal to the checkpoint, never the
-- other way, and the checkpoint stores no copy of the list.** §12.4's
-- checkpoint is "review N proposed notes", and N changes as proposals
-- attach to an already-pending review. A count or a list copied onto the
-- checkpoint row would be stale the moment the next proposal arrived, and
-- keeping it fresh would mean mutating a pending checkpoint — a state
-- change owing an event, for a number that can simply be derived. So the
-- count is a query, and the sentence a person reads is the renderer's.
--
-- **`expired` is distinct from `rejected` only so the record says who.**
-- §12.4 calls the timeout outcome "auto-rejected **with a record**", so
-- both are rejections; splitting the status is what lets the trail answer
-- "did a person decide this, or did it simply run out?" without parsing a
-- reason string.

CREATE TABLE memory_proposals (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('company','project','role','employee','user')),
  scope_ref      TEXT,
  -- The canonical memory-root-relative path the accepted note would take,
  -- produced by `resolveMemoryTarget` — already confined, already
  -- `memoryRelativePath`-shaped. Not UNIQUE: two employees may legitimately
  -- propose different content for one file, and the review is where that is
  -- settled.
  path           TEXT NOT NULL,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  rationale      TEXT NOT NULL,
  -- 'employee:<id>' | 'director' | 'user' — the same actor shape the
  -- activity log uses, so a proposal and its events read alike.
  proposed_by    TEXT NOT NULL,
  employee_id    TEXT REFERENCES employees(id) ON DELETE SET NULL,
  project_id     TEXT REFERENCES projects(id) ON DELETE SET NULL,
  phase_id       TEXT REFERENCES phases(id) ON DELETE SET NULL,
  checkpoint_id  TEXT REFERENCES checkpoints(id) ON DELETE SET NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','expired')),
  -- Why it left `pending`. Null while pending.
  resolution_reason TEXT,
  resolved_by    TEXT,
  resolved_at    TEXT,
  -- The `memory` row an accepted proposal produced, so the trail runs from
  -- the proposal to the note it became.
  applied_memory_id TEXT REFERENCES memory(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- The review's own query: everything still pending on one checkpoint.
CREATE INDEX idx_memory_proposals_checkpoint ON memory_proposals(checkpoint_id, status);
-- The expiry sweep's query: pending, oldest first.
CREATE INDEX idx_memory_proposals_pending ON memory_proposals(status, created_at);
-- "Is there already a review open for this phase?" — the at-most-once-per-
-- phase rule, answered without scanning.
CREATE INDEX idx_memory_proposals_batch ON memory_proposals(project_id, phase_id, status);

-- ## 2. Stat-before-hash for the index reconciler (§12.1)
--
-- §28's M10 item 1 is "file watching for out-of-band edits via
-- `content_sha256`", and detection is what M10 builds: the index reconciles
-- against layer 1 at startup, before every memory-pack composition, and
-- before every search. Hashing every file on every one of those would not
-- stay cheap as the tree grows per project, per role and per employee — and
-- CLAUDE.md's rule is to fix the performance, not add a switch that turns
-- the work off.
--
-- So the reconciler stats first (the walker already stats every entry to
-- find directories) and only reads and hashes a file whose stamp moved.
--
-- **These two columns are a skip hint, never the authority.**
-- `content_sha256` remains the truth about what is indexed. A file edited
-- so as to leave mtime and size unchanged is the case a stamp cannot see,
-- and it has a user-reachable repair: `memory.reindex` hashes
-- unconditionally, ignoring the stamp entirely.
--
-- Nullable, because every row written before this migration has no stamp —
-- and a null stamp reads as "unknown", which forces a hash. Failing toward
-- more work is the right direction for a cache.

ALTER TABLE memory ADD COLUMN file_mtime_ms INTEGER;
ALTER TABLE memory ADD COLUMN file_size INTEGER;
