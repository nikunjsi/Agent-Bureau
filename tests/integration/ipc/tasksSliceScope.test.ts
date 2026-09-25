import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { BrowserWindow } from 'electron';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { insertConversation } from '../../../src/main/db/repositories/conversations';
import { appendChatMessage } from '../../../src/main/chat/appendMessage';
import { seedProject, seedTask } from '../../helpers/dbFixtures';
import { seedCompany } from '../../helpers/companyFixture';
import { startLiveStateBroadcast } from '../../../src/main/ipc/liveState';
import { buildFullSnapshot, wireStateDeltaOnLoad } from '../../../src/main/ipc/stateDelta';
import { registerWindow } from '../../../src/main/windowRegistry';
import type { StateDelta } from '../../../src/shared/ipc/schemas/events';
import type { Task } from '../../../src/shared/models/task';
import type { Project } from '../../../src/shared/models/project';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const TASKS_PER_PROJECT = 300;

/**
 * M11 S2-5 (`NEXT-VERSION` §N.5): the `tasks` slice was every task in the
 * database, and `liveState` read `projects`, `tasks` and `company` by
 * building the whole six-slice snapshot, so a burst of `task.*` events
 * re-read settings, employees and checkpoints to send one slice.
 *
 * Now the slice is the **active project's** tasks — the project whose
 * conversation last had a message, the same default the conversation
 * switcher opens — and each slice has its own reader, shared by the
 * snapshot and the live push.
 */
describe('the tasks slice is the active project’s, and a task burst reads only tasks', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let stopLive: () => void;
  let sent: { channel: string; payload: unknown }[];
  let closeWindow: (() => void) | null = null;
  let finishLoad: () => void;
  let trattoria: Project;
  let pizzeria: Project;
  let trattoriaConversation: string;
  let pizzeriaConversation: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-taskscope-'));
    const paths = getDbPaths(tmpDir, REAL_MIGRATIONS_DIR);
    db = openConnection(paths.dbPath);
    await runMigrations({
      db,
      dbPath: paths.dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: paths.backupsDir,
    });
    activityLog = ActivityLog.open(paths.activityLogPath, db);

    const company = seedCompany(db, tmpDir);
    trattoria = seedProject(db, { name: 'Trattoria' });
    pizzeria = seedProject(db, { name: 'Pizzeria' });
    for (const project of [trattoria, pizzeria]) {
      for (let i = 0; i < TASKS_PER_PROJECT; i += 1) {
        seedTask(db, { project_id: project.id, title: `${project.name} task ${i}` });
      }
    }
    trattoriaConversation = insertConversation(db, {
      company_id: company.id,
      project_id: trattoria.id,
      title: 'Trattoria',
    }).id;
    pizzeriaConversation = insertConversation(db, {
      company_id: company.id,
      project_id: pizzeria.id,
      title: 'Pizzeria',
    }).id;

    sent = [];
    let handler: (() => void) | null = null;
    const win = {
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
  });

  afterEach(() => {
    stopLive();
    closeWindow?.();
    closeWindow = null;
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const say = (conversationId: string): void => {
    appendChatMessage(
      { db, activityLog },
      { conversationId, author: 'user', kind: 'text', body: 'How is it going?' },
    );
  };

  const tasksPatches = (): Task[][] =>
    sent
      .filter((s) => s.channel === 'stateDelta')
      .map((s) => s.payload as StateDelta)
      .filter((delta) => delta.kind === 'patch' && delta.slice === 'tasks')
      .map((delta) => (delta as { value: Task[] }).value);

  const emitTaskBurst = (projectId: string): void => {
    for (let i = 0; i < 5; i += 1) {
      activityLog.logEvent({
        actor: 'system',
        type: 'task.created',
        severity: 'info',
        project_id: projectId,
        payload: {},
      });
    }
  };

  it('the snapshot carries only the active project’s tasks', async () => {
    say(trattoriaConversation);
    await settle();

    const snapshot = buildFullSnapshot(db);
    const tasks = (snapshot as { slices: { tasks: Task[] } }).slices.tasks;
    expect(tasks).toHaveLength(TASKS_PER_PROJECT);
    expect(new Set(tasks.map((t) => t.project_id))).toEqual(new Set([trattoria.id]));
  });

  it('with no conversation spoken in yet, the newest project is active', () => {
    const tasks = (buildFullSnapshot(db) as { slices: { tasks: Task[] } }).slices.tasks;
    expect(new Set(tasks.map((t) => t.project_id))).toEqual(new Set([pizzeria.id]));
  });

  it('a task burst pushes the active project’s tasks and reads no other slice', async () => {
    say(trattoriaConversation);
    finishLoad();
    await settle();
    sent.length = 0;

    const prepared: string[] = [];
    const realPrepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      prepared.push(sql);
      return realPrepare(sql);
    }) as typeof db.prepare);

    emitTaskBurst(pizzeria.id);
    await settle();
    spy.mockRestore();

    const pushes = tasksPatches();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toHaveLength(TASKS_PER_PROJECT);
    expect(new Set(pushes[0]!.map((t) => t.project_id))).toEqual(new Set([trattoria.id]));

    // The reads the flush made. Anything touching another slice's table is
    // the whole snapshot being rebuilt to send one slice.
    const otherSlices = prepared.filter((sql) =>
      /\b(FROM|JOIN)\s+(settings|companies|employees|checkpoints)\b/i.test(sql),
    );
    expect(otherSlices).toEqual([]);
  });

  it('speaking in another project’s conversation re-pushes the tasks slice for it', async () => {
    say(trattoriaConversation);
    finishLoad();
    await settle();
    sent.length = 0;

    say(pizzeriaConversation);
    await settle();

    const last = tasksPatches().at(-1);
    expect(last).toBeDefined();
    expect(new Set(last!.map((t) => t.project_id))).toEqual(new Set([pizzeria.id]));

    // Another message in the same project changes nothing on the Board.
    sent.length = 0;
    say(pizzeriaConversation);
    await settle();
    expect(tasksPatches()).toEqual([]);
  });
});
