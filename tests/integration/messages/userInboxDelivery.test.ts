import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import {
  insertOutboxMessage,
  getOutboxMessageById,
} from '../../../src/main/db/repositories/messages';
import { getConversationMessageById } from '../../../src/main/db/repositories/conversationMessages';
import { routeOnce } from '../../../src/main/messages/router';
import { deliverabilityOf } from '../../../src/main/messages/deliverability';
import { parseMessageAddress } from '../../../src/main/messages/addressing';
import { newId } from '../../../src/shared/models/ids';
import { seedProject, seedTask } from '../../helpers/dbFixtures';
import type { MessageRouterDeps } from '../../../src/main/messages/router';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * **`docs/NEXT-VERSION.md` §J.4, closed.**
 *
 * M8 parsed a `user` address and held it with `no_user_inbox_yet` — the
 * Director chat is §9.4's first surface and it did not exist. M9 session 1
 * built the writer (`appendChatMessage`); this session points the router at
 * it and removes the hold.
 *
 * ## The two decisions this makes, and why
 *
 * **`author: 'system'`.** `MessageAuthorSchema` is a closed enum of
 * `user | director | system`, and an employee is none of them. `director`
 * would be a lie — `bureau_send_message` lets ANY employee address the
 * user. A fourth value is a migration plus an enum M11 inherits, for a
 * distinction `payload.delivered.fromAddr` already carries as a fact.
 *
 * **`kind: 'text'`.** The outbox row carries prose and a subject. Nothing
 * in it is a brief, a plan, a report or a decision, and session 1's rule
 * stands: if something seems to want a ninth kind, the payload is what is
 * wrong.
 */
describe('§J.4: a message addressed to `user` lands in the conversation', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let deps: MessageRouterDeps;
  let conversationId: string;
  let companyId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-user-inbox-'));
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
    deps = {
      db,
      activityLog,
      supervisorRegistry: new SupervisorRegistry(),
      appStartedAtMs: Date.now(),
    };
    companyId = insertCompany(db, { name: 'Test Co', home_path: tmpDir }).id;
    conversationId = insertConversation(db, {
      company_id: companyId,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function queueForUser(overrides: Record<string, unknown> = {}) {
    return insertOutboxMessage(db, {
      idempotency_key: newId(),
      from_addr: 'emp-quinn',
      to_addr: 'user',
      kind: 'question',
      subject: 'Which database?',
      body: 'Should I use SQLite or Postgres for this?',
      ...overrides,
    });
  }

  it('arrives as a real conversation message, authored `system`, kind `text`', async () => {
    const outbox = queueForUser();
    const report = await routeOnce(deps, { nowMs: Date.now() });
    expect(report.delivered).toEqual([outbox.id]);
    expect(report.held).toEqual([]);

    const row = db.prepare('SELECT id FROM conversation_messages').get() as { id: string };
    const message = getConversationMessageById(db, row.id)!;
    expect(message.conversation_id).toBe(conversationId);
    expect(message.author).toBe('system');
    expect(message.kind).toBe('text');
    expect(message.status).toBe('complete');
    // The prose is the body, verbatim — the Core does not reformat it.
    expect(message.body).toBe('Should I use SQLite or Postgres for this?');
    // Who it is from is a FACT on the payload, not a prefix in the text.
    expect(message.payload).toEqual({
      attachments: [],
      delivered: { messageId: outbox.id, fromAddr: 'emp-quinn', subject: 'Which database?' },
    });
    // And it is unread, which is what puts it on the badge.
    expect(message.read_at).toBeNull();
  });

  it('marks the outbox row delivered — but not consumed, which is an employee-turn idea', async () => {
    const outbox = queueForUser();
    await routeOnce(deps, { nowMs: Date.now() });

    const after = getOutboxMessageById(db, outbox.id)!;
    expect(after.status).toBe('delivered');
    expect(after.delivered_at).not.toBeNull();
    // §9.7 defines consumption as "the employee marks it consumed
    // implicitly when its next turn starts". The user has no turn; what
    // the user does is READ it, and that is `read_at` on the conversation
    // message — a different, real column with its own writer.
    expect(after.consumed_at).toBeNull();
    expect(after.resolved_employee_id).toBeNull();
  });

  it('does not deliver twice, and a second pass finds nothing to do', async () => {
    queueForUser();
    await routeOnce(deps, { nowMs: Date.now() });
    const second = await routeOnce(deps, { nowMs: Date.now() });

    expect(second.delivered).toEqual([]);
    expect(second.requeued).toEqual([]);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number }).n,
    ).toBe(1);
  });

  it('emits exactly one message.delivered, naming both rows', async () => {
    const outbox = queueForUser();
    await routeOnce(deps, { nowMs: Date.now() });
    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'message.delivered'")
      .all() as { payload: string }[];
    expect(events.length).toBe(1);
    const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
    expect(payload['messageId']).toBe(outbox.id);
    expect(payload['to']).toBe('user');
    expect(payload['conversationMessageId']).toEqual(expect.any(String));
  });

  it("prefers the project's own conversation when the message carries a task", async () => {
    const project = seedProject(db, { path: tmpDir });
    const projectConversation = insertConversation(db, {
      company_id: companyId,
      project_id: project.id,
      title: 'Recipe site',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    const task = seedTask(db, { project_id: project.id });

    queueForUser({ task_id: task.id });
    await routeOnce(deps, { nowMs: Date.now() });

    const row = db.prepare('SELECT conversation_id FROM conversation_messages').get() as {
      conversation_id: string;
    };
    expect(row.conversation_id).toBe(projectConversation.id);
  });

  it('holds — writing nothing — when the company has no conversation at all', async () => {
    // A real data state, not a missing mechanism: nothing creates a
    // conversation before M11's project intake or M13's wizard. Held for
    // the same reason `no_director_yet` is held — the target can come to
    // exist — and a hold must consume no retry budget (§9.7).
    db.prepare('DELETE FROM conversations').run();
    const outbox = queueForUser();

    expect(deliverabilityOf(deps, parseMessageAddress('user'))).toEqual({
      kind: 'hold',
      reason: 'no_conversation_yet',
    });

    const report = await routeOnce(deps, { nowMs: Date.now() });
    expect(report.delivered).toEqual([]);
    expect(report.held).toEqual([{ messageId: outbox.id, reason: 'no_conversation_yet' }]);
    expect(getOutboxMessageById(db, outbox.id)?.attempts).toBe(0);
    expect(getOutboxMessageById(db, outbox.id)?.status).toBe('pending');
  });
});
