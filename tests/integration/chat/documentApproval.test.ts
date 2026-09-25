import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { getBriefById } from '../../../src/main/db/repositories/briefs';
import { getPlanById } from '../../../src/main/db/repositories/plans';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { briefHandlers } from '../../../src/main/ipc/handlers/brief';
import { planHandlers } from '../../../src/main/ipc/handlers/plan';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { seedBrief, seedPlan, seedProject } from '../../helpers/dbFixtures';
import { newId } from '../../../src/shared/models/ids';
import type { Brief } from '../../../src/shared/models/brief';
import type { Plan } from '../../../src/shared/models/plan';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * §28 M9 item 4's Core half: `brief.approve`, `brief.saveEdit`,
 * `plan.approve`. All three were `stub('M11')`; session 1 recommended
 * making them real here because they are **row state changes against a
 * schema that already models them**, and only *drafting* is M11's.
 *
 * ## What these rows are, said plainly (standing rule 1)
 *
 * **The briefs and plans below are inserted by their own repositories, and
 * that is fine: they are the handler's INPUT.** No production path writes a
 * `briefs` row — `grep -rn "write_brief\|bureau_write" src/` returns
 * nothing, and the tool that will is M11's. So this file tests a handler
 * against a row it was given.
 *
 * What this file does **not** do is call that "approving a brief works end
 * to end", which is §28's M9 gate. Same row, different claim. The gate is
 * deferred to M11 and `m9Gate.test.ts` asserts the line this session can
 * honestly draw instead.
 */
describe('approving and editing a brief or plan (§8.2/§8.4, §28 M9 item 4)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-doc-approve-'));
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
    projectId = seedProject(db, { path: tmpDir }).id;
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = async (
    namespace: 'brief' | 'plan',
    method: string,
    input: Record<string, unknown>,
  ) =>
    dispatchIpcCall(
      `${namespace}:${method}`,
      getMethodSchema(namespace, method),
      (namespace === 'brief' ? briefHandlers : planHandlers)[method]!,
      ctx,
      true,
      input,
    );

  function eventTypes(): string[] {
    return (db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]).map(
      (row) => row.type,
    );
  }

  function draftBrief(overrides: Partial<Brief> = {}): Brief {
    return seedBrief(db, {
      project_id: projectId,
      version: 1,
      markdown: '# Recipe site\n\nA page listing recipes.',
      status: 'awaiting_approval',
      ...overrides,
    } as never);
  }

  function draftPlan(brief: Brief, overrides: Partial<Plan> = {}): Plan {
    return seedPlan(db, {
      project_id: projectId,
      brief_id: brief.id,
      version: 1,
      status: 'awaiting_approval',
      ...overrides,
    } as never);
  }

  describe('brief.approve — invariant #2’s only producer', () => {
    it('approves, stamps approved_at, and emits exactly one project.brief_approved', async () => {
      const brief = draftBrief();
      expect((await call('brief', 'approve', { id: brief.id })).ok).toBe(true);

      const after = getBriefById(db, brief.id)!;
      expect(after.status).toBe('approved');
      expect(after.approved_at).not.toBeNull();
      expect(eventTypes().filter((t) => t === 'project.brief_approved').length).toBe(1);
    });

    it('is idempotent — a second window pressing Approve reports success and emits nothing more', async () => {
      const brief = draftBrief();
      await call('brief', 'approve', { id: brief.id });
      const second = await call('brief', 'approve', { id: brief.id });

      expect(second.ok).toBe(true);
      // The CAS is what makes this true: the second UPDATE matched no
      // rows, so no second event and no re-stamped `approved_at`.
      expect(eventTypes().filter((t) => t === 'project.brief_approved').length).toBe(1);
    });

    it('refuses a superseded version, in words a person can act on', async () => {
      // Approving text the user has already replaced would authorise work
      // against something nobody agreed to — invariant #2, from the wrong
      // side.
      const brief = draftBrief({ status: 'superseded' } as Partial<Brief>);
      const result = await call('brief', 'approve', { id: brief.id });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toMatch(/replaced by a newer one/i);
      expect(getBriefById(db, brief.id)?.status).toBe('superseded');
      expect(eventTypes()).not.toContain('project.brief_approved');
    });

    it('404s a well-formed id that does not exist', async () => {
      // A well-formed id, not `"nope"`: a malformed one is rejected by
      // `IdSchema` before the handler runs at all (S14's own job), which
      // would make this test pass without proving the handler's NOT_FOUND
      // exists.
      const result = await call('brief', 'approve', { id: newId() });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('brief.saveEdit — §28 item 4’s "saves a NEW VERSION"', () => {
    it('inserts the next version and supersedes the old one, in one transaction', async () => {
      const brief = draftBrief();
      expect(
        (await call('brief', 'saveEdit', { id: brief.id, markdown: '# Recipe site\n\nEdited.' }))
          .ok,
      ).toBe(true);

      // The original is kept — `version` is an int and `superseded` is a
      // real status precisely so the text the user was shown survives.
      const original = getBriefById(db, brief.id)!;
      expect(original.status).toBe('superseded');
      expect(original.markdown).toBe('# Recipe site\n\nA page listing recipes.');

      const rows = db
        .prepare('SELECT id FROM briefs WHERE project_id = ? ORDER BY version')
        .all(projectId) as { id: string }[];
      expect(rows.length).toBe(2);
      const next = getBriefById(db, rows[1]!.id)!;
      expect(next.version).toBe(2);
      expect(next.markdown).toBe('# Recipe site\n\nEdited.');
      expect(next.status).toBe('awaiting_approval');
      expect(next.approved_at).toBeNull();
      // The structured content is carried over: deriving §8.3's fields
      // back out of edited markdown is a language task, and that is the
      // Director's (M11).
      expect(next.content).toEqual(original.content);

      expect(eventTypes().filter((t) => t === 'project.brief_drafted').length).toBe(1);
    });

    it('does not mutate an approved version in place — editing after approval starts a new one', async () => {
      const brief = draftBrief();
      await call('brief', 'approve', { id: brief.id });
      await call('brief', 'saveEdit', { id: brief.id, markdown: '# Changed my mind' });

      const original = getBriefById(db, brief.id)!;
      // Superseded, but its own approval record is intact: it WAS
      // approved, and the transcript above it says so.
      expect(original.status).toBe('superseded');
      expect(original.approved_at).not.toBeNull();
      expect(original.markdown).not.toContain('Changed my mind');

      const latest = (await call('brief', 'get', { projectId })) as unknown as {
        data: { item: Brief };
      };
      expect(latest.data.item.version).toBe(2);
      expect(latest.data.item.status).toBe('awaiting_approval');
    });

    it('refuses to edit an already-superseded version', async () => {
      const brief = draftBrief({ status: 'superseded' } as Partial<Brief>);
      const result = await call('brief', 'saveEdit', { id: brief.id, markdown: 'x' });
      expect(result.ok).toBe(false);
      expect((db.prepare('SELECT COUNT(*) AS n FROM briefs').get() as { n: number }).n).toBe(1);
    });
  });

  describe('plan.approve', () => {
    it('approves and emits exactly one project.plan_approved', async () => {
      const plan = draftPlan(draftBrief());
      expect((await call('plan', 'approve', { id: plan.id })).ok).toBe(true);
      const after = getPlanById(db, plan.id)!;
      expect(after.status).toBe('approved');
      expect(after.approved_at).not.toBeNull();
      expect(eventTypes().filter((t) => t === 'project.plan_approved').length).toBe(1);
    });

    it('refuses a superseded version and emits nothing', async () => {
      const plan = draftPlan(draftBrief(), { status: 'superseded' } as Partial<Plan>);
      const result = await call('plan', 'approve', { id: plan.id });
      expect(result.ok).toBe(false);
      expect(eventTypes()).not.toContain('project.plan_approved');
    });
  });

  it('requestEdit is real (M11), and with no Director waiting on the version it changes nothing', async () => {
    // Real since M11's requestEdit row (requestChanges.test.ts covers the
    // path where a Director is waiting). These projects have no
    // conversation, so there is nobody to send the feedback to: it is
    // refused in words, with no event.
    for (const [namespace, id] of [
      ['brief', draftBrief().id],
      ['plan', draftPlan(draftBrief({ version: 9 } as Partial<Brief>)).id],
    ] as const) {
      const result = await call(namespace, 'requestEdit', { id, feedback: 'shorter please' });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe('VALIDATION_FAILED');
      expect(result.ok === false && result.error.message).toContain('no conversation');
    }
    expect(eventTypes().filter((t) => t.endsWith('_changes_requested'))).toEqual([]);
  });
});
