import { describe, expect, it } from 'vitest';
import { IdempotencyCache } from '../../../src/main/controlChannel/idempotencyCache';
import type { ToolCallResponse } from '../../../src/shared/controlChannel/schemas';

describe('IdempotencyCache (§7.9: a retried tool call must not re-execute)', () => {
  it('returns undefined for a key never seen before', () => {
    const cache = new IdempotencyCache();
    expect(cache.get('emp1', 'key1')).toBeUndefined();
  });

  it('returns the exact cached response for a repeated key', () => {
    const cache = new IdempotencyCache();
    const response: ToolCallResponse = { ok: true, data: { taskId: 't1' } };
    cache.set('emp1', 'key1', response);
    expect(cache.get('emp1', 'key1')).toEqual(response);
  });

  it('keeps two employees using the same idempotency key value fully independent', () => {
    const cache = new IdempotencyCache();
    const responseA: ToolCallResponse = { ok: true, data: { from: 'emp1' } };
    const responseB: ToolCallResponse = { ok: true, data: { from: 'emp2' } };
    cache.set('emp1', 'key1', responseA);
    cache.set('emp2', 'key1', responseB);
    expect(cache.get('emp1', 'key1')).toEqual(responseA);
    expect(cache.get('emp2', 'key1')).toEqual(responseB);
  });

  it("clearForEmployee drops only that employee's entries", () => {
    const cache = new IdempotencyCache();
    cache.set('emp1', 'key1', { ok: true, data: 1 });
    cache.set('emp1', 'key2', { ok: true, data: 2 });
    cache.set('emp2', 'key1', { ok: true, data: 3 });
    cache.clearForEmployee('emp1');
    expect(cache.get('emp1', 'key1')).toBeUndefined();
    expect(cache.get('emp1', 'key2')).toBeUndefined();
    expect(cache.get('emp2', 'key1')).toEqual({ ok: true, data: 3 });
  });
});
