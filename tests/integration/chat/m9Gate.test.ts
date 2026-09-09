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
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { DIRECTOR_ROLE_FULL_KEY } from '../../../src/main/company/directorRole';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getOutboxMessageById } from '../../../src/main/db/repositories/messages';
import { routeOnce } from '../../../src/main/messages/router';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import { startLiveIdleEmployee } from '../../helpers/liveSupervisor';
import type { Supervisor } from '../../../src/main/engine/supervisor';

import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * # M9's gate — the one this session can honestly meet
 *
 * ## §28's gate cannot pass in M9, and this file does not claim it does
 *
 * §28 says: *"a full conversation including approving a brief works end to
 * end against `FakeAdapter`."* That needs three things, and this session
 * builds one of them:
 *
 *  | Needed                                             | Owner       |
 *  |----------------------------------------------------|-------------|
 *  | A Director employee row                            | **M9 s2**   |
 *  | Director output → `conversation_messages`          | M11         |
 *  | A tool that writes a `briefs` row                  | M11         |
 *
 * `grep -rn "write_brief\|bureau_write" src/` returns nothing: no tool, no
 * handler, no path of any kind writes a brief. So "approving a brief" has
 * no legitimate producer, and a test that inserted one and called the flow
 * end-to-end would be asserting a claim the product cannot make. Session
 * 1's own condition, applied: seeding a brief to test `brief.approve` is
 * fine — that is a handler with an input — but calling it "the gate" is
 * not. Same row, different claim.
 *
 * ## What this test asserts instead, and it is all real
 *
 * **A message typed in the composer persists, appears in the conversation,
 * is addressed to `director`, and is delivered by M8's real router to a
 * real Director hired through the real `hireEmployee` path, running
 * `FakeAdapter`, which receives it.**
 *
 * Six subsystems, no seeding: the real pack installer, the real hire, the
 * real `chat.send` through the real IPC dispatcher, the real
 * `appendChatMessage`, the real outbox, the real `deliverabilityOf`, the
 * real `routeOnce`, and a real `Supervisor` whose `send()` is the real
 * §7.4 implementation. The only fixture is `FakeAdapter`, which fakes the
 * engine process exactly as it does everywhere else in this repo.
 *
 * **What it does not include is a reply.** Nothing in Bureau decides what
 * to say yet. The honest sentence for §1 item 3 is therefore: *you can
 * hold half a conversation — you can speak, and nothing answers yet.*
 */
describe('M9 gate: a message typed by a person reaches a real Director', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let ctx: HandlerContext;
  let conversationId: string;
  let live: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m9-gate-'));
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
    registry = new SupervisorRegistry();
    live = [];

    const company = seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    conversationId = insertConversation(db, {
      company_id: company.id,
      project_id: null,
      title: 'Director',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    }).id;

    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
      supervisorRegistry: registry,
    } as HandlerContext;
  });

  afterEach(async () => {
    await Promise.all(live.map((supervisor) => supervisor.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function send(body: string) {
    return dispatchIpcCall(
      'chat:send',
      getMethodSchema('chat', 'send'),
      chatHandlers['send']!,
      ctx,
      true,
      { conversationId, body },
    );
  }

  it('composer → conversation → outbox → router → the Director’s own adapter', async () => {
    // 1. Hire a Director. THE PRODUCTION PATH — this is condition (a), and
    //    the whole reason a seeded row would have been worthless.
    const director = hireEmployee({
      db,
      activityLog,
      companyId: seedCompanyId(db),
      baseDir: tmpDir,
      roleKey: DIRECTOR_ROLE_FULL_KEY,
    }).employee;
    expect(director.is_director).toBe(true);

    // 2. Start them, for real. `assign()` is the production entry point and
    //    the §7.4 `send()` the router will call is the real one.
    const started = await startLiveIdleEmployee({
      db,
      activityLog,
      supervisorRegistry: registry,
      employee: director,
      stateDir: tmpDir,
    });
    live.push(started.supervisor);

    // 3. A person types a message. Through the real dispatcher — the same
    //    schema, handler and output re-validation the preload reaches.
    const result = await send('Build me a site that lists my recipes.');
    expect(result.ok).toBe(true);

    // 4. It persisted, as a real conversation message the read path serves.
    const persisted = (result as { data: { item: ConversationMessage } }).data.item;
    expect(persisted.author).toBe('user');
    expect(persisted.kind).toBe('text');
    expect(persisted.body).toBe('Build me a site that lists my recipes.');
    const listed = await dispatchIpcCall(
      'chat:listMessages',
      getMethodSchema('chat', 'listMessages'),
      chatHandlers['listMessages']!,
      ctx,
      true,
      { conversationId },
    );
    expect(listed.ok).toBe(true);
    expect(
      (listed as { data: { items: ConversationMessage[] } }).data.items.map((m) => m.id),
    ).toEqual([persisted.id]);

    // 5. It was addressed to the Director, in the durable outbox.
    const outboxRow = db.prepare('SELECT id FROM messages').get() as { id: string };
    const outbox = getOutboxMessageById(db, outboxRow.id)!;
    expect(outbox.to_addr).toBe('director');
    expect(outbox.from_addr).toBe('user');
    expect(outbox.status).toBe('pending');

    // 6. M8's real router delivers it.
    const report = await routeOnce(
      { db, activityLog, supervisorRegistry: registry, appStartedAtMs: Date.now() },
      { nowMs: Date.now() },
    );
    expect(report.delivered).toEqual([outbox.id]);
    expect(report.held).toEqual([]);

    // 7. And the Director's own adapter RECEIVED it. Not "the row says
    //    delivered" — the bytes reached the engine seam, which is the only
    //    thing that makes step 6 mean anything.
    const received = started.adapter.sentMessages;
    expect(received.map((entry) => entry.text).join('\n')).toContain(
      'Build me a site that lists my recipes.',
    );
    // §7.4: handed over at a real turn boundary, not injected mid-turn.
    expect(received.every((entry) => entry.kind === 'message')).toBe(true);

    expect(getOutboxMessageById(db, outbox.id)?.status).toBe('delivered');
    expect(getOutboxMessageById(db, outbox.id)?.resolved_employee_id).toBe(director.id);
  });

  it('two events, for two state changes, and no third', async () => {
    // Invariant #3, and the `user.message_sent` decision: §5.2 lists it,
    // but `chat.message_persisted` with `actor: 'user'` already carries
    // everything it would, and one state change gets one event. Same call
    // `answerCheckpoint.ts:54-60` made about `user.checkpoint_answered`.
    await send('Hello.');
    const types = (
      db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]
    ).map((row) => row.type);
    expect(types.filter((type) => type === 'chat.message_persisted').length).toBe(1);
    expect(types.filter((type) => type === 'message.sent').length).toBe(1);
    expect(types).not.toContain('user.message_sent');
    // Order: the conversation row commits and emits BEFORE the outbox row
    // it causes. Both indices are checked to exist first — an ordering
    // assertion needs a presence assertion (standing rule 3).
    expect(types).toContain('chat.message_persisted');
    expect(types).toContain('message.sent');
    expect(types.indexOf('chat.message_persisted')).toBeLessThan(types.indexOf('message.sent'));
  });
});

function seedCompanyId(db: Database.Database): string {
  return (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string }).id;
}
