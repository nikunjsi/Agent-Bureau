import { resolveDirectorProject } from '../../director/currentProject';
import { getTaskById } from '../../db/repositories/tasks';
import { getProjectById } from '../../db/repositories/projects';
import { changedFiles, latestSubmission } from '../../projects/taskCompletion';
import { runGit } from '../../workspace/gitProcess';
import { GetTaskDetailArgsSchema } from './schemas';
import type { ToolHandler, ToolHandlerResult } from './types';

/** Enough of a diff to judge a task by; a longer one says it was cut. */
const DIFF_CHARS = 20_000;

/**
 * §7.9's `bureau_get_task_detail`: *"Full detail including diff and event
 * trail, for completion evaluation."* A Director tool (M11 S3-4a, §8.5.1).
 *
 * Everything comes from the record, nothing is re-run: the task and its
 * acceptance criteria; what the employee said it did, verified and did not
 * verify (its `bureau_task_done`); the committed diff against the commit the
 * work was cut from, and what every check said (`git.committed`); and the
 * task's recent events. The task must be the turn's project's.
 */
export const handleGetTaskDetail: ToolHandler = async (ctx, rawArgs) => {
  const parsed = GetTaskDetailArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return refuse(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const project = resolveDirectorProject(ctx.db, ctx.supervisorRegistry);
  if (project === null) return refuse('this conversation is not about a project.');
  const task = getTaskById(ctx.db, parsed.data.task_id);
  if (task === null || task.project_id !== project.id) {
    return refuse(`there is no task ${parsed.data.task_id} in ${project.display_key}.`);
  }

  const submission = latestSubmission(ctx.db, task.id);
  const committed = ctx.db
    .prepare(
      "SELECT payload FROM events WHERE task_id = ? AND type = 'git.committed' ORDER BY seq DESC LIMIT 1",
    )
    .get(task.id) as { payload: string | null } | undefined;
  const commit = committed?.payload
    ? (JSON.parse(committed.payload) as {
        commitSha?: string;
        baseCommit?: string;
        validators?: { name: string; passed: boolean; output: string }[];
      })
    : {};

  let diff: string | null = null;
  let files: string[] = [];
  const repo = getProjectById(ctx.db, task.project_id)?.path ?? null;
  if (repo !== null && commit.commitSha !== undefined && commit.baseCommit !== undefined) {
    files = await changedFiles(repo, commit.baseCommit, commit.commitSha);
    const { stdout } = await runGit(['diff', commit.baseCommit, commit.commitSha], {
      cwd: repo,
      repoKey: repo,
    });
    diff =
      stdout.length > DIFF_CHARS
        ? `${stdout.slice(0, DIFF_CHARS)}\n… (the diff goes on; ${stdout.length} characters in all)`
        : stdout;
  }

  const trail = ctx.db
    .prepare('SELECT ts, type FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT 25')
    .all(task.id) as { ts: string; type: string }[];

  return {
    ok: true,
    data: {
      taskId: task.id,
      displayKey: task.display_key,
      title: task.title,
      body: task.body,
      status: task.status,
      statusReason: task.status_reason,
      attempts: task.attempts,
      acceptanceCriteria: task.acceptance_criteria,
      summary: task.result_summary,
      verified: submission.verified,
      notVerified: submission.notVerified,
      commitSha: commit.commitSha ?? null,
      changedFiles: files,
      diff,
      checks: commit.validators ?? [],
      recentEvents: trail.reverse(),
    },
  };
};

function refuse(message: string): ToolHandlerResult {
  return { ok: false, code: 'VALIDATION_FAILED', message: `bureau_get_task_detail: ${message}` };
}
