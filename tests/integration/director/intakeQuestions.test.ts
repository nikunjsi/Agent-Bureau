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
import { writeMemory } from '../../../src/main/memory/memoryStore';
import { noopSecretBroker } from '../../../src/shared/engine/seams';
import { startDirector } from '../../../src/main/director/startDirector';
import { createProject } from '../../../src/main/projects/createProject';
import { seedBrief } from '../../helpers/dbFixtures';
import { callBureauTool } from '../../helpers/bureauToolBridge';
import { inDirectorTurn } from '../../helpers/directorTurn';
import { resolveBureauToolsScriptPathForTests } from '../../helpers/realEngineAdapter';
import { installShippedPack, seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-2a, §8.1, decision E-6: **intake's questions go out through
 * `bureau_report` with `kind: 'question'`, and its handler enforces the
 * rules in plain code** — never the prompt alone. In intake: 2 to 4 at a
 * time, never one (a drip-feed interview is §8.1's named failure), and no
 * more rounds than `intake.maxRounds`; past it, the Director is told to write
 * the brief with its assumptions. And before anything is posted, invariant
 * #9: a question the decision log, the brief or memory already answers is
 * refused, with the earlier answer handed back.
 *
 * Real chain: the real Director on FakeAdapter, the real control channel, a
 * turn in the project's conversation.
 */
describe("intake's questions: the handler enforces the rules", () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let companyId: string;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-intake-questions-'));
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
    });
    expect(started.status).toBe('started');
  });

  afterEach(async () => {
    for (const { supervisor } of supervisorRegistry.all()) await supervisor.stop();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

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

  const q = (id: string, text: string) => ({
    id,
    text,
    options: [
      { id: 'a', label: 'Yes' },
      { id: 'b', label: 'No' },
    ],
    recommendation: { optionId: 'a', why: 'It is the simpler start.' },
  });

  const ask = (questions: unknown[], body = 'A few questions before I write the brief.') =>
    callBureauTool(adapter.startedContext!.controlChannel, 'bureau_report', {
      kind: 'question',
      body,
      payload: { questions },
    });

  const questionRows = (conversationId: string) =>
    db
      .prepare(
        "SELECT body, payload FROM conversation_messages WHERE conversation_id = ? AND kind = 'question'",
      )
      .all(conversationId) as { body: string; payload: string }[];

  const events = (type: string) =>
    readFileSync(path.join(tmpDir, 'activity.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string })
      .filter((event) => event.type === type);

  it('a batch of two is posted as one question card, and counts as one round', async () => {
    const { conversationId } = await projectInIntake();
    const before = events('chat.message_persisted').length;

    const result = await ask([
      q('who', 'Is the site just for bookings?'),
      q('menu', 'Should the menu be on the site?'),
    ]);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    const rows = questionRows(conversationId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload).questions.map((x: { id: string }) => x.id)).toEqual([
      'who',
      'menu',
    ]);
    expect(getConversationById(db, conversationId)!.director_state_data).toMatchObject({
      intakeRounds: 1,
    });
    // One state change — the card and its round, together — one event.
    expect(events('chat.message_persisted').length - before).toBe(1);
  });

  it('refuses one question at a time, and more than four', async () => {
    const { conversationId } = await projectInIntake();

    const one = await ask([q('who', 'Is the site just for bookings?')]);
    expect(one.ok).toBe(false);
    expect(JSON.stringify(one)).toMatch(/2 to 4/);

    const five = await ask(['a', 'b', 'c', 'd', 'e'].map((id) => q(id, `Question ${id}?`)));
    expect(five.ok).toBe(false);

    expect(questionRows(conversationId)).toEqual([]);
  });

  it('past the round cap, refuses another round and says to write the brief with assumptions', async () => {
    const { conversationId } = await projectInIntake();
    for (const round of [1, 2, 3]) {
      const posted = await ask([
        q(`a${round}`, `First ${round}?`),
        q(`b${round}`, `Second ${round}?`),
      ]);
      expect(posted.ok, JSON.stringify(posted)).toBe(true);
    }

    const fourth = await ask([q('a4', 'Fourth round?'), q('b4', 'Still asking?')]);

    expect(fourth.ok).toBe(false);
    expect(JSON.stringify(fourth)).toMatch(/write the brief/i);
    expect(JSON.stringify(fourth)).toMatch(/assumptions/i);
    expect(questionRows(conversationId)).toHaveLength(3);
  });

  it('refuses a question the decision log already answers, and hands the answer back', async () => {
    const { projectId, conversationId } = await projectInIntake();
    writeMemory(db, {
      scope: 'project',
      scopeRef: projectId,
      fileName: 'decisions.md',
      baseDir,
      title: 'Decisions',
      body: [
        '# Decisions',
        '',
        '## 2026-09-25 — Should diners book a table online or by phone?',
        '**Asked because:** the owner takes bookings by phone today.',
        '**Chosen:** By phone — the owner wants to keep talking to regulars.',
        '**Consequence:** No booking system to build.',
      ].join('\n'),
      source: 'observed',
      pinned: true,
    } as never);

    const result = await ask([
      q('booking', 'Should diners book a table online or by phone?'),
      q('menu', 'Should the menu be on the site?'),
    ]);

    expect(result.ok).toBe(false);
    const said = JSON.stringify(result);
    expect(said).toContain('Should diners book a table online or by phone?');
    expect(said).toContain('By phone');
    expect(questionRows(conversationId)).toEqual([]);
    // A refused round is not a round.
    expect(getConversationById(db, conversationId)!.director_state_data).not.toMatchObject({
      intakeRounds: 1,
    });
  });

  it('refuses a question the brief already answers', async () => {
    const { projectId, conversationId } = await projectInIntake();
    seedBrief(db, {
      project_id: projectId,
      markdown: '# Brief\n\n- The site shows the menu with prices.\n- Bookings stay by phone.',
      content: {},
    } as never);

    const result = await ask([
      q('menu', 'Does the site show the menu with prices?'),
      q('photos', 'Do you have photos of the dishes?'),
    ]);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('The site shows the menu with prices.');
    expect(questionRows(conversationId)).toEqual([]);
  });

  it('refuses a question memory already answers', async () => {
    const { conversationId } = await projectInIntake();
    writeMemory(db, {
      scope: 'user',
      scopeRef: null,
      fileName: 'preferences.md',
      baseDir,
      title: 'Preferences',
      body: 'Do you want the site in Italian as well as English? Yes, both, always.',
      source: 'user_stated',
      pinned: true,
    } as never);

    const result = await ask([
      q('lang', 'Do you want the site in Italian as well as English?'),
      q('photos', 'Do you have photos of the dishes?'),
    ]);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('Yes, both, always.');
    expect(questionRows(conversationId)).toEqual([]);
  });

  it('a question that only resembles an earlier one is asked: the safe side is the extra question', async () => {
    const { projectId, conversationId } = await projectInIntake();
    writeMemory(db, {
      scope: 'project',
      scopeRef: projectId,
      fileName: 'decisions.md',
      baseDir,
      title: 'Decisions',
      body: '# Decisions\n\n## 2026-09-25 — Should diners book a table online or by phone?\n**Chosen:** By phone.',
      source: 'observed',
      pinned: true,
    } as never);

    const result = await ask([
      q('deposit', 'Should diners pay a deposit when they book a table?'),
      q('menu', 'Should the menu be on the site?'),
    ]);

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(questionRows(conversationId)).toHaveLength(1);
  });

  it('outside intake, one question is allowed: the company conversation’s "which project?"', async () => {
    const company = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Test Co',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    await inDirectorTurn(db, supervisorRegistry, company.id);

    const result = await ask(
      [
        {
          id: 'which',
          text: 'Which project do you mean?',
          options: [
            { id: 'p1', label: 'Luigi Trattoria' },
            { id: 'p2', label: 'Luigi Pizzeria' },
          ],
          recommendation: { optionId: 'p1', why: 'It is the one you spoke about last.' },
        },
      ],
      'Which one?',
    );

    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(questionRows(company.id)).toHaveLength(1);
  });
});
