import path from 'node:path';
import { getProjectById, setProjectBudget } from '../../db/repositories/projects';
import { getSoleCompany } from '../../db/repositories/companies';
import { resolveConversationForDelivery } from '../../db/repositories/conversations';
import { createProject, ProjectCreationError } from '../../projects/createProject';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Projects as ProjectsSchemas } from '../../../shared/ipc/schemas/projects';
import { stub, type Handler, type HandlerContext } from './types';

function listAllProjects(ctx: HandlerContext) {
  const rows = ctx.db.prepare('SELECT id FROM projects ORDER BY created_at').all() as {
    id: string;
  }[];
  return rows.map((row) => getProjectById(ctx.db, row.id)).filter((p) => p !== null);
}

export const projectsHandlers: Record<string, Handler> = {
  list: (_input, ctx) => ipcOk({ items: listAllProjects(ctx) }),
  get: (input, ctx) => {
    const { id } = ProjectsSchemas.get.input.parse(input);
    return ipcOk({ item: getProjectById(ctx.db, id) });
  },
  // M11 S2-1b: §15.2's wizard shortcut, which "pre-creates the project"
  // (§5.1) — through the same one creation function as a project started
  // from the chat, with a conversation of its own, in intake.
  create: (input, ctx) => {
    const { name, path: workspace, kind } = ProjectsSchemas.create.input.parse(input);
    if (!path.isAbsolute(workspace)) {
      return ipcError('VALIDATION_FAILED', 'Choose a full folder path for the project.');
    }
    const company = getSoleCompany(ctx.db);
    if (company === null) {
      return ipcError('VALIDATION_FAILED', 'Finish setting up your company first.');
    }
    try {
      const { project } = createProject(
        { db: ctx.db, activityLog: ctx.activityLog },
        {
          companyId: company.id,
          name,
          kind,
          path: workspace,
          conversation: 'new',
          actor: 'user',
          reason: 'The user created the project directly.',
        },
      );
      return ipcOk({ item: project });
    } catch (err) {
      if (err instanceof ProjectCreationError) return ipcError('VALIDATION_FAILED', err.message);
      throw err;
    }
  },
  // M11 S2-1b: opening a project is opening its conversation. Reads only:
  // every project has one from the moment it is created (`createProject`).
  open: (input, ctx) => {
    const { id } = ProjectsSchemas.open.input.parse(input);
    if (getProjectById(ctx.db, id) === null) {
      return ipcError('NOT_FOUND', `No project with id ${id}`, { type: 'retry' });
    }
    const conversation = resolveConversationForDelivery(ctx.db, id);
    if (conversation === null || conversation.project_id !== id) {
      return ipcError('NOT_FOUND', 'This project has no conversation.');
    }
    return ipcOk({ conversationId: conversation.id });
  },
  // pause/resume/abandon and exportData/deleteData need their own flows
  // (a real export/delete pipeline, M13/M15) — not just an UPDATE/DELETE,
  // since project data spans the DB, memory/, and the worktree checkout.
  pause: stub('M11'),
  resume: stub('M11'),
  abandon: stub('M11'),
  // M6 session 2 built the four budget levels; this surface (the
  // project-level one) was left stubbed. CLAUDE.md invariant #3: commit
  // before the side effect, exactly one activity event — there is no
  // further side effect here (no employee to notify synchronously; the
  // next real budget check just reads the new value), so the event is
  // the whole second half.
  setBudget: (input, ctx) => {
    const { id, budgetUsdMicros } = ProjectsSchemas.setBudget.input.parse(input);
    const before = getProjectById(ctx.db, id);
    if (before === null)
      return ipcError('NOT_FOUND', `No project with id ${id}`, { type: 'retry' });
    setProjectBudget(ctx.db, id, budgetUsdMicros);
    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'project.budget_set',
      severity: 'info',
      project_id: id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { beforeUsdMicros: before.budget_usd_micros, afterUsdMicros: budgetUsdMicros },
    });
    return ipcOk({ ok: true as const });
  },
  exportData: stub('M15'),
  deleteData: stub('M15'),
};
