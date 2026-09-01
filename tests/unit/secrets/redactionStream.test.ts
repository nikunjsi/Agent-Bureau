import { describe, expect, it } from 'vitest';
import { SecretRegistry, RedactionStream } from '../../../src/main/secrets/redactor';

/**
 * S5 (§11.7): `redaction_across_chunk_boundary` — a secret split across
 * two stream chunks is still redacted. The real test is a genuine split
 * (the secret's own bytes divided mid-token across two `feed()` calls),
 * not one chunk containing the whole secret — that would pass trivially
 * and prove nothing, the same class of vacuous pass an unmutated test
 * would produce.
 */
describe('RedactionStream — S5 redaction_across_chunk_boundary (§11.7, §11.4)', () => {
  it('a secret split exactly mid-token across two feed() calls is never emitted in either chunk', () => {
    const registry = new SecretRegistry();
    const secret = 'sk-realsecretvalue1234567890abcdef';
    registry.register([secret]);
    const stream = new RedactionStream(registry);

    const splitPoint = 10; // genuinely mid-token, not at a natural boundary
    const before = `here is the key: ${secret.slice(0, splitPoint)}`;
    const after = `${secret.slice(splitPoint)} — end of line`;

    const out1 = stream.feed(before);
    const out2 = stream.feed(after);
    const flushed = stream.flush();
    const combined = out1 + out2 + flushed;

    // Neither individual emission may contain the raw secret, or any
    // prefix/suffix of it long enough to be useful on its own.
    expect(out1).not.toContain(secret);
    expect(out2).not.toContain(secret);
    // The full secret must never appear anywhere in the reassembled output.
    expect(combined).not.toContain(secret);
    expect(combined).toContain('«redacted:');
    // Exactly one redaction — the split value was recognized as ONE
    // secret, not fragmented into two partial (and differently) redacted
    // pieces.
    expect(combined.split('«redacted:').length - 1).toBe(1);
    expect(combined).toContain('here is the key:');
    expect(combined).toContain('— end of line');
  });

  it('a secret split into three pieces across three feed() calls is still caught as one', () => {
    const registry = new SecretRegistry();
    const secret = 'gsk_anothersecretvalue0987654321zzzz';
    registry.register([secret]);
    const stream = new RedactionStream(registry);

    const p1 = secret.slice(0, 8);
    const p2 = secret.slice(8, 20);
    const p3 = secret.slice(20);

    const out1 = stream.feed(`start ${p1}`);
    const out2 = stream.feed(p2);
    const out3 = stream.feed(`${p3} end`);
    const flushed = stream.flush();
    const combined = out1 + out2 + out3 + flushed;

    expect(combined).not.toContain(secret);
    expect(combined.split('«redacted:').length - 1).toBe(1);
    expect(combined).toContain('start');
    expect(combined).toContain('end');
  });

  it('a pattern match (not an exact value) split across a chunk boundary is also caught', () => {
    const registry = new SecretRegistry(); // empty — this is the pattern matcher's own job
    const stream = new RedactionStream(registry);
    const key = 'AKIAIOSFODNN7EXAMPLE'; // AWS access key ID shape

    const out1 = stream.feed(`key=${key.slice(0, 12)}`);
    const out2 = stream.feed(key.slice(12));
    const flushed = stream.flush();
    const combined = out1 + out2 + flushed;

    expect(combined).not.toContain(key);
    expect(combined).toContain('«redacted:aws_access_key_id»');
  });

  it('flush() with nothing pending is a safe no-op', () => {
    const stream = new RedactionStream(new SecretRegistry());
    expect(stream.flush()).toBe('');
  });

  it('plain, non-secret text streamed in small chunks reassembles losslessly', () => {
    const stream = new RedactionStream(new SecretRegistry());
    const text = 'the quick brown fox jumps over the lazy dog, several times over';
    let out = '';
    for (let i = 0; i < text.length; i += 3) {
      out += stream.feed(text.slice(i, i + 3));
    }
    out += stream.flush();
    expect(out).toBe(text);
  });

  it('never emits within maxMatchLen−1 of the buffered tail until flush — proves the held-back window is real, not accidental', () => {
    const registry = new SecretRegistry();
    registry.register(['x'.repeat(50)]); // a 50-char known secret sets a real overlap window
    const stream = new RedactionStream(registry);

    // Feed data shorter than the overlap window — nothing should be safe to emit yet.
    const out = stream.feed('short chunk, well under the window');
    expect(out).toBe('');
    expect(stream.pendingLength).toBeGreaterThan(0);

    // Flushing releases it all.
    const flushed = stream.flush();
    expect(flushed).toContain('short chunk');
    expect(stream.pendingLength).toBe(0);
  });

  it('bounded memory: pending never exceeds chunk length + (maxMatchLen − 1), regardless of total stream length (chaos row 8)', () => {
    const registry = new SecretRegistry();
    registry.register(['y'.repeat(100)]); // overlap window = max(4096, 100) = 4096
    const stream = new RedactionStream(registry);
    const maxMatchLen = 4096; // PATTERN_MAX_LEN floor, since 100 < 4096
    const chunk = 'z'.repeat(1000);

    // Simulate a genuinely large stream — many chunks, far more total
    // bytes than any reasonable single-chunk cap.
    for (let i = 0; i < 600; i++) {
      stream.feed(chunk);
      expect(stream.pendingLength).toBeLessThanOrEqual(chunk.length + maxMatchLen - 1);
    }
    stream.flush();
    expect(stream.pendingLength).toBe(0);
  });
});
