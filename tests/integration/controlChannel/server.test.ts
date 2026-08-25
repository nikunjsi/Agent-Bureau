import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { PolicyHoldRegistry } from '../../../src/main/controlChannel/policyHoldRegistry';
import { evaluateInterimPolicy } from '../../../src/main/controlChannel/policyEvaluator';
import { newId } from '../../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/** The one tool name this suite's injected evaluator treats as 'ask' — the
 * real interim evaluator (§20.2) never produces 'ask' for anything, so a
 * test evaluator is the only way to drive the long-poll hold through the
 * real /v1/policy/check endpoint (see server.ts's own doc comment). */
const HOLD_TOOL = 'HOLD_ME';

interface RawResponse {
  status: number;
  body: unknown;
}

function rawRequest(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: opts.method ?? 'POST',
        path: opts.path,
        headers: {
          'content-type': 'application/json',
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
        signal: opts.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          try {
            body = raw.length > 0 ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('ControlChannelServer (§7.9/§7.10)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let tokenRegistry: TokenRegistry;
  let policyHoldRegistry: PolicyHoldRegistry;
  let server: ControlChannelServer;
  let port: number;
  let token: string;
  let employeeId: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-controlchannel-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);

    tokenRegistry = new TokenRegistry();
    policyHoldRegistry = new PolicyHoldRegistry();
    employeeId = newId();
    token = tokenRegistry.mint(employeeId);

    server = new ControlChannelServer({
      activityLog,
      tokenRegistry,
      policyHoldRegistry,
      maxHoldMinutes: 5,
      bodyCapBytes: 2048,
      rateLimitsByToolName: { rate_limited_tool: 2000 },
      evaluatePolicy: async (request) => {
        if (request.tool === HOLD_TOOL) return 'ask';
        return evaluateInterimPolicy(request.tool);
      },
    });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function authed(): Record<string, string> {
    return { authorization: `Bearer ${token}` };
  }

  function readEventTypes(): string[] {
    return (db.prepare('SELECT type FROM events ORDER BY seq').all() as Array<{ type: string }>).map((r) => r.type);
  }

  // ---- origin ----

  describe('origin rejection (M4 step 1: "reject any non-loopback origin — test it")', () => {
    it('accepts a well-formed request with no Origin header and a matching Host header', async () => {
      const res = await rawRequest(port, {
        path: '/v1/tool/probe_tool',
        headers: authed(),
        body: { idempotencyKey: 'origin-ok', args: {} },
      });
      expect(res.status).toBe(200);
    });

    it('rejects a request carrying an Origin header (browser-shaped, never sent by bureau-hook/bureau-tools)', async () => {
      const res = await rawRequest(port, {
        path: '/v1/tool/probe_tool',
        headers: { ...authed(), origin: 'http://evil.example' },
        body: { idempotencyKey: 'origin-bad', args: {} },
      });
      expect(res.status).toBe(403);
      expect(readEventTypes()).toContain('control.origin_rejected');
    });

    it('rejects a request whose Host header does not match this server\'s own 127.0.0.1:<port> (DNS-rebinding-shaped)', async () => {
      const res = await rawRequest(port, {
        path: '/v1/tool/probe_tool',
        headers: { ...authed(), host: 'evil.example:1' },
        body: { idempotencyKey: 'host-bad', args: {} },
      });
      expect(res.status).toBe(403);
    });
  });

  // ---- auth ----

  describe('token auth (bad/revoked/unknown tokens rejected and logged)', () => {
    it('rejects a missing Authorization header', async () => {
      const res = await rawRequest(port, { path: '/v1/tool/probe_tool', body: { idempotencyKey: 'auth-missing', args: {} } });
      expect(res.status).toBe(401);
      expect(readEventTypes()).toContain('control.token_rejected');
    });

    it('rejects an unknown/bad token', async () => {
      const res = await rawRequest(port, {
        path: '/v1/tool/probe_tool',
        headers: { authorization: 'Bearer not-a-real-token' },
        body: { idempotencyKey: 'auth-bad', args: {} },
      });
      expect(res.status).toBe(401);
      expect(readEventTypes()).toContain('control.token_rejected');
    });

    it('rejects a token after it has been revoked (employee stop)', async () => {
      tokenRegistry.revoke(employeeId);
      const res = await rawRequest(port, {
        path: '/v1/tool/probe_tool',
        headers: authed(),
        body: { idempotencyKey: 'auth-revoked', args: {} },
      });
      expect(res.status).toBe(401);
    });
  });

  // ---- body cap ----

  it('rejects a request body larger than the configured cap with 413', async () => {
    const res = await rawRequest(port, {
      path: '/v1/tool/probe_tool',
      headers: authed(),
      body: { idempotencyKey: 'too-big', args: { blob: 'x'.repeat(4096) } },
    });
    expect(res.status).toBe(413);
  });

  // ---- /v1/event no longer exists (M4 session 2) ----

  it('/v1/event 404s — removed as an unused, agent-authenticated write path into the audit log (§7.10)', async () => {
    const res = await rawRequest(port, {
      path: '/v1/event',
      headers: authed(),
      body: { type: 'anything' },
    });
    expect(res.status).toBe(404);
  });

  // ---- rate limiting ----

  it('enforces the server-side rate limit on a configured tool, independent of client honesty', async () => {
    const first = await rawRequest(port, {
      path: '/v1/tool/rate_limited_tool',
      headers: authed(),
      body: { idempotencyKey: 'k1', args: {} },
    });
    expect(first.status).toBe(200);
    const second = await rawRequest(port, {
      path: '/v1/tool/rate_limited_tool',
      headers: authed(),
      body: { idempotencyKey: 'k2', args: {} },
    });
    expect(second.status).toBe(429);
  });

  // ---- idempotency ----

  it('returns the exact cached response for a retried tool call with the same idempotency key', async () => {
    const first = await rawRequest(port, {
      path: '/v1/tool/some_tool',
      headers: authed(),
      body: { idempotencyKey: 'same-key', args: { a: 1 } },
    });
    const second = await rawRequest(port, {
      path: '/v1/tool/some_tool',
      headers: authed(),
      body: { idempotencyKey: 'same-key', args: { a: 1 } },
    });
    expect(second.body).toEqual(first.body);
  });

  // ---- /v1/policy/check — basic allow/deny (no hold) ----

  it('/v1/policy/check allows a tool on the interim allow-list', async () => {
    const res = await rawRequest(port, {
      path: '/v1/policy/check',
      headers: authed(),
      body: { callId: newId(), tool: 'Read', rawTool: 'Read', args: {}, preview: 'read a file' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { verdict: string }).verdict).toBe('allow');
  });

  it('/v1/policy/check denies a tool not on the interim allow-list — deny by default', async () => {
    const res = await rawRequest(port, {
      path: '/v1/policy/check',
      headers: authed(),
      body: { callId: newId(), tool: 'Bash', rawTool: 'Bash', args: {}, preview: 'rm -rf /' },
    });
    expect(res.status).toBe(200);
    expect((res.body as { verdict: string }).verdict).toBe('deny');
  });

  it('/v1/policy/check allows a bureau_* tool — §11.3\'s bureau class routes through the same evaluator, not a bypass', async () => {
    const res = await rawRequest(port, {
      path: '/v1/policy/check',
      headers: authed(),
      body: { callId: newId(), tool: 'bureau_report_status', rawTool: 'bureau_report_status', args: {}, preview: '' },
    });
    expect((res.body as { verdict: string }).verdict).toBe('allow');
  });

  it('/v1/policy/check with a reused callId while the first is held is rejected as VALIDATION_FAILED, not a second independent hold', async () => {
    const callId = newId();
    const heldPromise = rawRequest(port, {
      path: '/v1/policy/check',
      headers: authed(),
      body: { callId, tool: HOLD_TOOL, rawTool: HOLD_TOOL, args: {}, preview: '' },
    });
    // Give the first request time to actually register as held.
    await waitUntilTrue(() => policyHoldRegistry.pendingCount === 1);

    const second = await rawRequest(port, {
      path: '/v1/policy/check',
      headers: authed(),
      body: { callId, tool: HOLD_TOOL, rawTool: HOLD_TOOL, args: {}, preview: '' },
    });
    expect(second.status).toBe(400);

    policyHoldRegistry.resolve(callId, 'allow');
    await heldPromise;
  });

  // ---- long-poll hold behaviour ----

  describe('the long-poll hold (§7.10)', () => {
    it('a slow human answering after a real delay does NOT get denied — the hold survives the wait', async () => {
      const callId = newId();
      const started = Date.now();
      const held = rawRequest(port, {
        path: '/v1/policy/check',
        headers: authed(),
        body: { callId, tool: HOLD_TOOL, rawTool: HOLD_TOOL, args: {}, preview: '' },
      });

      await waitUntilTrue(() => policyHoldRegistry.pendingCount === 1);
      await new Promise((resolve) => setTimeout(resolve, 500)); // simulate a slow human
      policyHoldRegistry.resolve(callId, 'allow');

      const res = await held;
      expect(Date.now() - started).toBeGreaterThanOrEqual(500);
      expect((res.body as { verdict: string }).verdict).toBe('allow');
    });

    it('the employee\'s connection dying mid-hold terminates the hold instead of leaking it', async () => {
      const callId = newId();
      const controller = new AbortController();
      const held = rawRequest(port, {
        path: '/v1/policy/check',
        headers: authed(),
        body: { callId, tool: HOLD_TOOL, rawTool: HOLD_TOOL, args: {}, preview: '' },
        signal: controller.signal,
      }).catch(() => undefined); // aborting is expected to reject the client's own promise

      await waitUntilTrue(() => policyHoldRegistry.pendingCount === 1);
      controller.abort();
      await held;

      // The cleanup is driven by the server's own 'close' listener, not
      // instantaneous with abort() — poll briefly rather than assume it's
      // synchronous.
      const cleaned = await waitUntilTrue(() => policyHoldRegistry.pendingCount === 0);
      expect(cleaned).toBe(true);
    });

    it('N employees holding simultaneously are genuinely concurrent — none starves the others', async () => {
      const N = 10;
      const employees = Array.from({ length: N }, () => {
        const id = newId();
        return { id, token: tokenRegistry.mint(id), callId: newId() };
      });

      const started = Date.now();
      const helds = employees.map((e) =>
        rawRequest(port, {
          path: '/v1/policy/check',
          headers: { authorization: `Bearer ${e.token}` },
          body: { callId: e.callId, tool: HOLD_TOOL, rawTool: HOLD_TOOL, args: {}, preview: '' },
        }),
      );

      // All N must register as held quickly (nothing serialized ahead of
      // the others establishing their own hold).
      const allHeld = await waitUntilTrue(() => policyHoldRegistry.pendingCount === N, 2000);
      expect(allHeld).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);

      employees.forEach((e, i) => policyHoldRegistry.resolve(e.callId, i % 2 === 0 ? 'allow' : 'deny'));
      const results = await Promise.all(helds);
      results.forEach((r, i) => {
        expect((r.body as { verdict: string }).verdict).toBe(i % 2 === 0 ? 'allow' : 'deny');
      });
    });
  });
});

/** Polls a predicate until true or the timeout elapses — used instead of a
 * fixed sleep to avoid the test being timing-flaky in either direction. */
async function waitUntilTrue(predicate: () => boolean, timeoutMs = 1000, intervalMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}
