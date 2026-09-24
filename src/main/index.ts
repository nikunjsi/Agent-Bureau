import { app, dialog } from 'electron';
import path from 'node:path';
import { registerAppProtocolPrivileges, registerAppProtocolHandler } from './protocol';
import { createMainWindow } from './window';
import { registerIpcRouter } from './ipc/router';
import { wireStateDeltaOnLoad } from './ipc/stateDelta';
import { containProcess, ensureJobObject } from './process/jobObject';
import { maybeRunSmoketest } from './smoketest';
import { openConnection, checkIntegrity } from './db/connection';
import { getDbPaths } from './db/paths';
import { runMigrations } from './db/migrate';
import { reconcile } from './db/reconcile';
import { runShutdownSequence } from './shutdownSequence';
import { seedSettingsDefaults } from './db/settingsLoader';
import { HookTimingInvalidError, resolveHookTiming } from './controlChannel/hookTiming';
import { ActivityLog } from './db/activityLog';
import { ControlChannelServer } from './controlChannel/server';
import { TokenRegistry } from './controlChannel/tokens';
import { SupervisorRegistry } from './engine/supervisorRegistry';
import { PolicyHoldRegistry } from './controlChannel/policyHoldRegistry';
import { startCheckpointsTick } from './checkpoints/checkpointsTick';
import { syncMemoryIndexFromDisk } from './memory/syncMemoryIndex';
import { CheckpointSurfacer } from './checkpoints/surfacing';
import { createDesktopNotifier } from './checkpoints/desktopNotifier';
import { startMessageRouter } from './messages/router';
import { ChatStreamRegistry } from './chat/chatStream';
import { createElectronChatBroadcaster } from './chat/electronChatBroadcaster';
import { startLiveStateBroadcast } from './ipc/liveState';
import { startResumeTick } from './engine/parkedEmployeeResumeTick';
import { createRealSecretBroker } from './secrets/secretBroker';
import { loadPricingYaml } from './cost/pricingYaml';
import { resolvePricingYamlPath, resolveBundledPacksDirPath } from './engine/resourceScripts';
import { revalidateInstalledPacks, revalidatePackEngines } from './packs/revalidateInstalledPacks';
import { ClaudeCodeAdapter } from './engine/claudeCodeAdapter';
import { globalProbeCache } from './engine/probeCache';
import { PROBE_LIVENESS_CEILING_MS } from '../shared/engine/types';
import { reportDirectorStart, startDirector } from './director/startDirector';

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

  // AUDIT M0–M2 #18: the result is CAPTURED, not discarded. Applying a
  // migration is a state change and invariant #3 owes it an event; the
  // list of applied versions is the only place that information exists.
  const migration = await runMigrations({
    db,
    dbPath: dbPaths.dbPath,
    migrationsDir: dbPaths.migrationsDir,
    backupsDir: dbPaths.backupsDir,
  });

  const integrity = checkIntegrity(db);
  if (!integrity.ok) {
    // §28 M1 step 8: fail loudly, not silently, on corruption. No UI
    // exists yet to "offer the most recent backup" from (backup.ts has
    // the mechanism, and as of audit M0–M2 #3 it is correct and tested —
    // it was a bare copyFileSync that left the stale WAL behind).
    //
    // **The recovery flow is owned by M15**, named rather than left
    // floating (audit #3's actual complaint was that this deferral cited
    // no milestone). It needs a pre-window dialog offering
    // `listBackups()`, which is shippable-hardening work of the same class
    // M15 already carries; M13's wizard is for a user with nothing
    // installed, not a user whose database broke. Tracked as chaos row 5
    // in PROJECT-CHECKLIST.md.
    throw new Error(`Database integrity check failed: ${integrity.issues.join('; ')}`);
  }

  const activityLog = ActivityLog.open(dbPaths.activityLogPath, db);

  // AUDIT M0–M2 #18. §5.2's `app.migrated`, emitted AFTER migrations
  // rather than before them.
  //
  // The audit suggested opening the ActivityLog *before* `runMigrations`
  // so the migration could be logged as it happened. That does not work,
  // and the reason is worth leaving here so it is not re-attempted:
  // `logEvent` writes a mirror row into `events`, and `events` is created
  // BY migration 0001. On a first run — the run where migrations matter
  // most — there is no table to mirror into, so the emit would throw
  // during boot. Making `insertMirrorRow` tolerate a missing table would
  // weaken the one writer #2 just made strict.
  //
  // `app.migrated` does not need to be emitted before migrations, only
  // *about* them, and `runMigrations` already returns exactly what it
  // needs to say. No reordering, no chicken-and-egg.
  //
  // Emitted only when something actually applied: a boot that migrates
  // nothing is not a state change, and "exactly one event per state
  // change" must not decay into "an event whenever we looked" — the same
  // rule §5.2 already states for `pack_validated`.
  if (migration.applied.length > 0) {
    activityLog.logEvent({
      actor: 'system',
      type: 'app.migrated',
      severity: 'info',
      payload: {
        applied: migration.applied,
        schemaVersion: migration.applied[migration.applied.length - 1] ?? null,
      },
    });
  }
  // §11.4, M6 session 3 — the real broker (safeStorage-backed; safe to
  // construct here since this is genuinely after app.whenReady()). The
  // same instance reconcile()'s orphan sweep uses is the one the
  // Director's EmployeeContext.broker carries (startDirector, M11 row
  // S1-8), and the one employees' contexts will carry when assignment
  // spawns them.
  const secretBroker = createRealSecretBroker(db);
  await reconcile(db, activityLog, app.getPath('userData'), secretBroker);
  seedSettingsDefaults(db);

  // S-1 / §7.10 item 3: the hook's self-deadline must be strictly below the
  // registered hook timeout, "validated at startup". A combination that
  // would let the engine's fail-open timeout decide a permission question is
  // refused here, with the settings' own sentence, rather than discovered at
  // the first tool call. settings.set refuses to write one, so reaching this
  // means the database was edited outside Bureau.
  try {
    resolveHookTiming(db);
  } catch (err) {
    if (!(err instanceof HookTimingInvalidError)) throw err;
    dialog.showErrorBox('Bureau cannot start', err.message);
    app.exit(1);
    return;
  }

  // AUDIT M0–M2 #18. §5.2's `app.started`, deliberately after reconcile()
  // and settings seeding rather than at the top of main(): it means "the
  // app is up and its state has been made consistent", which is the thing
  // a reader of the timeline actually wants to anchor to. Placed after
  // `app.migrated` so a first run reads migrated-then-started in order.
  activityLog.logEvent({
    actor: 'system',
    type: 'app.started',
    severity: 'info',
    payload: { version: app.getVersion() },
  });

  // M10, §12.1 — layer 1 is the source of truth and Bureau was not running
  // while the user may have edited it. Reconciling at startup means the
  // first search, the first memory view and the first task assignment all
  // see what is actually on disk. Cheap even on a cold start: the
  // reconciler stats before it hashes, so a tree nobody touched costs one
  // directory walk and no file reads.
  //
  // Deliberately NOT `rebuildMemoryIndex` — a wipe-and-rebuild on every
  // launch would clear every pin the user has ever set (§12.1), which is
  // the difference between repairing an index and resetting one.
  syncMemoryIndexFromDisk(db, app.getPath('userData'), activityLog);

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
    // X-22: the same table every other cost reader uses, so a one-shot
    // call's spend is a number rather than a null.
    pricing,
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
  // X-2 / §6.3: then each pack's `requires.engines`, against the real probe.
  // Not awaited: probes take seconds, and the window must not wait on them.
  // One adapter instance, so the process-wide probe cache is shared.
  const claudeCodeProbeAdapter = new ClaudeCodeAdapter();
  void revalidatePackEngines({
    db,
    activityLog,
    baseDir: app.getPath('userData'),
    appVersion: app.getVersion(),
    bundledPacksDir,
    probeEngine: async (engineKey) =>
      engineKey === 'claude-code'
        ? globalProbeCache.probe(claudeCodeProbeAdapter, { budgetMs: PROBE_LIVENESS_CEILING_MS })
        : null,
  }).catch((err: unknown) => console.error('[packs] engine requirement check failed', err));

  // §28 M9 — the chat writer's live half. The registry owns every
  // in-flight streamed reply; `chat.stop` reaches into it, and the
  // shutdown sequence drains it so an orderly quit does not leave a row
  // for the next launch's reconcile() to mark as a crash.
  //
  // **The producer is the Director** (M11 row S1-13): `startDirector` below
  // attaches `createDirectorChatProducer` to its Supervisor, so each turn's
  // prose streams through this registry. The user's own half has been real
  // since M9 session 2: the composer writes through `appendChatMessage` and
  // the router delivers replies back into the conversation.
  //
  // **One broadcaster, three writers.** The stream registry, `chat.send`/
  // `markRead`, and the message router all push down the same per-window
  // chat channel, and that channel's sequence is what the renderer uses to
  // notice a dropped push. Two broadcaster instances would each number
  // their own sends and every second push would look like a gap.
  const chatBroadcaster = createElectronChatBroadcaster();
  const chatStreams = new ChatStreamRegistry({
    db,
    activityLog,
    broadcaster: chatBroadcaster,
  });

  // M11 row S1-8, §8.0: the Director's Supervisor, started here rather than
  // on first use because the Director is "the only always-warm agent
  // process". Starting spawns no engine: structured mode runs one engine
  // process per turn, and nothing wakes the Director yet. Not awaited — the
  // assign() probe takes seconds and the window must not wait on it. Its
  // adapter comes from createClaudeCodeAdapterFromSettings (inside
  // startDirector), so the user's hook timing applies (pre-M11 §F, S-1).
  void startDirector({
    db,
    activityLog,
    tokenRegistry,
    supervisorRegistry,
    controlChannelPort: controlChannelServer.assignedPort,
    baseDir: app.getPath('userData'),
    secretBroker,
    // M11 row S1-9: every engine process the Director spawns joins the Job
    // Object ensureJobObject() created at the top of main().
    containProcess,
    // M11 row S1-13: the Director's prose streams through the same registry
    // `chat.stop` and shutdown reach, and its broadcaster pushes it live.
    chatStreams,
    supervisorOptions: { pricing },
  })
    .then((result) => reportDirectorStart({ db, activityLog }, result))
    .catch((err: unknown) => console.error('[director] could not start', err));

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
    // §28 M9 item 3: how chat.stop reaches the live stream. Same "one
    // instance, constructed here, handed to everyone who needs it" rule as
    // the hold registry — a second registry would let a user press Stop,
    // be told it worked, and watch the reply keep arriving.
    chatStreams,
    // M9 session 2: `chat.send` and `chat.markRead` push too. Same
    // instance as above — see the comment on its construction.
    chatBroadcaster,
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
    new CheckpointSurfacer(db, { activityLog, broadcaster: chatBroadcaster }),
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
    // §J.4, closed in M9 session 2: a message addressed to `user` becomes a
    // real conversation message, and an open window has to see it arrive.
    chatBroadcaster,
  });

  const win = createMainWindow();
  wireStateDeltaOnLoad(win, db);

  // M9 — what keeps an open window current between loads. Before this, the
  // renderer hydrated on `did-finish-load` and never heard about a change
  // again. §9.4's chat card has to appear when a checkpoint is raised and
  // leave when it is answered, and both of those happen while the window
  // is sitting there.
  const stopLiveState = startLiveStateBroadcast(activityLog, db);

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
      // D-2: the employees stop first, through the same registry the
      // control channel and `/pause` address them by.
      supervisors: supervisorRegistry,
      controlChannelServer,
      resumeTick,
      checkpointTick,
      messageRouter,
      stopLiveState,
      chatStreams,
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
