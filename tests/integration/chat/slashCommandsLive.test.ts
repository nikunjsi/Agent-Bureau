import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { promoteResumableParkedEmployees } from '../../../src/main/engine/parkedEmployeeResumeTick';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';
import { hireEmployee } from '../../../src/main/company/hireEmployee';
import { DIRECTOR_ROLE_FULL_KEY } from '../../../src/main/company/directorRole';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { getEmployeeById } from '../../../src/main/db/repositories/employees';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { insertUsage } from '../../../src/main/db/repositories/usage';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { chatHandlers } from '../../../src/main/ipc/handlers/chat';
import { employeesHandlers } from '../../../src/main/ipc/handlers/employees';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';
import { startLiveIdleEmployee, waitForState } from '../../helpers/liveSupervisor';
import type { Supervisor } from '../../../src/main/engine/supervisor';
import type { ConversationMessage } from '../../../src/shared/models/conversationMessage';
import type { Employee } from '../../../src/shared/models/employee';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * §17.2's slash commands, and **the reason they exist**:
 *
 * > Slash commands are parsed in the main process before reaching the
 * > Director, **so `/pause`, `/budget` and `/status` work even when the
 * > Director is mid-generation or out of budget.**
 *
 * That sentence is the requirement, and a parser unit test cannot touch
 * it: `slashCommandParse.test.ts` proves which strings are commands and
 * says so in its own header. This file proves the *reason* — a `/pause`
 * issued with a reply genuinely streaming, and a `/budget` issued with the
 * ledger genuinely over the daily limit. Both go through the real IPC
 * dispatcher against a real database.
 */
describe('slash commands work when the Director cannot answer (§17.2)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let registry: SupervisorRegistry;
  let streams: ChatStreamRegistry;
  let ctx: HandlerContext;
  let conversationId: string;
  let live: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-slash-'));
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
    registry = new SupervisorRegistry();
    streams = new ChatStreamRegistry({ db, activityLog });
    live = [];

    const company = seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'operations' });
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
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
      supervisorRegistry: registry,
      chatStreams: streams,
    } as HandlerContext;
  });

  afterEach(async () => {
    streams.abortAll();
    await Promise.all(live.map((supervisor) => supervisor.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function send(body: string): Promise<ConversationMessage> {
    const result = await dispatchIpcCall(
      'chat:send',
      getMethodSchema('chat', 'send'),
      chatHandlers['send']!,
      ctx,
      true,
      { conversationId, body },
    );
    if (!result.ok) throw new Error(`chat.send failed: ${result.error.message}`);
    return (result as { data: { item: ConversationMessage } }).data.item;
  }

  function hire(roleKey: string): Employee {
    return hireEmployee({
      db,
      activityLog,
      companyId: (db.prepare('SELECT id FROM companies LIMIT 1').get() as { id: string }).id,
      baseDir: tmpDir,
      roleKey,
    }).employee;
  }

  async function goLive(employee: Employee): Promise<void> {
    const started = await startLiveIdleEmployee({
      db,
      activityLog,
      supervisorRegistry: registry,
      employee,
      stateDir: tmpDir,
      keepOpen: true,
    });
    live.push(started.supervisor);
  }

  function outboxCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  }

  /**
   * **The test the whole design exists for.** A stream is genuinely live in
   * this conversation — a row is sitting at `status: 'streaming'` with text
   * arriving — and `/pause` still works, because it never goes near the
   * Director.
   */
  it('/pause works while a reply is streaming into the same conversation', async () => {
    const director = hire(DIRECTOR_ROLE_FULL_KEY);
    const developer = hire('engineering:developer');
    await goLive(director);
    await goLive(developer);

    // A real reply, mid-flight. Not a flag — the production `ChatStream`,
    // the same one `chat.stop` reaches.
    const stream = streams.begin({ conversationId, author: 'director' });
    stream.append('I have started looking at');
    expect(streams.get(conversationId)).not.toBeNull();

    const echoed = await send('/pause');

    // It ran, and the stream was untouched: `/pause` stops employees,
    // `chat.stop` stops a reply, and conflating them would make one
    // button do two jobs.
    expect(streams.get(conversationId)).not.toBeNull();

    expect(echoed.author).toBe('system');
    expect(echoed.kind).toBe('text');
    // §17.2: "The parsed command is echoed into the conversation."
    expect(echoed.body).toContain('/pause');
    // The scope, in words, because `/pause` reads like a project-level
    // command and is not one.
    expect(echoed.body).toMatch(/company-wide/i);
    // And what a restart does to it, because a manual pause survives one.
    expect(echoed.body).toMatch(/reopening bureau does not lift it|outlives closing the app/i);

    // The real fact, from the rows: both are stopped.
    expect(getEmployeeById(db, director.id)?.status).toBe('parked');
    expect(getEmployeeById(db, developer.id)?.status).toBe('parked');

    // And nothing was addressed to the Director. That is the mechanism: a
    // command that produced an outbox row would be a command that queues
    // behind exactly the condition it exists to work around.
    expect(outboxCount()).toBe(0);
  });

  /**
   * The undo, and the reason it had to be built this session: nothing in
   * the renderer called `resumeEmployee`, and after a restart nothing
   * *could* — a manual pause leaves `resume_at` null, which is the one
   * thing `promoteResumableParkedEmployees` needs.
   */
  describe('/pause has an undo a user can reach', () => {
    async function resume(employeeId: string) {
      return dispatchIpcCall(
        'employees:resumeEmployee',
        getMethodSchema('employees', 'resumeEmployee'),
        employeesHandlers['resumeEmployee']!,
        ctx,
        true,
        { id: employeeId },
      );
    }

    it('while the process is still live, through Supervisor.resume()', async () => {
      const developer = hire('engineering:developer');
      await goLive(developer);
      await send('/pause');
      expect(getEmployeeById(db, developer.id)?.status).toBe('parked');

      expect((await resume(developer.id)).ok).toBe(true);
      await waitForState(registry.get(developer.id)!, 'idle');
      expect(getEmployeeById(db, developer.id)?.status).toBe('idle');
    });

    it('after a restart, when there is no process at all — the case that had NO way back', async () => {
      const developer = hire('engineering:developer');
      await goLive(developer);
      await send('/pause');
      expect(getEmployeeById(db, developer.id)?.status).toBe('parked');

      /**
       * A restart, simulated the way one actually happens.
       *
       * Deliberately **not** by calling `supervisor.stop()` first: nothing
       * stops supervisors when Bureau quits — `runShutdownSequence` drains
       * the control channel, the ticks, the streams, the log and the
       * database, and never touches them — so on both a clean quit and a
       * crash the row is left exactly as it stands. A `stop()` here would
       * write `off` and quietly test a state a restart never produces.
       *
       * What the next process genuinely sees: the same database, the row
       * still `parked`, and an **empty registry**, because nothing
       * respawns employees before M11. `reconcile()`'s own un-parker only
       * promotes rows with a `resume_at`, and a manual pause never sets
       * one — so before this session this state had no reachable undo at
       * all, in any surface the product has.
       */
      const freshRegistry = new SupervisorRegistry();
      const freshCtx = { ...ctx, supervisorRegistry: freshRegistry } as HandlerContext;
      expect(freshRegistry.get(developer.id)).toBeUndefined();
      expect(getEmployeeById(db, developer.id)?.status).toBe('parked');
      // And reconcile's un-parker is confirmed not to touch it, rather
      // than assumed: it is the thing that WOULD have been the undo.
      expect(promoteResumableParkedEmployees(db, activityLog)).toEqual([]);
      expect(getEmployeeById(db, developer.id)?.status).toBe('parked');

      const result = await dispatchIpcCall(
        'employees:resumeEmployee',
        getMethodSchema('employees', 'resumeEmployee'),
        employeesHandlers['resumeEmployee']!,
        freshCtx,
        true,
        { id: developer.id },
      );
      expect(result.ok).toBe(true);
      // `off`, not `idle`: with no process, `off` is exactly what they
      // are, and normal assignment restarts them from there.
      expect(getEmployeeById(db, developer.id)?.status).toBe('off');
      expect(getEmployeeById(db, developer.id)?.resume_at).toBeNull();
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'employee.resumed'").get(),
      ).toEqual({ n: 1 });
    });

    it('refuses honestly when nobody is paused, rather than reporting a resume that did nothing', async () => {
      const developer = hire('engineering:developer');
      const result = await resume(developer.id);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.message).toMatch(/not paused/i);
    });
  });

  /**
   * The second half of §17.2's reason. `/budget` is what a user reaches for
   * *because* something stopped, so it must not be the thing that stops.
   */
  it('/budget works when the day is genuinely over budget', async () => {
    setSetting(db, 'budgets.dailyUsd', 5);
    setSetting(db, 'budgets.directorReserveUsd', 1);
    const developer = hire('engineering:developer');
    // Real spend in the real ledger — $9.00 against a $5.00 day. Not a
    // setting that says "over budget": the sum `/budget` reads is the sum
    // enforcement reads.
    insertUsage(db, {
      employee_id: developer.id,
      task_id: null,
      engine: 'claude-code',
      source: 'turn',
      turn_index: 0,
      model: 'claude-sonnet-5',
      tokens_in: 1,
      tokens_out: 1,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      cost_usd_micros: 9_000_000,
    });

    const echoed = await send('/budget');
    expect(echoed.author).toBe('system');
    expect(echoed.body).toContain('/budget');
    expect(echoed.body).toContain('$9.00');
    expect(echoed.body).toContain('$5.00');
    // It says the day is spent, in words — the user asked because
    // something stopped, and "here are your limits" without that would be
    // an answer to a question they did not ask.
    expect(echoed.body).toMatch(/budget is gone/i);
    expect(outboxCount()).toBe(0);
  });

  it('/status answers with the roster, what is waiting, and today’s spend', async () => {
    const director = hire(DIRECTOR_ROLE_FULL_KEY);
    await goLive(director);
    const echoed = await send('/status');
    expect(echoed.body).toContain('/status');
    expect(echoed.body).toContain(director.name);
    expect(echoed.body).toMatch(/idle/);
    expect(echoed.body).toMatch(/Nothing is waiting for you/i);
  });

  it('/help lists the six and says why they are handled here', async () => {
    const echoed = await send('/help');
    for (const command of ['/status', '/pause', '/budget', '/plan', '/deliver', '/help']) {
      expect(echoed.body).toContain(command);
    }
    expect(echoed.body).toMatch(/handled by Bureau itself/i);
  });

  it('/plan and /deliver say what to do rather than failing, when there is nothing yet', async () => {
    // §14.6: what happened, why, and a concrete next action. Never a raw
    // failure and never a silent no-op.
    const plan = await send('/plan');
    expect(plan.body).toMatch(/no plan yet/i);
    expect(plan.body).toMatch(/Director/);

    const deliver = await send('/deliver');
    expect(deliver.body).toMatch(/nothing to deliver yet/i);
  });

  /**
   * §17.2: "Unrecognised slashes are passed through as ordinary text." The
   * consequence, at the level that matters: it becomes a `user` message
   * addressed to the Director, not a `system` echo and not an error.
   */
  it('an unrecognised slash is an ordinary message to the Director', async () => {
    const message = await send('check /tmp/foo.log for the stack trace');
    expect(message.author).toBe('user');
    expect(message.body).toBe('check /tmp/foo.log for the stack trace');
    expect(outboxCount()).toBe(1);
    expect((db.prepare('SELECT to_addr FROM messages').get() as { to_addr: string }).to_addr).toBe(
      'director',
    );
  });
});
