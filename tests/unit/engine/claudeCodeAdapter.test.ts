import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import type { ProbeResult } from '../../../src/shared/engine/types';

/**
 * §7.1 correction 1 (M3 session 3): capabilities(probe, mode) must give a
 * different, honest answer for mode:'pty' than for the unset/'structured'
 * default — that was the whole point of taking mode as an explicit
 * parameter instead of reading adapter-internal state. No test asserted
 * this directly until now (M3->M4 boundary check, part 2/3, mutation d) —
 * confirmed missing by temporarily reintroducing the exact mutation
 * ("return the structured branch regardless of the mode argument"): this
 * file is what failed, nothing else in the suite noticed at all.
 */
describe('ClaudeCodeAdapter.capabilities() is mode-aware (§7.1 correction 1)', () => {
  const fakeProbe = {} as ProbeResult;

  it('mode:"pty" returns the honest, reduced set — not the structured default', () => {
    const adapter = new ClaudeCodeAdapter();
    const caps = adapter.capabilities(fakeProbe, 'pty');

    // §7.7.1: PTY mode cannot report usage — nothing to scrape it from.
    expect(caps.usageReporting).toBe(false);
    // No session id is ever captured without content parsing.
    expect(caps.sessionResume).toBe(false);
    // No structured tool-call objects in PTY mode.
    expect(caps.structuredEvents).toBe(false);
    // Bureau assembles no request payload of its own in PTY mode.
    expect(caps.promptCaching).toBe(false);
    // The one place PTY's real capability is BETTER than structured's:
    // \x03-into-ConPTY interrupt is genuinely verified.
    expect(caps.interrupt).toBe(true);
  });

  it('mode unset (engine-level, what §7.3 auto-selection asks) returns the structured, optimistic answer', () => {
    const adapter = new ClaudeCodeAdapter();
    const caps = adapter.capabilities(fakeProbe);

    expect(caps.usageReporting).toBe(true);
    expect(caps.sessionResume).toBe(true);
    expect(caps.structuredEvents).toBe(true);
    expect(caps.promptCaching).toBe(true);
    // Structured mode cannot achieve a real interrupt on Windows
    // (child.kill('SIGINT') is a hard kill).
    expect(caps.interrupt).toBe(false);
  });

  it('mode:"structured" explicitly gives the same answer as unset', () => {
    const adapter = new ClaudeCodeAdapter();
    expect(adapter.capabilities(fakeProbe, 'structured')).toEqual(adapter.capabilities(fakeProbe));
  });

  it('the two branches genuinely differ — not the same object reused, which would silently defeat this whole test file', () => {
    const adapter = new ClaudeCodeAdapter();
    const structured = adapter.capabilities(fakeProbe);
    const pty = adapter.capabilities(fakeProbe, 'pty');
    expect(structured).not.toEqual(pty);
  });
});
