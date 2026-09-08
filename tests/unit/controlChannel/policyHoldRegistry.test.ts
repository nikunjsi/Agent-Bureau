import { describe, expect, it } from 'vitest';
import {
  PolicyHoldRegistry,
  DuplicateHoldError,
} from '../../../src/main/controlChannel/policyHoldRegistry';

describe('PolicyHoldRegistry (§7.10 long-poll: hold a pending checkpoint up to maxHoldMinutes)', () => {
  it('resolve() settles a pending hold with the given verdict', async () => {
    const registry = new PolicyHoldRegistry();
    const held = registry.create('call1', 'emp1', 60_000);
    expect(registry.resolve('call1', 'allow')).toBe(true);
    await expect(held).resolves.toBe('allow');
  });

  it('resolve() returns false for a callId that does not exist', () => {
    const registry = new PolicyHoldRegistry();
    expect(registry.resolve('nonexistent', 'allow')).toBe(false);
  });

  it('resolve() is idempotent — a second resolve on an already-settled hold is a no-op, not a second settlement', async () => {
    const registry = new PolicyHoldRegistry();
    const held = registry.create('call1', 'emp1', 60_000);
    expect(registry.resolve('call1', 'deny')).toBe(true);
    expect(registry.resolve('call1', 'allow')).toBe(false); // already gone
    await expect(held).resolves.toBe('deny'); // the first verdict stands
  });

  it('CLAUDE.md invariant #6/#7: a timed-out hold auto-resolves to deny, never allow', async () => {
    const registry = new PolicyHoldRegistry();
    const held = registry.create('call1', 'emp1', 20);
    await expect(held).resolves.toBe('deny');
  });

  it('create() throws DuplicateHoldError for a callId already held — same callId reused is a client bug, not two independent holds', () => {
    const registry = new PolicyHoldRegistry();
    registry.create('call1', 'emp1', 60_000);
    expect(() => registry.create('call1', 'emp1', 60_000)).toThrow(DuplicateHoldError);
    registry.resolve('call1', 'deny'); // cleanup so the test doesn't leak a timer
  });

  it('the same employee can hold two different callIds fully independently', async () => {
    const registry = new PolicyHoldRegistry();
    const heldA = registry.create('callA', 'emp1', 60_000);
    const heldB = registry.create('callB', 'emp1', 60_000);
    expect(registry.pendingCount).toBe(2);
    registry.resolve('callA', 'allow');
    registry.resolve('callB', 'deny');
    await expect(heldA).resolves.toBe('allow');
    await expect(heldB).resolves.toBe('deny');
  });

  it('resolveAllForEmployee denies every hold for that employee and leaves others untouched (employee-dies-mid-hold)', async () => {
    const registry = new PolicyHoldRegistry();
    const heldA = registry.create('callA', 'emp1', 60_000);
    const heldB = registry.create('callB', 'emp1', 60_000);
    const heldOther = registry.create('callC', 'emp2', 60_000);

    const count = registry.resolveAllForEmployee('emp1');
    expect(count).toBe(2);
    await expect(heldA).resolves.toBe('deny');
    await expect(heldB).resolves.toBe('deny');
    expect(registry.pendingCount).toBe(1);

    registry.resolve('callC', 'allow');
    await expect(heldOther).resolves.toBe('allow');
  });

  it('resolveAllForEmployee is a no-op when the employee has no pending holds', () => {
    const registry = new PolicyHoldRegistry();
    expect(registry.resolveAllForEmployee('nobody')).toBe(0);
  });

  it('pendingCount reflects concurrently held calls across many employees without starving any of them (N-holders shape)', async () => {
    const registry = new PolicyHoldRegistry();
    const N = 25;
    const helds = Array.from({ length: N }, (_, i) =>
      registry.create(`call${i}`, `emp${i}`, 60_000),
    );
    expect(registry.pendingCount).toBe(N);
    for (let i = 0; i < N; i += 1) registry.resolve(`call${i}`, i % 2 === 0 ? 'allow' : 'deny');
    const results = await Promise.all(helds);
    expect(results.filter((v) => v === 'allow').length).toBe(Math.ceil(N / 2));
    expect(registry.pendingCount).toBe(0);
  });
});
