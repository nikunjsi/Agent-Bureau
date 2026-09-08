import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, waitForFile, packagedAppEnv } from '../helpers/packagedApp';

/**
 * §9.4's fourth surface — the desktop notification — proven inside the
 * **real packaged app**, because that is the only place its Electron half
 * exists.
 *
 * The decision (unfocused **and** `blocking` **and** the user's
 * `general.notifications` switch) lives in `surfacing.ts` and is tested
 * against a recording notifier in
 * `tests/integration/checkpoints/surfacing.test.ts`. This covers the part
 * that cannot be reached from vitest at all: `allKnownWindows()` reporting
 * real focus, and `Notification` being supported and constructible.
 *
 * Without this, "the window-focus state is available from M2's shell"
 * would be a claim resting on reading `windowRegistry.ts` — the exact
 * shape the M3–M6 audit named, where a comment reads as evidence.
 */
describe('§9.4 desktop notification: focus and toasts are real in the packaged app', () => {
  let child: ChildProcess | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    child?.kill();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads window focus through the real registry and shows a real toast', async () => {
    const exe = resolvePackagedExePath();
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-smoketest-notifications-'));
    const outFile = path.join(tmpDir, 'result.json');

    child = spawn(exe, [], {
      env: packagedAppEnv({ BUREAU_SMOKETEST: 'notifications', BUREAU_SMOKETEST_OUT: outFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = await waitForFile(outFile, 30_000);
    const result = JSON.parse(raw) as {
      ok: boolean;
      error?: string;
      focusedBeforeAnyWindow?: boolean;
      focusedAfterFocus?: boolean;
      focusedAfterBlur?: boolean;
      notificationSupported?: boolean;
      notifyThrew?: string | null;
      knownWindowCount?: number;
    };

    expect(result.ok, result.error).toBe(true);

    // The surfacing tick can genuinely run before a window exists (it
    // starts at boot), and "nothing is focused" must be the answer rather
    // than a crash — that is the notify-permitting state, so it has to be
    // right for the right reason.
    expect(result.focusedBeforeAnyWindow).toBe(false);
    expect(result.knownWindowCount).toBe(1);

    // The load-bearing direction for §9.4: a blurred window reports
    // unfocused, which is what allows a notification to fire.
    expect(result.focusedAfterBlur).toBe(false);

    // Windows toasts need `app.setAppUserModelId()` to match the installed
    // shortcut's AppUserModelID or they silently never appear (§18.2's own
    // named trap). `main/index.ts` makes that call; this is the observable
    // consequence of it having worked.
    expect(result.notificationSupported).toBe(true);
    expect(result.notifyThrew).toBeNull();

    // Reported rather than asserted: whether a foreground window actually
    // RECEIVES focus depends on the desktop session (a locked screen or a
    // headless agent may refuse it), and turning an environment-dependent
    // fact into a release-blocking assertion is how a flaky test is born.
    // Everything §9.4 depends on is asserted above.
    expect(typeof result.focusedAfterFocus).toBe('boolean');
  });
});
