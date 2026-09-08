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
import {
  insertOutboxMessage,
  getOutboxMessageById,
} from '../../../src/main/db/repositories/messages';
import { getEmployeeById, archiveEmployee } from '../../../src/main/db/repositories/employees';
import { routeOnce, startMessageRouter } from '../../../src/main/messages/router';
import type { MessageRouterDeps } from '../../../src/main/messages/router';
import { seedEmployee, seedRole, seedProject, seedTask } from '../../helpers/dbFixtures';
import { startLiveIdleEmployee } from '../../helpers/liveSupervisor';
import type { Supervisor } from '../../../src/main/engine/supervisor';
import type { Employee } from '../../../src/shared/models/employee';
import { newId } from '../../../src/shared/models/ids';

/**
 * §9.7's router, against real rows, a real `Supervisor` and the real §7.4
 * `send()` an employee would actually receive.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('the message router (§9.7)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let supervisorRegistry: SupervisorRegistry;
  let deps: MessageRouterDeps;
  let liveSupervisors: Supervisor[];
  let appStartedAtMs: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-router-'));
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
    appStartedAtMs = Date.now();
    deps = { db, activityLog, supervisorRegistry, appStartedAtMs };
  });

  afterEach(async () => {
    await Promise.all(liveSupervisors.map((s) => s.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function goLive(
    employee: Employee,
  ): Promise<{ adapter: import('../../../src/main/engine/fakeAdapter').FakeAdapter }> {
    const live = await startLiveIdleEmployee({
      db,
      activityLog,
      supervisorRegistry,
      employee,
      stateDir: tmpDir,
    });
    liveSupervisors.push(live.supervisor);
    return { adapter: live.adapter };
  }

  function queue(to: string, overrides: Record<string, unknown> = {}) {
    return insertOutboxMessage(db, {
      idempotency_key: newId(),
      from_addr: 'system',
      to_addr: to,
      kind: 'handoff',
      subject: 'A handoff',
      body: 'Please take this over.',
      ...overrides,
    });
  }

  function eventsOfType(type: string): { payload: string | null }[] {
    return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type) as {
      payload: string | null;
    }[];
  }

  describe('delivery to a live, idle employee', () => {
    it("sends through the real adapter as kind 'message', then marks the row delivered", async () => {
      const employee = seedEmployee(db);
      const { adapter } = await goLive(employee);
      const message = queue(`employee:${employee.id}`);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      expect(report.delivered).toEqual([message.id]);
      // §9.7 names the call: `adapter.send(body, 'message')`.
      expect(adapter.sentMessages.map((s) => s.kind)).toContain('message');
      const sent = adapter.sentMessages.find((s) => s.kind === 'message');
      expect(sent?.text).toContain('Please take this over.');
      // It went out at a real turn boundary, not into the §7.4 queue.
      expect(sent?.delivery).toBe('immediate');

      const row = getOutboxMessageById(db, message.id);
      expect(row?.status).toBe('delivered');
      expect(row?.delivered_at).not.toBeNull();
      expect(row?.resolved_employee_id).toBe(employee.id);
      // Not consumed yet — the employee has not started a turn (§9.7).
      expect(row?.consumed_at).toBeNull();

      expect(eventsOfType('message.delivered')).toHaveLength(1);
    });

    it('delivers a bare-id address, which is what an agent actually writes', async () => {
      const employee = seedEmployee(db);
      await goLive(employee);
      const message = queue(employee.id);

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.delivered).toEqual([message.id]);
    });

    it('picks up a row whose next_attempt_at is NULL — the state every agent-sent message is in', async () => {
      // `bureau_send_message` and `bureau_ask_director` have inserted rows
      // with `next_attempt_at: null` since M4. §9.7's literal query
      // (`next_attempt_at <= now`) never matches NULL, so written that way
      // the router would have ignored every message an agent ever sent.
      const employee = seedEmployee(db);
      await goLive(employee);
      const message = queue(`employee:${employee.id}`, { next_attempt_at: null });
      expect(getOutboxMessageById(db, message.id)?.next_attempt_at).toBeNull();

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.delivered).toEqual([message.id]);
    });

    it('delivers higher priority first — §9.7 orders by priority DESC', async () => {
      const employee = seedEmployee(db);
      const { adapter } = await goLive(employee);
      queue(`employee:${employee.id}`, { priority: 10, body: 'low priority' });
      queue(`employee:${employee.id}`, { priority: 90, body: 'high priority' });

      await routeOnce(deps, { nowMs: Date.now() });

      const bodies = adapter.sentMessages.filter((s) => s.kind === 'message').map((s) => s.text);
      expect(bodies).toHaveLength(2);
      // Presence before ordering (standing rule 3): an ordering assertion
      // over a missing element passes for the wrong reason.
      expect(bodies.some((b) => b.includes('high priority'))).toBe(true);
      expect(bodies.some((b) => b.includes('low priority'))).toBe(true);
      expect(bodies[0]).toContain('high priority');
    });
  });

  describe('consumption is recorded by the supervisor, not the agent (§9.7)', () => {
    it('marks consumed on the next real turn.started, and emits one message.consumed', async () => {
      const employee = seedEmployee(db);
      const live = await startLiveIdleEmployee({
        db,
        activityLog,
        supervisorRegistry,
        employee,
        stateDir: tmpDir,
        // The stream stays open so the next turn can be driven AFTER the
        // router has delivered — the employee starting its next turn is
        // what consumption MEANS, so it cannot be scripted up front.
        keepOpen: true,
      });
      liveSupervisors.push(live.supervisor);
      const message = queue(`employee:${employee.id}`);

      await routeOnce(deps, { nowMs: Date.now() });
      expect(getOutboxMessageById(db, message.id)?.status).toBe('delivered');
      expect(getOutboxMessageById(db, message.id)?.consumed_at).toBeNull();

      // The real turn boundary. Pushed through the adapter's own event
      // stream so the Supervisor's production handler runs, not a direct
      // call to a private method.
      live.adapter.pushEvent({ t: 'turn.started', turnIndex: 1 });
      await waitUntil(() => getOutboxMessageById(db, message.id)?.status === 'consumed');

      const row = getOutboxMessageById(db, message.id);
      expect(row?.status).toBe('consumed');
      expect(row?.consumed_at).not.toBeNull();
      const consumedEvents = eventsOfType('message.consumed');
      expect(consumedEvents).toHaveLength(1);
      expect(JSON.parse(consumedEvents[0]?.payload ?? 'null')).toEqual({ messageId: message.id });
    });
  });

  describe('a target that is off is HELD, not started (§9.7)', () => {
    it('holds with target_not_running, writes nothing at all, and never starts the employee', async () => {
      const employee = seedEmployee(db, { status: 'off' });
      // Deliberately NOT made live: no Supervisor registered, exactly as
      // for an employee that is switched off.
      const message = queue(`employee:${employee.id}`);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      // Assert the BRANCH, not just the outcome: several paths leave a row
      // pending, and only one of them is the rule under test.
      expect(report.held).toEqual([{ messageId: message.id, reason: 'target_not_running' }]);
      expect(report.delivered).toEqual([]);
      expect(report.deadLettered).toEqual([]);

      // "Bureau never spends money to deliver a message."
      expect(getEmployeeById(db, employee.id)?.status).toBe('off');
      expect(supervisorRegistry.get(employee.id)).toBeUndefined();

      // Nothing was written. A hold that consumed retry budget would
      // dead-letter this message in ~43 minutes.
      const row = getOutboxMessageById(db, message.id);
      expect(row?.status).toBe('pending');
      expect(row?.attempts).toBe(0);
      expect(row?.next_attempt_at).toBeNull();
      expect(row?.delivered_at).toBeNull();
      expect(eventsOfType('message.failed')).toEqual([]);
      expect(eventsOfType('message.dead_lettered')).toEqual([]);
    });

    it('stays held across many passes, then delivers when the employee starts', async () => {
      const employee = seedEmployee(db, { status: 'off' });
      const message = queue(`employee:${employee.id}`);

      for (let pass = 0; pass < 8; pass += 1) {
        const report = await routeOnce(deps, { nowMs: Date.now() });
        expect(report.held).toHaveLength(1);
      }
      // Eight passes is more attempts than §9.7's six-rung ladder allows.
      // A held message must not have consumed any of them.
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(0);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('pending');

      const { adapter } = await goLive(getEmployeeById(db, employee.id) as Employee);
      const report = await routeOnce(deps, { nowMs: Date.now() });

      expect(report.delivered).toEqual([message.id]);
      expect(adapter.sentMessages.some((s) => s.kind === 'message')).toBe(true);
    });

    it('holds a live employee that is mid-turn rather than injecting into it', async () => {
      const employee = seedEmployee(db);
      const live = await startLiveIdleEmployee({
        db,
        activityLog,
        supervisorRegistry,
        employee,
        stateDir: tmpDir,
        keepOpen: true,
      });
      liveSupervisors.push(live.supervisor);
      const message = queue(`employee:${employee.id}`);

      live.adapter.pushEvent({ t: 'turn.started', turnIndex: 1 });
      await waitUntil(() => live.supervisor.currentState === 'working');

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.held).toEqual([{ messageId: message.id, reason: 'target_mid_turn' }]);
      expect(live.adapter.sentMessages.some((s) => s.kind === 'message')).toBe(false);
    });
  });

  describe('role:<key> resolves to the least-loaded idle employee (§9.7)', () => {
    it('picks the idle employee with fewest live tasks, with a busier idle one present', async () => {
      const role = seedRole(db, { key: `dev-${newId()}` });
      const project = seedProject(db);
      const busy = seedEmployee(db, { role_key: role.full_key, name: `Busy-${newId()}` });
      const free = seedEmployee(db, { role_key: role.full_key, name: `Free-${newId()}` });

      // Two live tasks on `busy`, none on `free`. Both employees are idle:
      // "idle" and "unloaded" are genuinely different questions.
      seedTask(db, {
        project_id: project.id,
        assignee_employee_id: busy.id,
        status: 'assigned',
      });
      seedTask(db, {
        project_id: project.id,
        assignee_employee_id: busy.id,
        status: 'blocked',
      });

      const busyLive = await goLive(busy);
      const freeLive = await goLive(free);
      const message = queue(`role:${role.full_key}`);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      expect(report.delivered).toEqual([message.id]);
      // WHICH one, not just that one was chosen.
      expect(getOutboxMessageById(db, message.id)?.resolved_employee_id).toBe(free.id);
      expect(freeLive.adapter.sentMessages.some((s) => s.kind === 'message')).toBe(true);
      expect(busyLive.adapter.sentMessages.some((s) => s.kind === 'message')).toBe(false);
    });

    it('holds when the role exists but nobody is idle — the Director-notify seam', async () => {
      const role = seedRole(db, { key: `dev-${newId()}` });
      seedEmployee(db, { role_key: role.full_key, status: 'off' });
      const message = queue(`role:${role.full_key}`);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      // §9.7: "the message is held and the Director is notified so it can
      // propose a hire — it does not silently vanish." There is no Director
      // until M11; the hold and its reason are what a restart report will
      // read, and the row is untouched.
      expect(report.held).toEqual([{ messageId: message.id, reason: 'no_idle_employee_for_role' }]);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('pending');
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(0);
    });

    it('holds a message to the Director, because no Director employee exists yet', async () => {
      const message = queue('director', { kind: 'question' });

      const report = await routeOnce(deps, { nowMs: Date.now() });

      // Deliberately a hold and not a dead letter: `hireEmployee` hardcodes
      // `is_director: false`, so nothing creates one — but M11 will, and
      // dead-lettering a target that is going to exist would raise a
      // blocker checkpoint for every `bureau_ask_director` call in the
      // meantime.
      expect(report.held).toEqual([{ messageId: message.id, reason: 'no_director_yet' }]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM checkpoints').get()).toEqual({ n: 0 });
    });
  });

  describe('single-flight', () => {
    it('two overlapping passes deliver the message exactly once', async () => {
      const employee = seedEmployee(db);
      const { adapter } = await goLive(employee);
      queue(`employee:${employee.id}`);

      const router = startMessageRouter(deps, 999_999);
      try {
        // Both start before either finishes. Without the guard both select
        // the same pending row and both send.
        await Promise.all([router.runNow(), router.runNow()]);
      } finally {
        router.stop();
      }

      expect(adapter.sentMessages.filter((s) => s.kind === 'message')).toHaveLength(1);
    });
  });

  describe('the tick is the trigger — there is no signal', () => {
    it('a started router delivers with nothing ever signalling it', async () => {
      const employee = seedEmployee(db);
      const { adapter } = await goLive(employee);
      const message = queue(`employee:${employee.id}`);

      // §9.7's in-process signal is deliberately not built. The real
      // `setInterval` is the only trigger, so this drives the production
      // starter rather than `routeOnce` directly.
      const router = startMessageRouter(deps, 20);
      try {
        await waitUntil(() => getOutboxMessageById(db, message.id)?.status === 'delivered');
      } finally {
        router.stop();
      }
      expect(adapter.sentMessages.some((s) => s.kind === 'message')).toBe(true);
    });
  });

  describe('at-least-once: a delivery a dead process never consumed is requeued', () => {
    it('requeues a previous run’s unconsumed delivery, once, and redelivers it', async () => {
      const employee = seedEmployee(db);
      // A row exactly as a previous run would have left it: delivered
      // before this process started, never consumed, no live supervisor.
      const message = insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: 'system',
        to_addr: `employee:${employee.id}`,
        resolved_employee_id: employee.id,
        kind: 'answer',
        body: 'The decision was Postgres.',
        status: 'pending',
      });
      db.prepare(
        `UPDATE messages SET status='delivered', delivered_at=?, updated_at=? WHERE id=?`,
      ).run(new Date(appStartedAtMs - 60_000).toISOString(), new Date().toISOString(), message.id);

      const { adapter } = await goLive(employee);
      const report = await routeOnce(deps, { nowMs: Date.now() });

      expect(report.requeued).toEqual([message.id]);
      expect(report.delivered).toEqual([message.id]);
      expect(adapter.sentMessages.some((s) => s.text.includes('Postgres'))).toBe(true);

      // Bounded: the redelivery's own `delivered_at` is after this process
      // started, so a second pass does not requeue it again.
      const second = await routeOnce(deps, { nowMs: Date.now() });
      expect(second.requeued).toEqual([]);
    });

    it("never requeues THIS process's own unconsumed delivery — that is what stops a loop", async () => {
      const employee = seedEmployee(db);
      await goLive(employee);
      const message = queue(`employee:${employee.id}`);

      // A completely normal delivery: it is unconsumed the instant it
      // lands, because the employee has not taken its next turn yet. If
      // "unconsumed" alone were the trigger, the router would redeliver
      // this on its very next pass, forever.
      await routeOnce(deps, { nowMs: Date.now() });
      expect(getOutboxMessageById(db, message.id)?.status).toBe('delivered');
      expect(getOutboxMessageById(db, message.id)?.consumed_at).toBeNull();

      const second = await routeOnce(deps, { nowMs: Date.now() });
      expect(second.requeued).toEqual([]);
      expect(second.delivered).toEqual([]);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('delivered');
    });

    it('leaves a fired employee’s unconsumed delivery as the record of what was handed over', async () => {
      const employee = seedEmployee(db);
      const message = insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: 'system',
        to_addr: `employee:${employee.id}`,
        resolved_employee_id: employee.id,
        kind: 'answer',
        body: 'x',
      });
      db.prepare(
        `UPDATE messages SET status='delivered', delivered_at=?, updated_at=? WHERE id=?`,
      ).run(new Date(appStartedAtMs - 60_000).toISOString(), new Date().toISOString(), message.id);
      archiveEmployee(db, employee.id);

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.requeued).toEqual([]);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('delivered');
    });
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
