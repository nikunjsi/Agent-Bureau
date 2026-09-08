import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalBroadcaster } from '../../../src/main/engine/terminalBroadcaster';

describe('TerminalBroadcaster (§17.1/§17.2 M3 step 8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple feed() calls within ~16ms into one terminalChunk emission', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    const received: string[] = [];
    broadcaster.attach((chunk) =>
      received.push(Buffer.from(chunk.base64, 'base64').toString('utf8')),
    );

    broadcaster.feed(Buffer.from('a'));
    broadcaster.feed(Buffer.from('b'));
    broadcaster.feed(Buffer.from('c'));
    expect(received).toEqual([]); // nothing emitted yet — still coalescing

    vi.advanceTimersByTime(16);
    expect(received).toEqual(['abc']); // one emission, not three
  });

  it('a second burst after the first coalesce window closes produces a second, separate chunk with the next seq', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    const received: Array<{ text: string; seq: number }> = [];
    broadcaster.attach((chunk) =>
      received.push({ text: Buffer.from(chunk.base64, 'base64').toString('utf8'), seq: chunk.seq }),
    );

    broadcaster.feed(Buffer.from('first'));
    vi.advanceTimersByTime(16);
    broadcaster.feed(Buffer.from('second'));
    vi.advanceTimersByTime(16);

    expect(received).toEqual([
      { text: 'first', seq: 1 },
      { text: 'second', seq: 2 },
    ]);
  });

  it('a window attaching mid-session replays the ring buffer instead of starting blank', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    broadcaster.feed(Buffer.from('earlier output'));
    broadcaster.flushNow();

    const { replay } = broadcaster.attach(() => {});
    expect(replay).not.toBeNull();
    expect(Buffer.from(replay!.base64, 'base64').toString('utf8')).toBe('earlier output');
    expect(replay!.resync).toBe(false);
  });

  it('attaching to a fresh employee with no history yet gets no replay (not an empty-string chunk)', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    const { replay } = broadcaster.attach(() => {});
    expect(replay).toBeNull();
  });

  it('a reconnecting subscriber whose missed data has aged out of the ring buffer gets a resync marker, not a silent gap', () => {
    // Tiny cap so a handful of writes overflows it deterministically.
    const broadcaster = new TerminalBroadcaster('emp1', { ringBufferCapBytes: 8 });
    broadcaster.feed(Buffer.from('0123456789ABCDEF')); // 16 bytes, well over the 8-byte cap
    broadcaster.flushNow();

    // Claims to already have everything up through seq 0 (i.e. nothing) —
    // fine. But claiming fromSeq far in the past, before anything still
    // buffered, must trigger resync.
    const { replay } = broadcaster.attach(() => {}, -5);
    expect(replay?.resync).toBe(true);
  });

  it('two independent subscribers on the same employee both receive the same coalesced chunk (two windows, one employee)', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    const windowA: string[] = [];
    const windowB: string[] = [];
    broadcaster.attach((chunk) => windowA.push(chunk.base64));
    broadcaster.attach((chunk) => windowB.push(chunk.base64));

    broadcaster.feed(Buffer.from('shared'));
    vi.advanceTimersByTime(16);

    expect(windowA).toHaveLength(1);
    expect(windowB).toHaveLength(1);
    expect(windowA).toEqual(windowB);
  });

  it('unsubscribe stops future delivery to that window without affecting the other', () => {
    const broadcaster = new TerminalBroadcaster('emp1');
    const windowA: string[] = [];
    const windowB: string[] = [];
    const { unsubscribe: unsubA } = broadcaster.attach((chunk) => windowA.push(chunk.base64));
    broadcaster.attach((chunk) => windowB.push(chunk.base64));

    unsubA();
    broadcaster.feed(Buffer.from('after unsubscribe'));
    vi.advanceTimersByTime(16);

    expect(windowA).toHaveLength(0);
    expect(windowB).toHaveLength(1);
  });

  describe('read-only by default (§14.5)', () => {
    it('sendInput is refused with no controller — the default, safe state', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      const sink = vi.fn();
      // No takeControl() call at all.
      const delivered = broadcaster.sendInput('window-1', 'ls\r');
      expect(delivered).toBe(false);
      expect(sink).not.toHaveBeenCalled();
    });

    it('takeControl grants exactly the caller write access; sendInput then reaches the sink', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      const sink = vi.fn();
      expect(broadcaster.takeControl('window-1', sink)).toBe(true);
      expect(broadcaster.isControlled).toBe(true);

      expect(broadcaster.sendInput('window-1', 'ls\r')).toBe(true);
      expect(sink).toHaveBeenCalledWith('ls\r');
    });

    it('a second window cannot take control while another already holds it', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      broadcaster.takeControl('window-1', () => {});
      expect(broadcaster.takeControl('window-2', () => {})).toBe(false);
    });

    it('sendInput from a window that does not hold control is refused, even while someone else does', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      const sink = vi.fn();
      broadcaster.takeControl('window-1', sink);
      expect(broadcaster.sendInput('window-2', 'sneaky\r')).toBe(false);
      expect(sink).not.toHaveBeenCalled();
    });

    it('releaseControl by a non-holder is a no-op; the real holder can still release afterwards', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      broadcaster.takeControl('window-1', () => {});
      broadcaster.releaseControl('window-2'); // not the holder
      expect(broadcaster.isControlled).toBe(true);

      broadcaster.releaseControl('window-1');
      expect(broadcaster.isControlled).toBe(false);
    });

    it('after release, sendInput from the former controller is refused again — read-only is the resting state', () => {
      const broadcaster = new TerminalBroadcaster('emp1');
      const sink = vi.fn();
      broadcaster.takeControl('window-1', sink);
      broadcaster.releaseControl('window-1');
      expect(broadcaster.sendInput('window-1', 'ls\r')).toBe(false);
      expect(sink).not.toHaveBeenCalled();
    });
  });
});
