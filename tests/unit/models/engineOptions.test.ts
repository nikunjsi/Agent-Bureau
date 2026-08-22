import { describe, expect, it } from 'vitest';
import {
  ClaudeCodeEngineOptionsSchema,
  GenericPtyEngineOptionsSchema,
  engineOptionsSchemaFor,
} from '../../../src/shared/models/engineOptions';

describe('engine_options schemas (§7.1.1/§6.5)', () => {
  it('claude-code options default mode to auto and accept an empty object', () => {
    expect(ClaudeCodeEngineOptionsSchema.parse({})).toEqual({ mode: 'auto' });
    expect(ClaudeCodeEngineOptionsSchema.parse({ mode: 'structured' })).toEqual({ mode: 'structured' });
  });

  it('claude-code options reject mode:pty — structured-only (§7.7.1, M3 session 3)', () => {
    expect(() => ClaudeCodeEngineOptionsSchema.parse({ mode: 'pty' })).toThrow(/does not support mode:'pty'/);
  });

  it('claude-code options do NOT carry an engine field — the role field is the one source of truth', () => {
    // engine is deliberately not part of this schema at all; passing one is
    // simply an unknown extra key, not a discriminant.
    const parsed = ClaudeCodeEngineOptionsSchema.parse({ mode: 'auto' });
    expect(parsed).not.toHaveProperty('engine');
  });

  it('generic-pty options require command and ready_pattern', () => {
    expect(() => GenericPtyEngineOptionsSchema.parse({})).toThrow();
    expect(() => GenericPtyEngineOptionsSchema.parse({ command: 'my-agent' })).toThrow(); // missing ready_pattern
    const parsed = GenericPtyEngineOptionsSchema.parse({ command: 'my-agent', ready_pattern: '^> $' });
    expect(parsed).toEqual({
      mode: 'auto',
      command: 'my-agent',
      args: [],
      ready_pattern: '^> $',
      done_pattern: null,
      interrupt: '\x03',
      ready_debounce_ms: 150,
    });
  });

  describe('engineOptionsSchemaFor', () => {
    it('selects the claude-code schema for "claude-code"', () => {
      expect(engineOptionsSchemaFor('claude-code')).toBe(ClaudeCodeEngineOptionsSchema);
    });

    it('selects the generic-pty schema for "generic-pty"', () => {
      expect(engineOptionsSchemaFor('generic-pty')).toBe(GenericPtyEngineOptionsSchema);
    });

    it('falls back to the common mode-only shape for an unrecognised engine, rather than throwing', () => {
      const schema = engineOptionsSchemaFor('some-future-engine');
      expect(schema.parse({})).toEqual({ mode: 'auto' });
    });
  });
});
