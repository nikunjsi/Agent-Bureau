import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertBrief } from '../../../src/main/db/repositories/briefs';
import {
  setProjectApprovedBrief,
  setProjectBriefAndPlan,
} from '../../../src/main/db/repositories/projects';
import { setPhaseStatus } from '../../../src/main/db/repositories/phases';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import { proposeMemoryWrite } from '../../../src/main/memory/memoryProposals';
import { REVIEW_OPTION_IDS } from '../../../src/main/memory/memoryProposals';
import { expireMemoryProposalsTick } from '../../../src/main/checkpoints/checkpointsTick';
import { ensureProjectWorkspace } from '../../../src/main/workspace/projectWorkspace';
import { createPhaseIntegrationBranch } from '../../../src/main/workspace/employeeWorktree';
import { acceptPhase } from '../../../src/main/projects/phaseReview';
import { seedEmployee, seedPhase, seedPlan, seedProject } from '../../helpers/dbFixtures';
import { seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S3-7, §12.4, decision E-4: **the memory review is raised at most once
 * per phase.** A note proposed after its phase's review was answered does not
 * raise a second review: it waits, and joins the next phase's batch. Notes
 * still waiting when the last phase is accepted are raised then, at
 * delivery. The 14-day auto-reject clock runs from when the batch is
 * **raised**, so a note that waited is never expired unread.
 */
const DAY_MS = 86_400_000;

describe('the memory review, at most once per phase', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let projectId: string;
  let employeeId: string;
  let phaseOne: string;
  let phaseTwo: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-review-once-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
    seedCompany(db, path.join(tmpDir, 'home'));
    const project = seedProject(db, { path: path.join(tmpDir, 'home', 'luigi') });
    projectId = project.id;
    employeeId = seedEmployee(db).id;
    const plan = seedPlan(db, { project_id: projectId, status: 'approved' });
    phaseOne = seedPhase(db, { plan_id: plan.id, ordinal: 1 }).id;
    phaseTwo = seedPhase(db, { plan_id: plan.id, ordinal: 2, name: 'Phase 2' }).id;
    setProjectBriefAndPlan(db, projectId, plan.brief_id, plan.id);
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const deps = () => ({ db, activityLog, baseDir });

  let n = 0;
  const propose = (phaseId: string) => {
    n += 1;
    return proposeMemoryWrite(deps(), {
      scope: 'project',
      path: `${projectId}/note-${n}.md`,
      content: `# Note ${n}\n\nSomething worth remembering.`,
      rationale: 'It came up.',
      writer: 'employee',
      proposedBy: `employee:${employeeId}`,
      employeeId,
      projectId,
      phaseId,
    } as never);
  };

  const reviews = () =>
    db
      .prepare(
        "SELECT id, status, created_at FROM checkpoints WHERE type = 'approval' ORDER BY rowid",
      )
      .all() as { id: string; status: string; created_at: string }[];

  const answerReview = (id: string) =>
    answerCheckpoint(deps(), {
      checkpointId: id,
      optionId: REVIEW_OPTION_IDS.rejectAll,
      source: 'user',
    });

  it('a note after the phase’s review was answered waits, then joins the next phase’s batch', () => {
    propose(phaseOne);
    propose(phaseOne);
    expect(reviews()).toHaveLength(1);
    expect(answerReview(reviews()[0]!.id).ok).toBe(true);

    const late = propose(phaseOne);
    expect(late.kind).toBe('held');
    // No second review for phase 1.
    expect(reviews()).toHaveLength(1);

    const next = propose(phaseTwo);
    expect(next.kind).toBe('queued');
    expect(reviews()).toHaveLength(2);
    const batch = reviews()[1]!.id;
    const inBatch = db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_proposals WHERE checkpoint_id = ? AND status = 'pending'",
      )
      .get(batch) as { n: number };
    expect(inBatch.n).toBe(2);
  });

  it('the 14-day clock runs from when the batch is raised, not from when the note was made', () => {
    propose(phaseOne);
    expect(answerReview(reviews()[0]!.id).ok).toBe(true);
    const late = propose(phaseOne);
    if (late.kind !== 'held') throw new Error('expected a held note');
    // The note has waited 20 days before its batch is raised.
    db.prepare('UPDATE memory_proposals SET created_at = ? WHERE id = ?').run(
      new Date(Date.now() - 20 * DAY_MS).toISOString(),
      late.proposal.id,
    );
    // Held notes are never expired: they have not been shown yet.
    let report = expireMemoryProposalsTick(deps(), { appStartedAtMs: 0, nowMs: Date.now() });
    expect(report.expired).toEqual([]);

    propose(phaseTwo);
    report = expireMemoryProposalsTick(deps(), { appStartedAtMs: 0, nowMs: Date.now() });
    expect(report.expired).toEqual([]);
    // Fifteen days after the batch was raised, it expires.
    report = expireMemoryProposalsTick(deps(), {
      appStartedAtMs: 0,
      nowMs: Date.now() + 15 * DAY_MS,
    });
    expect(report.expired).toContain(late.proposal.id);
  });

  it('notes still waiting when the last phase is accepted are raised at delivery', async () => {
    // Phase 1 is done; phase 2 is the last and is in review.
    setPhaseStatus(db, phaseOne, 'done');
    propose(phaseTwo);
    expect(answerReview(reviews()[0]!.id).ok).toBe(true);
    const late = propose(phaseTwo);
    expect(late.kind).toBe('held');
    expect(reviews()).toHaveLength(1);

    const brief = insertBrief(db, {
      project_id: projectId,
      version: 1,
      status: 'approved',
      markdown: '# Brief',
      content: {},
    });
    setProjectApprovedBrief(db, projectId, brief.id, 'software');
    expect((await ensureProjectWorkspace({ db, activityLog }, projectId)).ok).toBe(true);
    const project = db
      .prepare('SELECT path, base_ref FROM projects WHERE id = ?')
      .get(projectId) as {
      path: string;
      base_ref: string;
    };
    await createPhaseIntegrationBranch(project.path, 2, project.base_ref);
    setPhaseStatus(db, phaseTwo, 'review');

    const accepted = await acceptPhase({ db, activityLog }, phaseTwo);
    expect(accepted.kind).toBe('accepted');
    expect(reviews()).toHaveLength(2);
    const lastBatch = reviews()[1]!;
    expect(lastBatch.status).toBe('pending');
    expect(
      db
        .prepare('SELECT checkpoint_id FROM memory_proposals WHERE id = ?')
        .get(late.kind === 'held' ? late.proposal.id : ''),
    ).toEqual({ checkpoint_id: lastBatch.id });
  });
});
