// A tiny, deliberately controllable child process for PtySession's real
// integration tests. Writes a sequence of {text, delayMs} parts to stdout,
// each delayed relative to the previous one — enough to reliably land in
// separate PTY reads/onData calls, exercising real chunk-boundary behaviour
// end to end rather than only the deterministic unit-level buffer tests.
//
// Usage: node ptyEchoScript.cjs '<JSON array of {"text":string,"delayMs":number}>'
'use strict';

const parts = JSON.parse(process.argv[2] || '[]');

function writeNext(index) {
  if (index >= parts.length) return;
  const { text, delayMs } = parts[index];
  setTimeout(() => {
    process.stdout.write(text);
    writeNext(index + 1);
  }, delayMs);
}

writeNext(0);
