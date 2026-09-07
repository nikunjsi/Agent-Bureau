-- 0009_checkpoints_fts.sql — M8 session 1. The index §9.2's duplicate check
-- reads ("checkpoint creation runs a duplicate-check against answered
-- checkpoints in the same project first"), plus the index the timeout
-- sweep's own hot query needs.
--
-- ## Why this is NOT an external-content FTS table
--
-- `memory_fts` uses `content='memory', content_rowid='rowid'`, and §5.1
-- gave `memory` an explicit `rowid INTEGER PRIMARY KEY` specifically so
-- that VACUUM could not renumber rowids out from under it —
-- `tests/integration/ftsVacuum.test.ts` pins that behaviour.
--
-- `checkpoints` has `id TEXT PRIMARY KEY`, so its rowid is IMPLICIT, and
-- an implicit rowid is exactly what VACUUM is free to renumber. An
-- external-content index over this table would therefore be silently
-- corruptible by a maintenance operation, and the only fix at that point
-- would be rewriting the table (the copy-rename dance of §5.3 rule 3) on a
-- table five production paths already write to.
--
-- A standalone FTS5 table keyed by `checkpoint_id` sidesteps the hazard
-- entirely: it stores its own copy of the text, joins on a TEXT id that
-- nothing renumbers, and costs a duplicate of two short columns. That is
-- the right trade for an index whose whole job is to stop Bureau asking a
-- question it already has the answer to.

CREATE VIRTUAL TABLE checkpoints_fts USING fts5(
  checkpoint_id UNINDEXED, title, context,
  tokenize='porter unicode61'
);

-- Kept in sync by triggers, the same shape as trg_memory_fts_*. Deletes
-- are by `checkpoint_id` rather than by rowid, for the reason above.
CREATE TRIGGER trg_checkpoints_fts_insert AFTER INSERT ON checkpoints BEGIN
  INSERT INTO checkpoints_fts(checkpoint_id, title, context)
  VALUES (new.id, new.title, new.context);
END;

CREATE TRIGGER trg_checkpoints_fts_delete AFTER DELETE ON checkpoints BEGIN
  DELETE FROM checkpoints_fts WHERE checkpoint_id = old.id;
END;

CREATE TRIGGER trg_checkpoints_fts_update AFTER UPDATE ON checkpoints BEGIN
  DELETE FROM checkpoints_fts WHERE checkpoint_id = old.id;
  INSERT INTO checkpoints_fts(checkpoint_id, title, context)
  VALUES (new.id, new.title, new.context);
END;

-- Backfill whatever already exists. 0001-0008 are applied to real dev DBs
-- that may already hold checkpoint rows (M5's merge conflicts, M6's budget
-- and breaker rows), and an index that silently starts at "everything
-- before today is invisible" would make duplicate detection quietly wrong
-- rather than loudly absent.
INSERT INTO checkpoints_fts(checkpoint_id, title, context)
SELECT id, title, context FROM checkpoints;

-- The timeout sweep's own query: pending rows whose expires_at has passed
-- (§9.5). Before M8 nothing ever set expires_at, so nothing ever ran this
-- query; from now on a periodic tick runs it every minute.
CREATE INDEX idx_checkpoints_expiry ON checkpoints(status, expires_at);
