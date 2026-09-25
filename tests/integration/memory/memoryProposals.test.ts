import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getMemoryDir } from '../../../src/main/db/paths';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { nowIso } from '../../../src/shared/models/ids';
import { insertBrief } from '../../../src/main/db/repositories/briefs';
import { insertPlan } from '../../../src/main/db/repositories/plans';
import { insertPhase } from '../../../src/main/db/repositories/phases';
import { listPendingCheckpoints } from '../../../src/main/db/repositories/checkpoints';
import {
  getMemoryProposalById,
  listPendingProposalsForCheckpoint,
} from '../../../src/main/db/repositories/memoryProposals';
import {
  REVIEW_OPTION_IDS,
  proposeMemoryWrite,
  type MemoryProposalDeps,
} from '../../../src/main/memory/memoryProposals';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import { expireMemoryProposalsTick } from '../../../src/main/checkpoints/checkpointsTick';
import { getMemoryRowByPath } from '../../../src/main/memory/memoryStore';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const DAY_MS = 86_400_000;

/**
 * §12.4 — gated writes, batching, and the expiry that keeps a `whenever`
 * checkpoint from accumulating forever.
 *
 * **The §9.5 question this file settles.** §12.4 calls itself an exception
 * to "`whenever` checkpoints never expire". The implementation is not one,
 * and that is asserted rather than argued: the review checkpoint carries
 * `expires_at = null` throughout, and what runs out is each *proposal*. The
 * checkpoint is resolved as a consequence of its last pending item going.
 */
describe('§12.4: proposed memory writes are gated, batched, and expire with a record', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let deps: MemoryProposalDeps;
  let projectId: string;
  let phaseId: string;
  let employeeId: string;

  function eventsOfType(type: string): { payload: Record<string, unknown> }[] {
    return (
      db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type) as {
        payload: string;
      }[]
    ).map((row) => ({ payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  function propose(overrides: Record<string, unknown> = {}) {
    return proposeMemoryWrite(deps, {
      scope: 'project',
      path: `${projectId}/decisions-extra.md`,
      content: '# A thing worth remembering\n\nThe API is versioned in the path.',
      rationale: 'It came up twice.',
      writer: 'employee',
      proposedBy: `employee:${employeeId}`,
      employeeId,
      projectId,
      phaseId,
      ...overrides,
    } as never);
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-memprop-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    deps = { db, activityLog, baseDir: tmpDir };

    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', nowIso(), nowIso());
    const role = insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role', 'project', 'company'],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    employeeId = insertEmployee(db, {
      name: 'Quinn',
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'working',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never).id;

    const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
    projectId = project.id;
    const brief = insertBrief(db, {
      project_id: project.id,
      version: 1,
      content: { goal: 'Ship it' },
      markdown: '# Brief',
      status: 'approved',
    });
    const plan = insertPlan(db, {
      project_id: project.id,
      brief_id: brief.id,
      version: 1,
      content: {},
      status: 'approved',
    });
    phaseId = insertPhase(db, {
      plan_id: plan.id,
      ordinal: 1,
      name: 'Phase 1',
      goal: 'Build it',
    }).id;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- free vs gated -------------------------------------------------

  it('an employee’s own notes are written immediately, with no checkpoint', () => {
    const outcome = propose({ scope: 'employee', path: 'notes.md' });

    expect(outcome.kind).toBe('applied');
    expect(existsSync(path.join(getMemoryDir(tmpDir), 'employee', employeeId, 'notes.md'))).toBe(
      true,
    );
    // §12.4: "writes to `employee/` are free". A checkpoint here would put a
    // question in front of the user that §12.4 says should never be asked.
    expect(listPendingCheckpoints(db)).toHaveLength(0);
    expect(eventsOfType('memory.write_applied')).toHaveLength(1);
  });

  it('the event says created the first time and updated the second', () => {
    // `writeMemory`'s own `changed` flag answers a different question —
    // whether the bytes moved — so reporting a first write as "updated"
    // would make the trail wrong in the one place it is consulted to find
    // out when a note came into existence.
    propose({ scope: 'employee', path: 'notes.md', content: '# Notes\n\nOne.' });
    propose({ scope: 'employee', path: 'notes.md', content: '# Notes\n\nOne and two.' });
    // Byte-identical to the previous write: nothing changed, and the event
    // says so rather than claiming an update.
    propose({ scope: 'employee', path: 'notes.md', content: '# Notes\n\nOne and two.' });

    const changes = eventsOfType('memory.write_applied').map((event) => event.payload['change']);
    expect(changes).toEqual(['created', 'updated', 'unchanged']);
  });

  it('the review checkpoint leaves the permission-only columns null (§5.1)', () => {
    propose();
    const row = db
      .prepare('SELECT tool_call_id, tool_name, args_preview FROM checkpoints LIMIT 1')
      .get() as Record<string, unknown>;

    // §5.1: "`tool_name`, `args_preview` — `permission` type only". The
    // first draft used `args_preview` to record who opened the review, which
    // is both off-label and untrue the moment a second employee's note
    // joins it. Provenance lives on the proposal rows.
    expect(row).toEqual({ tool_call_id: null, tool_name: null, args_preview: null });
  });

  it.each(['company', 'project', 'role', 'user'] as const)(
    '%s scope is gated: nothing is written until somebody says so',
    (scope) => {
      const outcome = propose(
        scope === 'project'
          ? {}
          : { scope, path: scope === 'role' ? 'engineering/developer/lessons.md' : 'notes.md' },
      );

      expect(outcome.kind).toBe('queued');
      // The load-bearing half: a queued proposal has touched no file.
      expect(getMemoryRowByPath(db, outcome.kind === 'queued' ? outcome.proposal.path : '')).toBe(
        null,
      );
      expect(eventsOfType('memory.write_proposed')).toHaveLength(1);
      expect(eventsOfType('memory.write_applied')).toHaveLength(0);
    },
  );

  // ---- batching ------------------------------------------------------

  it('three proposals in one phase produce ONE review, not three', () => {
    const first = propose({ path: `${projectId}/a.md` });
    const second = propose({ path: `${projectId}/b.md` });
    const third = propose({ path: `${projectId}/c.md` });

    // §12.4: "batched into a single 'review N proposed notes' checkpoint …
    // raised at most once per phase". Five separate pings for one phase is
    // the failure §9.3 and §12.4 both exist to prevent.
    const pending = listPendingCheckpoints(db);
    expect(pending).toHaveLength(1);
    expect(first.kind === 'queued' && first.checkpointId).toBe(pending[0]?.id);
    expect(second.kind === 'queued' && second.checkpointId).toBe(pending[0]?.id);
    expect(third.kind === 'queued' && third.checkpointId).toBe(pending[0]?.id);

    // The count is derived, never stored — which is why a fourth proposal
    // joining cannot leave a stale "3" on the checkpoint row.
    expect(listPendingProposalsForCheckpoint(db, pending[0]!.id)).toHaveLength(3);
    expect(pending[0]?.title).not.toMatch(/\d/);
  });

  it('a second phase gets its own review', () => {
    propose();
    const plan = db.prepare('SELECT id FROM plans LIMIT 1').get() as { id: string };
    const secondPhase = insertPhase(db, {
      plan_id: plan.id,
      ordinal: 2,
      name: 'Phase 2',
      goal: 'Ship it',
    });
    propose({ phaseId: secondPhase.id, path: `${projectId}/later.md` });

    expect(listPendingCheckpoints(db)).toHaveLength(2);
  });

  it('the review is a `whenever` checkpoint with NO expiry — §9.5 is untouched', () => {
    propose();
    const checkpoint = listPendingCheckpoints(db)[0]!;

    expect(checkpoint.urgency).toBe('whenever');
    // The whole §9.5 question. If this is ever non-null, §12.4 has been
    // turned into a real exception instead of a mechanism that needs none.
    expect(checkpoint.expires_at).toBeNull();
    // A safe default is still legal and still stated (§9.2, invariant #8) —
    // it simply never fires on a clock.
    expect(checkpoint.default_action).toBe(REVIEW_OPTION_IDS.rejectAll);
    for (const option of checkpoint.options ?? []) {
      expect(option.consequence.length).toBeGreaterThan(0);
    }
  });

  // ---- answering -----------------------------------------------------

  it('accept/reject per item: the accepted note is written, the rejected one is not', () => {
    const keep = propose({ path: `${projectId}/keep.md`, content: '# Keep\n\nWorth having.' });
    const drop = propose({ path: `${projectId}/drop.md`, content: '# Drop\n\nNot worth it.' });
    const checkpointId = listPendingCheckpoints(db)[0]!.id;

    const result = answerCheckpoint(deps, {
      checkpointId,
      optionId: REVIEW_OPTION_IDS.review,
      source: 'user',
      itemDecisions: [
        { proposalId: keep.kind === 'queued' ? keep.proposal.id : '', decision: 'accept' },
        { proposalId: drop.kind === 'queued' ? drop.proposal.id : '', decision: 'reject' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.memoryProposalsApplied).toHaveLength(1);
    expect(result.ok === true && result.memoryProposalsRejected).toHaveLength(1);

    expect(existsSync(path.join(getMemoryDir(tmpDir), 'project', projectId, 'keep.md'))).toBe(true);
    expect(existsSync(path.join(getMemoryDir(tmpDir), 'project', projectId, 'drop.md'))).toBe(
      false,
    );
    // The trail records both halves, and the rejection is not silent.
    expect(eventsOfType('memory.write_applied')).toHaveLength(1);
    expect(eventsOfType('memory.write_rejected')).toHaveLength(1);
  });

  it('an incomplete per-item answer is refused, writes nothing, and leaves the review open', () => {
    const first = propose({ path: `${projectId}/one.md` });
    propose({ path: `${projectId}/two.md` });
    const checkpointId = listPendingCheckpoints(db)[0]!.id;

    const result = answerCheckpoint(deps, {
      checkpointId,
      optionId: REVIEW_OPTION_IDS.review,
      source: 'user',
      itemDecisions: [
        { proposalId: first.kind === 'queued' ? first.proposal.id : '', decision: 'accept' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('incomplete_item_decisions');
    // The refusal happens BEFORE the CAS, so the review really is still
    // answerable — a partially resolved one the user believes they finished
    // is the state batching exists to prevent.
    expect(listPendingCheckpoints(db)).toHaveLength(1);
    expect(listPendingProposalsForCheckpoint(db, checkpointId)).toHaveLength(2);
    expect(eventsOfType('memory.write_applied')).toHaveLength(0);
  });

  it('rejecting all writes nothing and records every rejection', () => {
    propose({ path: `${projectId}/a.md` });
    propose({ path: `${projectId}/b.md` });
    const checkpointId = listPendingCheckpoints(db)[0]!.id;

    const result = answerCheckpoint(deps, {
      checkpointId,
      optionId: REVIEW_OPTION_IDS.rejectAll,
      source: 'user',
    });

    expect(result.ok === true && result.memoryProposalsRejected).toHaveLength(2);
    expect(eventsOfType('memory.write_rejected')).toHaveLength(2);
    expect(existsSync(path.join(getMemoryDir(tmpDir), 'project', projectId))).toBe(false);
  });

  // ---- expiry --------------------------------------------------------

  it('auto-rejects after retention.memoryProposalDays, WITH a record', () => {
    const queued = propose();
    const proposalId = queued.kind === 'queued' ? queued.proposal.id : '';
    const checkpointId = listPendingCheckpoints(db)[0]!.id;

    setSetting(db, 'retention.memoryProposalDays', 14);
    const fifteenDaysLater = Date.now() + 15 * DAY_MS;

    const report = expireMemoryProposalsTick(deps, {
      // Started long enough ago that the post-restart grace has lifted —
      // the other half of this behaviour has its own test below.
      appStartedAtMs: fifteenDaysLater - 3_600_000,
      nowMs: fifteenDaysLater,
    });

    expect(report.expired).toEqual([proposalId]);
    // §12.4: "auto-rejected-**with a record**. The rejection is recorded,
    // not silent." Both halves: the row and the event.
    expect(getMemoryProposalById(db, proposalId)?.status).toBe('expired');
    const rejected = eventsOfType('memory.write_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.payload['reason']).toBe('expired');

    // And the review it emptied is closed, so the queue really is bounded.
    expect(report.closedCheckpoints).toEqual([checkpointId]);
    expect(listPendingCheckpoints(db)).toHaveLength(0);
  });

  it('the closed review is NOT recorded as a timeout, because it did not time out', () => {
    propose();
    setSetting(db, 'retention.memoryProposalDays', 14);
    const later = Date.now() + 15 * DAY_MS;

    expireMemoryProposalsTick(deps, { appStartedAtMs: later - 3_600_000, nowMs: later });

    const resolved = eventsOfType('checkpoint.auto_resolved');
    expect(resolved).toHaveLength(1);
    // The checkpoint had `expires_at = null` and no clock ever touched it.
    // Claiming `appliedDefault` — the field a real timeout carries — would
    // make the trail wrong about the one thing someone opens it to learn.
    expect(resolved[0]?.payload['reason']).toBe('all_proposals_expired');
    expect(resolved[0]?.payload).not.toHaveProperty('appliedDefault');

    const row = db.prepare('SELECT answered_by FROM checkpoints LIMIT 1').get() as {
      answered_by: string;
    };
    expect(row.answered_by).toBe('system:all_proposals_expired');
  });

  it('the post-restart grace suppresses expiry, and says how much it held back', () => {
    propose();
    setSetting(db, 'retention.memoryProposalDays', 14);
    const later = Date.now() + 15 * DAY_MS;

    // Bureau has just started. CLAUDE.md names this exact trap: "do not
    // auto-resolve checkpoints in the first ten minutes after a restart."
    // Someone who opens the app after a fortnight away must not watch their
    // review empty itself before they have read it.
    const report = expireMemoryProposalsTick(deps, { appStartedAtMs: later, nowMs: later });

    expect(report.expired).toEqual([]);
    expect(report.suppressedByGrace).toBe(1);
    expect(listPendingCheckpoints(db)).toHaveLength(1);
    // Not resolving is not a state change, so nothing is emitted for it.
    expect(eventsOfType('memory.write_rejected')).toHaveLength(0);
  });

  it('a proposal younger than the retention window is left alone', () => {
    propose();
    setSetting(db, 'retention.memoryProposalDays', 14);
    const thirteenDaysLater = Date.now() + 13 * DAY_MS;

    const report = expireMemoryProposalsTick(deps, {
      appStartedAtMs: thirteenDaysLater - 3_600_000,
      nowMs: thirteenDaysLater,
    });

    expect(report.expired).toEqual([]);
    expect(listPendingCheckpoints(db)).toHaveLength(1);
  });
});
