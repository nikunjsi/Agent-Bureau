import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RedactionStream, SecretRegistry } from '../../../src/main/secrets/redactor';

/**
 * T-2 (§19, redactor): for ANY secret and ANY chunking of a stream containing
 * it, the secret never appears in the output. The hand-written S5 tests cover
 * two chosen splits; this covers every split point across the secret and
 * random multi-chunk splits, through the real `RedactionStream`.
 *
 * Streams are padded past the 4096-character hold-back window on purpose.
 * Below it, `feed()` emits nothing until `flush()`, so chunking would not be
 * exercised at all.
 *
 * Secrets come in two kinds, as in production: exact values registered with
 * the broker, and shapes caught by pattern (an OpenAI-style key, a Groq key,
 * an AWS access key id). Filler is lower-case words and spaces, so it can
 * never itself form a secret or glue onto one across a word boundary.
 */
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const UPPER_NUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const charsOf = (alphabet: string, min: number, max: number) =>
  fc
    .array(fc.constantFrom(...alphabet.split('')), { minLength: min, maxLength: max })
    .map((chars) => chars.join(''));

const secretArb: fc.Arbitrary<{ secret: string; registered: boolean }> = fc.oneof(
  charsOf(ALNUM, 12, 64).map((v) => ({ secret: `val-${v}`, registered: true })),
  charsOf(ALNUM, 20, 48).map((v) => ({ secret: `sk-${v}`, registered: false })),
  charsOf(ALNUM, 20, 48).map((v) => ({ secret: `gsk_${v}`, registered: false })),
  charsOf(UPPER_NUM, 16, 16).map((v) => ({ secret: `AKIA${v}`, registered: false })),
);

const fillerArb = (max: number, min = 0) =>
  fc
    .array(fc.constantFrom('lorem', 'ipsum', 'dolor', 'sit', 'amet', 'the', 'build', 'ok'), {
      minLength: min,
      maxLength: max,
    })
    .map((words) => words.join(' '));

function run(registry: SecretRegistry, pieces: readonly string[]): string {
  const stream = new RedactionStream(registry);
  let out = '';
  for (const piece of pieces) out += stream.feed(piece);
  return out + stream.flush();
}

function splitAt(text: string, cuts: readonly number[]): string[] {
  const points = [...new Set(cuts.map((c) => Math.min(text.length, c)))].sort((a, b) => a - b);
  const pieces: string[] = [];
  let from = 0;
  for (const point of points) {
    pieces.push(text.slice(from, point));
    from = point;
  }
  pieces.push(text.slice(from));
  return pieces;
}

describe('T-2: no chunking lets a secret through RedactionStream (property)', () => {
  it('every split point across the secret, in a stream longer than the hold-back window', () => {
    fc.assert(
      fc.property(
        secretArb,
        fillerArb(1500, 900),
        fillerArb(300),
        ({ secret, registered }, head, tail) => {
          const registry = new SecretRegistry();
          if (registered) registry.register([secret]);
          const text = `${head} ${secret} ${tail}`;
          expect(head.length).toBeGreaterThan(4096);
          const start = head.length + 1;
          for (let cut = start - 1; cut <= start + secret.length + 1; cut += 1) {
            const out = run(registry, splitAt(text, [cut]));
            expect(out, `split at ${cut}`).not.toContain(secret);
            expect(out).toContain('«redacted:');
          }
        },
      ),
      { numRuns: 40 },
    );
  });

  it('random multi-chunk splits, including one-character chunks around the secret', () => {
    fc.assert(
      fc.property(
        secretArb,
        fillerArb(1500, 900),
        fillerArb(1500),
        fc.array(fc.nat({ max: 20_000 }), { minLength: 1, maxLength: 40 }),
        ({ secret, registered }, head, tail, cuts) => {
          const registry = new SecretRegistry();
          if (registered) registry.register([secret]);
          const text = `${head} ${secret} ${tail}`;
          expect(head.length).toBeGreaterThan(4096);
          const start = head.length + 1;
          const aroundSecret = Array.from({ length: secret.length + 1 }, (_, i) => start + i);
          for (const pieces of [splitAt(text, cuts), splitAt(text, [...cuts, ...aroundSecret])]) {
            expect(pieces.join('')).toBe(text);
            expect(run(registry, pieces)).not.toContain(secret);
          }
        },
      ),
      { numRuns: 60 },
    );
  });

  it('non-secret text survives any chunking byte for byte (the redactor is not just deleting)', () => {
    fc.assert(
      fc.property(
        fillerArb(3000),
        fc.array(fc.nat({ max: 20_000 }), { maxLength: 30 }),
        (text, cuts) => {
          expect(run(new SecretRegistry(), splitAt(text, cuts))).toBe(text);
        },
      ),
      { numRuns: 60 },
    );
  });
});
