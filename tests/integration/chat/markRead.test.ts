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
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getConversationMessageById } from '../../../src/main/db/repositories/conversationMessages';
import { appendChatMessage } from '../../../src/main/chat/appendMessage';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import { isUnreadForUser } from '../../../src/shared/models/conversationMessage';
import { newId } from '../../../src/shared/models/ids';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { ChatBroadcaster } from '../../../src/main/chat/chatBroadcaster';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * §28 M9 item 7's unread badges, durable half. `conversation_messages
 * .read_at` has existed since M1 and nothing had ever written it.
 *
 * ## The rule, chosen here because §14 does not state one
 *
 * A message is **unread** when `read_at IS NULL AND author != 'user'`, and
 * that predicate lives in exactly one place (`isUnreadForUser`) with two
 * callers: this handler's guard, and the renderer's badge count. Two
 * copies would be standing rule 6's shape, and they would agree right up
 * until one of them did not.
 *
 * **When** it is set is a renderer decision and is asserted in the e2e:
 * scrolled into view, in a focused window. Marking on render would stamp
 * everything below the fold the moment a conversation loads, which is the
 * failure that makes a badge worthless.
 *
 * ## No activity event, argued rather than assumed
 *
 * Invariant #3 gives every state change one event, and this emits none.
 * `read_at` is the one column describing the **viewer** rather than the
 * company's work: nothing downstream reads it, there is no side effect to
 * order against, and §5.2's taxonomy — closed in session 1 — has no type
 * for it. Adding one would put a row in the activity stream for every
 * message a person's eyes passed over, in the stream §14.5 requires to
 * stay readable. Asserted below so the decision is pinned, not implied.
 */
describe('chat.markRead (§28 M9 item 7)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let conversationId: string;
  let pushed: ConversationMessage[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-mark-read-'));
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
    pushed = [];
    const broadcaster: ChatBroadcaster = {
      messageChanged: (message) => {
        pushed.push(message);
      },
    };

    const company = insertCompany(db, { name: 'Test Co', home_path: tmpDir });
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
      chatBroadcaster: broadcaster,
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(author: 'user' | 'director' | 'system', body: string): ConversationMessage {
    return appendChatMessage({ db, activityLog }, { conversationId, author, kind: 'text', body });
  }

  async function markRead(messageId: string) {
    return dispatchIpcCall(
      'chat:markRead',
      getMethodSchema('chat', 'markRead'),
      chatHandlers['markRead']!,
      ctx,
      true,
      { conversationId, messageId },
    );
  }

  it('stamps read_at on a message the user did not write, and pushes it', async () => {
    const message = write('director', 'Here is the brief.');
    expect(isUnreadForUser(message)).toBe(true);

    expect((await markRead(message.id)).ok).toBe(true);

    const after = getConversationMessageById(db, message.id)!;
    expect(after.read_at).not.toBeNull();
    expect(isUnreadForUser(after)).toBe(false);
    // Other windows must stop showing it as unread. The push is not an
    // event; it is how every other change reaches an open window.
    expect(pushed.map((m) => m.id)).toEqual([message.id]);
    expect(pushed[0]!.read_at).not.toBeNull();
  });

  it("leaves the user's own message alone — you cannot have failed to read what you wrote", async () => {
    const mine = write('user', 'Build me a site.');
    expect(isUnreadForUser(mine)).toBe(false);

    // Reports success — nothing failed — but changes nothing and pushes
    // nothing.
    expect((await markRead(mine.id)).ok).toBe(true);
    expect(getConversationMessageById(db, mine.id)?.read_at).toBeNull();
    expect(pushed).toEqual([]);
  });

  it('is idempotent — a second window marking the same message pushes nothing more', async () => {
    const message = write('system', 'Paused everyone.');
    await markRead(message.id);
    const firstStamp = getConversationMessageById(db, message.id)!.read_at;
    await markRead(message.id);

    // The `read_at` is not re-stamped, so "when did I first see this" stays
    // true, and only one push went out.
    expect(getConversationMessageById(db, message.id)?.read_at).toBe(firstStamp);
    expect(pushed.length).toBe(1);
  });

  it('emits no activity event at all', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    const message = write('director', 'Anything.');
    const afterWrite = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n;
    // The write itself emits exactly one (`chat.message_persisted`).
    expect(afterWrite).toBe(before + 1);

    await markRead(message.id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n).toBe(
      afterWrite,
    );
  });

  it('404s a message that is not in this conversation', async () => {
    // The conversation id is not decoration: without checking it, a window
    // could mark a message belonging to a conversation it is not showing.
    const other = insertConversation(db, {
      company_id: (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string }).id,
      project_id: null,
      title: 'Another',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
    });
    const elsewhere = appendChatMessage(
      { db, activityLog },
      { conversationId: other.id, author: 'director', kind: 'text', body: 'Not yours.' },
    );

    const result = await markRead(elsewhere.id);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('NOT_FOUND');
    expect(getConversationMessageById(db, elsewhere.id)?.read_at).toBeNull();

    expect((await markRead(newId())).ok).toBe(false);
  });
});
