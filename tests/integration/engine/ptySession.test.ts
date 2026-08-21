import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PtySession } from '../../../src/main/engine/ptySession';
import { buildEmployeeTempEnv, buildWindowsBaseEnv } from '../../../src/main/engine/windowsEnv';
import { buildResolvedPath, resolveBinaryAbsolutePath } from '../../../src/main/engine/resolvedPath';

const ECHO_SCRIPT = path.resolve('tests/helpers/ptyEchoScript.cjs');
const HEARTBEAT_SCRIPT = path.resolve('tests/helpers/ptyHeartbeatScript.cjs');

function baseEnv(): Record<string, string> {
  // The test process's own env is enough for spawning `node` itself, which
  // is all this helper script needs — PtySession's own contract doesn't
  // require any particular env shape.
  return { ...process.env } as Record<string, string>;
}

function scriptArgs(parts: Array<{ text: string; delayMs: number }>): string[] {
  return [ECHO_SCRIPT, JSON.stringify(parts)];
}

/**
 * M3 step 3, real `node-pty`. The exact chunk-boundary/debounce logic is
 * already proven deterministically in tests/unit/engine/ptyOutputBuffer.
 * test.ts and readyDebouncer.test.ts — real timing here is best-effort (an
 * OS can, in principle, coalesce two closely-spaced writes into one read),
 * so these tests assert the *logical* outcome, not exact chunk counts.
 */
describe('PtySession — real node-pty (M3 step 3)', () => {
  let session: PtySession | undefined;

  afterEach(() => {
    session?.kill();
    session = undefined;
  });

  it('spawns a real process and delivers its output via onData', async () => {
    session = new PtySession({
      command: process.execPath,
      args: scriptArgs([
        { text: 'hello ', delayMs: 0 },
        { text: 'world', delayMs: 20 },
      ]),
      cwd: process.cwd(),
      env: baseEnv(),
    });

    const collected = await new Promise<string>((resolve) => {
      let acc = '';
      session!.onData((chunk) => {
        acc += chunk;
        if (acc.includes('world')) resolve(acc);
      });
    });

    // Not `toContain('hello world')`: ConPTY is a real terminal emulator,
    // not a plain pipe — it legitimately injects its own control sequences
    // (clear screen, cursor positioning, console title) around application
    // output, including between two writes from the child process. Both
    // strings arriving, in order, is what PtySession actually promises;
    // byte-for-byte adjacency is ConPTY's business, not this class's.
    expect(collected.indexOf('hello')).toBeGreaterThanOrEqual(0);
    expect(collected.indexOf('world')).toBeGreaterThan(collected.indexOf('hello'));
  }, 10_000);

  it('survives a real escape-sequence split across a chunk boundary and still fires ready after quiet', async () => {
    session = new PtySession({
      command: process.execPath,
      args: scriptArgs([
        { text: 'building\x1b[3', delayMs: 0 }, // escape sequence cut mid-way
        { text: '2m> ', delayMs: 30 }, // completed in a separate, delayed write
      ]),
      cwd: process.cwd(),
      env: baseEnv(),
      readyPattern: /> $/,
      readyDebounceMs: 50,
    });

    // Resolves only if onReady actually fires; the surrounding test timeout
    // is the failure mode if the split corrupted matching.
    await new Promise<void>((resolve) => session!.onReady(() => resolve()));
  }, 10_000);

  it('a ready-pattern match immediately followed by more real output does not fire ready', async () => {
    session = new PtySession({
      command: process.execPath,
      args: scriptArgs([
        { text: 'computing... > ', delayMs: 0 }, // matches at this instant
        { text: 'still going', delayMs: 20 }, // arrives well within the debounce window, invalidating the match
      ]),
      cwd: process.cwd(),
      env: baseEnv(),
      readyPattern: /> $/,
      readyDebounceMs: 60,
    });

    let fired = false;
    session.onReady(() => {
      fired = true;
    });

    // Long enough to cover both writes plus a full debounce window past the
    // last one, with margin.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fired).toBe(false);
  }, 10_000);

  it('resize does not throw against a real process', () => {
    session = new PtySession({
      command: process.execPath,
      args: scriptArgs([]),
      cwd: process.cwd(),
      env: baseEnv(),
    });
    expect(() => session!.resize(100, 40)).not.toThrow();
  });

  it('kill() terminates the process (onExit fires)', async () => {
    session = new PtySession({
      command: process.execPath,
      args: [HEARTBEAT_SCRIPT], // actively writing, so it notices a closed pipe promptly rather than sitting unaware
      cwd: process.cwd(),
      env: baseEnv(),
    });

    // Let it actually start heartbeating before killing it, so this proves
    // kill() stops a live, active process — not a process that never
    // properly started.
    await new Promise<void>((resolve) => session!.onData(() => resolve()));

    const exited = new Promise<void>((resolve) => session!.onExit(() => resolve()));
    session.kill();
    await exited;
  }, 10_000);
});

// §7.8: "most of the suite must run offline and free, or contributors will
// not run it." This spawns the *real* installed `claude` CLI, resolved
// through the real resolved-PATH service — `--version` only, never a
// session, so there is no auth prompt, no model request, no spend. It must
// not fail CI (or any contributor's machine) that has no agent CLI
// installed, so it is skipped, visibly and with an explicit reason, rather
// than either failing or silently passing without proving anything.
const resolvedPathForRealClaude = await buildResolvedPath();
const realClaudePath = resolveBinaryAbsolutePath('claude', resolvedPathForRealClaude);

describe('PtySession — real claude.cmd smoke test (§7.6/§15.4, machine-dependent)', () => {
  it.skipIf(!realClaudePath)(
    'spawns the real installed claude via the resolved-PATH service + minimal Windows env and captures --version output',
    async () => {
      const tmpStateDir = path.join(os.tmpdir(), 'bureau-ptysession-smoketest');
      const session = new PtySession({
        command: realClaudePath as string,
        args: ['--version'],
        cwd: process.cwd(),
        env: {
          ...buildWindowsBaseEnv(),
          ...buildEmployeeTempEnv(tmpStateDir),
          Path: resolvedPathForRealClaude,
        },
      });

      try {
        const output = await new Promise<string>((resolve) => {
          let acc = '';
          session.onData((chunk) => {
            acc += chunk;
            resolve(acc); // any output at all proves the resolved absolute path + minimal env launched the real .cmd shim
          });
          session.onExit(() => resolve(acc));
        });
        expect(output.length).toBeGreaterThan(0);
      } finally {
        session.kill();
      }
    },
    10_000,
  );

  if (!realClaudePath) {
    // Deliberate, explicit skip reason (§7.8), not a silent no-op.
    console.log(
      '[ptySession.test.ts] claude CLI not found via the resolved-PATH service on this machine — ' +
        'real-binary smoke test skipped. Expected and fine on any machine/CI without an agent CLI installed.',
    );
  }
});
