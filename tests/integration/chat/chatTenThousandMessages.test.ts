import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertConversationMessage } from '../../../src/main/db/repositories/conversationMessages';
import { getDbPaths } from '../../../src/main/db/paths';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import {
  CHAT_PAGE_SIZE,
  isUnreadForUser,
  type ConversationMessage,
} from '../../../src/shared/models/conversationMessage';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
export const TEN_THOUSAND = 10_000;

/**
 * P-4 / chaos scenario #12, the chat half: `chat.listMessages` over 10,000
 * messages, through the real router (input validation, the real handler,
 * output validation, and N-2's redaction of the whole response).
 *
 * **Paginated as a result (P-4).** Measured before the change: about 1.1 s per
 * call and a 4.5 MB response, and in the packaged app the newest message
 * took 8.1 s to appear and a tab click 8.9 s to be handled. Now a page is
 * `CHAT_PAGE_SIZE` messages, walked with a `beforeMessageId` cursor, and the
 * unread messages older than a page are counted by the Core.
 *
 * A MEASUREMENT with correctness assertions only. No elapsed-time assertion:
 * a wall-clock bound on real work is the flake class D-3 removes. The numbers
 * are printed and recorded in the pre-M11 plan's P-4 row; the render half is
 * measured in the packaged app by `tests/e2e/chatTenThousand.spec.ts`.
 */
describe('chat.listMessages with 10,000 messages (P-4, chaos #12)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let conversationId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-chat10k-'));
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
    const company = insertCompany(db, { name: 'Co', home_path: tmpDir });
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
      baseDir: tmpDir,
    } as HandlerContext;

    // Realistic bodies (a sentence or three of prose, some markdown), written
    // by the production repository in one transaction so seeding is not what
    // gets measured.
    db.transaction(() => {
      for (let i = 0; i < TEN_THOUSAND; i += 1) {
        insertConversationMessage(db, {
          conversation_id: conversationId,
          project_id: null,
          author: i % 2 === 0 ? 'user' : 'director',
          kind: 'text',
          body: `Message ${i}. The report page now **loads in under a second**, and the export button writes a \`csv\` with every column the brief asked for. Next I will check the filters.`,
          payload: null,
          checkpoint_id: null,
          status: 'complete',
        });
      }
      // Distinct, ordered timestamps (a bulk insert shares milliseconds), and a
      // realistic mix of read and unread replies.
      const ids = db.prepare('SELECT id FROM conversation_messages ORDER BY rowid').all() as Array<{
        id: string;
      }>;
      const base = Date.parse('2026-09-01T00:00:00.000Z');
      ids.forEach(({ id }, i) => {
        db.prepare('UPDATE conversation_messages SET created_at = ?, read_at = ? WHERE id = ?').run(
          new Date(base + i * 1000).toISOString(),
          i % 3 === 0 ? new Date(base + i * 1000 + 500).toISOString() : null,
          id,
        );
      });
    })();
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function page(beforeMessageId: string | null) {
    const result = await dispatchIpcCall(
      'chat:listMessages',
      getMethodSchema('chat', 'listMessages'),
      chatHandlers['listMessages']!,
      ctx,
      true,
      { conversationId, beforeMessageId },
    );
    expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true);
    return (
      result as {
        ok: true;
        data: { items: ConversationMessage[]; hasOlder: boolean; unreadOlderCount: number };
      }
    ).data;
  }

  it('the first call returns only the newest page, and reports its cost', async () => {
    const samples: number[] = [];
    let first = await page(null);
    for (let run = 0; run < 3; run += 1) {
      const started = performance.now();
      first = await page(null);
      samples.push(performance.now() - started);
    }
    expect(first.items).toHaveLength(CHAT_PAGE_SIZE);
    expect(first.items.at(-1)?.body).toMatch(/^Message 9999\./);
    expect(first.hasOlder).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(first));
    console.log(
      `[P-4] chat.listMessages, newest page of ${TEN_THOUSAND}: ${samples.map((ms) => `${ms.toFixed(0)} ms`).join(', ')}; response ${(bytes / 1024).toFixed(0)} KB`,
    );
  });

  it('walking the cursor returns every message exactly once, in order, and the unread counts agree with the shared predicate', async () => {
    const all = (db.prepare('SELECT id FROM conversation_messages').all() as Array<{ id: string }>)
      .length;
    expect(all).toBe(TEN_THOUSAND);

    const seen: ConversationMessage[] = [];
    let cursor: string | null = null;
    for (;;) {
      const data = await page(cursor);
      // Every page's older-unread count is the predicate applied to what is
      // older than that page — computed here from the rows, not trusted.
      const olderRows = (
        db
          .prepare('SELECT * FROM conversation_messages ORDER BY created_at, id')
          .all() as ConversationMessage[]
      ).slice(0, TEN_THOUSAND - seen.length - data.items.length);
      expect(data.unreadOlderCount).toBe(
        olderRows.filter((row) => isUnreadForUser(row as ConversationMessage)).length,
      );
      seen.unshift(...data.items);
      if (!data.hasOlder) break;
      cursor = data.items[0]!.id;
    }
    expect(seen).toHaveLength(TEN_THOUSAND);
    expect(new Set(seen.map((m) => m.id)).size).toBe(TEN_THOUSAND);
    expect(seen.map((m) => Number(/^Message (\d+)\./.exec(m.body)![1]))).toEqual(
      Array.from({ length: TEN_THOUSAND }, (_, i) => i),
    );
  });
});
