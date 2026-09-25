import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import {
  getConversationById,
  insertConversation,
} from '../../../src/main/db/repositories/conversations';
import { getProjectById } from '../../../src/main/db/repositories/projects';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { createProject } from '../../../src/main/projects/createProject';
import { isBriefApproved } from '../../../src/main/projects/briefApproval';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { briefHandlers } from '../../../src/main/ipc/handlers/brief';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-3a, §8.2–§8.3, invariant #2: **the brief is written by the
 * Director, approved by the user, and nothing is built before that.**
 *
 * `bureau_write_brief` validates §8.3's `Brief`, writes a `briefs` row
 * awaiting approval, posts the brief card, and moves the Director to
 * `AWAITING_BRIEF_APPROVAL`. `brief.approve` then creates one `deliverables`
 * row per `Brief.deliverables[]` **in the same transaction** as the
 * approval, moves the project to planning and the Director to `PLANNING`,
 * and hands the Director its next turn. `isBriefApproved` is the one answer
 * every later step asks.
 *
 * Real chain: the real Director on FakeAdapter, the real control channel,
 * the real `brief.approve` through `dispatchIpcCall`, the real queue.
 */
const BRIEF = {
  title: 'Luigi Trattoria website',
  one_liner: 'A small site where diners see the menu and find the phone number.',
  goal: 'Diners can see what is on tonight and call to book, from their phone.',
  kind: 'software',
  users: 'Diners, mostly on phones; the owner updates the menu.',
  scope: ['A menu page with prices', 'A contact page with the phone number and map'],
  non_goals: ['Online booking', 'Online payment'],
  deliverables: [
    {
      type: 'repository',
      name: 'Website source',
      description: 'The site, ready to run locally or host.',
      acceptance: ['The menu page shows every dish with its price'],
    },
    {
      type: 'document',
      name: 'Owner guide',
      description: 'How to change the menu without help.',
      acceptance: ['The owner can change a price by following it'],
    },
  ],
  constraints: { tech: [], platform: ['Web'], deadline: null, budget_usd: null, other: [] },
  existing_assets: [],
  success_criteria: ['The owner stops getting "are you open?" calls'],
  assumptions: ['Bookings stay by phone'],
  open_questions: [],
  risks: [{ risk: 'Menu goes stale', impact: 'medium', mitigation: 'The owner guide' }],
};

describe('the brief: written by the Director, approved by the user', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let ctx: HandlerContext;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-brief-approval-'));
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
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    supervisorRegistry = new SupervisorRegistry();
    const tokenRegistry = new TokenRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir,
    });
    await server.start();
    triggers = createDirectorTriggers({
      db,
      activityLog,
      supervisorRegistry,
      baseDir,
      bundledPacksDir: path.resolve('packs'),
    });
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, path.resolve('src/main/db/migrations')),
      baseDir,
      directorTriggers: triggers,
    } as unknown as HandlerContext;
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const started = await startDirector({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      controlChannelPort: server.assignedPort,
      baseDir,
      secretBroker: noopSecretBroker,
      containProcess: () => {},
      createAdapter: () => adapter,
      resolveToolsScriptPath: resolveBureauToolsScriptPathForTests,
      directorTriggers: triggers,
    });
    expect(started.status).toBe('started');
  });

  afterEach(async () => {
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function until(check: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** A project in intake, and a turn in its conversation. */
  async function projectInIntake(): Promise<{ projectId: string; conversationId: string }> {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    const { project, conversation } = createProject(
      { db, activityLog },
      {
        companyId,
        name: 'Luigi Trattoria',
        conversation: { bind: company.id },
        actor: 'user',
        reason: 'test',
      },
    );
    await inDirectorTurn(db, supervisorRegistry, conversation.id);
    return { projectId: project.id, conversationId: conversation.id };
  }

  const writeBrief = (brief: unknown) =>
    callBureauTool(adapter.startedContext!.controlChannel, 'bureau_write_brief', { brief });

  const approve = (id: string) =>
    dispatchIpcCall(
      'brief:approve',
      getMethodSchema('brief', 'approve'),
      briefHandlers['approve']!,
      ctx,
      true,
      { id },
    );

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> })
      .filter((event) => event.type === type);

  const briefs = (projectId: string) =>
    db
      .prepare('SELECT id, version, status, markdown FROM briefs WHERE project_id = ?')
      .all(projectId) as { id: string; version: number; status: string; markdown: string }[];

  const deliverables = (projectId: string) =>
    db
      .prepare(
        'SELECT type, title, summary, status FROM deliverables WHERE project_id = ? ORDER BY title',
      )
      .all(projectId);

  it('bureau_write_brief: a validated brief row, the card, the event, and the Director waiting for approval', async () => {
    const { projectId, conversationId } = await projectInIntake();

    const result = await writeBrief(BRIEF);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const rows = briefs(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, status: 'awaiting_approval' });
    expect(rows[0]!.markdown).toContain('# Luigi Trattoria website');
    expect(rows[0]!.markdown).toContain('Bookings stay by phone');
    const card = db
      .prepare(
        "SELECT payload FROM conversation_messages WHERE conversation_id = ? AND kind = 'brief'",
      )
      .get(conversationId) as { payload: string };
    expect(JSON.parse(card.payload)).toMatchObject({
      briefId: rows[0]!.id,
      title: 'Luigi Trattoria website',
      deliverables: ['Website source', 'Owner guide'],
      assumptions: ['Bookings stay by phone'],
    });
    expect(events('project.brief_drafted')).toHaveLength(1);
    expect(getProjectById(db, projectId)!.stage).toBe('brief');
    expect(getConversationById(db, conversationId)!.director_state).toBe('AWAITING_BRIEF_APPROVAL');
    expect(isBriefApproved(db, projectId)).toBe(false);
  });

  it('refuses a brief that is not §8.3’s, and writes nothing', async () => {
    const { projectId, conversationId } = await projectInIntake();
    const result = await writeBrief({ ...BRIEF, deliverables: [] });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('deliverables');
    expect(briefs(projectId)).toEqual([]);
    expect(getConversationById(db, conversationId)!.director_state).toBe('INTAKE');
  });

  it('brief.approve: deliverables from the brief, planning, and the Director’s next turn', async () => {
    const { projectId, conversationId } = await projectInIntake();
    expect((await writeBrief(BRIEF)).ok).toBe(true);
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });
    const briefId = briefs(projectId)[0]!.id;
    const sentBefore = adapter.sentMessages.length;

    const result = await approve(briefId);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(deliverables(projectId)).toEqual([
      {
        type: 'document',
        title: 'Owner guide',
        summary: 'How to change the menu without help.',
        status: 'draft',
      },
      {
        type: 'repository',
        title: 'Website source',
        summary: 'The site, ready to run locally or host.',
        status: 'draft',
      },
    ]);
    const project = getProjectById(db, projectId)!;
    expect(project).toMatchObject({ stage: 'planning', brief_id: briefId, kind: 'software' });
    expect(getConversationById(db, conversationId)!.director_state).toBe('PLANNING');
    expect(isBriefApproved(db, projectId)).toBe(true);
    expect(events('project.brief_approved')).toHaveLength(1);
    expect(events('deliverable.created')).toHaveLength(2);

    // The Director is handed the approval as a turn of its own.
    await until(() => adapter.sentMessages.length > sentBefore, 'the Director’s turn');
    expect(adapter.sentMessages.at(-1)!.text).toMatch(/approved the brief/i);

    // Approving again changes nothing.
    expect((await approve(briefId)).ok).toBe(true);
    expect(deliverables(projectId)).toHaveLength(2);
  });

  it('approval is one transaction: a deliverable that cannot be written leaves the brief unapproved and nothing else behind', async () => {
    const { projectId, conversationId } = await projectInIntake();
    expect((await writeBrief(BRIEF)).ok).toBe(true);
    const briefId = briefs(projectId)[0]!.id;
    // The second deliverable fails — a failed write stands in for a kill
    // inside the transaction (answerAtomicity.test.ts says why).
    db.exec(`CREATE TEMP TRIGGER fail_second_deliverable BEFORE INSERT ON deliverables
      WHEN (SELECT COUNT(*) FROM deliverables WHERE project_id = NEW.project_id) >= 1
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);

    const result = await approve(briefId);

    expect(result.ok).toBe(false);
    expect(briefs(projectId)[0]!.status).toBe('awaiting_approval');
    expect(deliverables(projectId)).toEqual([]);
    expect(getProjectById(db, projectId)).toMatchObject({ stage: 'brief', brief_id: null });
    expect(getConversationById(db, conversationId)!.director_state).toBe('AWAITING_BRIEF_APPROVAL');
    expect(isBriefApproved(db, projectId)).toBe(false);
    expect(events('project.brief_approved')).toEqual([]);
    expect(events('deliverable.created')).toEqual([]);
  });

  it('an edit after approval is a new version, and the brief is no longer approved until that one is', async () => {
    const { projectId } = await projectInIntake();
    expect((await writeBrief(BRIEF)).ok).toBe(true);
    const briefId = briefs(projectId)[0]!.id;
    expect((await approve(briefId)).ok).toBe(true);
    expect(isBriefApproved(db, projectId)).toBe(true);

    const edited = await dispatchIpcCall(
      'brief:saveEdit',
      getMethodSchema('brief', 'saveEdit'),
      briefHandlers['saveEdit']!,
      ctx,
      true,
      { id: briefId, markdown: '# Luigi Trattoria website\n\nNow with a gallery.' },
    );
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    expect(isBriefApproved(db, projectId)).toBe(false);
  });
});
