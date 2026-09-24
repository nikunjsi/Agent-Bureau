import { describe, expect, it } from 'vitest';
import {
  DirectorTriggerQueue,
  startDirectorHeartbeat,
  type DirectorTrigger,
  type DirectorTurn,
  type TriggerClock,
} from '../../../src/main/director/triggerQueue';

/**
 * §26.1's rules for waking the Director, on a fake clock (M11's trigger
 * queue). One queue decides every Director turn. Each rule has a test, and
 * the three mutations the plan names — no coalescing, a bare-timer wake, and
 * mid-turn injection — each fail one of them.
 */
class FakeClock implements TriggerClock {
  private nowMs = 0;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;
  now(): number {
    return this.nowMs;
  }
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.push({ at: this.nowMs + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }
  async advance(ms: number): Promise<void> {
    const until = this.nowMs + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === undefined || next.at > until) break;
      this.timers.shift();
      this.nowMs = next.at;
      next.fn();
      await flush();
    }
    this.nowMs = until;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const WINDOW_MS = 20_000;

function harness() {
  const clock = new FakeClock();
  const turns: DirectorTurn[] = [];
  let idle = true;
  const queue = new DirectorTriggerQueue({
    clock,
    coalesceWindowMs: () => WINDOW_MS,
    isDirectorIdle: () => idle,
    deliverTurn: async (turn) => {
      turns.push(turn);
      idle = false; // a delivered turn is a turn in progress
    },
  });
  return {
    clock,
    queue,
    turns,
    kinds: () => turns.map((turn) => turn.triggers.map((t) => t.kind)),
    finishTurn: async () => {
      idle = true;
      queue.pump();
      await flush();
    },
    setIdle: (value: boolean) => {
      idle = value;
    },
  };
}

const user = (n: number): DirectorTrigger => ({
  kind: 'user_message',
  key: `m-user-${n}`,
  text: `user says ${n}`,
  messageId: `m-user-${n}`,
});
const ask = (n: number): DirectorTrigger => ({
  kind: 'ask_director',
  key: `m-ask-${n}`,
  text: `employee asks ${n}`,
  messageId: `m-ask-${n}`,
});

describe('the Director trigger queue (§26.1)', () => {
  it('a user message is delivered at once when the Director is idle', async () => {
    const h = harness();
    h.queue.offer(user(1));
    await flush();
    expect(h.kinds()).toEqual([['user_message']]);
    expect(h.turns[0]!.text).toContain('user says 1');
  });

  it('never mid-turn: user messages wait for idle, and those that arrived mid-turn become one turn', async () => {
    const h = harness();
    h.setIdle(false);
    h.queue.offer(user(1));
    h.queue.offer(user(2));
    h.queue.offer(user(3));
    await h.clock.advance(60_000);
    expect(h.turns, 'delivered while the Director was generating').toHaveLength(0);

    await h.finishTurn();
    expect(h.kinds()).toEqual([['user_message', 'user_message', 'user_message']]);
  });

  it('a user message is never coalesced with anything else', async () => {
    const h = harness();
    h.queue.offer(ask(1));
    h.queue.offer(user(1));
    await flush();
    expect(h.kinds()).toEqual([['user_message']]);
    await h.finishTurn();
    await h.clock.advance(WINDOW_MS);
    expect(h.kinds()).toEqual([['user_message'], ['ask_director']]);
  });

  it('coalescing triggers inside the window become one turn, delivered when the window closes', async () => {
    const h = harness();
    h.queue.offer(ask(1));
    await h.clock.advance(5_000);
    h.queue.offer(ask(2));
    await h.clock.advance(WINDOW_MS - 5_000 - 1);
    expect(h.turns, 'delivered before the coalesce window closed').toHaveLength(0);
    await h.clock.advance(1);
    expect(h.kinds()).toEqual([['ask_director', 'ask_director']]);
  });

  it('an answered blocking checkpoint is immediate and alone', async () => {
    const h = harness();
    h.queue.offer(ask(1));
    h.queue.offer({ kind: 'checkpoint_answered', key: 'cp-1', text: 'checkpoint answered' });
    await flush();
    expect(h.kinds()).toEqual([['checkpoint_answered']]);
  });

  it('a restart report is delivered alone, never merged', async () => {
    const h = harness();
    h.setIdle(false);
    h.queue.offer({ kind: 'restart', key: 'restart', text: 'restart' });
    h.queue.offer(ask(1));
    await h.clock.advance(WINDOW_MS);
    await h.finishTurn();
    expect(h.kinds()[0]).toEqual(['ask_director']);
    await h.finishTurn();
    expect(h.kinds()[1]).toEqual(['restart']);
  });

  it('the same trigger offered twice is one trigger', async () => {
    const h = harness();
    h.setIdle(false);
    expect(h.queue.offer(user(1))).toBe(true);
    expect(h.queue.offer(user(1))).toBe(false);
    await h.finishTurn();
    expect(h.turns[0]!.triggers).toHaveLength(1);
    // Still refused after delivery: the router re-lists a message until it
    // is marked delivered.
    expect(h.queue.offer(user(1))).toBe(false);
  });
});

describe('the heartbeat (§26.1: only if new events exist)', () => {
  it('no new events, no turn — a bare timer never wakes the Director', async () => {
    const h = harness();
    const heartbeat = startDirectorHeartbeat({
      clock: h.clock,
      intervalMs: () => 60_000,
      latestEventSeq: () => 7,
      queue: h.queue,
    });
    await h.clock.advance(60_000 * 5 + WINDOW_MS);
    heartbeat.stop();
    expect(h.turns).toHaveLength(0);
  });

  it('new events since the last report enqueue one heartbeat, which coalesces', async () => {
    const h = harness();
    let seq = 7;
    const heartbeat = startDirectorHeartbeat({
      clock: h.clock,
      intervalMs: () => 60_000,
      latestEventSeq: () => seq,
      queue: h.queue,
    });
    seq = 9;
    await h.clock.advance(60_000);
    h.queue.offer(ask(1));
    await h.clock.advance(WINDOW_MS);
    expect(h.kinds()).toEqual([['heartbeat', 'ask_director']]);
    // Nothing new since: the next beats stay silent.
    await h.finishTurn();
    await h.clock.advance(60_000 * 3);
    heartbeat.stop();
    expect(h.turns).toHaveLength(1);
  });
});
