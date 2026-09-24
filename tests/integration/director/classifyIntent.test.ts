import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { storeSecret, type SafeStorageLike } from '../../../src/main/secrets/secretStore';
import { ONESHOT_SECRET_KEY_NAME } from '../../../src/main/ai/oneshotConfig';
import {
  classifyIntent,
  classifyIntentByRules,
  type IntentDeps,
} from '../../../src/main/director/classifyIntent';

/**
 * **Intent classification** (M11 row S1-16, §22.2/§22.4). `classifyIntent`
 * is the only place intent is decided. With a one-shot provider it asks the
 * `fast` tier; without one — the normal case, since the provider is stored
 * unset — §22.4's keyword and structure rules decide. Ambiguity is "chat",
 * and the Director decides inside its own turn.
 *
 * The provider here is a real loopback HTTP server speaking Anthropic's
 * wire shape, as `oneshot.test.ts` and `duplicateDetection.test.ts` do.
 */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
};

describe('classifyIntent: one decider, a one-shot call with a rule fallback', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-intent-'));
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
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('with provider none — the shipped default', () => {
    it.each([
      ['Build me a website for my bakery', 'new_work'],
      ['Can you write a script that renames my photos?', 'new_work'],
      ["What's the status of the project?", 'question'],
      ['how much have we spent', 'question'],
      ['thanks!', 'chat'],
      ['make it nicer', 'chat'],
    ] as const)('%s → %s, decided by the rules', async (text, intent) => {
      const result = await classifyIntent({ db, activityLog }, { text, awaitingAnswer: false });
      expect(result).toEqual({ intent, decidedBy: 'rules' });
    });

    it('while the Director is waiting on its questions, a reply is an answer', async () => {
      const result = await classifyIntent(
        { db, activityLog },
        { text: 'Mostly families, and yes to online orders', awaitingAnswer: true },
      );
      expect(result.intent).toBe('answer');
    });

    it('no usage row is written when no call was made', async () => {
      await classifyIntent({ db, activityLog }, { text: 'Build me an app', awaitingAnswer: false });
      expect((db.prepare('SELECT COUNT(*) AS n FROM usage').get() as { n: number }).n).toBe(0);
    });
  });

  describe('with a real one-shot provider', () => {
    let server: http.Server;
    let port: number;
    let reply = 'NEW_WORK';
    let calls = 0;

    beforeEach(async () => {
      calls = 0;
      server = http.createServer((req, res) => {
        calls += 1;
        req.resume();
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: reply }],
              usage: { input_tokens: 60, output_tokens: 2 },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
      await storeSecret(db, ONESHOT_SECRET_KEY_NAME, 'sk-test-value', 'anthropic', fakeSafeStorage);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const withProvider = (baseUrl = `http://127.0.0.1:${port}`): IntentDeps => ({
      db,
      activityLog,
      safeStorage: fakeSafeStorage,
      oneShotConfig: {
        provider: 'anthropic',
        baseUrl,
        secretKey: ONESHOT_SECRET_KEY_NAME,
        model: 'claude-haiku-4-5-20251001',
      },
    });

    it('the call decides, and its cost is recorded through the one-shot path', async () => {
      reply = 'QUESTION';
      const result = await classifyIntent(withProvider(), {
        text: 'Build me a website',
        awaitingAnswer: false,
      });
      expect(result).toEqual({ intent: 'question', decidedBy: 'oneshot' });
      expect(calls).toBe(1);
      const usage = db.prepare("SELECT source FROM usage WHERE source = 'oneshot'").all();
      expect(usage).toHaveLength(1);
      const recorded = db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'cost.oneshot_recorded'")
        .get() as { n: number };
      expect(recorded.n).toBe(1);
    });

    it('a reply that is not one of the four words is chat', async () => {
      reply = 'Probably they want a website, I think.';
      const result = await classifyIntent(withProvider(), {
        text: 'Build me a website',
        awaitingAnswer: false,
      });
      expect(result).toEqual({ intent: 'chat', decidedBy: 'oneshot' });
    });

    it('a provider that cannot be reached falls back to the rules', async () => {
      const result = await classifyIntent(withProvider('http://127.0.0.1:1'), {
        text: 'Build me a website',
        awaitingAnswer: false,
      });
      expect(result).toEqual({ intent: 'new_work', decidedBy: 'rules' });
    });
  });

  it('the rules on their own: ambiguity is chat', () => {
    expect(classifyIntentByRules('do the thing', false)).toBe('chat');
    expect(classifyIntentByRules('Create a dashboard for sales', false)).toBe('new_work');
  });
});
