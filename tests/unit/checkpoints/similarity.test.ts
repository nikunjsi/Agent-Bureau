import { describe, expect, it } from 'vitest';
import { diceSimilarity, tokenize } from '../../../src/main/checkpoints/similarity';
import {
  DUPLICATE_THRESHOLD,
  NEAR_MISS_THRESHOLD,
} from '../../../src/main/checkpoints/duplicateDetection';

/**
 * The scoring half of duplicate detection. Bounded 0..1 and corpus-
 * independent, which is exactly what FTS5's own `rank` (bm25, negative and
 * unbounded) is not — see similarity.ts for the full reasoning.
 *
 * These tests pin the two thresholds against realistic checkpoint text, so
 * that changing either number breaks a test that says what the change
 * means rather than just a number that moved.
 */

describe('tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(tokenize('Postgres or SQLite?')).toEqual(['postgres', 'or', 'sqlite']);
  });

  it('drops punctuation that would be an FTS syntax error, rather than choking on it', () => {
    expect(tokenize('read-heavy "NEAR" workload *')).toEqual(['read', 'heavy', 'near', 'workload']);
  });

  it('returns nothing for text with no word characters', () => {
    expect(tokenize('??? --- ***')).toEqual([]);
  });
});

describe('diceSimilarity', () => {
  it('scores identical text 1', () => {
    expect(diceSimilarity('Postgres or SQLite', 'Postgres or SQLite')).toBe(1);
  });

  it('is order-independent — the same question asked backwards is the same question', () => {
    expect(diceSimilarity('Postgres or SQLite?', 'SQLite or Postgres?')).toBe(1);
  });

  it('scores completely unrelated text 0', () => {
    expect(diceSimilarity('Which database should we use', 'What colour is the login button')).toBe(
      0,
    );
  });

  it('scores two empty inputs 0, not 1', () => {
    // A checkpoint with no searchable tokens is not "identical to"
    // another one.
    expect(diceSimilarity('', '')).toBe(0);
    expect(diceSimilarity('???', 'Which database')).toBe(0);
  });

  it('is symmetric', () => {
    const a = 'Should we cache the report query';
    const b = 'Should we cache report results';
    expect(diceSimilarity(a, b)).toBe(diceSimilarity(b, a));
  });
});

describe('the two thresholds, against realistic checkpoint text', () => {
  const asked = {
    title: 'Which database should this project use?',
    context: 'The API needs to store data, and the choice affects how it is deployed.',
  };
  const text = (c: { title: string; context: string }) => `${c.title} ${c.context}`;

  it('a near-verbatim re-ask clears DUPLICATE_THRESHOLD', () => {
    const again = {
      title: 'Which database should this project use?',
      context: 'The API needs to store its data, and the choice affects how it is deployed.',
    };
    expect(diceSimilarity(text(asked), text(again))).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it('a genuinely different question about the same subject stays below DUPLICATE_THRESHOLD', () => {
    const different = {
      title: 'Should this project use a hosted database or run its own?',
      context: 'Running our own means we maintain it; hosted means a monthly bill.',
    };
    expect(diceSimilarity(text(asked), text(different))).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it('an unrelated question stays below NEAR_MISS_THRESHOLD, so it never costs a one-shot call', () => {
    const unrelated = {
      title: 'What should the invoice email say?',
      context: 'Customers receive this after paying, and the wording is yours to choose.',
    };
    expect(diceSimilarity(text(asked), text(unrelated))).toBeLessThan(NEAR_MISS_THRESHOLD);
  });

  it('the two thresholds leave a real near-miss band rather than meeting', () => {
    expect(NEAR_MISS_THRESHOLD).toBeLessThan(DUPLICATE_THRESHOLD);
  });
});
