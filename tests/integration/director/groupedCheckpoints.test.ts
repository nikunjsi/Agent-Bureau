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
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { setProjectBudget } from '../../../src/main/db/repositories/projects';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import {
  createDirectorTriggers,
  type DirectorTriggers,
} from '../../../src/main/director/directorTriggers';
import {
  CheckpointSurfacer,
  type CheckpointNotifier,
} from '../../../src/main/checkpoints/surfacing';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';
import { seedProject } from '../../helpers/dbFixtures';
import { setSetting } from '../../../src/main/db/repositories/settings';

/**
 * M11 S2-6, §9.3: "Multiple pending checkpoints from different employees are
 * **grouped by the Director into one message** when they arrive within
 * `checkpoints.batchWindowSeconds` and none is `blocking`."
 *
 * `groupPendingCheckpoints` has decided the groups since M8, and nothing
 * wrote the one message: a non-blocking checkpoint reached the chat not at
 * all. Here a settled batch becomes one coalesced Director trigger, and the
 * real Director (FakeAdapter supplying its output, the real control channel
 * carrying its tool call) posts one message that references every member.
 * With no Director turn possible, the Core posts the grouped card itself.
 */
describe('a settled batch of checkpoints becomes one grouped message', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let projectId: string;
  let conversationId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let triggers: DirectorTriggers;
  let adapter: FakeAdapter;

  const notifier: CheckpointNotifier = { isAnyWindowFocused: () => true, notify: () => {} };

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-grouped-cp-'));
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
    // The batch trigger coalesces with other news for this long; the test
    // does not wait out the 20 s default.
    setSetting(db, 'director.coalesceWindowSeconds', 0);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    companyId = seedCompany(db, path.join(tmpDir, 'home')).id;
    installShippedPack({ db, activityLog, baseDir, packKey: 'operations' });
    projectId = seedProject(db, { name: 'Trattoria' }).id;
    insertConversation(db, { company_id: companyId, project_id: null, title: 'Test Co' });
    conversationId = insertConversation(db, {
      company_id: companyId,
      project_id: projectId,
      title: 'Trattoria',
    }).id;
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
      chatStreams: new ChatStreamRegistry({ db, activityLog }),
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

  function raise(title: string): string {
    return insertCheckpoint(db, activityLog, {
      project_id: projectId,
      type: 'decision',
      urgency: 'soon',
      title,
      context: 'Either is fine; it is a preference.',
      default_action: 'a',
      options: [
        { id: 'a', label: 'The first', consequence: 'The first is used.', reversible: true },
        { id: 'b', label: 'The second', consequence: 'The second is used.', reversible: true },
      ],
    }).id;
  }

  /** Every message in the project's conversation, with the checkpoints it
   *  names: its own `checkpoint_id`, or a report's `checkpointIds`. */
  function messagesNaming(): { author: string; kind: string; ids: string[] }[] {
    const rows = db
      .prepare(
        'SELECT author, kind, checkpoint_id, payload FROM conversation_messages WHERE conversation_id = ? ORDER BY rowid',
      )
      .all(conversationId) as {
      author: string;
      kind: string;
      checkpoint_id: string | null;
      payload: string | null;
    }[];
    return rows.map((row) => {
      const payload = row.payload === null ? {} : (JSON.parse(row.payload) as object);
      const listed = (payload as { checkpointIds?: string[] }).checkpointIds ?? [];
      return {
        author: row.author,
        kind: row.kind,
        ids: row.checkpoint_id === null ? listed : [row.checkpoint_id, ...listed],
      };
    });
  }

  /** After the batch window has closed. */
  const later = () => Date.now() + 91_000;

  it('three non-blocking checkpoints in one window: one Director turn, one message naming all three', async () => {
    const ids = [raise('Header colour'), raise('Font'), raise('Photo order')];
    const surfacer = new CheckpointSurfacer(db, { activityLog, director: triggers });

    // Inside the window: nothing yet.
    surfacer.surface({ notifier, nowMs: Date.now() });
    expect(adapter.sentMessages).toHaveLength(0);

    surfacer.surface({ notifier, nowMs: later() });
    await until(() => adapter.sentMessages.length === 1, 'the Director’s turn');
    const turn = adapter.sentMessages[0]!.text;
    for (const id of ids) expect(turn).toContain(id);
    expect(turn).toContain('Header colour');

    // The Director's scripted reply: one grouped report.
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const posted = await callBureauTool(adapter.startedContext!.controlChannel, 'bureau_report', {
      kind: 'report',
      body: 'Three small choices are waiting for you.',
      payload: {
        whatHappened: 'Three small choices came up while the site was built.',
        checkpointIds: ids,
      },
    });
    expect(posted.ok, JSON.stringify(posted)).toBe(true);
    adapter.pushEvent({ t: 'turn.completed', turnIndex: 0, usage: null });
    adapter.pushEvent({ t: 'finished', reason: 'completed', summary: null });

    // A later pass neither re-offers the batch nor adds cards of its own.
    surfacer.surface({ notifier, nowMs: later() + 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(adapter.sentMessages).toHaveLength(1);

    const naming = messagesNaming().filter((m) => m.ids.length > 0);
    expect(naming).toHaveLength(1);
    expect(naming[0]!.kind).toBe('report');
    expect([...naming[0]!.ids].sort()).toEqual([...ids].sort());
  });

  it('with no Director turn possible, the Core posts one grouped card itself', async () => {
    // The project's budget is spent, reserve included: no turn may run.
    setProjectBudget(db, projectId, 1);
    db.prepare('UPDATE projects SET spend_usd_micros = 5 WHERE id = ?').run(projectId);

    const ids = [raise('Header colour'), raise('Font'), raise('Photo order')];
    const surfacer = new CheckpointSurfacer(db, { activityLog, director: triggers });
    surfacer.surface({ notifier, nowMs: later() });
    surfacer.surface({ notifier, nowMs: later() + 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(adapter.sentMessages).toHaveLength(0);
    const naming = messagesNaming().filter((m) => m.ids.length > 0);
    expect(naming).toHaveLength(1);
    expect(naming[0]).toMatchObject({ author: 'system', kind: 'report' });
    expect([...naming[0]!.ids].sort()).toEqual([...ids].sort());
  });

  it('a report may only name checkpoints that exist', async () => {
    const surfacer = new CheckpointSurfacer(db, { activityLog, director: triggers });
    const ids = [raise('Header colour'), raise('Font')];
    surfacer.surface({ notifier, nowMs: later() });
    await until(() => adapter.sentMessages.length === 1, 'the Director’s turn');
    adapter.pushEvent({ t: 'turn.started', turnIndex: 0 });
    const posted = await callBureauTool(adapter.startedContext!.controlChannel, 'bureau_report', {
      kind: 'report',
      body: 'Choices.',
      payload: { whatHappened: 'Choices.', checkpointIds: [...ids, '01ZZZZZZZZZZZZZZZZZZZZZZZZ'] },
    });
    expect(posted.ok).toBe(false);
    expect(JSON.stringify(posted)).toContain('01ZZZZZZZZZZZZZZZZZZZZZZZZ');
  });
});
