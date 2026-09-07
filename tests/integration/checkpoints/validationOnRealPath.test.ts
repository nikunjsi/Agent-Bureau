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
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { seedEmployee } from '../../helpers/dbFixtures';
import { isBureauTool } from '../../../src/shared/policy/evaluator';
import type { Verdict } from '../../../src/shared/policy/types';
import { newId } from '../../../src/shared/models/ids';

/**
 * **Standing rule 2: a guard is not a guard until something on the real
 * path calls it.**
 *
 * `tests/unit/checkpoints/checkpointAnatomy.test.ts` proves the schema
 * rejects a consequence-less option. On its own that proves only that the
 * schema works *if invoked* — the exact shape of M7's tier floor, which
 * had a green unit test and an install path that walked around it.
 *
 * So this drives the same rules through the **real** path an agent takes:
 * a real `ControlChannelServer` over real loopback HTTP, a real bearer
 * token, the real `bureau_raise_checkpoint` handler, and the real
 * `insertCheckpoint`. Nothing here imports a schema to call it directly.
 *
 * The mutation that must break this file: revert `consequence` in
 * `CheckpointOptionSchema` to a bare `z.string()`. The "empty consequence"
 * case below then passes validation and a checkpoint row is written.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

interface RawResponse {
  status: number;
  body: unknown;
}

function rawRequest(
  port: number,
  options: { headers: Record<string, string>; body: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/tool/bureau_raise_checkpoint',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...options.headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('§9.2 validation, through the real bureau_raise_checkpoint path', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: ControlChannelServer;
  let port: number;
  let token: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-validation-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);

    const tokenRegistry = new TokenRegistry();
    token = tokenRegistry.mint(seedEmployee(db).id);

    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry: new SupervisorRegistry(),
      // The tool call itself must be allowed, or the request never reaches
      // the handler and this file would be testing the policy layer.
      evaluatePolicy: async (request): Promise<Verdict> =>
        isBureauTool(request.tool)
          ? { effect: 'allow', ruleId: 'test.bureau_tools' }
          : { effect: 'deny', ruleId: 'test.deny', reason: 'not under test' },
    });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const call = (args: unknown) =>
    rawRequest(port, {
      headers: { authorization: `Bearer ${token}` },
      body: { idempotencyKey: newId(), args },
    });

  const wellFormed = {
    type: 'decision',
    urgency: 'soon',
    title: 'Should we optimise for read speed?',
    context: 'The report screen is slow. Speeding it up means storing some data twice.',
    options: [
      {
        id: 'optimise',
        label: 'Optimise for read speed',
        consequence: 'Reports load fast; some data is duplicated.',
      },
      { id: 'leave', label: 'Leave it alone', consequence: 'Nothing changes; reports stay slow.' },
    ],
  };

  function checkpointCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get() as { n: number }).n;
  }

  it('a well-formed checkpoint is accepted and written', async () => {
    const res = await call(wellFormed);
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(checkpointCount()).toBe(1);
  });

  // ---- the deliverable: invariant #8, on the real path ----

  it('REJECTS an option with a missing consequence — and writes nothing', async () => {
    const res = await call({
      ...wellFormed,
      options: [{ id: 'a', label: 'Option A' }, wellFormed.options[1]],
    });

    const body = res.body as { ok: boolean; error?: { code: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(body.error?.message).toMatch(/consequence/i);
    // The row must not exist. A validation error that still writes is the
    // worse half of this bug, and asserting only the error would miss it.
    expect(checkpointCount()).toBe(0);
  });

  it('REJECTS an option whose consequence is empty — the case a bare z.string() let through', async () => {
    const res = await call({
      ...wellFormed,
      options: [{ ...wellFormed.options[0], consequence: '' }, wellFormed.options[1]],
    });

    const body = res.body as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('VALIDATION_FAILED');
    expect(checkpointCount()).toBe(0);
  });

  it('REJECTS two recommended options', async () => {
    const res = await call({
      ...wellFormed,
      options: wellFormed.options.map((option) => ({ ...option, recommended: true })),
    });

    const body = res.body as { ok: boolean; error?: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.message).toMatch(/recommended/i);
    expect(checkpointCount()).toBe(0);
  });

  it('REJECTS a checkpoint with no options at all (only `information` may omit them)', async () => {
    const res = await call({ ...wellFormed, options: [] });
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect(checkpointCount()).toBe(0);
  });

  it('the agent-facing message names the offending field, per §7.9', async () => {
    // §7.9: "VALIDATION ERRORS ARE READ BY AN AGENT, NOT A HUMAN." A bare
    // "invalid input" gives the agent nothing to correct on its next call.
    const res = await call({
      ...wellFormed,
      options: [{ id: 'a', label: 'Option A' }, wellFormed.options[1]],
    });
    const message = (res.body as { error: { message: string } }).error.message;
    expect(message).toContain('bureau_raise_checkpoint');
    expect(message).toMatch(/options\.0\.consequence/);
  });
});
