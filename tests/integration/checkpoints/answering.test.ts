import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { dispatchIpcCall } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { IPC_SCHEMAS } from '../../../src/shared/ipc/schemas';
import { insertCheckpoint, getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { answerCheckpoint } from '../../../src/main/checkpoints/answerCheckpoint';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { searchMemory } from '../../../src/main/memory/searchMemory';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * §9.6's answering, driven through the **real IPC handler** — the same
 * `dispatchIpcCall` + real schema + real handler M9's chat card will call,
 * with no test-only path around it.
 *
 * §9.4's four surfaces do not exist (chat card and badge are M9/M14, the
 * floor is M12, the desktop notification is session 2), so M8's gate line
 * "answered from the UI" means exactly this and is claimed as exactly
 * this. Nothing here asserts anything about a screen.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('answering a checkpoint (§9.6), through the real IPC path', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-answer-'));
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
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** The real dispatcher, real schema, real handler — nothing bypassed. */
  async function callIpc(method: 'answer' | 'answerPermission', input: unknown) {
    return dispatchIpcCall(
      `checkpoints:${method}`,
      IPC_SCHEMAS.checkpoints[method],
      getHandler('checkpoints', method),
      ctx,
      true,
      input,
    );
  }

  function eventsOfType(type: string): unknown[] {
    return db.prepare('SELECT * FROM events WHERE type = ?').all(type);
  }

  const DECISION = {
    type: 'decision' as const,
    urgency: 'soon' as const,
    title: 'Should we optimise the report for read speed?',
    context: 'The report screen is slow. Speeding it up means storing some numbers twice.',
    options: [
      {
        id: 'optimise',
        label: 'Optimise for read speed',
        consequence: 'Reports load quickly; some data is duplicated and can drift.',
        recommended: true,
      },
      {
        id: 'leave',
        label: 'Leave it as it is',
        consequence: 'Nothing changes; reports stay slow.',
      },
    ],
  };

  /**
   * The same decision, with 'leave' stated as the reversible option and named
   * as the default. X-9 ties the two together in both directions, so a
   * fixture that wants a default says both, and `DECISION` above — used by
   * the tests that never time out — says neither.
   */
  const DECISION_WITH_DEFAULT = {
    ...DECISION,
    options: [DECISION.options[0]!, { ...DECISION.options[1]!, reversible: true }],
    default_action: 'leave',
  };

  it('does all five of §9.6 for a decision with a task and an employee', async () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

    const cp = insertCheckpoint(db, activityLog, {
      ...DECISION,
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
    });
    blockTaskForCheckpoint(db, activityLog, {
      taskId: task.id,
      checkpointId: cp.id,
      detail: 'waiting on a decision',
    });

    const result = await callIpc('answer', {
      id: cp.id,
      optionId: 'optimise',
      freeText: 'Speed matters more than storage here.',
    });

    expect(result).toMatchObject({ ok: true });
    const data = (result as { ok: true; data: Record<string, unknown> }).data;

    // 1. the answer is written
    const after = getCheckpointById(db, cp.id);
    expect(after?.status).toBe('answered');
    expect(after?.answer?.optionId).toBe('optimise');
    expect(after?.answer?.freeText).toBe('Speed matters more than storage here.');
    expect(after?.answered_by).toBe('user');
    expect(after?.answered_at).not.toBeNull();

    // 2. exactly one event, actor 'user'
    const answered = eventsOfType('checkpoint.answered') as { actor: string }[];
    expect(answered).toHaveLength(1);
    expect(answered[0]?.actor).toBe('user');
    // §5.2 also lists `user.checkpoint_answered`. One state change gets one
    // event (invariant #3); `actor: 'user'` carries the rest.
    expect(eventsOfType('user.checkpoint_answered')).toHaveLength(0);
    expect(eventsOfType('checkpoint.auto_resolved')).toHaveLength(0);

    // 3. the dependent task is unblocked
    expect(getTaskById(db, task.id)?.status).toBe('assigned');
    expect(getTaskById(db, task.id)?.status_reason).toBeNull();
    expect(data['unblockedTaskId']).toBe(task.id);

    // 4. the decision is queued for the employee's next turn (§9.7)
    expect(data['queuedMessageId']).not.toBeNull();
    const message = db
      .prepare('SELECT * FROM messages WHERE id = ?')
      .get(data['queuedMessageId'] as string) as
      | { to_addr: string; kind: string; status: string; body: string; thread_id: string }
      | undefined;
    expect(message?.to_addr).toBe(`employee:${employee.id}`);
    expect(message?.kind).toBe('answer');
    expect(message?.status).toBe('pending');
    expect(message?.thread_id).toBe(cp.id);
    expect(message?.body).toContain('Optimise for read speed');
    expect(message?.body).toContain('Speed matters more than storage here.');
    expect(eventsOfType('message.sent')).toHaveLength(1);

    // 5. it becomes project memory (§12.5)
    expect(data['decisionLogged']).toBe(true);
    const decisionsPath = path.join(tmpDir, 'memory', 'project', project.id, 'decisions.md');
    expect(existsSync(decisionsPath)).toBe(true);
    const log = readFileSync(decisionsPath, 'utf8');
    expect(log).toContain('**Asked because:**');
    expect(log).toContain('**Chosen:** Optimise for read speed');
    expect(log).toContain('**Consequence:** Reports load quickly');
    expect(log).toContain('**They also said:** Speed matters more than storage here.');

    // And it is indexed, which is what makes duplicate detection and
    // §12.3's memory pack able to see it at all.
    expect(searchMemory(db, 'read speed', { scopes: ['project'] }).length).toBeGreaterThan(0);
  });

  it('appends to the decision log rather than replacing it', async () => {
    const project = seedProject(db);
    const first = insertCheckpoint(db, activityLog, { ...DECISION, project_id: project.id });
    await callIpc('answer', { id: first.id, optionId: 'leave' });

    const second = insertCheckpoint(db, activityLog, {
      ...DECISION,
      project_id: project.id,
      title: 'Should the invoice email be formal or warm?',
      context: 'Customers read this after paying, and the tone is yours to choose.',
    });
    await callIpc('answer', { id: second.id, optionId: 'optimise' });

    const log = readFileSync(
      path.join(tmpDir, 'memory', 'project', project.id, 'decisions.md'),
      'utf8',
    );
    expect(log).toContain('Should we optimise the report for read speed?');
    expect(log).toContain('Should the invoice email be formal or warm?');
  });

  it('accepts free text alone for an information checkpoint that has no options', async () => {
    // §9.2: "Free text is always accepted alongside the options" —
    // alongside, and for `information`, instead of.
    const project = seedProject(db);
    const cp = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      type: 'information',
      urgency: 'whenever',
      title: "What is the staging API's base URL?",
      context: 'Only you know this, and nothing can be tested against staging without it.',
      options: null,
    });

    const result = await callIpc('answer', {
      id: cp.id,
      freeText: 'https://staging.example.test/api',
    });
    expect(result).toMatchObject({ ok: true });
    expect(getCheckpointById(db, cp.id)?.answer?.freeText).toBe('https://staging.example.test/api');
    // Not a `decision`, so §12.5's log does not apply.
    expect((result as { data: Record<string, unknown> }).data['decisionLogged']).toBe(false);
  });

  it('refuses an answer that is neither an option nor free text', async () => {
    const cp = insertCheckpoint(db, activityLog, { ...DECISION, project_id: seedProject(db).id });
    const result = await callIpc('answer', { id: cp.id });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(getCheckpointById(db, cp.id)?.status).toBe('pending');
  });

  it('refuses an option id this checkpoint does not offer', async () => {
    const cp = insertCheckpoint(db, activityLog, { ...DECISION, project_id: seedProject(db).id });
    const result = await callIpc('answer', { id: cp.id, optionId: 'something_else' });
    expect(result).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
    expect(getCheckpointById(db, cp.id)?.status).toBe('pending');
  });

  it('queues nothing when the checkpoint has no employee behind it', async () => {
    // A budget or merge-conflict checkpoint genuinely has no addressee.
    // Reported as null rather than silently skipped, so a caller can tell
    // "nobody to tell" from "told someone".
    const cp = insertCheckpoint(db, activityLog, { ...DECISION, project_id: seedProject(db).id });
    const result = await callIpc('answer', { id: cp.id, optionId: 'leave' });
    expect((result as { data: Record<string, unknown> }).data['queuedMessageId']).toBeNull();
    expect(eventsOfType('message.sent')).toHaveLength(0);
  });

  it('does not unblock a task blocked for an unrelated reason', async () => {
    const project = seedProject(db);
    const task = seedTask(db, { project_id: project.id });
    const cp = insertCheckpoint(db, activityLog, {
      ...DECISION,
      project_id: project.id,
      task_id: task.id,
    });

    // Something else blocked it after the checkpoint was raised — an agent
    // calling `bureau_task_blocked`, say. Answering this checkpoint must
    // not clear a block it did not create.
    db.prepare("UPDATE tasks SET status = 'blocked', status_reason = ? WHERE id = ?").run(
      'ended_without_report',
      task.id,
    );

    const result = await callIpc('answer', { id: cp.id, optionId: 'leave' });
    expect(result).toMatchObject({ ok: true });
    expect(getTaskById(db, task.id)?.status).toBe('blocked');
    expect(getTaskById(db, task.id)?.status_reason).toBe('ended_without_report');
    expect((result as { data: Record<string, unknown> }).data['unblockedTaskId']).toBeNull();
  });

  // ---- the compare-and-swap ------------------------------------------

  describe('two resolvers, one row — the compare-and-swap', () => {
    // A user answering through IPC and a timeout applying the default can
    // both reach one row. Whichever lands second must be a no-op, and the
    // dangerous ordering is the plausible one: a timeout default silently
    // replacing a real answer the user just gave.

    it('a timeout after a real answer changes nothing', async () => {
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const cp = insertCheckpoint(db, activityLog, {
        ...DECISION_WITH_DEFAULT,
        project_id: project.id,
        employee_id: employee.id,
      });

      await callIpc('answer', { id: cp.id, optionId: 'optimise' });
      const late = answerCheckpoint(
        { db, activityLog, baseDir: tmpDir },
        { checkpointId: cp.id, optionId: 'leave', source: 'timeout' },
      );

      expect(late).toEqual({ ok: false, reason: 'not_pending' });
      const after = getCheckpointById(db, cp.id);
      expect(after?.status).toBe('answered');
      expect(after?.answer?.optionId).toBe('optimise');
      expect(after?.answered_by).toBe('user');

      // Presence first, then count: nothing downstream ran twice.
      expect(eventsOfType('checkpoint.answered')).toHaveLength(1);
      expect(eventsOfType('checkpoint.auto_resolved')).toHaveLength(0);
      expect(eventsOfType('message.sent')).toHaveLength(1);
    });

    it('an answer arriving after a timeout is refused, and the timeout stands', async () => {
      // The other ordering, so neither is the one that happens to work.
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const cp = insertCheckpoint(db, activityLog, {
        ...DECISION_WITH_DEFAULT,
        project_id: project.id,
        employee_id: employee.id,
      });

      answerCheckpoint(
        { db, activityLog, baseDir: tmpDir },
        { checkpointId: cp.id, optionId: 'leave', source: 'timeout' },
      );
      const late = await callIpc('answer', { id: cp.id, optionId: 'optimise' });

      expect(late).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      const after = getCheckpointById(db, cp.id);
      expect(after?.status).toBe('auto_resolved');
      expect(after?.answer?.optionId).toBe('leave');

      expect(eventsOfType('checkpoint.auto_resolved')).toHaveLength(1);
      expect(eventsOfType('checkpoint.answered')).toHaveLength(0);
      expect(eventsOfType('message.sent')).toHaveLength(1);
    });
  });
});
