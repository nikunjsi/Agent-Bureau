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
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { PolicyHoldRegistry } from '../../../src/main/controlChannel/policyHoldRegistry';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { dispatchIpcCall } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { IPC_SCHEMAS } from '../../../src/shared/ipc/schemas';
import {
  getCheckpointById,
  listPendingPermissionCheckpoints,
} from '../../../src/main/db/repositories/checkpoints';
import { reconcile } from '../../../src/main/db/reconcile';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { seedEmployee } from '../../helpers/dbFixtures';
import { newId } from '../../../src/shared/models/ids';
import type { Verdict } from '../../../src/shared/policy/types';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * **M8's gate, first half:** "a permission checkpoint holds an agent, is
 * answered from the UI, and the agent proceeds."
 *
 * Every part of that is real here except the screen, which does not exist
 * in any milestone before M9: a real `ControlChannelServer` over real
 * loopback HTTP, a real `ask` verdict, a real `permission` checkpoint row,
 * a real M4 `PolicyHoldRegistry` hold, and the real
 * `checkpoints.answerPermission` IPC handler through the real dispatcher.
 * The one substitution is a test calling that handler instead of a button,
 * and it is the same handler the button will call.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const HOLD_TOOL = 'Bash';

interface RawResponse {
  status: number;
  body: unknown;
}

function policyCheck(port: number, token: string, body: unknown): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/policy/check',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe('a permission checkpoint holds an agent and releases it when answered (§9.1, §7.10)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: ControlChannelServer;
  let policyHoldRegistry: PolicyHoldRegistry;
  let port: number;
  let token: string;
  let employeeId: string;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-permission-'));
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

    const tokenRegistry = new TokenRegistry();
    // ONE registry, shared between the server and the IPC context —
    // exactly as `main/index.ts` wires it. Two instances would each work
    // in isolation and never meet: the user would answer, the handler
    // would report success, and the agent would wait out its full hold.
    policyHoldRegistry = new PolicyHoldRegistry();
    employeeId = seedEmployee(db, { name: 'Quinn', autonomy: 'ask' }).id;
    token = tokenRegistry.mint(employeeId);

    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry: new SupervisorRegistry(),
      policyHoldRegistry,
      maxHoldMinutes: 5,
      evaluatePolicy: async (request): Promise<Verdict> =>
        request.tool === HOLD_TOOL
          ? {
              effect: 'ask',
              ruleId: 'autonomy.ask',
              reason: 'Running commands needs your say-so at this autonomy level.',
            }
          : { effect: 'allow', ruleId: 'test.allow' },
    });
    port = await server.start();

    ctx = {
      db,
      activityLog,
      dbPaths: {
        dbPath,
        migrationsDir: REAL_MIGRATIONS_DIR,
        backupsDir: path.join(tmpDir, 'backups'),
        activityLogPath: path.join(tmpDir, 'activity.jsonl'),
      },
      pricing: loadPricingYaml(path.resolve('resources/pricing.yaml')),
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
      policyHoldRegistry,
    };
  });

  afterEach(async () => {
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const answerPermission = (id: string, allow: boolean) =>
    dispatchIpcCall(
      'checkpoints:answerPermission',
      IPC_SCHEMAS.checkpoints.answerPermission,
      getHandler('checkpoints', 'answerPermission'),
      ctx,
      true,
      { id, allow },
    );

  function pendingPermission() {
    return listPendingPermissionCheckpoints(db)[0];
  }

  it('raises a real permission checkpoint, holds the agent, and ALLOWS when answered', async () => {
    const callId = newId();
    const held = policyCheck(port, token, {
      callId,
      tool: HOLD_TOOL,
      rawTool: 'Bash',
      args: {},
      preview: 'npm install express',
    });

    // The agent is genuinely held...
    expect(await waitUntil(() => policyHoldRegistry.pendingCount === 1)).toBe(true);

    // ...and a real, readable checkpoint exists for a person to answer.
    expect(await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1)).toBe(true);
    const cp = pendingPermission();
    expect(cp?.tool_call_id).toBe(callId);
    expect(cp?.tool_name).toBe(HOLD_TOOL);
    expect(cp?.args_preview).toBe('npm install express');
    expect(cp?.urgency).toBe('blocking');
    // §9.2, written for a non-expert: the sentence names who and what, not
    // the rule id that produced it.
    expect(cp?.title).toContain('Quinn');
    expect(cp?.title).toContain('npm install express');
    // The default is hardcoded deny — the one place invariant #7 is
    // structural rather than an authored claim.
    expect(cp?.default_action).toBe('deny');
    expect(cp?.options?.map((o) => o.id)).toEqual(['allow_once', 'deny']);
    for (const option of cp?.options ?? []) {
      expect(option.consequence.length).toBeGreaterThan(0);
    }
    // The row's deadline and the hold's are the same number, not two that
    // agree today: 5 minutes, from the server's own maxHoldMinutes.
    const expiresInMs = Date.parse(cp?.expires_at as string) - Date.parse(cp?.created_at as string);
    expect(expiresInMs).toBe(5 * 60_000);

    // Answer it through the real IPC handler.
    const result = await answerPermission(cp!.id, true);
    expect(result).toMatchObject({ ok: true, data: { allowed: true, holdReleased: true } });

    // The agent proceeds.
    const response = await held;
    expect(response.status).toBe(200);
    expect((response.body as { verdict: string }).verdict).toBe('allow');

    const after = getCheckpointById(db, cp!.id);
    expect(after?.status).toBe('answered');
    expect(after?.answer?.optionId).toBe('allow_once');
  });

  it('DENIES when answered no, and the agent is refused rather than left waiting', async () => {
    const callId = newId();
    const held = policyCheck(port, token, {
      callId,
      tool: HOLD_TOOL,
      rawTool: 'Bash',
      args: {},
      preview: 'rm -rf build',
    });
    expect(await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1)).toBe(true);

    const cp = pendingPermission();
    await answerPermission(cp!.id, false);

    const response = await held;
    expect((response.body as { verdict: string }).verdict).toBe('deny');
    expect(getCheckpointById(db, cp!.id)?.answer?.optionId).toBe('deny');
  });

  it('records the row as auto_resolved when the agent gives up before anyone answers', async () => {
    // The employee's process disconnecting is one of two ways a hold ends
    // without a person. The row must not stay pending afterwards, or the
    // Checkpoints view keeps asking about a tool call that is long over.
    const callId = newId();
    const controller = new AbortController();
    const held = fetch(`http://127.0.0.1:${port}/v1/policy/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        callId,
        tool: HOLD_TOOL,
        rawTool: 'Bash',
        args: {},
        preview: 'sleep 1',
      }),
      signal: controller.signal,
    }).catch(() => undefined);

    expect(await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1)).toBe(true);
    const cp = pendingPermission();

    controller.abort();
    await held;

    expect(await waitUntil(() => getCheckpointById(db, cp!.id)?.status !== 'pending')).toBe(true);
    const after = getCheckpointById(db, cp!.id);
    // `auto_resolved`, not `answered` — nobody chose this.
    expect(after?.status).toBe('auto_resolved');
    expect(after?.answer?.optionId).toBe('deny');
    expect(after?.answered_by).toBe('system:hold_expired');
  });

  it('an answer arriving after the agent gave up is refused, and says so', async () => {
    const callId = newId();
    const controller = new AbortController();
    const held = fetch(`http://127.0.0.1:${port}/v1/policy/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        callId,
        tool: HOLD_TOOL,
        rawTool: 'Bash',
        args: {},
        preview: 'sleep 1',
      }),
      signal: controller.signal,
    }).catch(() => undefined);

    expect(await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1)).toBe(true);
    const cp = pendingPermission();
    controller.abort();
    await held;
    expect(await waitUntil(() => getCheckpointById(db, cp!.id)?.status !== 'pending')).toBe(true);

    const result = await answerPermission(cp!.id, true);
    // Not a success that released nothing — the user is told plainly.
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  });

  it('reconcile cancels a permission row left pending by a previous run', async () => {
    // Holds are in-memory. A `permission` row surviving a restart has no
    // hold and no waiting agent, so it is asking about something already
    // over. NOT subject to §9.6's post-restart grace: the grace protects a
    // DECISION from being applied on the user's behalf, and nothing is
    // being decided here.
    const callId = newId();
    const controller = new AbortController();
    const held = fetch(`http://127.0.0.1:${port}/v1/policy/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        callId,
        tool: HOLD_TOOL,
        rawTool: 'Bash',
        args: {},
        preview: 'sleep 1',
      }),
      signal: controller.signal,
    }).catch(() => undefined);
    expect(await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1)).toBe(true);
    const cp = pendingPermission();

    // Simulate "the process died before it could close the row out":
    // abandon the request and put the row back to pending by hand, which
    // is exactly the state a hard kill leaves behind.
    controller.abort();
    await held;
    db.prepare(
      "UPDATE checkpoints SET status = 'pending', answer = NULL, answered_by = NULL, answered_at = NULL WHERE id = ?",
    ).run(cp!.id);

    const report = await reconcile(db, activityLog, tmpDir);
    expect(report.stalePermissionCheckpointsCancelled).toEqual([cp!.id]);

    const after = getCheckpointById(db, cp!.id);
    expect(after?.status).toBe('cancelled');
    expect(after?.answered_by).toBe('system:app_restart');

    const cancelled = db.prepare("SELECT * FROM events WHERE type = 'checkpoint.cancelled'").all();
    expect(cancelled).toHaveLength(1);
  });
});
