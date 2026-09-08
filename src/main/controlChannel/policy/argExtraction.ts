import path from 'node:path';
import type { ToolClass } from '../../../shared/policy/types';
import { canonicalizePath } from './pathCanonicalize';

/**
 * §11.3: "Canonical argument string is tool-specific and defined by the
 * adapter: for `Bash`, the whitespace-normalised command line; for file
 * tools, the resolved absolute path; for MCP tools, canonical JSON of the
 * arguments."
 *
 * The exact arg field names below (`file_path` for Read/Write/Edit,
 * `path` for Grep/Glob, `command` for Bash, `url` for WebFetch/WebSearch)
 * follow Claude Code's own published/standard tool-argument schema — not
 * yet pinned against a live real-agent capture this session (no captured
 * `tool.requested.args` fixture exists anywhere in this codebase today).
 * Flagged rather than silently assumed: a wrong field name here would
 * silently make every immutable path deny fail to match, which is exactly
 * the class of bug this milestone exists to prevent — confirm against a
 * real agent before trusting this in a security-load-bearing way beyond
 * this session's own tests.
 */
function readStringField(args: unknown, field: string): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const value = (args as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Whitespace-normalised command line for Bash's canonical argument string. */
function normalizeCommandLine(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

export interface ExtractedArgs {
  canonicalPath: string | null;
  canonicalArg: string;
  domain: string | null;
}

/**
 * `impliedPathForRead` is the worktree (or, absent one, the project) —
 * Grep/Glob commonly omit an explicit `path` and default to the cwd,
 * which IS the worktree; treating that omission as "no path, fail closed"
 * would deny the single most common Grep/Glob call shape. Writes get NO
 * such fallback: a write with no resolvable target path fails closed to
 * `null` (treated as "outside" by `path_outside`, see conditions.ts) —
 * there is no sensible default write location to assume instead.
 */
export function extractArgs(
  toolClass: ToolClass,
  rawArgs: unknown,
  impliedPathForRead: string | null,
): ExtractedArgs {
  if (toolClass === 'read' || toolClass === 'write') {
    const rawPath = readStringField(rawArgs, 'file_path') ?? readStringField(rawArgs, 'path');
    const effectiveRawPath = rawPath ?? (toolClass === 'read' ? impliedPathForRead : null);
    if (effectiveRawPath === null) {
      return { canonicalPath: null, canonicalArg: canonicalJson(rawArgs), domain: null };
    }
    // A relative path resolves against the employee's own worktree/project
    // context (impliedPathForRead), never process.cwd() — the Core's own
    // working directory has no relationship to where the employee's
    // process actually runs, and resolving there could point a relative
    // path at a completely unintended location. path.resolve() with an
    // empty base falls back to process.cwd() only in the (edge) case
    // where impliedPathForRead is itself null, no worse than before.
    const canonical = canonicalizePath(
      path.isAbsolute(effectiveRawPath)
        ? effectiveRawPath
        : path.resolve(impliedPathForRead ?? '', effectiveRawPath),
    );
    return { canonicalPath: canonical, canonicalArg: canonical, domain: null };
  }

  if (toolClass === 'command') {
    const command = readStringField(rawArgs, 'command') ?? '';
    return { canonicalPath: null, canonicalArg: normalizeCommandLine(command), domain: null };
  }

  if (toolClass === 'network') {
    const url = readStringField(rawArgs, 'url');
    let domain: string | null = null;
    if (url) {
      try {
        domain = new URL(url).hostname.toLowerCase();
      } catch {
        domain = null; // malformed URL — no domain to match against, condition evaluates accordingly
      }
    }
    return { canonicalPath: null, canonicalArg: canonicalJson(rawArgs), domain };
  }

  // bureau / other — canonical JSON per the MCP-tool rule; bureau tools
  // never actually reach the condition-matching path (isBureauTool
  // short-circuits in evaluator.ts before any of this matters), but this
  // stays total over ToolClass rather than assuming that short-circuit
  // is the only caller forever.
  return { canonicalPath: null, canonicalArg: canonicalJson(rawArgs), domain: null };
}
