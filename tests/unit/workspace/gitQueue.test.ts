import { describe, expect, it } from 'vitest';
import { RepoCommandQueue, ReentrantGitQueueError } from '../../../src/main/workspace/gitQueue';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('RepoCommandQueue (Q6 — per-repo serialization, single-layer enqueueing)', () => {
  it('serializes concurrent calls for the same repoKey — never overlaps two fn executions', async () => {
    const queue = new RepoCommandQueue();
    let concurrentCount = 0;
    let maxConcurrent = 0;
    const order: number[] = [];

    async function slot(n: number): Promise<number> {
      concurrentCount += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await sleep(20);
      order.push(n);
      concurrentCount -= 1;
      return n;
    }

    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => queue.runSerialized('repoA', () => slot(n))));

    expect(maxConcurrent, 'no two executions for the same repoKey ever overlapped').toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]); // enqueue order preserved
    expect(results).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not serialize calls for two different repoKeys against each other', async () => {
    const queue = new RepoCommandQueue();
    const events: string[] = [];

    const a = queue.runSerialized('repoA', async () => {
      events.push('a-start');
      await sleep(30);
      events.push('a-end');
    });
    const b = queue.runSerialized('repoB', async () => {
      events.push('b-start');
      await sleep(10);
      events.push('b-end');
    });

    await Promise.all([a, b]);
    // repoB's whole run finishes before repoA's — proof they ran concurrently,
    // not queued behind each other.
    expect(events.indexOf('b-end')).toBeLessThan(events.indexOf('a-end'));
    expect(events.indexOf('b-start')).toBeLessThan(events.indexOf('a-end'));
  });

  it('a rejected slot does not block or corrupt the ordering of the next queued call', async () => {
    const queue = new RepoCommandQueue();
    const order: string[] = [];

    const failing = queue.runSerialized('repoA', async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const next = queue.runSerialized('repoA', async () => {
      order.push('next');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(order).toEqual(['failing', 'next']);
  });

  it('throws ReentrantGitQueueError when a queued fn tries to enqueue another call for the same repoKey from within its own execution (deadlock guard)', async () => {
    const queue = new RepoCommandQueue();

    const outer = queue.runSerialized('repoA', async () => {
      // This would deadlock (wait on a tail this very execution is
      // blocking) if not for the structural guard — it must throw
      // synchronously-from-the-queue's-perspective instead of hanging.
      await queue.runSerialized('repoA', async () => 'inner');
      return 'outer';
    });

    await expect(outer).rejects.toThrow(ReentrantGitQueueError);
  });

  it('does NOT throw for a nested call against a DIFFERENT repoKey', async () => {
    const queue = new RepoCommandQueue();

    const outer = await queue.runSerialized('repoA', async () => {
      const inner = await queue.runSerialized('repoB', async () => 'inner-b');
      return `outer-a:${inner}`;
    });

    expect(outer).toBe('outer-a:inner-b');
  });
});
