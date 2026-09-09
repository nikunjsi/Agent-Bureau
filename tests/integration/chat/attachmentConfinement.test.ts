import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * **S2 — `cannot_escape_workspace`**, for the one path a *person* can push
 * an arbitrary filesystem location into the system: §14.2's file attach.
 *
 * ## What this test claims, and what it explicitly does not
 *
 * §14.2 says an attachment is a "path reference into the conversation" —
 * the path becomes text the Director reads and may act on. Nothing stops a
 * user typing `C:\Users\me\.ssh\id_rsa`, and invariant #5 is absolute:
 * *nothing outside the workspace is readable or writable, at any autonomy
 * level. Not overridable.*
 *
 * Two questions, two answers, and conflating them would be the mistake:
 *
 *  - **"Is the user told now?"** — usability, and that is this file. The
 *    refusal happens in the **main process**, on the real `chat.send`
 *    path, through the real IPC dispatcher. A renderer-side check on a
 *    main-process invariant would not be a guard at all (standing rule 2),
 *    which is why the composer validates nothing.
 *  - **"Can the path actually be READ?"** — security, and that is **not**
 *    this file. It is `deny.read_outside_project` and
 *    `deny.credential_paths` (§11.3, both immutable), enforced when a tool
 *    call is made, and proven at every autonomy level by the other half of
 *    S2 in `tests/integration/controlChannel/policyRealEvaluator.test.ts`.
 *    That check stops `.ssh/id_rsa` whether or not this file exists.
 *
 * Both are listed in `test:security` and both claim S2, because S2 is the
 * property, not a file.
 */
describe('S2: an attached path outside the workspace is refused, and writes nothing', () => {
  let tmpDir: string;
  let homeDir: string;
  let outsideDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;
  let conversationId: string;

  /** Through the REAL dispatcher, so the input schema, the handler and the
   * output re-validation are all the production ones. */
  async function send(input: Record<string, unknown>) {
    return dispatchIpcCall(
      'chat:send',
      getMethodSchema('chat', 'send'),
      chatHandlers['send']!,
      ctx,
      true,
      input,
    );
  }

  function messageCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM conversation_messages').get() as { n: number }).n;
  }

  function outboxCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-attach-'));
    // A real directory layout, not a string: `canonicalizePath` resolves
    // through the real filesystem (junctions, 8.3 names, case), so a test
    // over paths that do not exist would exercise only its fallback.
    homeDir = path.join(tmpDir, 'Bureau');
    outsideDir = path.join(tmpDir, 'Elsewhere');
    mkdirSync(path.join(homeDir, 'my-project'), { recursive: true });
    mkdirSync(path.join(outsideDir, '.ssh'), { recursive: true });
    writeFileSync(path.join(homeDir, 'my-project', 'notes.md'), '# notes\n');
    writeFileSync(path.join(outsideDir, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
    // The near-miss that a naive `startsWith` lets through.
    mkdirSync(path.join(tmpDir, 'Bureau2'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'Bureau2', 'secrets.txt'), 'nope\n');

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

    const company = insertCompany(db, { name: 'Test Co', home_path: homeDir });
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
    } as HandlerContext;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('refuses a credential path outside the workspace, and leaves ZERO rows behind', async () => {
    const result = await send({
      conversationId,
      body: 'Have a look at this key.',
      attachments: [path.join(outsideDir, '.ssh', 'id_rsa')],
    });

    expect(result.ok).toBe(false);
    // §14.6: plain language, why, and what to do. Never "ENOENT" and never
    // a bare "invalid".
    expect(result.ok === false && result.error.message).toMatch(/outside your Bureau workspace/i);

    // The load-bearing half. A refusal that had already written the
    // message would leave the path in the transcript for the Director to
    // read — the exact thing being refused — and a user believing the
    // attachment had been dropped harmlessly.
    expect(messageCount()).toBe(0);
    expect(outboxCount()).toBe(0);
  });

  it('refuses a sibling directory whose name merely starts with the workspace name', async () => {
    // `E:/Bureau2` against a root of `E:/Bureau`. A `startsWith` without a
    // separator passes this, which is the classic way a containment check
    // is wrong in exactly the case an attacker would choose.
    const result = await send({
      conversationId,
      body: 'And this one.',
      attachments: [path.join(tmpDir, 'Bureau2', 'secrets.txt')],
    });
    expect(result.ok).toBe(false);
    expect(messageCount()).toBe(0);
  });

  it('refuses a traversal that resolves outside, however it is spelled', async () => {
    const result = await send({
      conversationId,
      body: 'Sneaky.',
      attachments: [path.join(homeDir, 'my-project', '..', '..', 'Elsewhere', '.ssh', 'id_rsa')],
    });
    expect(result.ok).toBe(false);
    expect(messageCount()).toBe(0);
  });

  it('refuses a relative path — there is no directory a chat message is written from', async () => {
    const result = await send({
      conversationId,
      body: 'Relative.',
      attachments: ['my-project/notes.md'],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/full path/i);
    expect(messageCount()).toBe(0);
  });

  it('fails CLOSED when there is no workspace at all', async () => {
    // Invariant #6. A company with no home path is not "allow everything"
    // — there is no workspace, so nothing is inside one.
    db.prepare('UPDATE companies SET home_path = ?').run(' ');
    const result = await send({
      conversationId,
      body: 'Anything.',
      attachments: [path.join(homeDir, 'my-project', 'notes.md')],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/no workspace folder/i);
    expect(messageCount()).toBe(0);
  });

  /**
   * The parallel proof, and it is not optional: without it every assertion
   * above is also satisfied by a `chat.send` that refuses everything.
   */
  it('(parallel proof, not a blanket refusal) accepts a path INSIDE the workspace and stores it structurally', async () => {
    const inside = path.join(homeDir, 'my-project', 'notes.md');
    const result = await send({
      conversationId,
      body: 'Here are my notes.',
      attachments: [inside],
    });

    expect(result.ok).toBe(true);
    expect(messageCount()).toBe(1);

    const row = db.prepare('SELECT body, payload FROM conversation_messages').get() as {
      body: string;
      payload: string | null;
    };
    // The path is a FACT on the payload, never formatted into the body:
    // how an attachment reads is the renderer's decision, and a stored row
    // is the one place presentation must not be baked in.
    expect(row.body).toBe('Here are my notes.');
    expect(row.body).not.toContain('notes.md');
    expect(JSON.parse(row.payload ?? 'null')).toEqual({ attachments: [inside], delivered: null });
  });
});
