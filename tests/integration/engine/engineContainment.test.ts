import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import { ENGINE_NOT_CONTAINED_MESSAGE } from '../../../src/main/engine/containEngineChild';
import type { AgentEvent } from '../../../src/shared/engine/events';
import type { EngineAdapter } from '../../../src/shared/engine/adapter';
import { adapterTestContext } from '../../helpers/adapterContext';

const SCRIPTED_CLI = path.resolve('tests/helpers/scriptedPtyCli.cjs');

/**
 * Every engine process is put in Bureau's Job Object the moment it exists
 * (M11 row S1-9; pre-M11 §F, P-10). `containProcess()` had no production
 * caller: engine children died with Bureau only because libuv puts every
 * non-detached child in its own kill-on-close job, which covers nothing
 * the engine spawns detached. The real adapters are driven here, with
 * Node standing in for the engine binary so each turn is a real process.
 *
 * If containment fails, the process is killed at once and the turn ends
 * with a plain error (invariant #6): an engine Bureau cannot guarantee to
 * stop must not run.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

/** Collects events in the background until one matches. */
function watch(adapter: EngineAdapter) {
  const seen: AgentEvent[] = [];
  let stopped = false;
  void (async () => {
    for await (const event of adapter.events()) {
      if (stopped) break;
      seen.push(event);
    }
  })();
  return {
    seen,
    stop: () => {
      stopped = true;
    },
  };
}

describe('engine processes are contained the moment they are spawned', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  function claudeAdapterWith(containProcess: (pid: number) => void) {
    let launches = 0;
    const adapter = new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: () => {
        launches += 1;
        return path.resolve('dist/resources/bin/bureau-hook.js');
      },
      // Node as the "engine": `-p <text>` evaluates the text, so the turn
      // below is a real process that stays alive for a minute.
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: process.execPath }),
      containProcess,
    });
    cleanups.push(() => adapter.stop());
    return { adapter, launches: () => launches };
  }

  const LONG_TURN = 'setTimeout(()=>{},60000)';

  it('claude-code: each per-turn process is contained, by its own pid', async () => {
    const contained: number[] = [];
    const { adapter } = claudeAdapterWith((pid) => contained.push(pid));
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    await adapter.start(ctx);
    await adapter.buildLaunchSpec(ctx);

    await adapter.send(LONG_TURN, 'task');

    expect(await waitFor(() => contained.length === 1, 5_000)).toBe(true);
    expect(isAlive(contained[0]!)).toBe(true);
  }, 20_000);

  it('claude-code: when containment fails the process is killed and the turn ends with a plain error', async () => {
    let pid = 0;
    const { adapter, launches } = claudeAdapterWith((p) => {
      pid = p;
      throw new Error('AssignProcessToJobObject failed');
    });
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    await adapter.start(ctx);
    await adapter.buildLaunchSpec(ctx);
    const events = watch(adapter);
    cleanups.push(async () => events.stop());
    const before = launches();

    await adapter.send(LONG_TURN, 'task');
    // Queued behind the failed turn: it must not be launched by it.
    await adapter.send(LONG_TURN, 'task');

    expect(await waitFor(() => pid !== 0, 5_000)).toBe(true);
    expect(await waitFor(() => !isAlive(pid), 5_000), 'the uncontained process kept running').toBe(
      true,
    );
    expect(
      await waitFor(
        () =>
          events.seen.some(
            (e) =>
              e.t === 'finished' &&
              e.reason === 'error' &&
              e.summary === ENGINE_NOT_CONTAINED_MESSAGE,
          ),
        5_000,
      ),
    ).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(launches() - before, 'a queued send was launched after the containment failure').toBe(1);
  }, 20_000);

  it('generic-pty: the session process is contained, and killed if containment fails', async () => {
    let pid = 0;
    const adapter = new GenericPtyAdapter({
      containProcess: (p) => {
        pid = p;
        throw new Error('AssignProcessToJobObject failed');
      },
    });
    cleanups.push(() => adapter.stop());
    const ctx = adapterTestContext('generic-pty', {
      command: process.execPath,
      args: [SCRIPTED_CLI],
      ready_pattern: '(?:^|\\r|\\n)>[^\\r\\n]*$',
      done_pattern: '\\[done\\]',
      interrupt: '\x03',
      ready_debounce_ms: 100,
    });
    await adapter.start(ctx);
    const events = watch(adapter);
    cleanups.push(async () => events.stop());

    await adapter.send('first', 'task');

    expect(await waitFor(() => pid !== 0, 5_000)).toBe(true);
    expect(await waitFor(() => !isAlive(pid), 5_000), 'the uncontained session kept running').toBe(
      true,
    );
    expect(
      await waitFor(
        () =>
          events.seen.some(
            (e) =>
              e.t === 'finished' &&
              e.reason === 'error' &&
              e.summary === ENGINE_NOT_CONTAINED_MESSAGE,
          ),
        5_000,
      ),
    ).toBe(true);
  }, 20_000);
});
