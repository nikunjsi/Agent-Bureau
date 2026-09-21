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
import { seedProject, seedTask } from '../../helpers/dbFixtures';
import { startLiveStateBroadcast } from '../../../src/main/ipc/liveState';
import { wireStateDeltaOnLoad } from '../../../src/main/ipc/stateDelta';
import { registerWindow } from '../../../src/main/windowRegistry';
import { settingsHandlers } from '../../../src/main/ipc/handlers/settings';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { StateDelta } from '../../../src/shared/ipc/schemas/events';

import { hireEmployee } from '../../../src/main/company/hireEmployee';
import type { FloorLayout } from '../../../src/shared/floor/layout';
import { seedCompany, installShippedPack } from '../../helpers/companyFixture';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * AUDIT M0–M2 #23 — §17.2: *"The renderer holds no authoritative state. It
 * hydrates from `stateDelta`"*, and it never polls.
 *
 * `liveState.ts` re-broadcast two of the six slices. The other four —
 * `projects`, `tasks`, `settings`, `company` — reached a window **only**
 * via `wireStateDeltaOnLoad` on `did-finish-load`, so anything that
 * changed while the window was open simply did not arrive. The Board
 * renders from `state.tasks`, which means a task created while the user
 * was looking at the Board would never appear, and §17.2 forbids the
 * renderer from polling to find out.
 *
 * ## What this test can and cannot drive, said plainly
 *
 * **`settings` is driven end to end through the production path**: the
 * real `settings.set` handler, which emits the real `app.setting_changed`.
 * That one is a complete proof.
 *
 * **`projects` and `tasks` are not, and cannot be yet.** Nothing in
 * `src/` emits `project.created` or `task.created` — those producers are
 * M11's, which is the audit's own reason for calling this "arguably M11's
 * problem". So those cases drive the real `activityLog.logEvent`, which is
 * the exact mechanism the subscription hangs off, and the real repository
 * writes underneath. What is missing is only the *producer*, and inventing
 * one would be inventing the Director (the same limit `chatSeed` states
 * for M9's fixtures).
 *
 * Saying which is which matters more than the coverage number: a reader
 * who assumes all three are equally proven would be wrong about two.
 */
describe('AUDIT #23: every slice that changes while a window is open reaches it', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let stopLive: () => void;
  let sent: { channel: string; payload: unknown }[];
  let win: BrowserWindow;
  let finishLoad: () => void;
  let closeWindow: (() => void) | null = null;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-liveslices-'));
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
    registerWindow(win);
    wireStateDeltaOnLoad(win, db);
    finishLoad = () => handler?.();
    stopLive = startLiveStateBroadcast(activityLog, db);

    ctx = {
      db,
      activityLog,
      dbPaths: paths,
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    };
  });

  afterEach(() => {
    stopLive();
    closeWindow?.();
    closeWindow = null;
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Two hops: listeners are deferred to `setImmediate` so they never run
   * inside the emitter's transaction, and the broadcast is coalesced onto
   * a `setTimeout(0)`. Same as `liveCheckpointPatch.test.ts`. */
  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const patchesFor = (slice: string): StateDelta[] =>
    sent
      .filter((s) => s.channel === 'stateDelta')
      .map((s) => s.payload as StateDelta)
      .filter((delta) => delta.kind === 'patch' && delta.slice === slice);

  it('a project created while the window is open reaches it', async () => {
    finishLoad();
    const project = seedProject(db);
    // The producer M11 owns. See the header: the subscription is what is
    // under test, and this is the event every real producer must emit
    // anyway (invariant #3).
    activityLog.logEvent({
      actor: 'system',
      type: 'project.created',
      severity: 'info',
      project_id: project.id,
      payload: {},
    });
    await settle();

    const patch = patchesFor('projects').at(-1);
    expect(
      patch,
      'a new project produced no patch — the window stays stale until reload',
    ).toBeDefined();
    const value = patch?.kind === 'patch' ? (patch.value as Array<{ id: string }>) : [];
    expect(value.map((p) => p.id)).toContain(project.id);
  });

  it('a task created while the window is open reaches it — the Board renders from this slice', async () => {
    finishLoad();
    const project = seedProject(db);
    const task = seedTask(db, { project_id: project.id });
    activityLog.logEvent({
      actor: 'system',
      type: 'task.created',
      severity: 'info',
      project_id: project.id,
      task_id: task.id,
      payload: {},
    });
    await settle();

    const patch = patchesFor('tasks').at(-1);
    expect(patch, 'the Board would never show a task created while it was open').toBeDefined();
    const value = patch?.kind === 'patch' ? (patch.value as Array<{ id: string }>) : [];
    expect(value.map((t) => t.id)).toContain(task.id);
  });

  it('a setting changed through the real handler reaches the window', async () => {
    // The one case with a genuine production producer today, so it is
    // driven through it: `settings.set` emits `app.setting_changed`
    // itself. AUDIT #17's splitter is the first feature to depend on this
    // — the floor pane renders from the `settings` slice, so without the
    // push a dragged width would snap back until the next reload.
    finishLoad();
    const result = await settingsHandlers['set']!(
      { key: 'general.floorPaneWidth', value: 320 },
      ctx,
    );
    expect((result as { ok: boolean }).ok).toBe(true);
    await settle();

    const patch = patchesFor('settings').at(-1);
    expect(patch, 'a setting changed at runtime never reaches the open window').toBeDefined();
    const value = patch?.kind === 'patch' ? (patch.value as Record<string, unknown>) : {};
    expect(value['general.floorPaneWidth']).toBe(320);
  });

  it('hiring rewrites the floor layout, and the company slice reaches the window (#23 residual)', async () => {
    // The sixth slice, and the only one of the four that a **production
    // path** can drive today: `hireEmployee` places the new desk and
    // `persistFloorLayout` writes `companies.floor_layout`, emitting
    // `company.floor_rearranged`. Before this, a user watching the floor
    // while someone was hired saw the layout the window loaded with.
    const company = seedCompany(db, tmpDir);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
    finishLoad();
    sent.length = 0;

    hireEmployee({
      db,
      activityLog,
      companyId: company.id,
      baseDir: tmpDir,
      roleKey: 'engineering:developer',
    });
    await settle();

    const patches = patchesFor('company');
    expect(patches).toHaveLength(1);
    // The layout the window would render, with the new hire's desk in it —
    // not merely "a patch arrived".
    const value = (patches[0] as { value: { floor_layout: FloorLayout } }).value;
    const occupied = value.floor_layout.rooms.flatMap((room) =>
      room.desks.filter((desk) => desk.employeeId !== null),
    );
    expect(occupied).toHaveLength(1);
    // The roster changed too, and that is a different slice with its own
    // reader — both arrive, neither stands in for the other.
    expect(patchesFor('employees')).toHaveLength(1);
  });

  it('an unrelated event does not churn a slice that did not change', async () => {
    // Every patch consumes a sequence number the renderer checks for gaps,
    // so re-sending a slice nothing touched is not free. `liveState.ts`
    // says this in its own header; this is the assertion for it.
    finishLoad();
    activityLog.logEvent({
      actor: 'system',
      type: 'app.started',
      severity: 'info',
      payload: {},
    });
    await settle();

    expect(patchesFor('projects')).toHaveLength(0);
    expect(patchesFor('tasks')).toHaveLength(0);
    expect(patchesFor('settings')).toHaveLength(0);
    expect(patchesFor('company')).toHaveLength(0);
  });
});
