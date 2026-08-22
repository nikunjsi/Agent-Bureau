import { describe, expect, it } from 'vitest';
import { NdjsonLineBuffer } from '../../../src/main/engine/ndjsonLineBuffer';

describe('NdjsonLineBuffer (§7.6 trap #1: no verbatim one-object-per-line guarantee)', () => {
  it('a single JSON object arriving in one whole chunk parses immediately', () => {
    const buf = new NdjsonLineBuffer();
    const result = buf.feed('{"type":"system","subtype":"init"}\n');
    expect(result.parsed).toEqual([{ type: 'system', subtype: 'init' }]);
    expect(result.malformedLines).toEqual([]);
  });

  it('a JSON object deliberately split across two chunks reassembles correctly, not a parse failure', () => {
    const buf = new NdjsonLineBuffer();
    // Split mid-object, mid-string-value even — the realistic failure mode.
    const first = buf.feed('{"type":"assistant","message":{"content":[{"type":"text","text":"hel');
    expect(first.parsed).toEqual([]); // nothing complete yet — correctly withheld, not a parse error
    expect(first.malformedLines).toEqual([]);

    const second = buf.feed('lo world"}]}}\n');
    expect(second.parsed).toEqual([
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } },
    ]);
  });

  it('multiple complete events arriving in one chunk all parse, in order', () => {
    const buf = new NdjsonLineBuffer();
    const result = buf.feed('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    expect(result.parsed).toEqual([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
  });

  it('a complete event plus a trailing incomplete one in the same chunk: only the complete one parses now', () => {
    const buf = new NdjsonLineBuffer();
    const result = buf.feed('{"type":"a"}\n{"type":"b",');
    expect(result.parsed).toEqual([{ type: 'a' }]);
    expect(buf.pendingTail).toBe('{"type":"b",');

    const next = buf.feed('"rest":true}\n');
    expect(next.parsed).toEqual([{ type: 'b', rest: true }]);
  });

  it('a genuinely malformed line is surfaced, not thrown, and does not block later valid lines', () => {
    const buf = new NdjsonLineBuffer();
    const result = buf.feed('not json at all\n{"type":"valid"}\n');
    expect(result.malformedLines).toEqual(['not json at all']);
    expect(result.parsed).toEqual([{ type: 'valid' }]);
  });

  it('blank lines between events are skipped, not treated as malformed', () => {
    const buf = new NdjsonLineBuffer();
    const result = buf.feed('{"type":"a"}\n\n{"type":"b"}\n');
    expect(result.parsed).toEqual([{ type: 'a' }, { type: 'b' }]);
    expect(result.malformedLines).toEqual([]);
  });

  it('splitting one byte at a time still reassembles correctly (worst-case chunking)', () => {
    const buf = new NdjsonLineBuffer();
    const payload = '{"type":"turn_result","usage":{"tokens":42}}\n';
    let allParsed: unknown[] = [];
    for (const char of payload) {
      const { parsed } = buf.feed(char);
      allParsed = allParsed.concat(parsed);
    }
    expect(allParsed).toEqual([{ type: 'turn_result', usage: { tokens: 42 } }]);
  });
});
