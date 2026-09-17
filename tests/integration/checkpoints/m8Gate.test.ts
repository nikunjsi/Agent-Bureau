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
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import {
  insertCheckpoint,
  getCheckpointById,
  listPendingCheckpoints,
  listPendingPermissionCheckpoints,
} from '../../../src/main/db/repositories/checkpoints';
import { getOutboxMessageById } from '../../../src/main/db/repositories/messages';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { startCheckpointsTick } from '../../../src/main/checkpoints/checkpointsTick';
import { CheckpointSurfacer } from '../../../src/main/checkpoints/surfacing';
import type { CheckpointNotifier } from '../../../src/main/checkpoints/surfacing';
import { startMessageRouter } from '../../../src/main/messages/router';
import { fireEmployee } from '../../../src/main/company/fireEmployee';
import { seedCompany } from '../../helpers/companyFixture';
import { handleSendMessage } from '../../../src/main/controlChannel/toolHandlers/sendMessage';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import { newId } from '../../../src/shared/models/ids';
import type { Verdict } from '../../../src/shared/policy/types';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * **§28's M8 gate, all three lines, run here rather than cited.**
 *
 *   1. A permission checkpoint holds an agent, is answered, and the agent
 *      proceeds. (Session 1 proved this; §28's gate is a milestone
 *      statement, so it is re-run as part of the milestone closing.)
 *   2. An unanswered blocking checkpoint resolves safely.
 *   3. A question to a dead employee ends in a blocker checkpoint, not
 *      silence.
 *
 * "Answered from the UI" is met at the real IPC handler M9's card will
 * call — there is no screen in any milestone before M9, and nothing here
 * pretends otherwise.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const HOUR_MS = 60 * 60 * 1000;

const SILENT_NOTIFIER: CheckpointNotifier = {
  isAnyWindowFocused: () => true,
  notify: () => undefined,
};

function policyCheck(
  port: number,
  token: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
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
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('M8 gate (§28)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let policyHoldRegistry: PolicyHoldRegistry;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m8-gate-'));
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
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    policyHoldRegistry = new PolicyHoldRegistry();
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
      supervisorRegistry,
    };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1 — a permission checkpoint holds an agent, is answered, and the agent proceeds', async () => {
    const employee = seedEmployee(db, { name: 'Ravi', autonomy: 'ask' });
    const token = tokenRegistry.mint(employee.id);
    const server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      policyHoldRegistry,
      maxHoldMinutes: 5,
      evaluatePolicy: async (request): Promise<Verdict> =>
        request.tool === 'Bash'
          ? {
              effect: 'ask',
              ruleId: 'autonomy.ask',
              reason: 'Running commands needs your say-so at this autonomy level.',
            }
          : { effect: 'allow', ruleId: 'test.allow' },
    });
    const port = await server.start();

    try {
      const callId = newId();
      // A real agent request over real loopback HTTP, left in flight.
      const held = policyCheck(port, token, {
        callId,
        tool: 'Bash',
        rawTool: 'Bash',
        args: {},
        preview: 'npm install express',
      });

      await waitUntil(() => policyHoldRegistry.pendingCount === 1);
      await waitUntil(() => listPendingPermissionCheckpoints(db).length === 1);
      const checkpoint = listPendingPermissionCheckpoints(db)[0];
      expect(checkpoint?.tool_call_id).toBe(callId);
      expect(checkpoint?.default_action).toBe('deny');

      const answered = await dispatchIpcCall(
        'checkpoints:answerPermission',
        IPC_SCHEMAS.checkpoints.answerPermission,
        getHandler('checkpoints', 'answerPermission'),
        ctx,
        true,
        { id: checkpoint?.id, allow: true },
      );
      expect(answered).toMatchObject({ ok: true, data: { allowed: true, holdReleased: true } });

      // The agent proceeds — the held HTTP request comes back allow.
      const response = await held;
      expect(response.status).toBe(200);
      expect((response.body as { verdict: string }).verdict).toBe('allow');
    } finally {
      await server.stop();
    }
  });

  it('2 — an unanswered blocking checkpoint resolves to its safe default', () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'approval',
      urgency: 'blocking',
      title: 'Push the finished work to GitHub?',
      context: 'The work is done locally. Pushing publishes it where other people can see it.',
      options: [
        {
          id: 'push',
          label: 'Push to GitHub',
          consequence: 'The branch is published and cannot be un-published.',
        },
        {
          id: 'hold',
          reversible: true,
          label: 'Keep it local',
          consequence: 'Nothing leaves this machine. You can push at any time later.',
          recommended: true,
        },
      ],
      default_action: 'hold',
    });
    blockTaskForCheckpoint(db, activityLog, {
      taskId: task.id,
      checkpointId: checkpoint.id,
      detail: 'waiting on a push approval',
    });
    expect(getTaskById(db, task.id)?.status).toBe('blocked');

    db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - HOUR_MS).toISOString(),
      checkpoint.id,
    );

    // The real tick `main/index.ts` starts, past the post-restart grace. The
    // grace is measured on a monotonic clock (P-3), so the hour of uptime is
    // given to that clock, not only to the wall-clock start.
    let monotonic = 0;
    const tick = startCheckpointsTick(
      { db, activityLog, baseDir: tmpDir },
      new CheckpointSurfacer(db, { activityLog }),
      SILENT_NOTIFIER,
      Date.now() - HOUR_MS,
      999_999,
      () => monotonic,
    );
    try {
      monotonic = HOUR_MS;
      tick.runNow();
    } finally {
      tick.stop();
    }

    const resolved = getCheckpointById(db, checkpoint.id);
    expect(resolved?.status).toBe('auto_resolved');
    expect(resolved?.answer?.optionId).toBe('hold');
    expect(resolved?.answer?.optionId).not.toBe('push');
    // Safely: the task is released, and nothing irreversible happened.
    expect(getTaskById(db, task.id)?.status).not.toBe('blocked');
  });

  it('3 — a question to a dead employee ends in a blocker checkpoint, not silence', async () => {
    const project = seedProject(db);
    const asker = seedEmployee(db, { name: 'Meera' });
    const target = seedEmployee(db, { name: 'Ravi' });
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: asker.id });
    db.prepare('UPDATE employees SET current_task_id = ? WHERE id = ?').run(task.id, asker.id);

    // A real question, written by the real `bureau_send_message` handler an
    // agent calls — not an insert crafted by the test.
    const sent = handleSendMessage(
      {
        db,
        activityLog,
        employeeId: asker.id,
        idempotencyKey: newId(),
        baseDir: tmpDir,
      } as never,
      {
        to: `employee:${target.id}`,
        kind: 'question',
        subject: 'Which database?',
        body: 'Postgres or SQLite for the orders table? I am blocked on this.',
      },
    ) as { ok: boolean; data?: { messageId: string } };
    expect(sent.ok).toBe(true);
    const messageId = sent.data?.messageId as string;

    // Ravi is let go, through the real M7 path — archived, not deleted,
    // which is exactly why the row still exists and why the row existing
    // is not evidence anyone is there to read this.
    const company = seedCompany(db, tmpDir);
    await fireEmployee({ db, activityLog, companyId: company.id, employeeId: target.id });

    // The real router, started the way `main/index.ts` starts it.
    const router = startMessageRouter(
      { db, activityLog, supervisorRegistry, appStartedAtMs: Date.now() },
      20,
    );
    try {
      await waitUntil(() => getOutboxMessageById(db, messageId)?.status === 'dead_letter');
    } finally {
      router.stop();
    }

    // Not silence: an event, and a checkpoint a person will actually see.
    const deadLettered = db
      .prepare("SELECT payload FROM events WHERE type = 'message.dead_lettered'")
      .all() as { payload: string | null }[];
    expect(deadLettered).toHaveLength(1);

    const pending = listPendingCheckpoints(db);
    expect(pending).toHaveLength(1);
    const blocker = pending[0];
    expect(blocker?.type).toBe('blocker');
    expect(blocker?.urgency).toBe('blocking');
    expect(blocker?.employee_id).toBe(asker.id);
    expect(blocker?.title).toContain('Meera');
    expect(JSON.stringify(blocker?.preview)).toContain('Postgres or SQLite');
    // It cannot quietly time out — the question already went missing once.
    expect(blocker?.expires_at).toBeNull();

    // And it surfaces: unfocused + blocking is §9.4's rule, so a person
    // gets told rather than having to go looking.
    const shown: string[] = [];
    new CheckpointSurfacer(db, { activityLog }).surface({
      notifier: {
        isAnyWindowFocused: () => false,
        notify: ({ title }) => shown.push(title),
      },
      nowMs: Date.now(),
    });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Meera');
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
