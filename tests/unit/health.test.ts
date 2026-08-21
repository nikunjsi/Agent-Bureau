import { describe, expect, it } from 'vitest';
import { HealthResultSchema } from '../../src/shared/ipc/health';

describe('HealthResultSchema', () => {
  it('accepts a well-formed health result', () => {
    const value = {
      ok: true,
      version: '0.0.1',
      electron: '43.4.1',
      chrome: '150.0.7871.224',
      node: '24.18.1',
      platform: 'win32',
    };
    expect(HealthResultSchema.parse(value)).toEqual(value);
  });

  it('rejects a result missing a required field', () => {
    const value = { ok: true, version: '0.0.1' };
    expect(() => HealthResultSchema.parse(value)).toThrow();
  });

  it('rejects ok: false', () => {
    const value = {
      ok: false,
      version: '0.0.1',
      electron: '43.4.1',
      chrome: '150.0.7871.224',
      node: '24.18.1',
      platform: 'win32',
    };
    expect(() => HealthResultSchema.parse(value)).toThrow();
  });

  it('rejects a non-win32 platform', () => {
    const value = {
      ok: true,
      version: '0.0.1',
      electron: '43.4.1',
      chrome: '150.0.7871.224',
      node: '24.18.1',
      platform: 'darwin',
    };
    expect(() => HealthResultSchema.parse(value)).toThrow();
  });
});
