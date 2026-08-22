import fs from 'node:fs';
import path from 'node:path';

/**
 * A real, empirically-found problem (M3 session 2), not a theoretical one:
 * Node's `child_process.execFile`/`spawn` cannot launch a `.cmd` file
 * directly on Windows — confirmed by reproducing it against the real,
 * installed `claude.cmd` (`spawn EINVAL`). The documented fix is
 * `shell: true`, but that has two real costs: it needs the executable path
 * manually quoted (space-in-path breaks it otherwise — also reproduced),
 * and Node's own docs warn that with `shell: true` "arguments are not
 * escaped, only concatenated" — a real shell-injection surface once a
 * spawn's argv includes arbitrary text (a task prompt, eventually a user
 * message), not just fixed flags.
 *
 * npm's own global-install convention sidesteps all of this: every
 * `<pkg>.cmd` shim npm generates is a thin, one-line wrapper that execs a
 * real `.exe` sitting next to the package's own `bin/` entry — confirmed
 * directly by reading the installed `claude.cmd`:
 * `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`.
 * Spawning that `.exe` directly needs no shell at all, correctly handles a
 * path with spaces, and passes arbitrary argv text through completely
 * literally (verified: a deliberately shell-metacharacter-laden argument
 * came through as one inert string, not interpreted).
 *
 * This only ever *prefers* the real exe when the shim can be read and
 * parsed — never silently falls back to failing at spawn time,
 * but does fall back to the original `.cmd` path unresolved, so the
 * caller's own error handling (already required — a `.cmd` really can be
 * the correct thing to spawn for some other npm package) still applies.
 */
export function resolveRealExecutable(
  resolvedPath: string,
  readFileFn: (filePath: string) => string = (p) => fs.readFileSync(p, 'utf8'),
  existsFn: (filePath: string) => boolean = fs.existsSync,
): string {
  if (!resolvedPath.toLowerCase().endsWith('.cmd')) return resolvedPath;

  let content: string;
  try {
    content = readFileFn(resolvedPath);
  } catch {
    return resolvedPath;
  }

  // npm's shim quotes the target path with "%dp0%\..." (the shim's own
  // directory) or an absolute path; either way it's the first double-
  // quoted token on the line that invokes the real binary.
  const match = /"%dp0%\\(.+?\.exe)"|"([A-Za-z]:\\[^"]+\.exe)"/i.exec(content);
  if (!match) return resolvedPath;

  const relativeOrAbsolute = match[1] ?? match[2];
  if (!relativeOrAbsolute) return resolvedPath;

  const candidate = match[1]
    ? path.join(path.dirname(resolvedPath), match[1]) // %dp0% = the shim's own directory
    : relativeOrAbsolute;

  return existsFn(candidate) ? candidate : resolvedPath;
}
