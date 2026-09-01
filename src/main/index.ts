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
import { startResumeTick } from './engine/parkedEmployeeResumeTick';

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

  // §24.3: "A single orchestrator tick (every 60s) promotes any parked
  // employee whose resume_at has passed." reconcile() (above) already did
  // the startup re-arm; this is the live, periodic half — real and started
  // regardless of whether any employee is currently parked, exactly like
  // Supervisor's own heartbeat monitor precedent. Not a general
  // orchestrator: this does exactly one job (§24.3's own scoping) and
  // nothing else — no task assignment, no employee spawning.
  const resumeTick = startResumeTick(db, activityLog);

  // M6 session 2, item 7 — `resources/pricing.yaml` is loaded once here
  // (`loadPricingYaml(resolvePricingYamlPath())`) and threaded into every
  // real Supervisor via `spawnSupervisedEmployee`'s own
  // `supervisorOptions.pricing`, once a real hiring flow actually calls
  // it — no code in this file spawns an employee yet (that is a later
  // milestone's job; §7.11's Supervisor is fully built and tested against
  // FakeAdapter today, but nothing here constructs one for a live engine).
  // Loading it into an unused local here would be dead code today, not
  // real wiring — left as this explicit seam instead, matching M5's
  // integrationRef precedent, rather than half-wiring it to nothing.

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
    resumeTick.stop();
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
