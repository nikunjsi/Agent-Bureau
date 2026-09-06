import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { runOneShot, type OneShotConfig } from '../../../src/main/ai/oneshot';
import { storeSecret } from '../../../src/main/secrets/secretStore';
import { SecretRegistry } from '../../../src/main/secrets/redactor';
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { seedProject } from '../../helpers/dbFixtures';
import type { SafeStorageLike } from '../../../src/main/secrets/secretStore';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/** A working DPAPI stand-in — the real one needs a live Electron. */
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (buf: Buffer) => buf.toString('utf8').replace(/^enc:/, ''),
};

/**
 * §22.4's one-shot client.
 *
 * **This has no production caller this milestone, and that is deliberate**
 * — §28 places it here because M8's checkpoint duplicate confirmation and
 * M11's intent classification both need it. The audit fix session refused
 * §10.6 rules 5/6 on "no caller" grounds, so the distinction matters:
 * those were BEHAVIOUR whose triggers did not exist, which rots silently.
 * This is a library with a defined interface.
 *
 * That distinction alone is not enough, so these tests close the gap it
 * leaves: they drive the **real HTTP path** against a real loopback
 * server — real request, real headers, real timeout, real retry, real
 * usage row — rather than a mocked `fetch`. Unexercised code rots;
 * exercised code does not, caller or no caller.
 */
describe('§22.4 one-shot client', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: http.Server;
  let baseUrl: string;
  let requests: { url: string; headers: http.IncomingHttpHeaders; body: unknown }[];
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-oneshot-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    await storeSecret(db, 'oneshot_key', 'sk-test-value', 'test-provider', fakeSafeStorage);

    requests = [];
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'chat' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      );
    };

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url ?? '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
        });
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function config(over: Partial<OneShotConfig> = {}): OneShotConfig {
    return {
      provider: 'openai-compatible',
      baseUrl,
      secretKey: 'oneshot_key',
      model: 'test-fast',
      ...over,
    };
  }

  function deps(over: Record<string, unknown> = {}) {
    return {
      db,
      activityLog,
      config: config(),
      safeStorage: fakeSafeStorage,
      secretRegistry: new SecretRegistry(),
      ...over,
    };
  }

  // --- provider: 'none' is a first-class branch --------------------------

  it("returns a well-formed unavailable result for provider 'none', never an error", async () => {
    // §22.4: 'none' is the NORMAL case, because the two configurations this
    // product recommends most keep OAuth credentials inside the agent CLI.
    const result = await runOneShot(deps({ config: config({ provider: 'none' }) }), { prompt: 'hi' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_provider');
    // Nothing was spent and nothing was logged — there was no call.
    expect(db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 0 });
  });

  it('distinguishes "no provider" from "no key", because a caller may say different things', async () => {
    const result = await runOneShot(deps({ config: config({ secretKey: 'never_stored' }) }), { prompt: 'hi' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_key');
  });

  // --- the real HTTP path ------------------------------------------------

  it('makes a real HTTP call and returns the text', async () => {
    const result = await runOneShot(deps(), { prompt: 'classify this', system: 'be terse' });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('chat');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/v1/chat/completions');
    expect(requests[0]!.headers.authorization).toBe('Bearer sk-test-value');
    expect(requests[0]!.body).toMatchObject({
      model: 'test-fast',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'classify this' },
      ],
    });
  });

  it('speaks Anthropic’s wire format when told to', async () => {
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude' }], usage: { input_tokens: 3, output_tokens: 2 } }));
    };

    const result = await runOneShot(deps({ config: config({ provider: 'anthropic' }) }), { prompt: 'hi' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('claude');
    expect(requests[0]!.url).toBe('/v1/messages');
    expect(requests[0]!.headers['x-api-key']).toBe('sk-test-value');
    expect(requests[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('retries once on a server error, then gives up rather than hammering', async () => {
    let calls = 0;
    respond = (_req, res) => {
      calls += 1;
      res.writeHead(500).end('boom');
    };

    const result = await runOneShot(deps(), { prompt: 'hi' });

    expect(result.ok).toBe(false);
    // maxRetries default 1 == two attempts total. "These calls are never
    // critical" (§22.4) — a helper must not become a load generator.
    expect(calls).toBe(2);
  });

  it('times out and says so', async () => {
    respond = () => {
      /* never responds */
    };

    const result = await runOneShot(
      deps({ config: config({ timeoutMs: 120, maxRetries: 0 }) }),
      { prompt: 'hi' },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('timeout');
    expect(result.detail).toContain('120ms');
  });

  it('registers the key for redaction the moment it holds one', async () => {
    // §11.4's choke point: a real value in hand is a value that must be
    // redactable everywhere, not just where it was resolved.
    const registry = new SecretRegistry();
    expect(registry.values()).toEqual([]);
    await runOneShot(deps({ secretRegistry: registry }), { prompt: 'hi' });
    expect(registry.values()).toContain('sk-test-value');
  });

  // --- cost recording ----------------------------------------------------

  it('records usage with source=oneshot and NULL employee/task/turn', async () => {
    const project = seedProject(db);
    await runOneShot(deps({ projectId: project.id }), { prompt: 'hi' });

    const row = db.prepare('SELECT * FROM usage').get() as Record<string, unknown>;
    expect(row['source']).toBe('oneshot');
    expect(row['employee_id']).toBeNull();
    expect(row['task_id']).toBeNull();
    expect(row['turn_index']).toBeNull();
    expect(row['project_id']).toBe(project.id);
    expect(row['tokens_in']).toBe(11);
    expect(row['tokens_out']).toBe(7);
  });

  it('emits cost.oneshot_recorded, and says who paid', async () => {
    await runOneShot(deps({ projectId: null }), { prompt: 'hi' });

    const row = db
      .prepare("SELECT payload FROM events WHERE type = 'cost.oneshot_recorded'")
      .get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({
      provider: 'openai-compatible',
      model: 'test-fast',
      // No project active, so the Director reserve covers it (§8.0/§22.4).
      againstDirectorReserve: true,
    });
  });

  it('records NOTHING when the call fails — no fabricated spend', async () => {
    respond = (_req, res) => res.writeHead(500).end('boom');
    await runOneShot(deps(), { prompt: 'hi' });

    expect(db.prepare('SELECT COUNT(*) AS n FROM usage').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'cost.oneshot_recorded'").get()).toEqual({ n: 0 });
  });

  // --- THE INVERSION -----------------------------------------------------

  it('STILL RUNS with the budget blown — the rule this file deliberately inverts', async () => {
    // §22.4: one-shot calls "are how the app explains that the budget is
    // exhausted, and the reserve covers them". M6 built budget enforcement
    // to block spending everywhere else; blocking here would leave the
    // user with an app that has run out of money and cannot say so.
    //
    // The proof is real spend on the ledger, not a flag: a project with
    // more recorded spend than any plausible ceiling.
    const project = seedProject(db);
    insertUsage(
      db,
      { engine: 'claude-code', model: 'x', cost_usd_micros: 999_999_999_999, source: 'turn' },
      { projectId: project.id },
    );

    const result = await runOneShot(deps({ projectId: project.id }), { prompt: 'why did it stop?' });

    expect(result.ok, 'a one-shot call must survive an exhausted budget').toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe('chat');
  });
});
