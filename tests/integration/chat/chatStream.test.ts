import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { appendChatMessage } from '../../../src/main/chat/appendMessage';
import type { ChatBroadcaster } from '../../../src/main/chat/chatBroadcaster';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import type { IpcResult } from '../../../src/shared/ipc/envelope';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * §5.1's "Streaming (MUST)" and §28 M9 items 2 and 3, against a real
 * database and the real IPC dispatcher.
 *
 * The write-count assertions matter more than the final body: "the text is
 * right at the end" is true of an implementation that writes on every
 * token, which is the thing §5.1 forbids and the reason the throttle
 * exists. So the branch is asserted — how many UPDATEs actually ran —
 * not only the outcome.
 */
describe('chat streaming (§5.1, §28 M9 items 2-3)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let conversationId: string;
  let updates: number;
  let pushed: ConversationMessage[];
  let broadcaster: ChatBroadcaster;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-chatstream-'));
    const paths = getDbPaths(tmpDir, REAL_MIGRATIONS_DIR);
    db = openConnection(paths.dbPath);
    await runMigrations({
      db,
      dbPath: paths.dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: paths.backupsDir,
    });
    activityLog = ActivityLog.open(paths.activityLogPath, db);

    const company = insertCompany(db, { name: 'Chat Co', home_path: tmpDir });
    conversationId = insertConversation(db, {
      company_id: company.id,
      project_id: null,
      title: 'Chat',
      director_session_id: null,
      summary: null,
      director_state: null,
      director_state_data: null,
      status: 'active',
    }).id;

    // Counting real UPDATEs against the real table, by wrapping the real
    // connection's `prepare` — not by asking the class how many times it
    // thinks it wrote.
    updates = 0;
    const realPrepare = db.prepare.bind(db);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare = (sql: string) => {
      if (/^\s*UPDATE conversation_messages/i.test(sql)) updates += 1;
      return realPrepare(sql);
    };

    pushed = [];
    broadcaster = { messageChanged: (message) => pushed.push(message) };
  });

  afterEach(() => {
    vi.useRealTimers();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const eventTypes = (): string[] =>
    (db.prepare('SELECT type FROM events ORDER BY seq').all() as { type: string }[]).map(
      (row) => row.type,
    );

  const messageRow = (id: string): { body: string; status: string } =>
    db.prepare('SELECT body, status FROM conversation_messages WHERE id = ?').get(id) as {
      body: string;
      status: string;
    };

  it('inserts the row as streaming before any text, and says so once', () => {
    const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
    const stream = registry.begin({ conversationId });

    expect(messageRow(stream.messageId)).toEqual({ body: '', status: 'streaming' });
    // Two events, for two things that happened: a row exists, and a stream
    // began. Not one event for one function call.
    expect(eventTypes()).toEqual(['chat.message_persisted', 'chat.stream_started']);
    expect(pushed).toHaveLength(1);
  });

  it('coalesces many deltas into one write per ~500ms window', () => {
    vi.useFakeTimers();
    const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
    const stream = registry.begin({ conversationId });
    const updatesAfterBegin = updates;

    for (let i = 0; i < 10; i += 1) stream.append(`chunk ${i} `);
    // Nothing yet: the whole point is that ten deltas do not mean ten
    // writes.
    expect(updates - updatesAfterBegin).toBe(0);

    vi.advanceTimersByTime(500);
    expect(
      updates - updatesAfterBegin,
      'ten deltas in one window must cost exactly one UPDATE',
    ).toBe(1);
    expect(messageRow(stream.messageId).body).toBe(
      'chunk 0 chunk 1 chunk 2 chunk 3 chunk 4 chunk 5 chunk 6 chunk 7 chunk 8 chunk 9 ',
    );

    // A second window is a second write, not a second batch of ten.
    stream.append('more');
    vi.advanceTimersByTime(500);
    expect(updates - updatesAfterBegin).toBe(2);

    // And no event for either flush: mid-stream progress is not a state
    // change §5.2 has a type for.
    expect(eventTypes()).toEqual(['chat.message_persisted', 'chat.stream_started']);
  });

  it('finalises at completion, keeping text that arrived inside the last window', () => {
    vi.useFakeTimers();
    const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
    const stream = registry.begin({ conversationId });
    stream.append('first ');
    vi.advanceTimersByTime(500);
    // Appended and NOT flushed — completion must not lose it.
    stream.append('last');
    stream.complete();

    expect(messageRow(stream.messageId)).toEqual({ body: 'first last', status: 'complete' });
    expect(eventTypes()).toEqual([
      'chat.message_persisted',
      'chat.stream_started',
      'chat.stream_completed',
    ]);
  });

  it('an aborted stream keeps what arrived and is marked aborted, not left looking complete', () => {
    vi.useFakeTimers();
    const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
    const stream = registry.begin({ conversationId });
    stream.append('half a thou');
    stream.abort('stopped_by_user');

    const row = messageRow(stream.messageId);
    // Both halves matter: the words survive AND the row says it did not
    // finish. A truncated message that reads as complete is the failure
    // mode this state exists to prevent.
    expect(row.body).toBe('half a thou');
    expect(row.status).toBe('aborted');
    expect(eventTypes().at(-1)).toBe('chat.stream_aborted');
  });

  it('ending twice does not write a second ending', () => {
    const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
    const stream = registry.begin({ conversationId });
    stream.complete();
    expect(stream.abort()).toBeNull();
    expect(eventTypes().filter((t) => t.startsWith('chat.stream_')).length).toBe(2);
    expect(messageRow(stream.messageId).status).toBe('complete');
  });

  describe('chat.stop through the real dispatcher', () => {
    const context = (registry?: ChatStreamRegistry): HandlerContext =>
      ({
        db,
        activityLog,
        dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
        pricing: REAL_PRICING,
        baseDir: tmpDir,
        bundledPacksDir: path.resolve('packs'),
        appVersion: '0.0.1',
        chatStreams: registry,
      }) as HandlerContext;

    const callStop = async (
      registry?: ChatStreamRegistry,
    ): Promise<IpcResult<{ ok: true; stopped: boolean }>> =>
      (await dispatchIpcCall(
        'chat:stop',
        getMethodSchema('chat', 'stop'),
        chatHandlers['stop']!,
        context(registry),
        true,
        { conversationId },
      )) as IpcResult<{ ok: true; stopped: boolean }>;

    it('stops a live stream, and reports honestly that it stopped nothing the second time', async () => {
      const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
      const stream = registry.begin({ conversationId });
      stream.append('mid sen');

      const first = await callStop(registry);
      expect(first.ok && first.data.stopped).toBe(true);
      expect(messageRow(stream.messageId)).toEqual({ body: 'mid sen', status: 'aborted' });
      expect(eventTypes().at(-1)).toBe('chat.stream_aborted');

      // Two windows can both press Stop. The second press must not claim a
      // success that did nothing — and must not emit a second abort for a
      // state change that already happened.
      const second = await callStop(registry);
      expect(second.ok && second.data.stopped).toBe(false);
      expect(eventTypes().filter((t) => t === 'chat.stream_aborted')).toHaveLength(1);
    });

    it('stopping when nothing is streaming is a real answer, not an error', async () => {
      const registry = new ChatStreamRegistry({ db, activityLog, broadcaster });
      const result = await callStop(registry);
      expect(result.ok && result.data.stopped).toBe(false);
    });

    it('says so rather than claiming success when there is no registry at all', async () => {
      const result = await callStop(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('INTERNAL_ERROR');
    });
  });

  it('a non-streamed message is persisted, evented and pushed exactly once', () => {
    const message = appendChatMessage(
      { db, activityLog, broadcaster },
      {
        conversationId,
        author: 'director',
        kind: 'report',
        body: 'Done.',
        payload: { whatHappened: 'Built it', costMicros: null },
      },
    );
    expect(message.status).toBe('complete');
    expect(eventTypes()).toEqual(['chat.message_persisted']);
    expect(pushed.map((m) => m.id)).toEqual([message.id]);
  });

  it('refuses a payload that does not match its kind rather than storing an unrenderable row', () => {
    expect(() =>
      appendChatMessage(
        { db, activityLog, broadcaster },
        { conversationId, author: 'director', kind: 'report', body: 'Done.', payload: { nope: 1 } },
      ),
    ).toThrow(/whatHappened/);
    // Nothing was written on the way to throwing.
    const count = db.prepare('SELECT COUNT(*) as n FROM conversation_messages').get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
