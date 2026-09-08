import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCheckpoint, getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { resolveExpiredCheckpoints } from '../../../src/main/checkpoints/checkpointsTick';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import type { AnswerDeps } from '../../../src/main/checkpoints/answerCheckpoint';

/**
 * §9.5's timeouts and §9.6's post-restart grace, against real rows created
 * through the real creation path.
 *
 * Deliberately NOT named `checkpoint_timeout_is_safe`: that is S12's name,
 * S12 lands in session 2 with S15, and M7's security-suite coverage guard
 * matches on those names. Naming a test S12 before it is wired into
 * `npm run test:security` would make the guard report coverage that the
 * release-blocking suite does not actually run.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('checkpoint timeouts and the post-restart grace (§9.5, §9.6)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let deps: AnswerDeps;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-cp-timeout-'));
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
    deps = { db, activityLog, baseDir: tmpDir };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function eventsOfType(type: string): unknown[] {
    return db.prepare('SELECT * FROM events WHERE type = ?').all(type);
  }

  const decisionWithSafeDefault = (
    projectId: string | null,
    taskId: string | null,
    employeeId: string | null,
  ) => ({
    project_id: projectId,
    task_id: taskId,
    employee_id: employeeId,
    type: 'decision' as const,
    urgency: 'blocking' as const,
    title: 'Should we switch the report screen to cached data?',
    context:
      'The report is slow. Caching makes it fast but can show numbers a few minutes out of date.',
    options: [
      {
        id: 'cache',
        label: 'Use cached data',
        consequence: 'Reports load instantly but can be a few minutes old.',
      },
      {
        id: 'leave',
        label: 'Leave it as it is',
        consequence: 'Nothing changes; the report stays slow but always current.',
        recommended: true,
      },
    ],
    default_action: 'leave',
  });

  // ---- invariant #7, structurally ------------------------------------

  it('a checkpoint with no safe default gets NO expires_at, so nothing can ever time it out', () => {
    // §9.5: "If the only options are irreversible, the checkpoint cannot
    // time out and the task stays parked indefinitely." That is enforced
    // by the row simply having no deadline, not by the sweep remembering.
    const cp = insertCheckpoint(db, activityLog, {
      type: 'approval',
      urgency: 'blocking',
      title: 'Push this project to GitHub?',
      context: 'Pushing makes the code visible to anyone with access to that repository.',
      options: [
        {
          id: 'push',
          label: 'Push',
          consequence: 'The code is published to the remote repository.',
        },
        {
          id: 'dont',
          label: "Don't push",
          consequence: 'Nothing is published; the work stays on this machine.',
        },
      ],
      default_action: null,
    });

    expect(cp.expires_at).toBeNull();

    // Sweep far into the future — it still must not be selected.
    const report = resolveExpiredCheckpoints(deps, {
      appStartedAtMs: Date.now() - DAY_MS,
      nowMs: Date.now() + 365 * DAY_MS,
    });
    expect(report.resolved).toEqual([]);
    expect(getCheckpointById(db, cp.id)?.status).toBe('pending');
  });

  it('a blocking checkpoint with a safe default gets an expires_at from the settings registry', () => {
    const before = Date.now();
    const cp = insertCheckpoint(db, activityLog, decisionWithSafeDefault(null, null, null));
    expect(cp.expires_at).not.toBeNull();
    // §16.1 default: 60 minutes.
    const expiresMs = Date.parse(cp.expires_at as string);
    expect(expiresMs).toBeGreaterThanOrEqual(before + 59 * 60_000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 61 * 60_000);
  });

  // ---- the post-restart grace ----------------------------------------

  describe('the post-restart grace (§9.6) — the named trap', () => {
    it('does NOT auto-resolve a checkpoint that expired days ago while the app was closed', () => {
      const cp = insertCheckpoint(db, activityLog, decisionWithSafeDefault(null, null, null));
      // Backdate it three days: exactly the "you were away for a long
      // weekend" case. `expires_at <= now` is true, and the naive
      // implementation resolves the user's whole backlog on the first tick.
      const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS).toISOString();
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(threeDaysAgo, cp.id);

      const justStarted = Date.now();
      const report = resolveExpiredCheckpoints(deps, {
        appStartedAtMs: justStarted,
        nowMs: justStarted + 1000,
      });

      // Nothing resolved...
      expect(report.resolved).toEqual([]);
      // ...but the app knows how many it held back, which is what M11's
      // restart report will read. (The other half of §9.6 — the Director
      // actually surfacing them — is M11 and is a stated seam.)
      expect(report.suppressedByGrace).toBe(1);
      expect(report.graceRemainingMs).toBeGreaterThan(0);

      // The row is untouched: still pending, still unanswered.
      const after = getCheckpointById(db, cp.id);
      expect(after?.status).toBe('pending');
      expect(after?.answer).toBeNull();
      expect(after?.answered_at).toBeNull();

      // And no event was emitted, because nothing changed.
      expect(eventsOfType('checkpoint.auto_resolved')).toHaveLength(0);
    });

    it('resolves that same checkpoint once the grace has passed', () => {
      const cp = insertCheckpoint(db, activityLog, decisionWithSafeDefault(null, null, null));
      const threeDaysAgo = new Date(Date.now() - 3 * DAY_MS).toISOString();
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(threeDaysAgo, cp.id);

      // §16.1 default: 10 minutes. Same row, same expiry, only the app's
      // own uptime differs — so this pins the grace itself rather than
      // anything about the checkpoint.
      const startedAt = Date.now();
      const report = resolveExpiredCheckpoints(deps, {
        appStartedAtMs: startedAt,
        nowMs: startedAt + 11 * 60_000,
      });

      expect(report.resolved).toEqual([cp.id]);
      expect(report.suppressedByGrace).toBe(0);
      expect(getCheckpointById(db, cp.id)?.status).toBe('auto_resolved');
    });
  });

  // ---- what a timeout actually does ----------------------------------

  describe('resolution applies the safe default and does the rest of §9.6', () => {
    it('applies default_action, emits exactly one checkpoint.auto_resolved, unblocks the task, and logs the decision', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

      const cp = insertCheckpoint(
        db,
        activityLog,
        decisionWithSafeDefault(project.id, task.id, employee.id),
      );
      blockTaskForCheckpoint(db, activityLog, {
        taskId: task.id,
        checkpointId: cp.id,
        detail: 'waiting on a decision',
      });
      expect(getTaskById(db, task.id)?.status).toBe('blocked');

      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        cp.id,
      );

      const startedAt = Date.now() - 60 * 60_000; // well past the grace
      const report = resolveExpiredCheckpoints(deps, {
        appStartedAtMs: startedAt,
        nowMs: Date.now(),
      });
      expect(report.resolved).toEqual([cp.id]);

      const after = getCheckpointById(db, cp.id);
      expect(after?.status).toBe('auto_resolved');
      // The SAFE option, the one the author designated — never "proceed".
      expect(after?.answer?.optionId).toBe('leave');
      expect(after?.answered_by).toBe('system:timeout');

      // Exactly one event for the one state change, and it is the
      // system-actor one, not `checkpoint.answered`.
      expect(eventsOfType('checkpoint.auto_resolved')).toHaveLength(1);
      expect(eventsOfType('checkpoint.answered')).toHaveLength(0);

      // The dependent task is released.
      expect(getTaskById(db, task.id)?.status).toBe('assigned');
      expect(eventsOfType('task.unblocked')).toHaveLength(1);

      // §12.5 — an auto-resolved decision is still a decision, and the log
      // records HOW it was made rather than implying a person chose it.
      const decisionsPath = path.join(tmpDir, 'memory', 'project', project.id, 'decisions.md');
      expect(existsSync(decisionsPath)).toBe(true);
      const log = readFileSync(decisionsPath, 'utf8');
      expect(log).toContain('Leave it as it is');
      expect(log).toContain('nobody answered within the timeout');
    });

    it('queues the decision for the employee through the messages outbox (§9.7), not a live supervisor', () => {
      const project = seedProject(db);
      const employee = seedEmployee(db);
      const cp = insertCheckpoint(
        db,
        activityLog,
        decisionWithSafeDefault(project.id, null, employee.id),
      );
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60_000).toISOString(),
        cp.id,
      );

      resolveExpiredCheckpoints(deps, {
        appStartedAtMs: Date.now() - 60 * 60_000,
        nowMs: Date.now(),
      });

      // The employee here is `off` — it has never been spawned, and there
      // is no live Supervisor for it. §9.7: a message to an `off` employee
      // is HELD, not dropped. A direct-injection implementation would have
      // discarded this answer entirely.
      const message = db
        .prepare("SELECT * FROM messages WHERE thread_id = ? AND status = 'pending'")
        .get(cp.id) as { to_addr: string; body: string; kind: string } | undefined;
      expect(message).toBeDefined();
      expect(message?.to_addr).toBe(`employee:${employee.id}`);
      expect(message?.kind).toBe('answer');
      expect(message?.body).toContain('Leave it as it is');
    });

    it('a permission checkpoint is never swept — its deadline belongs to the live hold', () => {
      const employee = seedEmployee(db);
      const cp = insertCheckpoint(db, activityLog, {
        employee_id: employee.id,
        type: 'permission',
        urgency: 'blocking',
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        title: 'Ravi wants to run npm install',
        context: 'Ravi is set to ask before actions like this one.',
        options: [
          { id: 'allow_once', label: 'Allow once', consequence: 'This one action runs.' },
          { id: 'deny', label: "Don't allow", consequence: 'The action is refused.' },
        ],
        default_action: 'deny',
      });
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - DAY_MS).toISOString(),
        cp.id,
      );

      const report = resolveExpiredCheckpoints(deps, {
        appStartedAtMs: Date.now() - DAY_MS,
        nowMs: Date.now(),
      });

      // Two timers on one deadline is the rule-6 trap. The hold owns this
      // one; after a restart there is no hold and no waiting agent, and
      // `reconcile()` cancels the row instead.
      expect(report.resolved).toEqual([]);
      expect(getCheckpointById(db, cp.id)?.status).toBe('pending');
    });
  });
});
