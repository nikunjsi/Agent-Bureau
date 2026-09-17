import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCheckpoint, getCheckpointById } from '../../../src/main/db/repositories/checkpoints';
import { blockTaskForCheckpoint } from '../../../src/main/checkpoints/taskBlocking';
import { startCheckpointsTick } from '../../../src/main/checkpoints/checkpointsTick';
import { CheckpointSurfacer } from '../../../src/main/checkpoints/surfacing';
import type { CheckpointNotifier } from '../../../src/main/checkpoints/surfacing';
import { getTaskById } from '../../../src/main/db/repositories/tasks';
import { createPermissionCheckpoint } from '../../../src/main/checkpoints/permissionCheckpoint';
import { seedEmployee, seedProject, seedTask } from '../../helpers/dbFixtures';
import type { NewCheckpointInput } from '../../../src/shared/models/checkpoint';

/**
 * **S12 — `checkpoint_timeout_is_safe`** (§11.7).
 *
 * "An unanswered checkpoint resolves to the safe default, never 'proceed'."
 *
 * This is deliberately a DISTINCT test, not a rename of session 1's
 * `tests/integration/checkpoints/timeoutAndGrace.test.ts` — which
 * deliberately avoided this name and said why. That file tests the
 * mechanism: the grace, the sweep, the event, the unblock. S12 tests the
 * guarantee, and adds three things the mechanism tests do not:
 *
 *   1. it runs through the **real started tick** (`startCheckpointsTick`),
 *      the thing `main/index.ts` actually starts — standing rule 2, "a
 *      guard is not a guard until something on the real path calls it";
 *   2. it puts a genuinely irreversible "proceed anyway" option on the
 *      checkpoint and asserts the timeout provably did NOT pick it;
 *   3. it pins the other half of §9.5 — a checkpoint whose only options are
 *      irreversible cannot time out at all, and its task stays parked.
 *
 * **The honest scope of the claim.** No schema can judge whether the option
 * an author designated as the default is genuinely the reversible one. So
 * what is asserted here is the narrower true statement: *a timeout only
 * ever applies the option the author explicitly designated as safe, and a
 * checkpoint with no such option never times out at all.* The one place
 * that designation is structural rather than authored is `permission`,
 * whose default is hardcoded to `deny`, and that is asserted too.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const HOUR_MS = 60 * 60 * 1000;

/** Records nothing that matters here; surfacing shares the tick and must
 *  not be able to affect the sweep's outcome. */
const SILENT_NOTIFIER: CheckpointNotifier = {
  isAnyWindowFocused: () => true,
  notify: () => undefined,
};

describe('S12 checkpoint_timeout_is_safe — an unanswered checkpoint never "proceeds"', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-s12-'));
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
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Drives the REAL tick body once, with the app started long enough ago
   *  that §9.6's post-restart grace has lifted. Not `resolveExpiredCheckpoints`
   *  directly: the production trigger is what must be shown to work. */
  function runRealTick(appStartedAtMs = Date.now() - HOUR_MS): void {
    // The grace is measured on a monotonic clock (P-3): the uptime the
    // wall-clock start implies is given to that clock too.
    let monotonic = 0;
    const tick = startCheckpointsTick(
      { db, activityLog, baseDir: tmpDir },
      new CheckpointSurfacer(db, { activityLog }),
      SILENT_NOTIFIER,
      appStartedAtMs,
      // Long enough that the interval never fires on its own; `runNow()` is
      // the same function body the interval calls.
      999_999,
      () => monotonic,
    );
    try {
      monotonic = Date.now() - appStartedAtMs;
      tick.runNow();
    } finally {
      tick.stop();
    }
  }

  function expire(checkpointId: string): void {
    db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
      new Date(Date.now() - HOUR_MS).toISOString(),
      checkpointId,
    );
  }

  it('applies the designated safe default and provably not the irreversible option', () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'approval',
      urgency: 'blocking',
      title: 'Push the new branch to GitHub?',
      context:
        'The work is finished locally. Pushing publishes it to the shared repository, ' +
        'where other people and any automation will see it.',
      options: [
        {
          id: 'push',
          label: 'Push to GitHub',
          // The irreversible one, and the one a naive "just carry on"
          // implementation would pick.
          consequence: 'The branch is published. It cannot be un-published once others have it.',
        },
        {
          id: 'hold',
          reversible: true,
          label: 'Keep it local for now',
          consequence: 'Nothing leaves this machine. You can push later at any time.',
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
    expire(checkpoint.id);

    runRealTick();

    const resolved = getCheckpointById(db, checkpoint.id);
    expect(resolved?.status).toBe('auto_resolved');
    // The branch, and then the negation of the dangerous one — asserting
    // only "it resolved" would pass if it had chosen `push`.
    expect(resolved?.answer?.optionId).toBe('hold');
    expect(resolved?.answer?.optionId).not.toBe('push');
    expect(resolved?.answered_by).toBe('system:timeout');

    const events = db
      .prepare("SELECT payload FROM events WHERE type = 'checkpoint.auto_resolved'")
      .all() as { payload: string | null }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload ?? 'null')).toMatchObject({ appliedDefault: 'hold' });

    // §9.6's other four things still happen — a timeout is an answer, not a
    // separate lesser path.
    expect(getTaskById(db, task.id)?.status).not.toBe('blocked');
  });

  it('never times out a checkpoint whose only options are irreversible — the task parks', () => {
    const project = seedProject(db);
    const employee = seedEmployee(db);
    const task = seedTask(db, { project_id: project.id, assignee_employee_id: employee.id });

    // §9.5: "If the only options are irreversible, the checkpoint cannot
    // time out and the task stays parked indefinitely." Expressed as
    // `default_action: null`, which `computeExpiresAt` turns into no
    // `expires_at` at all — so the sweep's own query cannot select it.
    const checkpoint = insertCheckpoint(db, activityLog, {
      project_id: project.id,
      task_id: task.id,
      employee_id: employee.id,
      type: 'approval',
      urgency: 'blocking',
      title: 'Delete the old customer records?',
      context: 'Both choices are permanent. There is no version of this that can be undone.',
      options: [
        { id: 'delete', label: 'Delete them', consequence: 'The records are gone for good.' },
        {
          id: 'publish',
          label: 'Publish them to the archive',
          consequence: 'They become permanently readable by everyone with archive access.',
        },
      ],
      default_action: null,
    } as NewCheckpointInput);

    expect(checkpoint.expires_at).toBeNull();
    blockTaskForCheckpoint(db, activityLog, {
      taskId: task.id,
      checkpointId: checkpoint.id,
      detail: 'waiting on an irreversible decision',
    });

    // Even trying to force it: the sweep runs, an hour past anything.
    runRealTick();

    expect(getCheckpointById(db, checkpoint.id)?.status).toBe('pending');
    expect(getCheckpointById(db, checkpoint.id)?.answer).toBeNull();
    expect(getTaskById(db, task.id)?.status).toBe('blocked');
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'checkpoint.auto_resolved'").get(),
    ).toEqual({ n: 0 });
  });

  it("a permission checkpoint's default is structurally 'deny', not an authored choice", () => {
    const employee = seedEmployee(db);
    const checkpoint = createPermissionCheckpoint(db, activityLog, {
      employeeId: employee.id,
      taskId: null,
      projectId: null,
      callId: 'call-1',
      tool: 'Bash',
      argsPreview: 'rm -rf build',
      reason: 'ask autonomy — a command needs confirmation',
      holdMinutes: 30,
    });

    // Everywhere else the safe default is a human judgement the schema
    // cannot check. Here it is hardcoded, which is the one place the claim
    // is structural rather than trusted.
    expect(checkpoint.default_action).toBe('deny');
    expect(checkpoint.options?.map((o) => o.id)).toContain('deny');
  });

  it('the sweep never touches a permission checkpoint — its deadline belongs to the live hold', () => {
    const employee = seedEmployee(db);
    const checkpoint = createPermissionCheckpoint(db, activityLog, {
      employeeId: employee.id,
      taskId: null,
      projectId: null,
      callId: 'call-2',
      tool: 'Bash',
      argsPreview: 'npm install',
      reason: 'ask autonomy — a command needs confirmation',
      holdMinutes: 30,
    });
    expire(checkpoint.id);

    runRealTick();

    // Resolving it here would answer on behalf of an agent that is still
    // parked inside a live HTTP request — two mechanisms deciding one
    // outcome. The hold denies it when its own clock runs out.
    expect(getCheckpointById(db, checkpoint.id)?.status).toBe('pending');
  });
});
