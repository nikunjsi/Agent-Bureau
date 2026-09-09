/**
 * A real process that begins a real streamed reply and then waits to be
 * killed — the producer half of `chatAborted.spec.ts`.
 *
 * It uses the production `ChatStreamRegistry` against the app's own
 * database, appends text inside the ~500 ms throttle window (so the tail is
 * still in memory, exactly as it would be during a crash), announces
 * itself, and blocks forever. The parent SIGKILLs it and then launches the
 * real packaged app on the same directory.
 *
 * Modelled on `tests/integration/fixtures/dbKillWorker.ts` (M1's kill-point
 * harness), including the blocking stdin read: without it the process can
 * race past the intended kill point before the parent's signal — sent only
 * after it sees the marker over a real OS pipe — can arrive.
 */
import { readSync } from 'node:fs';
import { openConnection } from '../../../src/main/db/connection';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getDbPaths } from '../../../src/main/db/paths';
import { ChatStreamRegistry } from '../../../src/main/chat/chatStream';

async function main(): Promise<void> {
  const userDataDir = process.env['BUREAU_CHATKILL_USER_DATA_DIR'];
  const conversationId = process.env['BUREAU_CHATKILL_CONVERSATION_ID'];
  const migrationsDir = process.env['BUREAU_CHATKILL_MIGRATIONS_DIR'];
  if (!userDataDir || !conversationId || !migrationsDir) {
    throw new Error('chatStreamKillWorker: missing required BUREAU_CHATKILL_* env vars');
  }

  const paths = getDbPaths(userDataDir, migrationsDir);
  const db = openConnection(paths.dbPath);
  const activityLog = ActivityLog.open(paths.activityLogPath, db);
  const registry = new ChatStreamRegistry({ db, activityLog });

  const stream = registry.begin({ conversationId });
  // Part one, then a real wait past the ~500 ms throttle so it is genuinely
  // persisted — this is the text that must survive the kill.
  stream.append('You could keep the recipes as plain files, which means');
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Part two, inside a fresh window and therefore still in memory. This is
  // the text that must NOT survive, and its absence is exactly why the
  // marker matters: what is left reads as a finished sentence.
  stream.append(' no server to run and nothing to pay for.');

  process.stdout.write(`STREAMING ${stream.messageId}\n`);
  const buffer = Buffer.alloc(1);
  try {
    readSync(0, buffer, 0, 1, null);
  } catch {
    // stdin closed — we were killed mid-read, which is the intent.
  }
}

void main();
