import { describe, expect, it } from 'vitest';
import {
  DIRECTOR_CONTEXT_LAYERS,
  estimateContextTokens,
  fitDirectorLayers,
  type DirectorContextLayerName,
} from '../../../src/main/director/assembleDirectorContext';

/**
 * §8.0.1's budget (M11 context assembly): seven layers in a fixed order,
 * dropped from the bottom when over `director.contextBudgetTokens`, the
 * estimate `chars / 4` plus 10 %. The system prompt is never dropped.
 */
describe("§8.0.1's drop order", () => {
  it('the estimate is chars / 4, over-counted by 10 %', () => {
    expect(estimateContextTokens('x'.repeat(400))).toBe(110);
    expect(estimateContextTokens('')).toBe(0);
  });

  it('the layers are §8.0.1 in its order', () => {
    expect(DIRECTOR_CONTEXT_LAYERS).toEqual([
      'system',
      'standards',
      'project',
      'decisions',
      'team',
      'memory',
      'conversation',
    ]);
  });

  // Each layer costs 110 tokens (400 characters).
  const layers = DIRECTOR_CONTEXT_LAYERS.map((name) => ({ name, text: 'x'.repeat(400) }));
  const total = 110 * 7;

  it.each([
    [total, []],
    [total - 1, ['conversation']],
    [total - 110 - 1, ['conversation', 'memory']],
    [total - 220 - 1, ['conversation', 'memory', 'team']],
    [total - 330 - 1, ['conversation', 'memory', 'team', 'decisions']],
    [total - 440 - 1, ['conversation', 'memory', 'team', 'decisions', 'project']],
    [total - 550 - 1, ['conversation', 'memory', 'team', 'decisions', 'project', 'standards']],
  ] as const)('a budget of %i drops %j, from the bottom', (budget, dropped) => {
    expect([...fitDirectorLayers(layers, budget)]).toEqual(dropped);
  });

  it('the system prompt is never dropped, even when it alone is over budget', () => {
    const dropped = fitDirectorLayers(layers, 1);
    expect(dropped.has('system' as DirectorContextLayerName)).toBe(false);
    expect(dropped.size).toBe(6);
  });

  it('an empty layer costs nothing and is never the one dropped for room', () => {
    const withEmptyConversation = layers.map((layer) =>
      layer.name === 'conversation' ? { ...layer, text: '' } : layer,
    );
    // 660 tokens against 659: one layer has to go, and it is memory, not
    // the empty conversation that would free nothing.
    expect([...fitDirectorLayers(withEmptyConversation, total - 110 - 1)]).toEqual(['memory']);
  });
});
