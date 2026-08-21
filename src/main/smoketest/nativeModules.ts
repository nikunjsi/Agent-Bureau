import { app } from 'electron';
import Database from 'better-sqlite3';
import * as pty from 'node-pty';
import { writeResult } from './result';

/**
 * Gate 3: `better-sqlite3` and `node-pty` must load and actually work
 * *inside the packaged app* — proving they were rebuilt against Electron's
 * ABI, not just present in node_modules. Run only when
 * `BUREAU_SMOKETEST=native`, from the packaged exe, by the integration test
 * in tests/integration/native-modules.test.ts.
 */
export async function runNativeModulesSmoketest(): Promise<void> {
  try {
    await checkBetterSqlite3();
    await checkNodePty();
    writeResult({ ok: true });
    app.exit(0);
  } catch (error) {
    writeResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    app.exit(1);
  }
}

async function checkBetterSqlite3(): Promise<void> {
  const db = new Database(':memory:');
  try {
    const row = db.prepare('SELECT 1 + 1 AS n').get() as { n: number } | undefined;
    if (row?.n !== 2) {
      throw new Error(`better-sqlite3: unexpected query result ${JSON.stringify(row)}`);
    }
  } finally {
    db.close();
  }
}

async function checkNodePty(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let out = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('node-pty: timed out waiting for output'));
      }
    }, 10_000);

    const proc = pty.spawn('cmd.exe', ['/c', 'echo hi'], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
    });

    proc.onData((chunk: string) => {
      out += chunk;
    });

    proc.onExit(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!out.includes('hi')) {
        reject(new Error(`node-pty: unexpected output ${JSON.stringify(out)}`));
      } else {
        resolve();
      }
    });
  });
}
