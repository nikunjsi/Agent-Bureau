import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_DEFAULT_MODEL_TIERS,
  looksLikeValidModelId,
} from '../../../src/main/engine/modelTiers';

describe('looksLikeValidModelId (§7.5) — a syntactic sanity check only, never real validation', () => {
  it('accepts the current dateless pinned-snapshot format (4.6+ generation)', () => {
    expect(looksLikeValidModelId('claude-sonnet-5')).toBe(true);
    expect(looksLikeValidModelId('claude-opus-5')).toBe(true);
  });

  it('accepts the older dated-snapshot format — the date suffix is optional, not required', () => {
    expect(looksLikeValidModelId('claude-haiku-4-5-20251001')).toBe(true);
    expect(looksLikeValidModelId('claude-sonnet-4-5-20250929')).toBe(true);
  });

  it('rejects an obviously wrong shape', () => {
    expect(looksLikeValidModelId('gpt-4')).toBe(false);
    expect(looksLikeValidModelId('sonnet')).toBe(false); // a bare alias, not a full model ID
    expect(looksLikeValidModelId('')).toBe(false);
  });

  it('the three shipping defaults all pass the syntactic check', () => {
    for (const modelId of Object.values(CLAUDE_CODE_DEFAULT_MODEL_TIERS)) {
      expect(looksLikeValidModelId(modelId), modelId).toBe(true);
    }
  });
});
