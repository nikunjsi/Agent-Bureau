import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { canonicalizePath } from '../controlChannel/policy/pathCanonicalize';
import { isInside } from '../security/pathConfinement';
import { MAX_SEARCH_RESULTS } from '../controlChannel/toolHandlers/schemas';

/**
 * §7.9's `bureau_search_workspace`: *"Grep/glob the project without
 * spawning an employee."*
 *
 * ## Why the confinement is here
 *
 * This runs for a `bureau_` tool, and `evaluator.ts` short-circuits every
 * `bureau_`/`mcp__bureau__` tool to `allow` **before** the seven immutable
 * denies are scanned (§23.2). So `deny.system_paths` and every other rule
 * that would keep a reader inside the workspace never runs for this call.
 * **The handler is the guard** — CLAUDE.md invariant #5's carve-out, the
 * same position `memoryTarget.ts`, `attachments.ts` and `artifactPath.ts`
 * are in, and the reason the escape test for this lives at the handler.
 *
 * The root is canonicalised once, and **every directory entry is
 * canonicalised and checked against it before it is descended into or
 * read**. A junction or symlink inside the project pointing at
 * `C:\Users\...\.ssh` is a real path that passes every syntactic check;
 * only canonicalisation sees where it lands. Fail closed: an entry that
 * cannot be canonicalised or stat'ed is skipped, never read.
 *
 * ## Bounded by construction
 *
 * A project can be large and this runs in the main process, where
 * better-sqlite3's synchronous calls already queue behind it. So: a
 * capped result count (the caller's, itself capped), a capped file size, a
 * capped number of files examined, and a skip list for the directories
 * that are never source (`.git`, `node_modules`, build output). The caps
 * are reported, not silently applied — a truncated answer an agent thinks
 * is complete is worse than a smaller one it knows is partial.
 */

/** Directories that are never worth grepping and are usually the largest. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-package',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
]);

/** Above this, a file is treated as data, not text, and skipped. */
const MAX_FILE_BYTES = 512 * 1024;

/** A hard ceiling on the walk itself, independent of how many match. */
const MAX_FILES_EXAMINED = 5_000;

export interface WorkspaceMatch {
  /** POSIX-style, relative to the project root — never an absolute path. */
  readonly path: string;
  /** 1-based, as every editor and every grep reports it. */
  readonly line: number;
  readonly text: string;
}

export interface WorkspaceSearchResult {
  readonly matches: readonly WorkspaceMatch[];
  /** True when a cap stopped the search before it was exhaustive. */
  readonly truncated: boolean;
  readonly filesExamined: number;
}

export interface WorkspaceSearchRequest {
  readonly pattern: string;
  /** A `*`/`**`/`?` glob against the POSIX relative path. */
  readonly glob?: string | null;
  readonly maxResults?: number;
}

export type WorkspaceSearchOutcome =
  | { readonly ok: true; readonly result: WorkspaceSearchResult }
  | { readonly ok: false; readonly reason: string };

/**
 * Turns a glob into an anchored regex. Only the three wildcards a caller
 * would expect are special; everything else is literal, so a `.` or a `+`
 * in a file name cannot quietly become a pattern.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches any number of directories, including none.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]*/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

/** A NUL byte in the first chunk is the usual, cheap "this is not text". */
function looksBinary(content: string): boolean {
  return content.includes('\0');
}

export function searchWorkspace(
  projectRoot: string,
  request: WorkspaceSearchRequest,
): WorkspaceSearchOutcome {
  if (projectRoot.trim() === '') {
    return { ok: false, reason: 'this project has no folder on disk to search.' };
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(request.pattern, 'i');
  } catch (err) {
    return {
      ok: false,
      reason: `“${request.pattern}” is not a valid regular expression (${
        err instanceof Error ? err.message : String(err)
      }). Escape the special characters, or search for a plain substring.`,
    };
  }

  const globMatcher = request.glob ? globToRegExp(request.glob) : null;
  const maxResults = Math.min(request.maxResults ?? 50, MAX_SEARCH_RESULTS);

  // Canonicalised once. Every candidate below is compared against this,
  // after its own canonicalisation — that comparison is the guard.
  const canonicalRoot = canonicalizePath(projectRoot);
  let rootReal: string;
  try {
    rootReal = statSync(projectRoot).isDirectory() ? projectRoot : '';
  } catch {
    return {
      ok: false,
      reason: `this project's folder (${projectRoot}) cannot be read, so there is nothing to search.`,
    };
  }
  if (rootReal === '') {
    return { ok: false, reason: `this project's path (${projectRoot}) is not a folder.` };
  }

  const matches: WorkspaceMatch[] = [];
  let filesExamined = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as never;
    } catch {
      return; // unreadable directory: skipped, never guessed at
    }
    for (const entry of entries as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>) {
      if (truncated) return;
      const absolute = path.join(dir, entry.name);

      // The guard, on every entry: where does this really land? A junction
      // or symlink is canonicalised to its target, so one pointing out of
      // the project fails here and is never descended into or read.
      if (!isInside(canonicalRoot, canonicalizePath(absolute))) continue;

      let isDirectory: boolean;
      let isFile: boolean;
      let size = 0;
      try {
        // `statSync` follows links deliberately — a link that survived the
        // containment check above points somewhere inside the project, and
        // what matters then is what it points AT.
        const stats = statSync(absolute);
        isDirectory = stats.isDirectory();
        isFile = stats.isFile();
        size = stats.size;
      } catch {
        continue; // vanished, or not readable: skipped
      }

      if (isDirectory) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      if (!isFile || size > MAX_FILE_BYTES) continue;

      const relative = path.relative(projectRoot, absolute).split(path.sep).join('/');
      if (globMatcher && !globMatcher.test(relative)) continue;

      if (filesExamined >= MAX_FILES_EXAMINED) {
        truncated = true;
        return;
      }
      filesExamined++;

      let content: string;
      try {
        content = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      if (looksBinary(content)) continue;

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] as string;
        if (!pattern.test(text)) continue;
        if (matches.length >= maxResults) {
          truncated = true;
          return;
        }
        matches.push({ path: relative, line: i + 1, text: text.slice(0, 400) });
      }
    }
  };

  walk(projectRoot);

  return { ok: true, result: { matches, truncated, filesExamined } };
}
