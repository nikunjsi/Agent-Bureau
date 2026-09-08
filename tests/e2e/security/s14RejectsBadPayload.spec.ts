import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../../helpers/packagedApp';

/**
 * §11.7 S14 (`ipc_rejects_bad_payload`) — release-blocking, gates M2
 * (§28). "Malformed IPC is dropped and logged, never coerced." §4.2:
 * "An invalid payload is dropped and logged, never coerced."
 *
 * Driven against the real packaged app: calls `window.bureau.settings.set`
 * with a payload whose `key` is the wrong type — something no correctly
 * *typed* caller could construct (TypeScript would reject it at compile
 * time), which is exactly why this has to be tested by actually reaching
 * across the real IPC boundary via `page.evaluate`, not by calling a
 * TypeScript function directly.
 *
 * Handlers in `src/main/ipc/handlers/` also re-validate their own input
 * internally (defense in depth — see the M2 session notes) — the router's
 * own dedicated validation step (`src/main/ipc/router.ts`'s
 * `dispatchIpcCall`, matching §17.2 step 2's literal requirement) is what
 * this test and its mutation proof are specifically about: does malformed
 * input get cleanly rejected with `VALIDATION_FAILED` *before* reaching
 * any handler at all, rather than leaking through as a raw internal
 * error or (worse) being silently coerced into something the handler
 * accepts.
 */
test('S14: malformed IPC is dropped and logged as VALIDATION_FAILED, never coerced', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-s14-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const before = await win.evaluate(() => window.bureau.settings.get({}));
    expect(before.ok).toBe(true);

    // `key` must be a string per the real schema — 12345 is a deliberately
    // malformed payload no TypeScript-typed caller could construct.
    const malformed = await win.evaluate(() =>
      (window.bureau.settings.set as unknown as (input: unknown) => Promise<unknown>)({
        key: 12345,
        value: 'x',
      }),
    );
    expect(malformed).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });

    const after = await win.evaluate(() => window.bureau.settings.get({}));
    // Dropped, not coerced: every setting's value is byte-for-byte
    // unchanged, not "changed to something close enough."
    expect(after).toEqual(before);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
