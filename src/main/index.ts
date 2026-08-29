import { app } from 'electron';
import path from 'node:path';
import { registerAppProtocolPrivileges, registerAppProtocolHandler } from './protocol';
import { createMainWindow } from './window';
import { registerIpcRouter } from './ipc/router';
import { wireStateDeltaOnLoad } from './ipc/stateDelta';
import { ensureJobObject } from './process/jobObject';
import { maybeRunSmoketest } from './smoketest';
import { openConnection, checkIntegrity } from './db/connection';
import { getDbPaths } from './db/paths';
import { runMigrations } from './db/migrate';
import { reconcile } from './db/reconcile';
import { seedSettingsDefaults } from './db/settingsLoader';
import { ActivityLog } from './db/activityLog';
import { ControlChannelServer } from './controlChannel/server';
import { TokenRegistry } from './controlChannel/tokens';
import { SupervisorRegistry } from './engine/supervisorRegistry';

// Must run before app.whenReady() — privileges cannot change afterwards.
registerAppProtocolPrivileges();

// Must match the AppUserModelID NSIS gives the installed shortcut, or
// Windows toast notifications silently never appear (§18.2).
app.setAppUserModelId('com.bureau.app');

async function main(): Promise<void> {
  const ranSmoketest = await maybeRunSmoketest();
  if (ranSmoketest) return;

  await app.whenReady();

  ensureJobObject();

  // Durable state, before anything else touches the app (§4.4, §28 M1).
  // No product data is created here — no default company/employees; that
  // is the setup wizard's job (M13). This is only the mechanical boot
  // sequence that makes "closing the laptop loses nothing" true of the
  // actual running app, not just of the data layer's own tests.
  const dbPaths = getDbPaths(app.getPath('userData'), path.join(__dirname, 'db', 'migrations'));
  const db = openConnection(dbPaths.dbPath);

  await runMigrations({
    db,
    dbPath: dbPaths.dbPath,
    migrationsDir: dbPaths.migrationsDir,
    backupsDir: dbPaths.backupsDir,
  });

  const integrity = checkIntegrity(db);
  if (!integrity.ok) {
    // §28 M1 step 8: fail loudly, not silently, on corruption. No UI
    // exists yet to "offer the most recent backup" from (backup.ts has
    // the mechanism); a later milestone wires this to an actual recovery
    // flow instead of a hard crash.
    throw new Error(`Database integrity check failed: ${integrity.issues.join('; ')}`);
  }

  const activityLog = ActivityLog.open(dbPaths.activityLogPath, db);
  await reconcile(db, activityLog, app.getPath('userData'));
  seedSettingsDefaults(db);

  // §7.10 — the loopback control channel bureau-hook/bureau-tools talk to.
  // Started here, before any employee can exist to need it, and stopped on
  // quit alongside the rest of durable state. tokenRegistry/
  // supervisorRegistry both live for the whole Core process lifetime;
  // Supervisor's own constructor (M4 session 2) takes both so stop()
  // revokes/unregisters as part of the same sequence that tears down the
  // adapter.
  const tokenRegistry = new TokenRegistry();
  const supervisorRegistry = new SupervisorRegistry();
  const controlChannelServer = new ControlChannelServer({
    db,
    activityLog,
    tokenRegistry,
    supervisorRegistry,
    baseDir: app.getPath('userData'),
  });
  await controlChannelServer.start();

  const rendererDistRoot = path.join(__dirname, '..', 'renderer');
  registerAppProtocolHandler(rendererDistRoot);

  // §17: the complete window.bureau surface, one ipcMain.handle per
  // method, registered once before any window (and therefore any
  // renderer that could call one) exists.
  registerIpcRouter(db, activityLog, dbPaths);

  const win = createMainWindow();
  wireStateDeltaOnLoad(win, db);

  app.on('before-quit', () => {
    // Best-effort: does not block quit on the server's own close, so a
    // request already mid-flight when the process exits can still race
    // activityLog/db closing below. Acceptable for now — no employee (and
    // therefore no real client of this server) exists yet in what's built;
    // revisit once M4 session 2's bureau-hook/bureau-tools are real
    // processes that can actually be mid-request at quit time.
    void controlChannelServer.stop();
    activityLog.close();
    db.close();
  });
}

// Windows-only app: no macOS dock/"activate" convention to honour, so
// closing every window always quits.
app.on('window-all-closed', () => {
  app.quit();
});

void main();
