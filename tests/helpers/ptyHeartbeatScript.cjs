// A responsive child process for PtySession's kill() test: writes a small
// heartbeat every 200ms so it discovers a closed pipe / dies promptly once
// killed, rather than sitting silently unaware for a long fixed delay.
'use strict';
setInterval(() => {
  process.stdout.write('.');
}, 200);
