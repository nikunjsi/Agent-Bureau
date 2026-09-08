/**
 * §17.1/§17.2 M3 step 8: the mechanism behind `on.terminalChunk`. One
 * instance per employee, owned by that employee's Supervisor (mirroring
 * TranscriptWriter's own per-employee ownership) — fed raw PTY bytes as
 * they arrive, and read by however many renderer windows currently have
 * that employee's Terminal tab open.
 *
 * Four properties, each with its own reason to exist:
 *
 *  - Coalescing (~16ms): a verbose build can write hundreds of small PTY
 *    chunks a second. One `terminalChunk` IPC message per byte-chunk would
 *    flood the renderer; batching everything received within one ~16ms
 *    window into a single emission (§17.1's own comment: "coalesced
 *    ~16ms") keeps the channel usable without losing any bytes.
 *  - Monotonic seq + ring-buffer replay: a window that opens the Terminal
 *    tab mid-task must not start blank (§14.5) — attach() replays
 *    whatever's still in the ring buffer, tagged with the seq it actually
 *    carries, not seq 0..N invented for the replay. A late/reconnecting
 *    subscriber that's missed too much (its last-known seq has aged out
 *    of the buffer) gets a `resync` marker instead of pretending to have
 *    the gap.
 *  - Multi-window fanout: two windows can have the same employee's
 *    Terminal tab open at once. Each is an independent subscriber; a
 *    chunk reaches all of them from one coalesced write, not duplicated
 *    per-subscriber work upstream.
 *  - Read-only by default: sendInput() is refused unless control has been
 *    explicitly taken (§14.5 — "take control" first calls interrupt(),
 *    then blocks Bureau's own send() until control is released). Exactly
 *    one controller at a time; a second takeControl() while one is
 *    already held is refused, not silently reassigned.
 */

export interface TerminalChunkPayload {
  employeeId: string;
  seq: number;
  base64: string;
  resync: boolean;
}

export interface TerminalBroadcasterOptions {
  /** Real default: 16ms (§17.1). Injectable so tests don't need real wall-clock timing. */
  coalesceMs?: number;
  /** Real default: 256 KiB — comfortably more than a terminal screenful of scrollback, small enough to bound memory per employee. */
  ringBufferCapBytes?: number;
}

type Unsubscribe = () => void;

const DEFAULT_COALESCE_MS = 16;
const DEFAULT_RING_BUFFER_CAP_BYTES = 256 * 1024;

export class TerminalBroadcaster {
  private readonly employeeId: string;
  private readonly coalesceMs: number;
  private readonly ringBufferCapBytes: number;

  private ringBuffer: Buffer = Buffer.alloc(0);
  /** seq of the NEXT chunk to be emitted. */
  private nextSeq = 1;
  /** The seq of the oldest byte still present in ringBuffer, so a replay/resync decision can tell what's actually recoverable. */
  private oldestBufferedSeq = 1;

  private pendingParts: Buffer[] = [];
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly subscribers = new Set<(chunk: TerminalChunkPayload) => void>();

  /** Read-only by default (§14.5) — null means no controller holds write access. */
  private controllerId: string | null = null;
  private inputSink: ((data: string) => void) | null = null;

  constructor(employeeId: string, options: TerminalBroadcasterOptions = {}) {
    this.employeeId = employeeId;
    this.coalesceMs = options.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.ringBufferCapBytes = options.ringBufferCapBytes ?? DEFAULT_RING_BUFFER_CAP_BYTES;
  }

  /** Feed raw bytes (from AgentEvent{t:'raw'}) — call on every chunk; coalescing happens internally. */
  feed(data: Buffer): void {
    this.pendingParts.push(data);
    if (this.coalesceTimer) return;
    this.coalesceTimer = setTimeout(() => this.flush(), this.coalesceMs);
  }

  /** Forces any pending coalesced bytes out immediately — used by stop()/tests, not normal operation. */
  flushNow(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
    this.flush();
  }

  private flush(): void {
    this.coalesceTimer = null;
    if (this.pendingParts.length === 0) return;
    const combined = Buffer.concat(this.pendingParts);
    this.pendingParts = [];

    const seq = this.nextSeq;
    this.nextSeq += 1;

    this.ringBuffer = Buffer.concat([this.ringBuffer, combined]);
    if (this.ringBuffer.length > this.ringBufferCapBytes) {
      const overflow = this.ringBuffer.length - this.ringBufferCapBytes;
      this.ringBuffer = this.ringBuffer.subarray(overflow);
      // Bytes aged out — the oldest seq still fully recoverable moves
      // forward. Conservative: treats the whole dropped region as
      // belonging to seq < the new oldest, which is always safe (never
      // claims a chunk is replayable when it partially isn't).
      this.oldestBufferedSeq = seq; // this flush's own bytes are always the newest, always present
    }

    const payload: TerminalChunkPayload = {
      employeeId: this.employeeId,
      seq,
      base64: combined.toString('base64'),
      resync: false,
    };
    for (const subscriber of this.subscribers) subscriber(payload);
  }

  /**
   * A window's Terminal tab mounting. Returns replay (whatever's in the
   * ring buffer right now, as one chunk carrying the CURRENT seq — not
   * reconstructed per-original-chunk boundaries, which is not something a
   * xterm.js consumer needs to distinguish) plus an unsubscribe function.
   * `fromSeq` (a reconnecting subscriber that already has some history)
   * gets a `resync: true` marker instead of a replay if what it's missing
   * has already aged out of the ring buffer — never a claim of continuity
   * the buffer can't back up.
   */
  attach(
    onChunk: (chunk: TerminalChunkPayload) => void,
    fromSeq?: number,
  ): { replay: TerminalChunkPayload | null; unsubscribe: Unsubscribe } {
    this.subscribers.add(onChunk);
    const unsubscribe: Unsubscribe = () => {
      this.subscribers.delete(onChunk);
    };

    if (fromSeq !== undefined && fromSeq < this.oldestBufferedSeq - 1) {
      // Genuinely missed data that's no longer in the buffer — say so
      // rather than silently replaying an incomplete window.
      return {
        replay: { employeeId: this.employeeId, seq: this.nextSeq - 1, base64: '', resync: true },
        unsubscribe,
      };
    }

    if (this.ringBuffer.length === 0) {
      return { replay: null, unsubscribe };
    }
    return {
      replay: {
        employeeId: this.employeeId,
        seq: this.nextSeq - 1,
        base64: this.ringBuffer.toString('base64'),
        resync: false,
      },
      unsubscribe,
    };
  }

  // ---- read-only gate (§14.5) ----

  get isControlled(): boolean {
    return this.controllerId !== null;
  }

  /** `sink` receives raw keystrokes once control is granted — the caller (Supervisor) wires this to the adapter's own write path, already interrupt()-then-blocked per §14.5's own ordering, which lives one layer up, not in this class. */
  takeControl(controllerId: string, sink: (data: string) => void): boolean {
    if (this.controllerId !== null && this.controllerId !== controllerId) return false; // already held by someone else
    this.controllerId = controllerId;
    this.inputSink = sink;
    return true;
  }

  releaseControl(controllerId: string): void {
    if (this.controllerId !== controllerId) return; // not yours to release
    this.controllerId = null;
    this.inputSink = null;
  }

  /** Refused (returns false) unless `controllerId` currently holds control — read-only by default is enforced HERE, not trusted to the caller. */
  sendInput(controllerId: string, data: string): boolean {
    if (this.controllerId !== controllerId || !this.inputSink) return false;
    this.inputSink(data);
    return true;
  }

  dispose(): void {
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    this.coalesceTimer = null;
    this.subscribers.clear();
    this.controllerId = null;
    this.inputSink = null;
  }
}
