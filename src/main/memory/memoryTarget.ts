import path from 'node:path';
import { getMemoryDir } from '../db/paths';
import { canonicalizePath } from '../controlChannel/policy/pathCanonicalize';
import { isInside } from '../security/pathConfinement';
import { memoryAbsolutePath, memoryRelativePath, type MemoryLocation } from './memoryStore';
import type { MemoryScope } from '../../shared/models/enums';

/**
 * The single door every memory write goes through, and the place CLAUDE.md
 * invariant #5 is actually enforced for memory.
 *
 * ## Read this before assuming policy has already checked
 *
 * §12.1 says memory is unreachable to an employee's *own* file tools, and
 * that is true: `deny.system_paths` denies any path under
 * `AppData/Roaming/Bureau/` (`immutableRules.ts`), which is where this tree
 * lives. But
 * `bureau_propose_memory` is a `bureau_` tool, and `evaluator.ts` returns
 * `{effect:'allow'}` for every `bureau_`/`mcp__bureau__` tool **before** the
 * seven immutable denies are scanned (§23.2 — "always allowed", deliberate
 * and correct). So for this tool the deny never runs.
 *
 * **For a `bureau_` tool, policy is not the guard. The handler is.** That
 * is AUDIT #10's second consequence, it is now written beside invariant #5
 * in CLAUDE.md, and this file is what makes it true for the first Bureau
 * tool that writes files to disk. The test that matters therefore proves
 * *this* refuses (`tests/integration/memory/memoryWriteConfinement.test.ts`,
 * S2), not that policy would have — standing rule 2.
 *
 * ## Shape
 *
 * A caller supplies a `scope` and a `path` **relative to that scope's
 * directory**; everything before the file name becomes the `scopeRef`. That
 * is the layout §12.1 already defines, and `memoryRelativePath` /
 * `memoryAbsolutePath` remain the only things that turn a location into a
 * path — nothing here re-derives one (standing rule 6).
 *
 * ## Fail closed
 *
 * Every branch below refuses rather than repairs. A refused memory write
 * costs an agent one corrected call; an accepted one that escaped the tree
 * is the invariant. The final containment test is done on the
 * **canonicalised** absolute path — after junctions, symlinks and 8.3 short
 * names are collapsed — because the earlier syntactic checks can be walked
 * around by a filesystem link and the canonical check cannot.
 */

/** Windows device names, which are not legal file names anywhere in a path. */
const RESERVED_SEGMENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** A control character or DEL in a file name. Tested by code point rather
 *  than a regex literal: a raw control character pasted into source is
 *  invisible to the next reader and to every diff that shows it. */
function hasControlChar(segment: string): boolean {
  return [...segment].some((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

export type MemoryTargetRefusal =
  | { readonly kind: 'no_memory_root' }
  | { readonly kind: 'not_relative'; readonly path: string }
  | { readonly kind: 'traversal'; readonly path: string }
  | { readonly kind: 'illegal_segment'; readonly path: string; readonly segment: string }
  | { readonly kind: 'not_markdown'; readonly path: string }
  | { readonly kind: 'escapes_memory_root'; readonly path: string }
  | {
      readonly kind: 'wrong_owner';
      readonly path: string;
      readonly ownerId: string;
      readonly requestedRef: string | null;
    };

export type MemoryTargetResolution =
  | {
      readonly ok: true;
      readonly location: MemoryLocation;
      /** The `memory.path` key — POSIX, relative to the memory root. */
      readonly relativePath: string;
      readonly absolutePath: string;
    }
  | { readonly ok: false; readonly refusal: MemoryTargetRefusal };

export interface MemoryTargetRequest {
  readonly scope: MemoryScope;
  /**
   * Relative to the scope directory: `standards.md`, or
   * `engineering/developer/playbook.md` for a role. Never absolute, never
   * containing `..`.
   */
  readonly path: string;
  /**
   * The employee this write is on behalf of, when there is one. For
   * `employee` scope this **is** the `scopeRef` — it is taken from the
   * authenticated token, never from the request — and `path` must then be a
   * bare file name. An employee that could name another employee's
   * directory could read and rewrite their notes, which is the same class
   * of hole as naming a path outside the tree.
   */
  readonly employeeId?: string | null;
}

/**
 * §12.4: "Writes to `employee/` are free. Writes to `company/` and
 * `project/` require approval." `role` and `user` are gated too, and that is
 * a reading rather than an omission: §12.2 says a role's shared scope is
 * written by employees *"with approval"*, and `user/` is written by the
 * Director *"from explicit statements only"*. Gating everything that is not
 * an employee's own notebook is also the fail-closed direction (#6).
 *
 * **And for the Director it answers a second question, in the same place**
 * (M11 S1-12b, `NEXT-VERSION` §M.4): §7.9 gives `bureau_write_memory` a
 * direct `project` write and keeps `company` asking. That is a different
 * answer for the same scope, so it takes the writer as an argument rather
 * than living in a second function — standing rule 6, one decision, one
 * place. The argument is required: a default would let a new caller get
 * the employee's answer by saying nothing.
 *
 * One function, one answer. Nothing else decides whether a scope is gated.
 */
export type MemoryWriter = 'employee' | 'director';

export function memoryScopeRequiresApproval(scope: MemoryScope, writer: MemoryWriter): boolean {
  // Either caller's own notebook is their own.
  if (scope === 'employee') return false;
  // §7.9's Director row: 'Direct write (project scope without approval;
  // company scope still asks)'. Only 'project' is named, and only
  // 'project' is free — 'user' and 'role' stay gated, which is the
  // fail-closed direction (#6) and what §12.2 already says about them.
  if (writer === 'director' && scope === 'project') return false;
  return true;
}

export function resolveMemoryTarget(
  baseDir: string,
  request: MemoryTargetRequest,
): MemoryTargetResolution {
  // **No configured root means nothing is inside it — not "resolve against
  // the current directory".** `getMemoryDir('')` is the bare relative path
  // `memory`, which `path.resolve` would happily anchor to whatever the
  // process's cwd happens to be, and every containment check below would
  // then pass while writing somewhere nobody chose. `attachments.ts` refuses
  // an unset company home for the same reason and in the same words: the
  // absence of a workspace does not mean everything is in it.
  //
  // Found by a test whose control-channel server was constructed without a
  // `baseDir` — which is exactly the shape a real caller could have.
  if (baseDir.trim() === '') return { ok: false, refusal: { kind: 'no_memory_root' } };

  const raw = request.path.trim();

  // A relative path is the only kind that has meaning here: the scope
  // directory is the origin, and an absolute one would be naming a place in
  // the filesystem rather than a note in the tree.
  if (raw === '' || path.isAbsolute(raw) || /^[a-z]:/i.test(raw) || raw.startsWith('\\\\')) {
    return { ok: false, refusal: { kind: 'not_relative', path: request.path } };
  }

  const segments = raw.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return { ok: false, refusal: { kind: 'not_relative', path: request.path } };
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      return { ok: false, refusal: { kind: 'traversal', path: request.path } };
    }
    // `:` would make an alternate NTFS data stream; a control character or a
    // reserved device name is not a file name on this platform at all.
    // Refused rather than sanitised — a rewritten name is a note filed
    // somewhere the author did not ask for.
    if (segment.includes(':') || hasControlChar(segment) || RESERVED_SEGMENTS.test(segment)) {
      return { ok: false, refusal: { kind: 'illegal_segment', path: request.path, segment } };
    }
  }

  const fileName = segments[segments.length - 1] as string;
  if (!/\.md$/i.test(fileName)) {
    // Layer 1 is markdown, by §12.1's first sentence. A `.md`-only tree is
    // also what makes `discoverMemoryFiles` able to walk it without
    // guessing.
    return { ok: false, refusal: { kind: 'not_markdown', path: request.path } };
  }

  let refParts = segments.slice(0, -1);

  if (request.scope === 'employee') {
    const ownerId = request.employeeId ?? '';
    if (ownerId === '') {
      // No authenticated employee, so there is no `employee/` directory this
      // write could legitimately belong to. Not "let it through unscoped".
      return {
        ok: false,
        refusal: {
          kind: 'wrong_owner',
          path: request.path,
          ownerId: '',
          requestedRef: refParts.length === 0 ? null : refParts.join('/'),
        },
      };
    }
    // Anything the caller put in front of the file name would be naming a
    // directory; for this scope the only legal one is the caller's own, and
    // it is taken from the token rather than believed from the request.
    if (refParts.length > 0 && refParts.join('/') !== ownerId) {
      return {
        ok: false,
        refusal: {
          kind: 'wrong_owner',
          path: request.path,
          ownerId,
          requestedRef: refParts.join('/'),
        },
      };
    }
    refParts = [ownerId];
  }

  const location: MemoryLocation = {
    scope: request.scope,
    scopeRef: refParts.length === 0 ? null : refParts.join('/'),
    fileName,
  };

  const absolutePath = memoryAbsolutePath(baseDir, location);

  // The check that actually holds the line. Everything above is syntax and
  // can be defeated by a junction or a symlink pointing out of the tree;
  // `canonicalizePath` collapses those, and only then is containment a fact
  // about where the bytes would land.
  const root = canonicalizePath(getMemoryDir(baseDir));
  if (!isInside(root, canonicalizePath(absolutePath))) {
    return { ok: false, refusal: { kind: 'escapes_memory_root', path: request.path } };
  }

  return {
    ok: true,
    location,
    relativePath: memoryRelativePath(location),
    absolutePath,
  };
}

/**
 * §7.9's rule that a tool's validation errors "are read by an agent, not a
 * human" and §14.6's rule that a person gets "what happened, why, and a
 * concrete next action" happen to want the same thing here: say what was
 * wrong and what a legal path looks like. Content, not presentation — the
 * caller decides where it is shown.
 */
export function describeMemoryTargetRefusal(refusal: MemoryTargetRefusal): string {
  switch (refusal.kind) {
    case 'no_memory_root':
      return (
        'Bureau has no memory folder configured, so there is nowhere a note could be written. ' +
        'This is a Bureau-side problem, not something the path can fix.'
      );
    case 'not_relative':
      return (
        `“${refusal.path}” is not a path inside a memory scope. Give a path relative to the ` +
        'scope, like `standards.md` or `engineering/developer/playbook.md`.'
      );
    case 'traversal':
      return (
        `“${refusal.path}” contains a “..” or “.” segment. Memory paths point inside the memory ` +
        'tree only; write the path out in full instead.'
      );
    case 'illegal_segment':
      return (
        `“${refusal.segment}” cannot be part of a memory path — it is a reserved name or uses a ` +
        'character Windows does not allow in one. Rename that part of the path.'
      );
    case 'not_markdown':
      return (
        `“${refusal.path}” is not a markdown file. Memory notes are markdown, so the path must ` +
        'end in `.md`.'
      );
    case 'escapes_memory_root':
      return (
        `“${refusal.path}” resolves to somewhere outside Bureau's memory folder, and nothing ` +
        'outside it is writable. Use a path inside the scope you named.'
      );
    case 'wrong_owner':
      return refusal.ownerId === ''
        ? 'Employee-scope notes belong to a specific employee, and this request has none. ' +
            'Use a different scope, or make the write as an employee.'
        : `Employee-scope notes go in your own folder (${refusal.ownerId}); “${refusal.requestedRef ?? ''}” ` +
            'is somebody else’s. Give just the file name, like `notes.md`.';
  }
}
