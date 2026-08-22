import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';

/**
 * §7.8 test 1 / §7.1: "probe() returns within 5s and never throws,
 * including when the binary is absent." M3 session 2's prompt asks all
 * three failure cases to be tested explicitly, not just the happy path.
 */
describe('ClaudeCodeAdapter.probe() — three failure cases (§7.8 test 1)', () => {
  it('binary absent: never throws, returns installed:false with a readable error, well under 5s', async () => {
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: null }),
    });
    const start = Date.now();
    const result = await adapter.probe();
    const elapsedMs = Date.now() - start;

    expect(result.installed).toBe(false);
    expect(result.authenticated).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.metered).toBe(true); // §24.5 safe direction
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('binary present but hanging: never throws, still returns within 5s (the hard deadline actually fires)', async () => {
    // A real OS process that hangs on exactly `--version` (the adapter's
    // fixed argv — not configurable per test) turned out to have no
    // reliable, portable answer on Windows (tried several standalone
    // executables; each either resolved instantly or wasn't found) — an
    // *injected never-resolving promise* proves the exact thing this test
    // is actually about (withTimeout()'s deadline firing) more directly
    // than fighting real process semantics would have.
    const neverResolves = new Promise<string>(() => {});
    const adapter = new ClaudeCodeAdapter({
      resolveBinary: async () => ({ resolvedPathString: '', binaryPath: 'C:\\fake\\claude.exe' }),
      runVersionCheck: () => neverResolves,
    });
    const start = Date.now();
    const result = await adapter.probe();
    const elapsedMs = Date.now() - start;

    expect(result.installed).toBe(false);
    expect(result.error).toContain('5s');
    expect(result.metered).toBe(true);
    // The real proof this test exists for: it did NOT hang forever
    // waiting on a promise that never resolves — it fired right at the
    // 5000ms deadline (observed: ~5011ms; the margin here is just
    // Promise/event-loop settling overhead, not slack in the deadline
    // itself), not early and not indefinitely late.
    expect(elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(elapsedMs).toBeLessThan(5200);
  }, 10_000);

  describe('binary present but unauthenticated', () => {
    let tempConfigDir: string;
    let originalConfigDir: string | undefined;

    afterEach(() => {
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
      if (tempConfigDir) rmSync(tempConfigDir, { recursive: true, force: true });
    });

    it('never throws, returns installed:true, authenticated:false — verified against a real fresh CLAUDE_CONFIG_DIR, not simulated', async () => {
      // §7.6's empirical check A (M3 session 2) proved CLAUDE_CONFIG_DIR
      // genuinely isolates auth state (a fresh dir starts logged out; the
      // real ~/.claude.json is untouched) — this test relies on exactly
      // that proof, applied here rather than re-derived.
      tempConfigDir = mkdtempSync(path.join(tmpdir(), 'bureau-probe-unauth-'));
      originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = tempConfigDir;

      const adapter = new ClaudeCodeAdapter();
      const start = Date.now();
      const result = await adapter.probe();
      const elapsedMs = Date.now() - start;

      expect(result.installed).toBe(true); // the real binary was found and --version worked
      expect(result.authenticated).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.metered).toBe(true); // safe direction — no confirmed subscription
      expect(elapsedMs).toBeLessThan(5000);
    }, 10_000);
  });

  it('the real machine, with real auth, reports authenticated:true and metered:false (this dev box has a Pro subscription)', async () => {
    const adapter = new ClaudeCodeAdapter();
    const result = await adapter.probe();
    expect(result.installed).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.metered).toBe(false);
    expect(result.binaryPath).toBeTruthy();
    expect(result.version).toBeTruthy();
  }, 10_000);
});
