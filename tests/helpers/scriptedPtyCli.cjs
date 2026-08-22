// A tiny, fully deterministic PTY test target — §7.7's generic-pty adapter
// exists so a user can wire "any terminal agent"; this is the smallest one
// that actually is one, for the contract suite and manual testing. No
// onboarding, no trust gate, no network, no cost — just a fixed prompt, an
// echo, and an exit keyword. Prints the prompt/done markers from §7.7's own
// example config (`> `, `[done]`); see genericPtyAdapter.test.ts for the two
// real fixes actually running that example against this script found (an
// invalid inline regex flag, and a ConPTY rendering quirk on the ready
// pattern specifically).
//
// Behaviour:
//   - prints "> " on startup and after every echoed line (the ready state)
//   - each input line becomes "echo: <line>"
//   - the literal line "exit" prints "[done]" and exits(0)
process.stdout.write('> ');

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  // PtySession.write() sends CR-terminated text (matches a real terminal's
  // Enter key); split on CR or LF so this works whether the pty forwards
  // \r, \n, or \r\n.
  while ((idx = buf.search(/[\r\n]/)) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    if (line.trim() === 'exit') {
      process.stdout.write('[done]\n');
      process.exit(0);
    }
    process.stdout.write(`echo: ${line}\n`);
    process.stdout.write('> ');
  }
});
