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
import { archiveEmployee } from '../../../src/main/db/repositories/employees';
import { listPendingCheckpoints } from '../../../src/main/db/repositories/checkpoints';
import { routeOnce, DELIVERY_BACKOFF_MS } from '../../../src/main/messages/router';
import type { MessageRouterDeps } from '../../../src/main/messages/router';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import { startLiveIdleEmployee } from '../../helpers/liveSupervisor';
import type { Supervisor } from '../../../src/main/engine/supervisor';
import { newId } from '../../../src/shared/models/ids';

/**
 * §9.7's retry ladder and dead letter, and the blocker checkpoint a lost
 * question raises — "a question that silently disappeared is the worst
 * possible outcome."
 *
 * Two roads reach the dead letter and both are driven here: exhausted
 * retries, and an address no amount of waiting can fix.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

describe('retry, dead letter, and the blocker a lost question raises (§9.7)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let supervisorRegistry: SupervisorRegistry;
  let deps: MessageRouterDeps;
  let liveSupervisors: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-deadletter-'));
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
    deps = { db, activityLog, supervisorRegistry, appStartedAtMs: Date.now() };
  });

  afterEach(async () => {
    await Promise.all(liveSupervisors.map((s) => s.stop()));
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function eventsOfType(type: string): { payload: string | null }[] {
    return db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq').all(type) as {
      payload: string | null;
    }[];
  }

  describe('the ladder, walked for real', () => {
    it('backs off 5s → 30s → 2m → 10m → 30m and then dead-letters', async () => {
      const employee = seedEmployee(db);
      const live = await startLiveIdleEmployee({
        db,
        activityLog,
        supervisorRegistry,
        employee,
        stateDir: tmpDir,
      });
      liveSupervisors.push(live.supervisor);
      // A real failing send: `stop()` makes the real FakeAdapter's own
      // `send()` throw ("this adapter instance is no longer usable"), which
      // is a genuine adapter-level failure rather than a stubbed rejection.
      // The supervisor stays registered and idle, so the router still
      // chooses to deliver and the failure happens where a real one would.
      await live.adapter.stop();

      const message = insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: 'system',
        to_addr: `employee:${employee.id}`,
        kind: 'handoff',
        body: 'take this over',
      });

      // Each pass is driven at the exact instant the previous pass said the
      // next attempt was due, so the ladder is walked rather than skipped.
      let nowMs = Date.now();
      const observedDelays: number[] = [];
      for (let rung = 0; rung < DELIVERY_BACKOFF_MS.length; rung += 1) {
        const report = await routeOnce(deps, { nowMs });
        expect(report.retried).toHaveLength(1);
        const next = Date.parse(report.retried[0]?.nextAttemptAt as string);
        observedDelays.push(next - nowMs);
        expect(getOutboxMessageById(db, message.id)?.attempts).toBe(rung + 1);
        expect(getOutboxMessageById(db, message.id)?.status).toBe('pending');
        nowMs = next;
      }

      expect(observedDelays).toEqual([...DELIVERY_BACKOFF_MS]);
      expect(eventsOfType('message.failed')).toHaveLength(5);

      // The sixth attempt has no rung left.
      const final = await routeOnce(deps, { nowMs });
      expect(final.deadLettered).toEqual([message.id]);
      expect(final.retried).toEqual([]);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('dead_letter');
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(6);
      expect(eventsOfType('message.dead_lettered')).toHaveLength(1);
    });

    it('does not attempt a message before its next_attempt_at is due', async () => {
      const employee = seedEmployee(db);
      const live = await startLiveIdleEmployee({
        db,
        activityLog,
        supervisorRegistry,
        employee,
        stateDir: tmpDir,
      });
      liveSupervisors.push(live.supervisor);
      await live.adapter.stop();

      const message = insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: 'system',
        to_addr: `employee:${employee.id}`,
        kind: 'handoff',
        body: 'x',
      });

      const nowMs = Date.now();
      await routeOnce(deps, { nowMs });
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(1);

      // One second later — well inside the 5s first rung.
      const report = await routeOnce(deps, { nowMs: nowMs + 1_000 });
      expect(report.retried).toEqual([]);
      expect(report.held).toEqual([]);
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(1);
    });
  });

  describe('a question to a dead employee ends in a blocker checkpoint, not silence', () => {
    it('dead-letters immediately and raises a blocker addressed to the sender', async () => {
      const project = seedProject(db);
      const asker = seedEmployee(db, { name: `Asker-${newId()}` });
      const target = seedEmployee(db, { name: `Target-${newId()}` });
      const task = seedTask(db, { project_id: project.id, assignee_employee_id: asker.id });

      const message = insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: asker.id,
        to_addr: `employee:${target.id}`,
        task_id: task.id,
        kind: 'question',
        subject: 'Which database?',
        body: 'Postgres or SQLite for the orders table?',
      });

      // The employee is fired through the real repository function M7 uses
      // — archived, not deleted, which is exactly why its row still exists
      // and why "the row exists" is not evidence anyone is there.
      archiveEmployee(db, target.id);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      // The branch, not just the outcome: this is the structurally
      // undeliverable road, which must NOT spend 43 minutes on a ladder
      // first.
      expect(report.deadLettered).toEqual([message.id]);
      expect(report.retried).toEqual([]);
      expect(report.held).toEqual([]);
      expect(getOutboxMessageById(db, message.id)?.attempts).toBe(0);
      expect(getOutboxMessageById(db, message.id)?.status).toBe('dead_letter');

      const dead = eventsOfType('message.dead_lettered');
      expect(dead).toHaveLength(1);
      expect(JSON.parse(dead[0]?.payload ?? 'null')).toMatchObject({
        messageId: message.id,
        kind: 'question',
        reason: 'employee_fired',
      });

      const pending = listPendingCheckpoints(db);
      expect(pending).toHaveLength(1);
      const blocker = pending[0];
      expect(blocker?.type).toBe('blocker');
      expect(blocker?.urgency).toBe('blocking');
      // Addressed to the ASKER — the one actually waiting — which is what
      // makes "answer it yourself" reach anybody.
      expect(blocker?.employee_id).toBe(asker.id);
      expect(blocker?.task_id).toBe(task.id);
      expect(blocker?.project_id).toBe(project.id);
      expect(blocker?.title).toContain(asker.name);
      // The question itself is not lost — it is in the preview.
      expect(JSON.stringify(blocker?.preview)).toContain('Postgres or SQLite');

      // No safe default ⇒ no expiry ⇒ the timeout sweep's own query cannot
      // select it. A question that already went missing once must never be
      // resolved a second time by a clock (invariant #7).
      expect(blocker?.default_action).toBeNull();
      expect(blocker?.expires_at).toBeNull();

      // Every option states its consequence (§9.2 / invariant #8) — the
      // schema enforces it, and these are real options a person can act on.
      expect(blocker?.options?.map((o) => o.id)).toEqual(['answer_here', 'drop']);
      for (const option of blocker?.options ?? []) {
        expect(option.consequence.length).toBeGreaterThan(0);
      }

      // Exactly one checkpoint.raised, from insertCheckpoint's one door.
      expect(eventsOfType('checkpoint.raised')).toHaveLength(1);
    });

    it('dead-letters a question to an employee that never existed', async () => {
      const asker = seedEmployee(db);
      insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: asker.id,
        to_addr: 'employee:does-not-exist',
        kind: 'question',
        body: 'anyone there?',
      });

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.deadLettered).toHaveLength(1);
      expect(listPendingCheckpoints(db)).toHaveLength(1);
      expect(JSON.parse(eventsOfType('message.dead_lettered')[0]?.payload ?? 'null')).toMatchObject(
        { reason: 'unknown_employee' },
      );
    });

    it('raises NO checkpoint for a non-question that dies — only a question gets one', async () => {
      const sender = seedEmployee(db);
      const target = seedEmployee(db);
      insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: sender.id,
        to_addr: `employee:${target.id}`,
        kind: 'status',
        body: 'FYI: the build is green.',
      });
      archiveEmployee(db, target.id);

      const report = await routeOnce(deps, { nowMs: Date.now() });

      // §9.7 is specific about which kind gets the checkpoint. A lost
      // status update is a lost notification; a lost question is somebody
      // waiting forever.
      expect(report.deadLettered).toHaveLength(1);
      expect(eventsOfType('message.dead_lettered')).toHaveLength(1);
      expect(listPendingCheckpoints(db)).toEqual([]);
      expect(eventsOfType('checkpoint.raised')).toEqual([]);
    });

    it('dead-letters an address that parses to nothing rather than guessing', async () => {
      const asker = seedEmployee(db);
      insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: asker.id,
        to_addr: 'team:engineering',
        kind: 'question',
        body: 'who owns this?',
      });

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(report.deadLettered).toHaveLength(1);
      expect(JSON.parse(eventsOfType('message.dead_lettered')[0]?.payload ?? 'null')).toMatchObject(
        { reason: 'unparseable_address' },
      );
      expect(listPendingCheckpoints(db)).toHaveLength(1);
    });

    it('dead-letters a role nobody has ever defined', async () => {
      const asker = seedEmployee(db);
      insertOutboxMessage(db, {
        idempotency_key: newId(),
        from_addr: asker.id,
        to_addr: 'role:engineering.nonexistent',
        kind: 'question',
        body: 'who owns this?',
      });

      const report = await routeOnce(deps, { nowMs: Date.now() });
      expect(JSON.parse(eventsOfType('message.dead_lettered')[0]?.payload ?? 'null')).toMatchObject(
        { reason: 'unknown_role' },
      );
      expect(report.deadLettered).toHaveLength(1);
    });
  });
});
