import { SearchWorkspaceArgsSchema } from './schemas';
import { resolveDirectorProject } from '../../director/currentProject';
import { searchWorkspace } from '../../workspace/searchWorkspace';
import type { ToolHandler } from './types';

/**
 * §7.9's `bureau_search_workspace`: *"Grep/glob the project without
 * spawning an employee."* A Director tool (M11 row S1-12b).
 *
 * The Director reads to answer a question — what does this codebase
 * already do, where is that file — and paying an employee's turn for it is
 * the waste this tool exists to avoid.
 *
 * **The root is not an argument.** It is the Director's current project's
 * own folder, and when there is none the call is refused rather than
 * defaulted to anything (invariant #6). The confinement itself lives in
 * `searchWorkspace`, at the handler, because policy allowed this tool
 * before scanning a single deny (§23.2 / invariant #5's carve-out).
 */

export const handleSearchWorkspace: ToolHandler = (ctx, rawArgs) => {
  const parsed = SearchWorkspaceArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_search_workspace: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    };
  }

  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message:
        'bureau_search_workspace: there is no project on this conversation yet, so there is no ' +
        'workspace to search. Nothing outside a project is readable.',
    };
  }

  const outcome = searchWorkspace(project.path, {
    pattern: parsed.data.pattern,
    glob: parsed.data.glob,
    maxResults: parsed.data.max_results,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `bureau_search_workspace: ${outcome.reason}`,
    };
  }

  return {
    ok: true,
    data: {
      projectId: project.id,
      matches: outcome.result.matches,
      truncated: outcome.result.truncated,
      filesExamined: outcome.result.filesExamined,
      ...(outcome.result.truncated
        ? {
            note:
              'This answer is incomplete — a cap was reached. Narrow the pattern or the glob ' +
              'rather than assuming these are all the matches.',
          }
        : {}),
    },
  };
};
