import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import { getBriefById } from '../db/repositories/briefs';
import { getProjectById, setProjectWorkspaceReady } from '../db/repositories/projects';
import { isBriefApproved } from '../projects/briefApproval';
import { BriefDocumentSchema } from '../../shared/models/brief';
import { ensureNonUnbornHead, ensureRepoInitialised } from './gitInit';
import { GitCommandError, runGit } from './gitProcess';

export type ProjectWorkspaceResult =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string };

/**
 * A project's folder, ready for its first assignment (M11 S3-0, §F S2-1b).
 *
 * `createProject` records `<home>/<slug>` and creates nothing on disk,
 * because intake may still learn the work belongs in a folder the user
 * already has (§8.1, "Existing assets"). The first assignment needs a git
 * repository with a commit to branch a worktree from (§10.3), so this is
 * called before it (S3-2) and:
 *
 * - **Never before the brief is approved** (invariant #2): nothing is made
 *   on disk for a project the user has not agreed to.
 * - **Uses a folder the approved brief names**: an absolute path among its
 *   `existing_assets` that is a directory. It is verified, not replaced: a
 *   repository already there is left as it is, and one that is not yet a
 *   repository is initialised in place. A named path that is not there, or
 *   two named folders, is a reason to stop and ask, not to guess (invariant
 *   #6). An absolute path to a file is a file asset and is ignored.
 * - **Otherwise creates the recorded folder** and initialises it, with an
 *   initial commit (`ensureNonUnbornHead`).
 * - **`base_ref` is made real**, because a worktree branches from it
 *   (§10.3). A repository with no commit yet gets `base_ref` as its first
 *   branch (whatever `git init` would have named it on this machine). An
 *   existing repository on another branch keeps it: that branch is recorded
 *   as the project's `base_ref`, never renamed. A detached `HEAD` is a
 *   reason to stop.
 * - **Idempotent**: a project already ready is checked and returned, with no
 *   event. The first time, one `project.workspace_ready`.
 * - **A failure is a plain reason**, returned for the caller to block the
 *   task with. It is never retried here.
 *
 * Ordering (invariant #3): the folder and the repository are made first and
 * the row written after, because the row says "this is ready" and must not
 * be true before it is. Every disk step is idempotent, so a crash between
 * the two is repaired by the next call, which finds the folder, verifies it
 * and writes the row.
 */
export async function ensureProjectWorkspace(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  projectId: string,
): Promise<ProjectWorkspaceResult> {
  const { db, activityLog } = deps;
  const project = getProjectById(db, projectId);
  if (project === null) return { ok: false, reason: 'the project no longer exists.' };
  if (!isBriefApproved(db, project.id) || project.brief_id === null) {
    return {
      ok: false,
      reason: "the project's brief is not approved, so nothing is made on disk for it yet.",
    };
  }

  if (project.repo_initialised && isRepository(project.path)) {
    return { ok: true, path: project.path };
  }

  const named = namedFolder(db, project.brief_id);
  if (!named.ok) return named;
  const folder = named.folder ?? project.path;
  const source = named.folder !== null ? 'existing' : 'created';

  let createdFolder = false;
  let initialisedRepo = false;
  let createdInitialCommit = false;
  let baseRef = project.base_ref;
  try {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
      createdFolder = true;
    }
    initialisedRepo = (await ensureRepoInitialised(folder)).initialisedNow;
    const git = (args: string[]) => runGit(args, { cwd: folder, repoKey: folder });
    if (!(await resolves(git, 'HEAD'))) {
      await git(['symbolic-ref', 'HEAD', `refs/heads/${baseRef}`]);
    }
    createdInitialCommit = (await ensureNonUnbornHead(folder)).createdInitialCommit;
    if (!(await resolves(git, `refs/heads/${baseRef}`))) {
      const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
      if (current === null) {
        return {
          ok: false,
          reason:
            `the repository at ${folder} has no branch checked out (a detached HEAD), so there is ` +
            'no branch for the work to start from. Ask the user to check out the branch the ' +
            'work belongs on.',
        };
      }
      baseRef = current.stdout.trim();
    }
  } catch (err) {
    return {
      ok: false,
      reason: `Bureau could not prepare the project's folder ${folder} as a repository: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  setProjectWorkspaceReady(db, project.id, folder, baseRef);
  activityLog.logEvent({
    actor: 'system',
    type: 'project.workspace_ready',
    severity: 'info',
    project_id: project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      path: folder,
      source,
      baseRef,
      createdFolder,
      initialisedRepo,
      createdInitialCommit,
    },
  });
  return { ok: true, path: folder };
}

async function resolves(git: (args: string[]) => Promise<unknown>, ref: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch (err) {
    if (err instanceof GitCommandError) return false;
    throw err;
  }
}

function isRepository(folder: string): boolean {
  return fs.existsSync(path.join(folder, '.git'));
}

/** The one folder the approved brief names as existing work, `null` when it
 *  names none, or a reason when what it names cannot be used. */
function namedFolder(
  db: Database.Database,
  briefId: string,
): { ok: true; folder: string | null } | { ok: false; reason: string } {
  const brief = getBriefById(db, briefId);
  const document = BriefDocumentSchema.safeParse(brief?.content ?? {});
  if (!document.success) return { ok: true, folder: null };
  const folders: string[] = [];
  for (const asset of document.data.existing_assets) {
    const candidate = asset.trim();
    if (!path.isAbsolute(candidate)) continue;
    const resolved = path.resolve(candidate);
    if (!fs.existsSync(resolved)) {
      return {
        ok: false,
        reason:
          `the approved brief names ${resolved} as existing work, and it is not there. ` +
          'Ask the user where it is before any work starts.',
      };
    }
    if (fs.statSync(resolved).isDirectory()) folders.push(resolved);
  }
  if (folders.length > 1) {
    return {
      ok: false,
      reason:
        `the approved brief names more than one existing folder (${folders.join(', ')}), ` +
        'and a project works in one. Ask the user which one the work belongs in.',
    };
  }
  return { ok: true, folder: folders[0] ?? null };
}
