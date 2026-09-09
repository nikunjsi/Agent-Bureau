import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { insertCheckpoint } from '../../../src/main/db/repositories/checkpoints';
import { setEmployeeStatus } from '../../../src/main/db/repositories/employees';
import { seedEmployee } from '../../helpers/dbFixtures';
import { startLiveStateBroadcast } from '../../../src/main/ipc/liveState';
import { wireStateDeltaOnLoad } from '../../../src/main/ipc/stateDelta';
import { registerWindow } from '../../../src/main/windowRegistry';
import { checkpointsHandlers } from '../../../src/main/ipc/handlers/checkpoints';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { StateDelta } from '../../../src/shared/ipc/schemas/events';
import type { Checkpoint } from '../../../src/shared/models/checkpoint';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * §9.4 — "a pending checkpoint appears in four places, all reflecting one
 * piece of state", and the mechanism that keeps an already-open window in
 * step with it.
 *
 * Before M9 the renderer hydrated once per window load and never heard
 * about a change again. A chat card that appears when a checkpoint is
 * raised and leaves when it is answered needs otherwise, and the answer is
 * deliberately **not** a push at every call site that changes a
 * checkpoint: every one of them already emits exactly one `checkpoint.*`
 * event (invariant #3), so one subscription to the activity log cannot
 * fall behind the code the way five remembered calls would.
 *
 * Everything here is the production path — `insertCheckpoint`, the real
 * `checkpoints.answer` handler through the real dispatcher, the real
 * `startLiveStateBroadcast`, the real `broadcastPatch`. Only the window is
 * substituted, for the usual reason (no Electron runtime under vitest).
 */
describe('live checkpoint state (§9.4)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let stopLive: () => void;
  let sent: { channel: string; payload: unknown }[];
  let win: BrowserWindow;
  let finishLoad: () => void;
  let closeWindow: (() => void) | null = null;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-livecp-'));
    const paths = getDbPaths(tmpDir, REAL_MIGRATIONS_DIR);
    db = openConnection(paths.dbPath);
    await runMigrations({
      db,
      dbPath: paths.dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: paths.backupsDir,
    });
    activityLog = ActivityLog.open(paths.activityLogPath, db);

    sent = [];
    let handler: (() => void) | null = null;
    win = {
      isDestroyed: () => false,
      // The registry removes a window on its real `closed` event; capturing
      // it here means `afterEach` can leave through the same door rather
      // than a test-only escape hatch — and without it, every previous
      // test's window is still in the registry and still receiving
      // broadcasts, which is how this test first caught its own leak.
      once: (event: string, cb: () => void) => {
        if (event === 'closed') closeWindow = cb;
      },
      webContents: {
        id: 1,
        on: (event: string, cb: () => void) => {
          if (event === 'did-finish-load') handler = cb;
        },
        send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      },
    } as unknown as BrowserWindow;
    // Registered the way the real app registers it, so `broadcastPatch`'s
    // own default window list is what is exercised — not an injected one.
    registerWindow(win);
    wireStateDeltaOnLoad(win, db);
    finishLoad = () => handler?.();
    stopLive = startLiveStateBroadcast(activityLog, db);
  });

  afterEach(() => {
    stopLive();
    closeWindow?.();
    closeWindow = null;
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Two hops, because the real path has two: listeners are deferred to
   * `setImmediate` so they never run inside the emitter's transaction, and
   * the broadcast itself is then coalesced onto a `setTimeout(0)` so a
   * burst of events costs one read and one send. A test has to let both
   * turn, exactly as the real app does.
   */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const patches = (): StateDelta[] =>
    sent
      .filter((s) => s.channel === 'stateDelta')
      .map((s) => s.payload as StateDelta)
      .filter((delta) => delta.kind === 'patch');

  const raise = (): Checkpoint =>
    insertCheckpoint(db, activityLog, {
      type: 'decision',
      urgency: 'soon',
      title: 'Postgres or SQLite?',
      context: 'The project needs somewhere to keep its data.',
      options: [
        {
          id: 'sqlite',
          label: 'SQLite',
          consequence: 'One file on disk. Easy to move; harder to share later.',
          recommended: true,
          detail: 'Nothing here needs more than one machine yet.',
        },
        { id: 'postgres', label: 'Postgres', consequence: 'A server to run and maintain.' },
      ],
      default_action: 'sqlite',
    });

  it('raising a checkpoint reaches an already-loaded window without it asking', async () => {
    finishLoad();
    const checkpoint = raise();
    await settle();

    const patch = patches().at(-1);
    expect(patch, 'a raised checkpoint produced no patch at all').toBeDefined();
    expect(patch?.kind === 'patch' && patch.slice).toBe('checkpoints');
    const value = patch?.kind === 'patch' ? (patch.value as Checkpoint[]) : [];
    expect(value.map((c) => c.id)).toEqual([checkpoint.id]);
    // The card renders the consequences off this payload, so they have to
    // survive the trip (§9.2 / invariant #8).
    expect(value[0]?.options?.every((option) => option.consequence.length > 0)).toBe(true);
  });

  it('answering through the real handler is what removes the card', async () => {
    finishLoad();
    const checkpoint = raise();
    await settle();
    const patchesAfterRaise = patches().length;

    const result = await dispatchIpcCall(
      'checkpoints:answer',
      getMethodSchema('checkpoints', 'answer'),
      checkpointsHandlers['answer']!,
      {
        db,
        activityLog,
        dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
        pricing: REAL_PRICING,
        baseDir: tmpDir,
        bundledPacksDir: path.resolve('packs'),
        appVersion: '0.0.1',
      } as HandlerContext,
      true,
      { id: checkpoint.id, optionId: 'sqlite', freeText: 'and keep a backup' },
    );
    expect(result.ok).toBe(true);
    await settle();

    expect(patches().length).toBe(patchesAfterRaise + 1);
    const patch = patches().at(-1);
    const value = patch?.kind === 'patch' ? (patch.value as Checkpoint[]) : [null];
    // The view does not remove the card itself; the Core says the
    // checkpoint is no longer pending and the card goes with it.
    expect(value).toEqual([]);
  });

  it('a burst of checkpoint events costs one read and one broadcast, not one each', async () => {
    finishLoad();
    const before = patches().length;

    // The real shape of a burst: the timeout sweep can auto-resolve
    // several checkpoints in a single tick, and §9.3's batching exists
    // because several arrive together. Three raised synchronously is that
    // shape, minimally.
    const raised = [raise(), raise(), raise()];
    await settle();

    // The branch: one patch, not three. The slice is a whole-array
    // replacement, so the first two would be redundant by construction —
    // and each one costs a full read of the pending set plus a send to
    // every open window.
    expect(patches().length - before, 'three events in one burst must coalesce').toBe(1);

    // And the one that is sent is the CURRENT state, not the state at the
    // first event — coalescing must not mean sending a stale snapshot.
    const patch = patches().at(-1);
    const value = patch?.kind === 'patch' ? (patch.value as Checkpoint[]) : [];
    expect(value.map((c) => c.id).sort()).toEqual(raised.map((c) => c.id).sort());
  });

  it('an event that is not a checkpoint change produces no patch', async () => {
    finishLoad();
    const before = patches().length;
    activityLog.logEvent({
      actor: 'system',
      type: 'app.started',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
    });
    await settle();
    // The branch: subscribing to every event is not the same as pushing on
    // every event, and a broadcast per unrelated event would put the whole
    // pending set on the wire dozens of times a turn.
    expect(patches().length).toBe(before);
  });

  /**
   * The `employees` slice joined this in M9 session 2, and it was found by
   * something visibly not happening rather than by a failing assertion.
   *
   * `/pause` stops an employee; the Resume banner above the composer renders
   * from this slice. A resume that changed the row but never reached the
   * window left the banner sitting there — the undo worked and looked
   * broken, which for an undo is barely better than not working at all.
   */
  describe('the employees slice (M9 session 2)', () => {
    const employeePatches = () =>
      patches().filter((d) => d.kind === 'patch' && d.slice === 'employees');

    it('a status change reaches an already-loaded window', async () => {
      const employee = seedEmployee(db, { status: 'idle' });
      finishLoad();
      const before = employeePatches().length;

      // The real transition an employee makes, through the real writer and
      // the real event — not a hand-fired `employee.parked`.
      setEmployeeStatus(db, employee.id, 'parked');
      activityLog.logEvent({
        actor: 'user',
        type: 'employee.parked',
        severity: 'info',
        project_id: null,
        task_id: null,
        employee_id: employee.id,
        checkpoint_id: null,
        payload: null,
      });
      await settle();

      const patch = employeePatches().at(-1);
      expect(employeePatches().length).toBe(before + 1);
      expect(
        patch?.kind === 'patch' ? (patch.value as Array<{ id: string; status: string }>) : [],
      ).toEqual([expect.objectContaining({ id: employee.id, status: 'parked' })]);
    });

    it('a checkpoint event does not drag an employees read along with it, and vice versa', async () => {
      seedEmployee(db, { status: 'idle' });
      finishLoad();
      const employeesBefore = employeePatches().length;

      raise();
      await settle();

      // One timer per slice, not one shared timer: every patch consumes a
      // sequence number the renderer checks for gaps, so re-sending a slice
      // that did not change is not free.
      expect(employeePatches().length).toBe(employeesBefore);
      expect(
        patches().filter((d) => d.kind === 'patch' && d.slice === 'checkpoints').length,
      ).toBeGreaterThan(0);
    });

    it('a burst of employee events costs one read and one broadcast', async () => {
      const employee = seedEmployee(db, { status: 'idle' });
      finishLoad();
      const before = employeePatches().length;

      // A pause of several employees is exactly this shape.
      for (const type of ['employee.parked', 'employee.idle', 'employee.parked'] as const) {
        activityLog.logEvent({
          actor: 'user',
          type,
          severity: 'info',
          project_id: null,
          task_id: null,
          employee_id: employee.id,
          checkpoint_id: null,
          payload: null,
        });
      }
      await settle();

      expect(employeePatches().length).toBe(before + 1);
    });
  });

  it('a listener that throws does not take down the state change that triggered it', async () => {
    finishLoad();
    const stopThrower = activityLog.onEvent(() => {
      throw new Error('a listener behaving badly');
    });
    const checkpoint = raise();
    await settle();
    stopThrower();

    // The row is real regardless of what any listener did with the news.
    const row = db.prepare('SELECT status FROM checkpoints WHERE id = ?').get(checkpoint.id) as {
      status: string;
    };
    expect(row.status).toBe('pending');
    expect(patches().length).toBeGreaterThan(0);
  });
});
