import * as pty from 'node-pty';
import { PtyOutputBuffer } from './ptyOutputBuffer';
import { ReadyDebouncer } from './readyDebouncer';

export interface PtySessionOptions {
  /** Absolute path — §15.4. PtySession does not resolve bare names itself; that is resolvedPath.ts's job, done once before spawn. */
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
  /** §7.4 — matched against accumulated output, debounced. Omit for a session with no idle detection (e.g. a one-shot probe). */
  readyPattern?: RegExp;
  /** §7.4 default: 150ms of quiet. */
  readyDebounceMs?: number;
}

export type PtyExitInfo = { exitCode: number; signal?: number };
type Unsubscribe = () => void;

/**
 * M3 step 3: the `node-pty` wrapper — spawn, write, resize, kill, plus
 * §7.4's debounced ready-pattern idle detection. Composes `PtyOutputBuffer`
 * (chunk-boundary-safe accumulation) and `ReadyDebouncer` (the quiet-period
 * scheduling) rather than reimplementing either inline, so both stay
 * independently, deterministically testable.
 *
 * `kill()` deliberately takes no signal argument: node-pty's own types say
 * a signal argument "is not supported on Windows" and **throws** if used —
 * Bureau is Windows-only (§3), so there is no cross-platform case where
 * accepting one would ever be correct.
 */
export class PtySession {
  private readonly proc: pty.IPty;
  private readonly outputBuffer: PtyOutputBuffer;
  private readonly debouncer: ReadyDebouncer | null;

  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly readyListeners = new Set<() => void>();
  private readonly exitListeners = new Set<(info: PtyExitInfo) => void>();

  constructor(options: PtySessionOptions) {
    this.outputBuffer = new PtyOutputBuffer(
      options.readyPattern ? { readyPattern: options.readyPattern } : {},
    );
    this.debouncer = options.readyPattern
      ? new ReadyDebouncer(options.readyDebounceMs ?? 150, () => {
          this.readyListeners.forEach((cb) => cb());
        })
      : null;

    this.proc = pty.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
    });

    this.proc.onData((chunk) => this.handleData(chunk));
    this.proc.onExit((info) => this.exitListeners.forEach((cb) => cb(info)));
  }

  private handleData(chunk: string): void {
    this.outputBuffer.feed(chunk);
    this.dataListeners.forEach((cb) => cb(chunk));
    this.debouncer?.notifyChunk(() => this.outputBuffer.matchesReadyPattern());
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }

  kill(): void {
    this.debouncer?.dispose();
    this.proc.kill();
  }

  /** Raw decoded chunks, as they arrive — for xterm.js (M3 step 8) and the `raw` AgentEvent. */
  onData(cb: (chunk: string) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  /** Fires once per debounced ready-pattern match — §7.4's idle signal. */
  onReady(cb: () => void): Unsubscribe {
    this.readyListeners.add(cb);
    return () => this.readyListeners.delete(cb);
  }

  onExit(cb: (info: PtyExitInfo) => void): Unsubscribe {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  get pid(): number {
    return this.proc.pid;
  }
}
