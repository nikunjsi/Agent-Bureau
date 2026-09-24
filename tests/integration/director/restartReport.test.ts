import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
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
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { insertOutboxMessage } from '../../../src/main/db/repositories/messages';
import { reconcile } from '../../../src/main/db/reconcile';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import { buildRestartSummary, offerRestartReport } from '../../../src/main/director/restartReport';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * **The restart report** (M11 row S1-20, §26.1, `NEXT-VERSION` §I.3). At
 * startup with interrupted work — what `reconcile()` repaired, what the
 * post-restart grace held back (`suppressedByGrace`, which nothing read
 * before this), pending checkpoints, held messages — exactly one `restart`
 * trigger is enqueued, alone, carrying a structured summary, and the
 * Director's turn is told to post one report. With nothing interrupted,
 * nothing wakes the Director: no bare-timer wake.
 */
describe('the Director reports what a restart interrupted, once, or not at all', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-restart-report-'));
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
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
      supervisorRegistry,
    });
    await server.start();
    triggers = createDirectorTriggers({ db, activityLog, supervisorRegistry });
  });

  afterEach(async () => {
    triggers.stop();
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runningDirector(): Promise<FakeAdapter> {
    hireEmployee({ db, activityLog, companyId, baseDir, roleKey: 'operations:director' });
    const adapter = new FakeAdapter({
      keepOpen: true,
      capabilities: { mcpServers: true, sessionResume: true },
    });
    const started = await startDirector({
      db,
      activityLog,
      tokenRegistry: new TokenRegistry(),
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
    return adapter;
  }

  const conversation = () =>
    insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;

  it('interrupted work: one restart turn, alone, with a summary that counts what the grace held', async () => {
    const conversationId = conversation();
    // A reply the crash cut off — reconcile() aborts it.
    insertConversationMessage(db, {
      conversation_id: conversationId,
      project_id: null,
      author: 'director',
      kind: 'text',
      body: 'Half a reply',
      payload: null,
      checkpoint_id: null,
      status: 'streaming',
    });
    // A checkpoint already past its deadline — the grace holds it back.
    insertCheckpoint(db, activityLog, {
      project_id: null,
      task_id: null,
      employee_id: null,
      type: 'decision',
      urgency: 'soon',
      title: 'Use the dark theme?',
      context: 'The designer asked.',
      options: [
        { id: 'yes', label: 'Yes', consequence: 'The site is dark.', reversible: true },
        { id: 'no', label: 'No', consequence: 'The site stays light.', reversible: true },
      ],
      default_action: 'no',
    });
    db.prepare("UPDATE checkpoints SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    // A message still waiting for its employee.
    insertOutboxMessage(db, {
      idempotency_key: 'held-1',
      from_addr: 'director',
      to_addr: 'employee:nobody-yet',
      kind: 'handoff',
      subject: 'Start the menu',
      body: 'Start the menu page.',
    });

    const reconciled = await reconcile(db, activityLog, baseDir);
    const now = Date.now();
    const summary = buildRestartSummary(
      { db, activityLog, baseDir },
      { reconcile: reconciled, appStartedAtMs: now, nowMs: now },
    );
    expect(summary).not.toBeNull();

    const adapter = await runningDirector();
    offerRestartReport(triggers, summary!, now);
    offerRestartReport(triggers, summary!, now); // exactly one, however often asked
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(adapter.sentMessages).toHaveLength(1);
    const text = adapter.sentMessages[0]!.text;
    expect(text).toContain('Bureau restarted');
    expect(text).toContain('1 reply that was being written was cut off');
    expect(text).toMatch(/1 decision past its deadline was held back/);
    expect(text).toContain('Use the dark theme?');
    expect(text).toContain('1 message is still waiting to be delivered');
    expect(text).toContain('bureau_report');
  });

  it('nothing interrupted: no summary, no trigger, no turn', async () => {
    conversation();
    const reconciled = await reconcile(db, activityLog, baseDir);
    const now = Date.now();
    const summary = buildRestartSummary(
      { db, activityLog, baseDir },
      { reconcile: reconciled, appStartedAtMs: now, nowMs: now },
    );
    expect(summary).toBeNull();
    const adapter = await runningDirector();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(adapter.sentMessages).toHaveLength(0);
  });
});
