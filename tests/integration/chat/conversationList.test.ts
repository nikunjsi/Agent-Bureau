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
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { seedProject } from '../../helpers/dbFixtures';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { seedCompany } from '../../helpers/companyFixture';

/**
 * M11 S2-1c, §K.2 and Nikunj's decision of 2026-09-25: **the switcher is a
 * list** — the company conversation, then one entry per project, each with
 * the project's status and an unread or waiting marker. Those markers are
 * decided in the Core, from the rows (invariant #11: the renderer holds no
 * authoritative state), and this is what `chat.listConversations` returns.
 */
describe('chat.listConversations: the switcher’s list, decided in the Core', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-conversation-list-'));
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
    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, path.resolve('src/main/db/migrations')),
    } as unknown as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function conversation(projectId: string | null, state: string | null = null): string {
    return insertConversation(db, {
      company_id: companyId,
      project_id: projectId,
      title: projectId === null ? 'Test Co' : 'Project',
      director_session_id: null,
      summary: null,
      director_state: state as never,
      director_state_data: null,
    }).id;
  }

  function message(conversationId: string, author: string, readAt: string | null): void {
    insertConversationMessage(db, {
      conversation_id: conversationId,
      project_id: null,
      author,
      kind: 'text',
      body: `from ${author}`,
      payload: null,
      checkpoint_id: null,
      status: 'complete',
      read_at: readAt,
    } as never);
  }

  async function list() {
    const result = await dispatchIpcCall(
      'chat:listConversations',
      getMethodSchema('chat', 'listConversations'),
      chatHandlers['listConversations']!,
      ctx,
      true,
      { projectId: null },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return (result as { data: { items: Array<Record<string, unknown>> } }).data.items;
  }

  it('the company conversation first, then each project with its status, unread count and waiting marker', async () => {
    const trattoria = seedProject(db, { name: 'Luigi Trattoria', path: path.join(tmpDir, 't') });
    const pizzeria = seedProject(db, { name: 'Luigi Pizzeria', path: path.join(tmpDir, 'p') });
    db.prepare("UPDATE projects SET stage = 'brief' WHERE id = ?").run(pizzeria.id);
    // Created in this order on purpose: the company conversation is the
    // newest, and still comes first.
    const trattoriaChat = conversation(trattoria.id, 'INTAKE');
    const pizzeriaChat = conversation(pizzeria.id, 'AWAITING_BRIEF_APPROVAL');
    const companyChat = conversation(null);

    message(trattoriaChat, 'user', null); // the user's own words are never unread
    message(trattoriaChat, 'director', null);
    message(trattoriaChat, 'director', null);
    message(pizzeriaChat, 'director', '2026-09-25T00:00:00.000Z'); // read
    insertCheckpoint(db, activityLog, {
      type: 'decision',
      urgency: 'soon',
      project_id: trattoria.id,
      title: 'Booking by phone or online?',
      context: 'How diners reserve a table.',
      options: [
        {
          id: 'phone',
          label: 'Phone',
          consequence: 'Nothing to build; the owner answers.',
          reversible: true,
        },
        { id: 'online', label: 'Online', consequence: 'A booking form and a calendar to keep.' },
      ],
      default_action: 'phone',
    } as never);

    const items = await list();

    expect(items.map((item) => item['id'])).toEqual([companyChat, trattoriaChat, pizzeriaChat]);
    expect(items[0]).toMatchObject({ project: null, unreadCount: 0, waiting: false });
    expect(items[1]).toMatchObject({
      project: { id: trattoria.id, name: 'Luigi Trattoria', stage: 'intake' },
      unreadCount: 2,
      // A pending checkpoint on the project is the user being waited on.
      waiting: true,
    });
    expect(items[2]).toMatchObject({
      project: { id: pizzeria.id, name: 'Luigi Pizzeria', stage: 'brief' },
      unreadCount: 0,
      // The brief is waiting for the user's approval.
      waiting: true,
    });
    expect(typeof items[1]!['lastMessageAt']).toBe('string');
    expect(items[0]!['lastMessageAt']).toBeNull();
  });

  it('a project that waits on nobody is not marked waiting', async () => {
    const quiet = seedProject(db, { name: 'Quiet', path: path.join(tmpDir, 'q') });
    conversation(null);
    conversation(quiet.id, 'SUPERVISING');
    const items = await list();
    expect(items[1]).toMatchObject({ waiting: false, unreadCount: 0 });
  });
});
