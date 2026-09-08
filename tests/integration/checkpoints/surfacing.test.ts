import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { setSetting } from '../../../src/main/db/repositories/settings';
import { dispatchIpcCall } from '../../../src/main/ipc/router';
import { getHandler } from '../../../src/main/ipc/handlers';
import { IPC_SCHEMAS } from '../../../src/shared/ipc/schemas';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { CheckpointSurfacer } from '../../../src/main/checkpoints/surfacing';
import type { CheckpointNotifier } from '../../../src/main/checkpoints/surfacing';
import { startCheckpointsTick } from '../../../src/main/checkpoints/checkpointsTick';
import { seedProject, seedEmployee } from '../../helpers/dbFixtures';
import type { Checkpoint, NewCheckpointInput } from '../../../src/shared/models/checkpoint';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

/**
 * §9.4's surfacing, and §9.3's batching getting its first caller.
 *
 * The Electron half of the notification — reading window focus and showing
 * a toast — cannot be reached from vitest at all (nothing here can import
 * `electron`), so it is proven separately inside the real packaged app by
 * `tests/integration/notificationsSmoketest.test.ts`. What is tested here
 * is everything that decides *whether* to notify, against real rows.
 */

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/** Records what the real production code asked for. It implements the same
 *  interface `desktopNotifier.ts` does and re-implements none of the
 *  decision — every rule under test lives in `surfacing.ts`. */
class RecordingNotifier implements CheckpointNotifier {
  focused = false;
  readonly shown: { title: string; body: string }[] = [];
  isAnyWindowFocused(): boolean {
    return this.focused;
  }
  notify(input: { title: string; body: string }): void {
    this.shown.push({ ...input });
  }
}

describe('surfacing a pending checkpoint (§9.4, §9.3)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let surfacer: CheckpointSurfacer;
  let notifier: RecordingNotifier;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-surfacing-'));
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
    surfacer = new CheckpointSurfacer(db);
    notifier = new RecordingNotifier();
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

  function raise(overrides: Partial<NewCheckpointInput> = {}): Checkpoint {
    return insertCheckpoint(db, activityLog, {
      type: 'decision',
      urgency: 'soon',
      title: 'A question',
      context: 'Some context for a person who does not work here.',
      options: [
        { id: 'a', label: 'Do it', consequence: 'The thing happens and can be undone.' },
        { id: 'b', label: 'Leave it', consequence: 'Nothing changes.' },
      ],
      default_action: 'b',
      ...overrides,
    } as NewCheckpointInput);
  }

  describe('§9.4: unfocused AND blocking', () => {
    it('notifies for a blocking checkpoint when the window is unfocused', () => {
      const checkpoint = raise({ urgency: 'blocking' });
      notifier.focused = false;

      const report = surfacer.surface({ notifier, nowMs: Date.now() });

      expect(report.notified).toEqual([checkpoint.id]);
      expect(notifier.shown).toHaveLength(1);
      expect(notifier.shown[0]?.title).toBe(checkpoint.title);
      // The context sentence is what makes a toast worth reading — §9.2's
      // non-expert rule applies to it too.
      expect(notifier.shown[0]?.body).toBe(checkpoint.context);
    });

    it('does not notify while the window is focused — and says which rule stopped it', () => {
      const checkpoint = raise({ urgency: 'blocking' });
      notifier.focused = true;

      const report = surfacer.surface({ notifier, nowMs: Date.now() });

      // The branch, not just the silence. Four separate rules can suppress
      // a notification and a bare `shown === []` cannot tell them apart.
      expect(report.skipped).toContainEqual({ id: checkpoint.id, reason: 'window_focused' });
      expect(notifier.shown).toEqual([]);
    });

    it('does not notify for a non-blocking checkpoint even when unfocused', () => {
      const checkpoint = raise({ urgency: 'soon' });
      notifier.focused = false;

      // A `soon` checkpoint whose batch window has closed IS surfaced — it
      // appears in `settled` — and still gets no toast. Surfacing and
      // notifying are different things.
      const report = surfacer.surface({ notifier, nowMs: Date.now() + 10 * 60_000 });

      expect(report.settled).toEqual([checkpoint.id]);
      expect(report.skipped).toContainEqual({ id: checkpoint.id, reason: 'not_blocking' });
      expect(notifier.shown).toEqual([]);
    });

    it("honours the user's own general.notifications switch", () => {
      const checkpoint = raise({ urgency: 'blocking' });
      setSetting(db, 'general.notifications', false);
      notifier.focused = false;

      const report = surfacer.surface({ notifier, nowMs: Date.now() });
      expect(report.skipped).toContainEqual({
        id: checkpoint.id,
        reason: 'notifications_disabled',
      });
      expect(notifier.shown).toEqual([]);
    });

    it('notifies once, not every tick', () => {
      raise({ urgency: 'blocking' });
      notifier.focused = false;

      surfacer.surface({ notifier, nowMs: Date.now() });
      surfacer.surface({ notifier, nowMs: Date.now() });
      const third = surfacer.surface({ notifier, nowMs: Date.now() });

      expect(notifier.shown).toHaveLength(1);
      expect(third.skipped.map((s) => s.reason)).toContain('already_notified');
    });
  });

  describe('§9.3: batching, and what is never batched', () => {
    it('holds two checkpoints inside an open window, then hands them over as one batch', () => {
      const project = seedProject(db);
      const first = raise({ project_id: project.id, urgency: 'soon' });
      const second = raise({ project_id: project.id, urgency: 'soon' });
      const openedAt = Date.parse(first.created_at);

      // Inside the 90s default window: nothing is surfaced yet. Five pings
      // for one phase is the failure mode §9.3 prevents.
      const early = surfacer.surface({ notifier, nowMs: openedAt + 30_000 });
      expect(early.waiting.sort()).toEqual([first.id, second.id].sort());
      expect(early.batches).toEqual([]);

      const late = surfacer.surface({ notifier, nowMs: openedAt + 120_000 });
      expect(late.batches).toHaveLength(1);
      expect(late.batches[0]?.sort()).toEqual([first.id, second.id].sort());
      expect(late.waiting).toEqual([]);
    });

    it('never batches a blocking checkpoint — it is immediate even inside the window', () => {
      const project = seedProject(db);
      const soon = raise({ project_id: project.id, urgency: 'soon' });
      const blocking = raise({ project_id: project.id, urgency: 'blocking' });

      const report = surfacer.surface({ notifier, nowMs: Date.parse(soon.created_at) + 1_000 });

      expect(report.immediate).toEqual([blocking.id]);
      expect(report.waiting).toEqual([soon.id]);
    });

    it('never batches a permission checkpoint — an agent is held waiting', () => {
      const employee = seedEmployee(db);
      const permission = insertCheckpoint(db, activityLog, {
        employee_id: employee.id,
        type: 'permission',
        urgency: 'blocking',
        tool_call_id: 'call-1',
        tool_name: 'Bash',
        args_preview: 'npm install express',
        title: 'Run npm install express?',
        context: 'The developer wants to add a web framework to the project.',
        options: [
          { id: 'allow_once', label: 'Allow once', consequence: 'The command runs, this once.' },
          { id: 'deny', label: 'Deny', consequence: 'The command does not run.' },
        ],
        default_action: 'deny',
      });

      const report = surfacer.surface({ notifier, nowMs: Date.now() });
      expect(report.immediate).toEqual([permission.id]);
    });
  });

  describe('§9.4: all surfaces reflect ONE piece of state', () => {
    it('surfaces exactly the set checkpoints.listPending returns', async () => {
      const blocking = raise({ urgency: 'blocking' });
      const soon = raise({ urgency: 'soon' });

      const listed = (await dispatchIpcCall(
        'checkpoints:listPending',
        IPC_SCHEMAS.checkpoints.listPending,
        getHandler('checkpoints', 'listPending'),
        ctx,
        true,
        {},
      )) as { ok: boolean; data: { items: Checkpoint[] } };

      const report = surfacer.surface({ notifier, nowMs: Date.now() + 10 * 60_000 });
      const surfaced = [...report.immediate, ...report.batches.flat(), ...report.settled];

      // Not "both happen to contain two rows" — the same ids, because both
      // go through `listPendingCheckpoints`. Two queries that agree today
      // are two definitions of "pending" free to drift tomorrow.
      expect(listed.data.items.map((c) => c.id).sort()).toEqual([blocking.id, soon.id].sort());
      expect(surfaced.sort()).toEqual(listed.data.items.map((c) => c.id).sort());
    });

    it('stops surfacing a checkpoint once it has been answered', async () => {
      const checkpoint = raise({ urgency: 'blocking' });
      surfacer.surface({ notifier, nowMs: Date.now() });
      expect(notifier.shown).toHaveLength(1);

      await dispatchIpcCall(
        'checkpoints:answer',
        IPC_SCHEMAS.checkpoints.answer,
        getHandler('checkpoints', 'answer'),
        ctx,
        true,
        { id: checkpoint.id, optionId: 'a' },
      );

      const report = surfacer.surface({ notifier, nowMs: Date.now() });
      expect(report.immediate).toEqual([]);
      expect(report.skipped).toEqual([]);
      expect(notifier.shown).toHaveLength(1);
    });
  });

  describe('the post-restart grace suppresses the SWEEP, never the surfacing', () => {
    it('notifies about a checkpoint that is inside the grace window and does not resolve it', () => {
      // A checkpoint that expired days ago, on an app that started seconds
      // ago: exactly §9.6's case. The grace exists to stop Bureau APPLYING
      // a decision on the user's behalf while they were away — and §9.6's
      // own next sentence is that they get surfaced instead. Silence for
      // ten minutes would be the failure the grace exists to prevent,
      // arriving by another route.
      const checkpoint = raise({ urgency: 'blocking' });
      db.prepare('UPDATE checkpoints SET expires_at = ? WHERE id = ?').run(
        new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        checkpoint.id,
      );
      notifier.focused = false;

      const tick = startCheckpointsTick(
        { db, activityLog, baseDir: tmpDir },
        surfacer,
        notifier,
        // App started right now, so the 10-minute grace is fully in force.
        Date.now(),
        999_999,
      );
      try {
        // The production tick body, not a copy of it.
        tick.runNow();
      } finally {
        tick.stop();
      }

      // Suppressed: not auto-resolved.
      const row = db.prepare('SELECT status FROM checkpoints WHERE id = ?').get(checkpoint.id) as {
        status: string;
      };
      expect(row.status).toBe('pending');
      expect(
        db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'checkpoint.auto_resolved'")
          .get(),
      ).toEqual({ n: 0 });
      // Surfaced anyway.
      expect(notifier.shown).toHaveLength(1);
      expect(notifier.shown[0]?.title).toBe(checkpoint.title);
    });
  });
});
