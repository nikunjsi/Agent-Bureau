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
import { runShutdownSequence } from './shutdownSequence';
import { seedSettingsDefaults } from './db/settingsLoader';
import { ActivityLog } from './db/activityLog';
import { ControlChannelServer } from './controlChannel/server';
import { TokenRegistry } from './controlChannel/tokens';
import { SupervisorRegistry } from './engine/supervisorRegistry';
import { PolicyHoldRegistry } from './controlChannel/policyHoldRegistry';
import { startCheckpointsTick } from './checkpoints/checkpointsTick';
import { CheckpointSurfacer } from './checkpoints/surfacing';
import { createDesktopNotifier } from './checkpoints/desktopNotifier';
import { startMessageRouter } from './messages/router';
import { startResumeTick } from './engine/parkedEmployeeResumeTick';
import { createRealSecretBroker } from './secrets/secretBroker';
import { loadPricingYaml } from './cost/pricingYaml';
import { resolvePricingYamlPath, resolveBundledPacksDirPath } from './engine/resourceScripts';
import { revalidateInstalledPacks } from './packs/revalidateInstalledPacks';

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
  // §11.4, M6 session 3 — the real broker (safeStorage-backed; safe to
  // construct here since this is genuinely after app.whenReady()). The
  // same instance reconcile()'s orphan sweep uses is the real seam a
  // future hiring flow's EmployeeContext.broker threads through
  // (spawnSupervisedEmployee.ts — no code here spawns an employee yet,
  // same "no live caller until a real hiring flow exists" shape
  // pricing.yaml's own comment below already documents for a sibling
  // seam).
  const secretBroker = createRealSecretBroker(db);
  await reconcile(db, activityLog, app.getPath('userData'), secretBroker);
  seedSettingsDefaults(db);

  // §24.3: "A single orchestrator tick (every 60s) promotes any parked
  // employee whose resume_at has passed." reconcile() (above) already did
  // the startup re-arm; this is the live, periodic half — real and started
  // regardless of whether any employee is currently parked, exactly like
  // Supervisor's own heartbeat monitor precedent. Not a general
  // orchestrator: this does exactly one job (§24.3's own scoping) and
  // nothing else — no task assignment, no employee spawning.
  const resumeTick = startResumeTick(db, activityLog);

  // M6 session 2, item 7 named this seam; M6 session 3 gives it its first
  // real reader. `resources/pricing.yaml` is loaded exactly once, here —
  // `costsHandlers.pricingTable` (session 3) reads this same loaded value
  // via `HandlerContext.pricing` rather than re-resolving/re-parsing the
  // file on every IPC call. The same value is still the one a real hiring
  // flow (M7+) would thread into `spawnSupervisedEmployee`'s own
  // `supervisorOptions.pricing` — nothing in this file spawns an employee
  // yet, so that half of the seam stays a seam.
  const pricing = loadPricingYaml(resolvePricingYamlPath());

  // §7.10 — the loopback control channel bureau-hook/bureau-tools talk to.
  // Started here, before any employee can exist to need it, and stopped on
  // quit alongside the rest of durable state. tokenRegistry/
  // supervisorRegistry both live for the whole Core process lifetime;
  // Supervisor's own constructor (M4 session 2) takes both so stop()
  // revokes/unregisters as part of the same sequence that tears down the
  // adapter.
  const tokenRegistry = new TokenRegistry();
  const supervisorRegistry = new SupervisorRegistry();
  // §9.1/§7.10 — ONE hold registry, shared. The server holds an agent's
  // HTTP request on it when the policy evaluator says 'ask'; the IPC
  // handler releases that exact hold when the user answers the permission
  // checkpoint. Two instances would both work in isolation and never meet:
  // the user would answer, the handler would report success, and the agent
  // would sit there until its own hold timed out to deny. Constructed here
  // rather than defaulted inside the server precisely so there is one.
  const policyHoldRegistry = new PolicyHoldRegistry();
  const controlChannelServer = new ControlChannelServer({
    db,
    activityLog,
    tokenRegistry,
    supervisorRegistry,
    policyHoldRegistry,
    baseDir: app.getPath('userData'),
  });
  await controlChannelServer.start();

  const rendererDistRoot = path.join(__dirname, '..', 'renderer');
  registerAppProtocolHandler(rendererDistRoot);

  // §6.7: "On startup and on install, every pack is validated." This is
  // the startup half. It **installs nothing** — this file's own rule
  // still holds that no product data is created here. It re-validates
  // packs the user has already installed and records the outcome, so a
  // pack that broke since last launch (an edited YAML, a deleted prompt)
  // is reported with a readable reason instead of failing at hire time.
  //
  // Never rewrites `enabled`: that is the user's intent. See
  // revalidateInstalledPacks for why withholding beats flipping.
  const bundledPacksDir = resolveBundledPacksDirPath();
  revalidateInstalledPacks({
    db,
    activityLog,
    baseDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    bundledPacksDir,
  });

  // §17: the complete window.bureau surface, one ipcMain.handle per
  // method, registered once before any window (and therefore any
  // renderer that could call one) exists.
  registerIpcRouter(
    db,
    activityLog,
    dbPaths,
    pricing,
    { baseDir: app.getPath('userData'), bundledPacksDir, appVersion: app.getVersion() },
    // §14.5's employees.pause/resumeEmployee/interrupt reach the live
    // Supervisor through here. Populated once employees are actually
    // spawned; empty until then, and the handlers say so rather than
    // pretending an operation succeeded.
    supervisorRegistry,
    // §9.1: how checkpoints.answerPermission reaches the live hold above.
    policyHoldRegistry,
  );

  // §9.5/§9.6 — the checkpoint timeout sweep, with the post-restart grace.
  // `appStartedAt` is captured HERE, at the real process start, and passed
  // in: the grace exists to stop the first tick after launch resolving a
  // three-day-old backlog to defaults before the user has read any of it,
  // and it can only do that if it knows when this run began. Started
  // unconditionally, like the resume tick, rather than only when something
  // is pending.
  const appStartedAtMs = Date.now();
  const checkpointTick = startCheckpointsTick(
    { db, activityLog, baseDir: app.getPath('userData') },
    // §9.4's surfacing shares this timer. The surfacer holds the one piece
    // of state the database does not — which pending checkpoints have
    // already been announced — so it is constructed once here and lives as
    // long as the app, not per tick.
    new CheckpointSurfacer(db),
    createDesktopNotifier(),
    appStartedAtMs,
  );

  // §9.7 — the message router. The outbox has been written to since M4
  // (`bureau_send_message`, `bureau_ask_director`) and since M8 session 1
  // (`answerCheckpoint`), and until this line nothing delivered any of it.
  //
  // `appStartedAtMs` is the same instant the checkpoints tick uses, and for
  // a related reason: it bounds redelivery of a message that a PREVIOUS run
  // handed to an adapter and whose employee never took another turn, so
  // that can happen at most once per app start.
  //
  // §9.7's in-process signal is deliberately not wired (docs/NEXT-VERSION.md
  // §J). SQLite is the source of truth; the tick finds everything.
  const messageRouter = startMessageRouter({
    db,
    activityLog,
    supervisorRegistry,
    appStartedAtMs,
  });

  const win = createMainWindow();
  wireStateDeltaOnLoad(win, db);

  // AUDIT #16: the shutdown ORDER lives in `shutdownSequence.ts` so it can
  // be tested — `before-quit` needs a live Electron runtime that vitest
  // never has, which is exactly why the old fire-and-forget version went
  // unnoticed. It now genuinely waits (bounded) for the control channel to
  // drain before closing the log and the database.
  let shuttingDown: Promise<void> | null = null;
  app.on('before-quit', (event) => {
    if (shuttingDown) return; // already draining — let the quit proceed
    event.preventDefault();
    shuttingDown = runShutdownSequence({
      controlChannelServer,
      resumeTick,
      checkpointTick,
      messageRouter,
      activityLog,
      db,
    }).finally(() => {
      app.quit();
    });
  });
}

// Windows-only app: no macOS dock/"activate" convention to honour, so
// closing every window always quits.
app.on('window-all-closed', () => {
  app.quit();
});

void main();
