import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import {
  insertCheckpoint,
  recordCheckpointAnswer,
} from '../../../src/main/db/repositories/checkpoints';
import { askCheckpoint } from '../../../src/main/checkpoints/ask';
import { findDuplicateCheckpoint } from '../../../src/main/checkpoints/duplicateDetection';
import { resolveOneShotConfig } from '../../../src/main/ai/oneshotConfig';
import { seedProject } from '../../helpers/dbFixtures';
import { storeSecret, type SafeStorageLike } from '../../../src/main/secrets/secretStore';
import { ONESHOT_SECRET_KEY_NAME } from '../../../src/main/ai/oneshotConfig';
import type { NewCheckpointInput } from '../../../src/shared/models/checkpoint';

/**
 * CLAUDE.md invariant #9 — "never ask a question that memory, the brief,
 * or the workspace already answers" — for the part M8 owns.
 *
 * **`provider: 'none'` is the primary path and is tested as one.** §22.4
 * is explicit that the one-shot client fails in the two configurations
 * this product recommends most (a subscription login and a free CLI login
 * both hold OAuth credentials inside the agent CLI), so FTS-plus-Dice
 * alone is what a real install runs. The one-shot half gets one test,
 * against a real loopback HTTP server, and it is the exception.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/** A working DPAPI stand-in — the real one needs a live Electron. Same
 * helper `tests/integration/ai/oneshot.test.ts` uses. */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
};

describe('checkpoint duplicate detection (§9.2, §22.4)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let projectId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-dupe-'));
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
    projectId = seedProject(db).id;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const DB_QUESTION = {
    title: 'Which database should this project use?',
    context:
      'The API needs to store data, and the choice affects how it is deployed and maintained.',
    options: [
      {
        id: 'sqlite',
        label: 'SQLite',
        consequence: 'One file, no server to run; no concurrent writers.',
      },
      {
        id: 'postgres',
        label: 'Postgres',
        consequence: 'Handles many writers; needs a server to run and maintain.',
      },
    ],
  };

  /**
   * A genuinely different question about the same subject, whose Dice
   * score against DB_QUESTION sits inside [NEAR_MISS_THRESHOLD,
   * DUPLICATE_THRESHOLD) — the only band that ever costs a one-shot call.
   * Measured, not guessed: the first draft of this fixture scored 0.30 and
   * silently took the below-threshold branch instead, so every test using
   * it passed for the wrong reason.
   */
  const NEAR_MISS = {
    title: 'Should this project add a cache in front of the database?',
    context: 'The API needs faster reads, and the choice affects how data is stored.',
    options: [
      {
        id: 'cache',
        label: 'Add a cache',
        consequence: 'Reads get faster; cached values can be a little stale.',
      },
      {
        id: 'no_cache',
        label: 'No cache',
        consequence: 'Reads stay as they are; nothing can go stale.',
      },
    ],
  };

  function answered(input: Partial<NewCheckpointInput> = {}): string {
    const cp = insertCheckpoint(db, activityLog, {
      project_id: projectId,
      type: 'decision',
      urgency: 'soon',
      ...DB_QUESTION,
      ...input,
    } as NewCheckpointInput);
    recordCheckpointAnswer(db, cp.id, {
      status: 'answered',
      answer: { optionId: 'sqlite', freeText: 'This runs on one machine for one user.' },
      answeredBy: 'user',
    });
    return cp.id;
  }

  const deps = () => ({ db, activityLog });

  describe('with no one-shot provider — the normal install', () => {
    it('resolves to provider: none out of a freshly seeded settings registry', () => {
      // Pinning the premise of every test below: this is what a real
      // install produces, not a test-only configuration.
      expect(resolveOneShotConfig(db).provider).toBe('none');
    });

    it('suppresses a re-ask of an answered question, and hands back the answer', async () => {
      const priorId = answered();

      const result = await askCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...DB_QUESTION,
      });

      expect(result.kind).toBe('duplicate');
      if (result.kind !== 'duplicate') throw new Error('unreachable');
      expect(result.checkpoint.id).toBe(priorId);
      expect(result.decidedBy).toBe('fts');
      // The point of returning it: the agent gets the DECISION, not a
      // second question. Invariant #9 as behaviour, not as a rule.
      expect(result.checkpoint.answer?.optionId).toBe('sqlite');
      expect(result.checkpoint.answer?.freeText).toContain('one machine');

      // Nothing new was written.
      const count = db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number };
      expect(count.n).toBe(1);
    });

    it('CREATES on a near-miss rather than suppressing it — §22.4s stated consequence', async () => {
      answered();

      // First, prove this text really IS in the near-miss band, not merely
      // below the threshold. Without this the test would pass for the
      // wrong reason — an unrelated question also "creates" — and would
      // never actually exercise the fallback §22.4 specifies.
      const detected = await findDuplicateCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        title: NEAR_MISS.title,
        context: NEAR_MISS.context,
      });
      expect(detected).toEqual({ kind: 'none', reason: 'near_miss_unconfirmed' });

      const result = await askCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...NEAR_MISS,
      });
      expect(result.kind).toBe('created');
    });

    it('does not suppress an unrelated question', async () => {
      answered();
      const result = await askCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        title: 'What should the invoice email say?',
        context: 'Customers receive this after paying, and the wording is yours to choose.',
        options: [
          { id: 'formal', label: 'Formal', consequence: 'Reads like a receipt from a bank.' },
          { id: 'warm', label: 'Warm', consequence: 'Reads like a note from a small business.' },
        ],
      });
      expect(result.kind).toBe('created');
    });

    it('does not suppress across projects — two projects may answer the same question differently', async () => {
      answered();
      const otherProject = seedProject(db).id;

      const result = await askCheckpoint(deps(), {
        project_id: otherProject,
        type: 'decision',
        urgency: 'soon',
        ...DB_QUESTION,
      });
      expect(result.kind).toBe('created');
    });

    it('does not suppress against a still-PENDING checkpoint — only answered ones count', async () => {
      insertCheckpoint(db, activityLog, {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...DB_QUESTION,
      });

      const result = await askCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...DB_QUESTION,
      });
      // §9.2 says "against ANSWERED checkpoints". A pending duplicate is a
      // surfacing/batching concern, not a reason to drop the question.
      expect(result.kind).toBe('created');
    });

    it('never deduplicates an approval — a decision that recurs is a real decision again', async () => {
      const approval = {
        project_id: projectId,
        type: 'approval' as const,
        urgency: 'blocking' as const,
        title: 'Raise the budget for this project?',
        context: 'The budget is spent and work is paused until you decide.',
        options: [
          {
            id: 'raise',
            label: 'Raise it',
            consequence: 'Work continues immediately at the new limit.',
          },
          {
            id: 'stop',
            label: 'Leave it',
            consequence: 'Work stays paused until the limit resets.',
          },
        ],
      };
      const first = insertCheckpoint(db, activityLog, approval);
      recordCheckpointAnswer(db, first.id, {
        status: 'answered',
        answer: { optionId: 'raise' },
        answeredBy: 'user',
      });

      const result = await askCheckpoint(deps(), approval);
      expect(result.kind).toBe('created');
    });

    it('survives a title full of FTS query syntax rather than throwing', async () => {
      // FTS5's MATCH argument is a query LANGUAGE. A title containing `-`,
      // `"`, `*` or the literal word NEAR is a syntax error unless every
      // token is quoted — which is exactly why `toFtsQuery` is imported
      // from the memory layer rather than rewritten here.
      answered();
      const result = await askCheckpoint(deps(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        title: 'Use a read-heavy "NEAR" cache * or not?',
        context: 'AND OR NOT NEAR -- these are all FTS operators, in a real sentence.',
        options: DB_QUESTION.options,
      });
      expect(result.kind).toBe('created');
    });
  });

  describe('with a real one-shot provider, on a near-miss only', () => {
    let oneShotServer: http.Server;
    let oneShotPort: number;
    let callCount = 0;
    let reply = 'DISTINCT';

    beforeEach(async () => {
      callCount = 0;
      // A real loopback HTTP server, not a mocked fetch — the same
      // discipline `tests/integration/ai/oneshot.test.ts` established, so
      // the request, headers and JSON shape are all genuinely exercised.
      oneShotServer = http.createServer((req, res) => {
        callCount += 1;
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              content: [{ type: 'text', text: reply }],
              usage: { input_tokens: 40, output_tokens: 1 },
            }),
          );
        });
      });
      await new Promise<void>((resolve) => oneShotServer.listen(0, '127.0.0.1', resolve));
      oneShotPort = (oneShotServer.address() as { port: number }).port;
      // A real key under the exact name `resolveOneShotConfig` uses,
      // stored through the real secret store.
      await storeSecret(db, ONESHOT_SECRET_KEY_NAME, 'sk-test-value', 'anthropic', fakeSafeStorage);
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => oneShotServer.close(() => resolve()));
    });

    const withProvider = () => ({
      db,
      activityLog,
      safeStorage: fakeSafeStorage,
      oneShotConfig: {
        provider: 'anthropic' as const,
        baseUrl: `http://127.0.0.1:${oneShotPort}`,
        secretKey: ONESHOT_SECRET_KEY_NAME,
        model: 'claude-haiku-4-5-20251001',
      },
    });

    it('does NOT call the provider when FTS alone already decided', async () => {
      answered();
      await askCheckpoint(withProvider(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...DB_QUESTION,
      });
      // A verbatim re-ask is over DUPLICATE_THRESHOLD, so no money is
      // spent. "One-shot call only on a near-miss" (§28 M8 item 3).
      expect(callCount).toBe(0);
    });

    it('does NOT call the provider when the question is plainly unrelated', async () => {
      answered();
      await askCheckpoint(withProvider(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        title: 'What should the invoice email say?',
        context: 'Customers receive this after paying, and the wording is yours to choose.',
        options: DB_QUESTION.options,
      });
      expect(callCount).toBe(0);
    });

    it('DOES call the provider on a near-miss, and suppresses when it answers DUPLICATE', async () => {
      reply = 'DUPLICATE';
      const priorId = answered();

      const result = await askCheckpoint(withProvider(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...NEAR_MISS,
      });

      expect(callCount).toBe(1);
      expect(result.kind).toBe('duplicate');
      if (result.kind !== 'duplicate') throw new Error('unreachable');
      expect(result.decidedBy).toBe('oneshot');
      expect(result.checkpoint.id).toBe(priorId);
    });

    it('creates when the provider answers DISTINCT', async () => {
      reply = 'DISTINCT';
      answered();
      const result = await askCheckpoint(withProvider(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...NEAR_MISS,
      });
      expect(callCount).toBe(1);
      expect(result.kind).toBe('created');
    });

    it('creates when the provider replies with something unexpected — unsure means ask', async () => {
      // §22.4: no feature may depend on the one-shot. A garbled reply is
      // one of the ways it fails, and the fallback direction is the same
      // as no provider at all: raise the question.
      reply = 'I think maybe possibly';
      answered();
      const result = await askCheckpoint(withProvider(), {
        project_id: projectId,
        type: 'decision',
        urgency: 'soon',
        ...NEAR_MISS,
      });
      expect(result.kind).toBe('created');
    });

    it('creates when the provider is unreachable — a failed helper call never blocks a question', async () => {
      answered();
      const result = await askCheckpoint(
        {
          ...withProvider(),
          // A port nothing is listening on.
          oneShotConfig: { ...withProvider().oneShotConfig, baseUrl: 'http://127.0.0.1:1' },
        },
        { project_id: projectId, type: 'decision', urgency: 'soon', ...NEAR_MISS },
      );
      expect(result.kind).toBe('created');
    });
  });
});
