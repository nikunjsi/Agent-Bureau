/**
 * The worker driven by tests/integration/controlChannel/coreDiesMidHold.test.ts
 * — "THE TEST THAT MATTERS MOST" (M4 session 1 prompt): a real Core process,
 * killed for real while it holds a /v1/policy/check open, must leave the
 * caller with a denial, never a silent allow. Runs as a plain Node process
 * (no Electron needed, same reasoning as dbKillWorker.ts) hosting a real
 * ControlChannelServer with one tool name (HOLD_ME) wired to an injected
 * evaluator that returns 'ask' — nothing in the real interim evaluator ever
 * does, so this is the only way to reach the hold path at all this session.
 *
 * Prints `READY <port> <token> <employeeId>` once listening, then prints
 * `PENDING_COUNT <n>` every time the number of held policy checks changes —
 * the parent test's only window into this process's internal state, since
 * it lives in a different process by design (the whole point is to kill it
 * for real). The parent kills this process outright once it sees the hold
 * actually register; nothing here ever exits on its own.
 */
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { PolicyHoldRegistry } from '../../../src/main/controlChannel/policyHoldRegistry';
import { evaluateInterimPolicy } from '../../../src/main/controlChannel/policyEvaluator';
import { newId } from '../../../src/shared/models/ids';

const HOLD_TOOL = 'HOLD_ME';

async function main(): Promise<void> {
  const dbPath = process.env['BUREAU_CONTROLTEST_DB_PATH'];
  const activityLogPath = process.env['BUREAU_CONTROLTEST_ACTIVITY_LOG_PATH'];
  const migrationsDir = process.env['BUREAU_CONTROLTEST_MIGRATIONS_DIR'];
  const backupsDir = process.env['BUREAU_CONTROLTEST_BACKUPS_DIR'];
  if (!dbPath || !activityLogPath || !migrationsDir || !backupsDir) {
    throw new Error('controlChannelWorker: missing required BUREAU_CONTROLTEST_* env vars');
  }

  const db = openConnection(dbPath);
  await runMigrations({ db, dbPath, migrationsDir, backupsDir });
  const activityLog = ActivityLog.open(activityLogPath, db);

  const tokenRegistry = new TokenRegistry();
  const policyHoldRegistry = new PolicyHoldRegistry();
  const employeeId = newId();
  const token = tokenRegistry.mint(employeeId);

  const server = new ControlChannelServer({
    activityLog,
    tokenRegistry,
    policyHoldRegistry,
    maxHoldMinutes: 30, // real default — this test proves the kill wins long before any timeout would
    evaluatePolicy: async (request) => {
      if (request.tool === HOLD_TOOL) return 'ask';
      return evaluateInterimPolicy(request.tool);
    },
  });

  const port = await server.start();
  process.stdout.write(`READY ${port} ${token} ${employeeId}\n`);

  let lastReported = -1;
  setInterval(() => {
    const current = policyHoldRegistry.pendingCount;
    if (current !== lastReported) {
      lastReported = current;
      process.stdout.write(`PENDING_COUNT ${current}\n`);
    }
  }, 20);

  // Never resolves — this process only ever ends by being killed, which is
  // the entire point of the test driving it.
  await new Promise(() => {});
}

main().catch((err) => {
  process.stderr.write(`controlChannelWorker failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
