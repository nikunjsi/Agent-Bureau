import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';

/**
 * AUDIT M0–M2 #22 — the production half of §17.2's rate limit.
 *
 * `ipcRateLimit.test.ts` proves the bucket and the dispatcher, but it
 * injects the limiter by hand — so deleting the one line in
 * `registerIpcRouter` that passes the real limiter in would leave it green
 * while the shipped app limited nothing (standing rule 2: a guard is not a
 * guard until something on the real path calls it).
 *
 * This fires a loop at `chat.send` from the real renderer, over the real
 * preload, into the real router. The payload is deliberately empty: the
 * limit is checked before validation, so a malformed loop is bounded too,
 * and no conversation or Director is needed to reach it.
 */
test('a renderer loop against chat.send is refused with RATE_LIMITED in the packaged app', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-ratelimit-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const codes = await win.evaluate(async () => {
      const send = window.bureau.chat.send as unknown as (
        input: unknown,
      ) => Promise<{ ok: boolean; error?: { code: string } }>;
      const out: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = await send({});
        out.push(r.ok ? 'ok' : (r.error?.code ?? 'unknown'));
      }
      return out;
    });

    expect(codes, 'forty back-to-back calls were never rate limited').toContain('RATE_LIMITED');
    // And the first calls were NOT limited — they reached validation and
    // were refused for their empty payload, which is how a real person's
    // first call behaves.
    expect(codes[0]).toBe('VALIDATION_FAILED');
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
