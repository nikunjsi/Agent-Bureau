import { describe, expect, it } from 'vitest';
import { newId, nowIso, IdSchema, IsoTimestampSchema } from '../../../src/shared/models/ids';
import { usdToMicros, microsToUsd, UsdDecimalToMicrosSchema } from '../../../src/shared/models/money';

describe('ids', () => {
  it('newId produces a valid ULID-shaped id', () => {
    const id = newId();
    expect(() => IdSchema.parse(id)).not.toThrow();
    expect(id).toHaveLength(26);
  });

  it('newId is unique across calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });

  it('ULIDs sort lexicographically by creation time', async () => {
    const a = newId();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = newId();
    expect(a < b).toBe(true);
  });

  it('nowIso produces a schema-valid ISO-8601 UTC timestamp with milliseconds', () => {
    const ts = nowIso();
    expect(() => IsoTimestampSchema.parse(ts)).not.toThrow();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('money', () => {
  it('usdToMicros converts a decimal dollar amount to integer micros', () => {
    expect(usdToMicros(20)).toBe(20_000_000);
    expect(usdToMicros('20.00')).toBe(20_000_000);
    expect(usdToMicros(2.5)).toBe(2_500_000);
    expect(usdToMicros('0.01')).toBe(10_000);
  });

  it('microsToUsd is the inverse, for display only', () => {
    expect(microsToUsd(20_000_000)).toBe(20);
    expect(microsToUsd(2_500_000)).toBe(2.5);
  });

  it('rejects a non-numeric value', () => {
    expect(() => usdToMicros('not a number')).toThrow();
  });

  it('UsdDecimalToMicrosSchema parses a decimal into stored micros', () => {
    expect(UsdDecimalToMicrosSchema.parse(20)).toBe(20_000_000);
    expect(UsdDecimalToMicrosSchema.parse('8.00')).toBe(8_000_000);
  });
});
