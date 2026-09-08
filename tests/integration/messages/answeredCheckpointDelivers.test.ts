import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { dispatchIpcCall } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { IPC_SCHEMAS } from '../../../src/shared/ipc/schemas';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { getOutboxMessageById } from '../../../src/main/db/repositories/messages';
import { startMessageRouter } from '../../../src/main/messages/router';
import type { MessageRouterDeps } from '../../../src/main/messages/router';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import { startLiveIdleEmployee } from '../../helpers/liveSupervisor';
import type { Supervisor } from '../../../src/main/engine/supervisor';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * **The join between M8's two sessions, and nothing has ever exercised it.**
 *
 * Session 1 made answering write a `messages` row and deliberately built no
 * delivery path (`docs/NEXT-VERSION.md` §I.4 records exactly that). Session
 * 2 built the router. Each half has its own tests; this is the only test
 * that runs both, end to end:
 *
 *   a real checkpoint → the real `checkpoints.answer` IPC handler through
 *   the real dispatcher → the outbox row session 1 writes → the real
 *   started router → `adapter.send(body, 'message')` on a real `Supervisor`
 *   over a real adapter.
 *
 * Nothing here reimplements a step of that chain (standing rule 1). The
 * only thing faked is the engine process.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('an answered checkpoint actually reaches the employee (§9.6 → §9.7)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let supervisorRegistry: SupervisorRegistry;
  let ctx: HandlerContext;
  let routerDeps: MessageRouterDeps;
  let liveSupervisors: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-join-'));
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
    supervisorRegistry = new SupervisorRegistry();
    liveSupervisors = [];
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
    };
    routerDeps = { db, activityLog, supervisorRegistry, appStartedAtMs: Date.now() };
  });

  afterEach(async () => {
    await Promise.all(liveSupervisors.map((s) => s.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answer → outbox → router → the employee genuinely receives the decision', async () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });
    const live = await startLiveIdleEmployee({
      db,
      activityLog,
      supervisorRegistry,
      employee,
      stateDir: tmpDir,
      keepOpen: true,
    });
    liveSupervisors.push(live.supervisor);

    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'decision',
      urgency: 'soon',
      title: 'Should the reports load faster, at the cost of storing some numbers twice?',
      context:
        'The report screen is slow. Speeding it up means keeping some totals in two places, ' +
        'which can briefly disagree after an edit.',
      options: [
        {
          id: 'optimise',
          label: 'Make reports fast',
          consequence:
            'Reports load instantly; some numbers are stored twice and can briefly disagree.',
          recommended: true,
        },
        {
          id: 'leave',
          label: 'Leave it as it is',
          consequence: 'Nothing changes; reports stay slow but are always exactly right.',
        },
      ],
      default_action: 'leave',
    });

    // The real handler M9's chat card will call, through the real
    // dispatcher and the real schema.
    const answered = (await dispatchIpcCall(
      'checkpoints:answer',
      IPC_SCHEMAS.checkpoints.answer,
      getHandler('checkpoints', 'answer'),
      ctx,
      true,
      { id: checkpoint.id, optionId: 'optimise', freeText: 'Ship it behind a flag.' },
    )) as { ok: boolean; data?: { queuedMessageId: string | null } };

    expect(answered.ok).toBe(true);
    const messageId = answered.data?.queuedMessageId;
    expect(messageId, 'session 1 writes the outbox row here').toBeTruthy();
    // The state session 1 left the system in: written, and undelivered.
    expect(getOutboxMessageById(db, messageId as string)?.status).toBe('pending');
    expect(live.adapter.sentMessages.some((s) => s.kind === 'message')).toBe(false);

    // The real periodic router, started the way `main/index.ts` starts it.
    const router = startMessageRouter(routerDeps, 20);
    try {
      await waitUntil(() => getOutboxMessageById(db, messageId as string)?.status === 'delivered');
    } finally {
      router.stop();
    }

    const sent = live.adapter.sentMessages.find((s) => s.kind === 'message');
    expect(sent, 'the employee received the decision through send(_, "message")').toBeDefined();
    expect(sent?.text).toContain('Make reports fast');
    // The consequence travels with the decision — the employee is told what
    // the choice means, not just which label was picked.
    expect(sent?.text).toContain('some numbers are stored twice');
    // §9.2's free text is not dropped on the way.
    expect(sent?.text).toContain('Ship it behind a flag.');

    // And the employee consuming it is the supervisor's record, not the
    // agent's claim.
    live.adapter.pushEvent({ t: 'turn.started', turnIndex: 1 });
    await waitUntil(() => getOutboxMessageById(db, messageId as string)?.status === 'consumed');
    expect(getOutboxMessageById(db, messageId as string)?.consumed_at).not.toBeNull();
  });

  it('an answer given while the employee is off is held, then delivered when it starts', async () => {
    // §9.7's whole reason for the outbox, and session 1's stated reason for
    // refusing a direct `Supervisor.injectMessage`: for a `soon` or
    // `whenever` checkpoint answered hours later, the employee being off is
    // the normal case, not the edge one.
    const project = seedProject(db);
    const employee = seedEmployee(db, { status: 'off' });
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'decision',
      urgency: 'whenever',
      title: 'Which database should the orders service use?',
      context: 'Both work. One is easier to run; the other handles more traffic later.',
      options: [
        { id: 'postgres', label: 'Postgres', consequence: 'More setup now, more headroom later.' },
        { id: 'sqlite', label: 'SQLite', consequence: 'Nothing to run; harder to scale later.' },
      ],
      default_action: 'sqlite',
    });

    const answered = (await dispatchIpcCall(
      'checkpoints:answer',
      IPC_SCHEMAS.checkpoints.answer,
      getHandler('checkpoints', 'answer'),
      ctx,
      true,
      { id: checkpoint.id, optionId: 'postgres' },
    )) as { ok: boolean; data?: { queuedMessageId: string | null } };
    const messageId = answered.data?.queuedMessageId as string;

    const router = startMessageRouter(routerDeps, 10);
    try {
      // Several real passes go by with the employee off. The answer is not
      // lost, not retried into a dead letter, and no engine is started.
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(getOutboxMessageById(db, messageId)?.status).toBe('pending');
      expect(getOutboxMessageById(db, messageId)?.attempts).toBe(0);
      expect(supervisorRegistry.get(employee.id)).toBeUndefined();

      const live = await startLiveIdleEmployee({
        db,
        activityLog,
        supervisorRegistry,
        employee,
        stateDir: tmpDir,
      });
      liveSupervisors.push(live.supervisor);

      await waitUntil(() => getOutboxMessageById(db, messageId)?.status === 'delivered');
      expect(live.adapter.sentMessages.find((s) => s.kind === 'message')?.text).toContain(
        'Postgres',
      );
    } finally {
      router.stop();
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
