import { app } from 'electron';
import path from 'node:path';
import { registerAppProtocolPrivileges, registerAppProtocolHandler } from './protocol';
import { createMainWindow } from './window';
import { registerHealthHandler } from './ipc/health';
import { ensureJobObject } from './process/jobObject';
import { maybeRunSmoketest } from './smoketest';
import { openConnection, checkIntegrity } from './db/connection';
import { getDbPaths } from './db/paths';
import { runMigrations } from './db/migrate';
import { reconcile } from './db/reconcile';
import { seedSettingsDefaults } from './db/settingsLoader';
import { ActivityLog } from './db/activityLog';

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
  reconcile(db, dbPaths.activityLogPath);
  seedSettingsDefaults(db);

  const rendererDistRoot = path.join(__dirname, '..', 'renderer');
  registerAppProtocolHandler(rendererDistRoot);

  registerHealthHandler();

  createMainWindow();

  app.on('before-quit', () => {
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
