// A stand-in for the `claude` CLI's hook handling, and nothing else (M11
// hook liveness). Run as `node fakeClaudeCli.cjs <the adapter's real argv>`
// through the adapter's `spawnProcess` seam, because Node itself cannot be
// the binary: it parses `--settings` and the other flags as its own options.
//
// What it does is what the real CLI measurably does before any model call:
// read the `--settings` file the adapter wrote and run each `SessionStart`
// command hook, passing the event as JSON on stdin and waiting for it to
// finish. It never runs a PreToolUse hook and never "calls a model".
//
// FAKE_CLAUDE_IGNORE_HOOKS=1 plays a CLI that skips hooks, the way
// `--bare` does: it exits without running any of them.
'use strict';
/* eslint-disable @typescript-eslint/no-require-imports -- a plain CommonJS script Node runs directly */
const { spawn } = require('node:child_process');
const { readFileSync, appendFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
/* eslint-enable @typescript-eslint/no-require-imports */

const argv = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGV_LOG) {
  appendFileSync(process.env.FAKE_CLAUDE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}

async function main() {
  if (process.env.FAKE_CLAUDE_IGNORE_HOOKS === '1') return;
  const settingsIndex = argv.indexOf('--settings');
  if (settingsIndex === -1) return;
  const settings = JSON.parse(readFileSync(argv[settingsIndex + 1], 'utf8'));
  const groups = (settings.hooks && settings.hooks.SessionStart) || [];
  const payload = JSON.stringify({
    hook_event_name: 'SessionStart',
    session_id: randomUUID(),
    source: 'startup',
    cwd: process.cwd(),
  });
  for (const group of groups) {
    for (const hook of group.hooks || []) {
      if (hook.type !== 'command') continue;
      await new Promise((resolve) => {
        const child = spawn(hook.command, hook.args || [], {
          env: process.env,
          stdio: ['pipe', 'ignore', 'inherit'],
        });
        child.on('exit', resolve);
        child.on('error', resolve);
        child.stdin.end(payload);
      });
    }
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
