import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import {
  MemoryProposalSchema,
  NewMemoryProposalInputSchema,
  type MemoryProposal,
  type MemoryProposalStatus,
  type NewMemoryProposalInput,
} from '../../../shared/models/memoryProposal';

/**
 * Row access for §12.4's proposal queue. Rows only — every decision about
 * what a proposal *means* (is its scope gated, does it need a review, what
 * happens when it is accepted) lives in `src/main/memory/memoryProposals.ts`,
 * matching how every other repository in this directory is scoped.
 */

export function insertMemoryProposal(
  db: Database.Database,
  input: NewMemoryProposalInput,
): MemoryProposal {
  const parsed = NewMemoryProposalInputSchema.parse(input);
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO memory_proposals
       (id, scope, scope_ref, path, title, content, rationale, proposed_by,
        employee_id, project_id, phase_id, checkpoint_id, status,
        resolution_reason, resolved_by, resolved_at, applied_memory_id,
        created_at, updated_at)
     VALUES
       (@id, @scope, @scope_ref, @path, @title, @content, @rationale, @proposed_by,
        @employee_id, @project_id, @phase_id, @checkpoint_id, 'pending',
        NULL, NULL, NULL, NULL,
        @created_at, @updated_at)`,
  ).run({
    id,
    scope: parsed.scope,
    scope_ref: parsed.scope_ref,
    path: parsed.path,
    title: parsed.title,
    content: parsed.content,
    rationale: parsed.rationale,
    proposed_by: parsed.proposed_by,
    employee_id: parsed.employee_id,
    project_id: parsed.project_id,
    phase_id: parsed.phase_id,
    checkpoint_id: parsed.checkpoint_id,
    created_at: now,
    updated_at: now,
  });
  return getMemoryProposalById(db, id) as MemoryProposal;
}

export function getMemoryProposalById(db: Database.Database, id: string): MemoryProposal | null {
  const row = db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id);
  return row ? MemoryProposalSchema.parse(row) : null;
}

/** Everything still awaiting a decision on one review checkpoint. The
 *  review's count and its item list are both derived from this — the
 *  checkpoint row holds no copy, so nothing goes stale as items attach. */
export function listPendingProposalsForCheckpoint(
  db: Database.Database,
  checkpointId: string,
): MemoryProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_proposals
        WHERE checkpoint_id = ? AND status = 'pending'
        ORDER BY created_at, id`,
    )
    .all(checkpointId);
  return rows.map((row) => MemoryProposalSchema.parse(row));
}

/** Every pending proposal, newest last — what the memory view lists
 *  alongside the notes that already exist. */
export function listPendingProposals(db: Database.Database): MemoryProposal[] {
  const rows = db
    .prepare(`SELECT * FROM memory_proposals WHERE status = 'pending' ORDER BY created_at, id`)
    .all();
  return rows.map((row) => MemoryProposalSchema.parse(row));
}

/**
 * §12.4's "at most once per phase". `phase_id` is nullable and SQL never
 * matches NULL with `=`, so the null case is written out explicitly rather
 * than left to silently match nothing — the same bug §9.7's router query had
 * (`next_attempt_at <= now` against NULL), recorded in Known Issues.
 */
export function findOpenReviewCheckpointId(
  db: Database.Database,
  projectId: string | null,
  phaseId: string | null,
): string | null {
  const row = db
    .prepare(
      `SELECT p.checkpoint_id AS checkpoint_id
         FROM memory_proposals p
         JOIN checkpoints c ON c.id = p.checkpoint_id
        WHERE p.status = 'pending'
          AND c.status = 'pending'
          AND p.checkpoint_id IS NOT NULL
          -- IS, not =. A pre-plan proposal has no phase and a company-scope
          -- one may have no project, and "= NULL" is never true -- the same
          -- silent-never-matches bug §9.7's router query had against a NULL
          -- next_attempt_at (Known Issues, 2026-09-08). IS is SQLite's
          -- null-safe equality and matches both the value and the null case.
          AND p.project_id IS @projectId
          AND p.phase_id IS @phaseId
        ORDER BY p.created_at
        LIMIT 1`,
    )
    .get({ projectId, phaseId }) as { checkpoint_id: string } | undefined;
  return row?.checkpoint_id ?? null;
}

export function listExpiredPendingProposals(
  db: Database.Database,
  cutoffIso: string,
): MemoryProposal[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_proposals
        WHERE status = 'pending' AND created_at <= ?
        ORDER BY created_at, id`,
    )
    .all(cutoffIso);
  return rows.map((row) => MemoryProposalSchema.parse(row));
}

export function attachProposalToCheckpoint(
  db: Database.Database,
  proposalId: string,
  checkpointId: string,
): void {
  db.prepare(
    `UPDATE memory_proposals SET checkpoint_id = @checkpointId, updated_at = @now
      WHERE id = @proposalId AND status = 'pending'`,
  ).run({ proposalId, checkpointId, now: nowIso() });
}

export interface ResolveProposalInput {
  readonly status: Exclude<MemoryProposalStatus, 'pending'>;
  readonly reason: string;
  readonly resolvedBy: string;
  readonly appliedMemoryId?: string | null;
}

/**
 * **Compare-and-set on `pending`** — returns false if somebody else got
 * there first. That is what makes a double-apply structurally impossible:
 * the expiry sweep and a person answering the review can race, and the
 * loser's caller must do nothing rather than write a second file and a
 * second event. The same shape `recordCheckpointAnswer` uses, for the same
 * reason.
 */
export function casProposalResolved(
  db: Database.Database,
  proposalId: string,
  input: ResolveProposalInput,
): boolean {
  const result = db
    .prepare(
      `UPDATE memory_proposals
          SET status = @status,
              resolution_reason = @reason,
              resolved_by = @resolvedBy,
              resolved_at = @now,
              applied_memory_id = @appliedMemoryId,
              updated_at = @now
        WHERE id = @proposalId AND status = 'pending'`,
    )
    .run({
      proposalId,
      status: input.status,
      reason: input.reason,
      resolvedBy: input.resolvedBy,
      appliedMemoryId: input.appliedMemoryId ?? null,
      now: nowIso(),
    });
  return result.changes === 1;
}
