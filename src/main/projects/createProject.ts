import type Database from 'better-sqlite3';
import path from 'node:path';
import type { ActivityLog } from '../db/activityLog';
import { getCompanyById } from '../db/repositories/companies';
import {
  bindConversationToProject,
  getCompanyConversation,
  getConversationById,
  insertConversation,
} from '../db/repositories/conversations';
import { insertProject } from '../db/repositories/projects';
import {
  emitDirectorTransition,
  writeDirectorTransition,
  type WrittenDirectorTransition,
} from '../director/directorState';
import type { Conversation } from '../../shared/models/conversation';
import type { Project } from '../../shared/models/project';
import type { z } from 'zod';
import type { ProjectKindSchema } from '../../shared/models/enums';

type ProjectKind = z.infer<typeof ProjectKindSchema>;

/**
 * **A project is created in one place** (standing rule 6; M11 S2-1b). Three
 * callers, one function:
 *
 * - the intent step, when the user describes new work in the company
 *   conversation (`directorTriggers.ts`);
 * - `bureau_set_project_stage` with `stage: 'intake'`, when the Director
 *   judges it new work itself, or the user accepted its offer of a new
 *   project from inside another project's conversation;
 * - `projects.create`, §15.2's wizard shortcut.
 *
 * ## What one creation is (§5.1, Nikunj's decision of 2026-09-25)
 *
 * One transaction: the project at stage `intake`, its conversation, and
 * the Director's move into `INTAKE` there (A.3, validated by the one table).
 * The conversation is either **the current one, bound** — the user was
 * already talking about this work, so its history and context stay with it
 * — or **a new one** when the current conversation is already another
 * project's, or there is none (the wizard). §5.1's "there is always one
 * company-level conversation" is kept in the same transaction: binding the
 * company conversation creates a fresh one, and a company with none gets one.
 *
 * Then, committed, the two events: `project.created` and the transition's
 * `director.intake_started` (invariant #3; `logEvent` refuses to run inside
 * a transaction). Nothing is created on disk: `path` is where the workspace
 * will live, and the repository is initialised when work starts.
 */
export interface CreateProjectInput {
  readonly companyId: string;
  readonly name: string;
  readonly kind?: ProjectKind;
  /** Where the workspace lives. Defaults to a folder under the company's
   *  home named after the project. */
  readonly path?: string;
  /** Bind this conversation (it must be company-level), or give the project
   *  a new one. */
  readonly conversation: { readonly bind: string } | 'new';
  readonly actor: 'user' | 'director';
  /** Why, in the words of whoever decided: the event carries it. */
  readonly reason: string;
}

export interface CreatedProject {
  readonly project: Project;
  readonly conversation: Conversation;
}

export class ProjectCreationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectCreationError';
  }
}

/**
 * The kind is one of §8.1's intake dimensions, so at creation it is not yet
 * known. `mixed` is the one value that claims nothing narrower; the brief
 * says what it really is.
 */
const KIND_BEFORE_INTAKE: ProjectKind = 'mixed';

export function createProject(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  input: CreateProjectInput,
): CreatedProject {
  const { db, activityLog } = deps;
  const company = getCompanyById(db, input.companyId);
  if (company === null) throw new ProjectCreationError(`no company ${input.companyId}`);
  const name = input.name.trim();
  if (name.length === 0) throw new ProjectCreationError('a project needs a name');

  let intake: WrittenDirectorTransition | null = null;
  const created = db.transaction((): CreatedProject => {
    const project = insertProject(db, {
      name,
      path: input.path ?? uniqueWorkspacePath(db, company.home_path, name),
      kind: input.kind ?? KIND_BEFORE_INTAKE,
      stage: 'intake',
    });

    let conversationId: string;
    if (input.conversation === 'new') {
      conversationId = insertConversation(db, {
        company_id: company.id,
        project_id: project.id,
        title: name,
        director_session_id: null,
        summary: null,
        director_state: null,
        director_state_data: null,
      }).id;
    } else {
      const current = getConversationById(db, input.conversation.bind);
      if (current === null) {
        throw new ProjectCreationError(`no conversation ${input.conversation.bind}`);
      }
      if (current.project_id !== null) {
        throw new ProjectCreationError(
          'this conversation is already about a project, so it cannot become another one',
        );
      }
      bindConversationToProject(db, current.id, project.id, name);
      conversationId = current.id;
    }

    // §5.1: there is always one company-level conversation.
    if (getCompanyConversation(db) === null) {
      insertConversation(db, {
        company_id: company.id,
        project_id: null,
        title: company.name,
        director_session_id: null,
        summary: null,
        director_state: null,
        director_state_data: null,
      });
    }

    intake = writeDirectorTransition(db, conversationId, 'INTAKE', { trigger: 'new_project' });
    return { project, conversation: getConversationById(db, conversationId)! };
  })();

  activityLog.logEvent({
    actor: input.actor,
    type: 'project.created',
    severity: 'info',
    project_id: created.project.id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      projectId: created.project.id,
      displayKey: created.project.display_key,
      name: created.project.name,
      conversationId: created.conversation.id,
      conversationBound: input.conversation !== 'new',
      reason: input.reason,
    },
  });
  emitDirectorTransition(activityLog, intake!);
  return created;
}

/**
 * A project's name from the words that asked for it: "Build me a website
 * for my bakery" → "A website for my bakery". Plain code, no model call
 * (§22.4's rule for anything that must work without a provider). The
 * Director can say better later; this only has to be recognisable in the
 * conversation list.
 */
export function projectNameFromRequest(text: string): string {
  const firstLine = (text.trim().split(/\r?\n/)[0] ?? '').trim();
  const stripped = firstLine
    .replace(/^(please\s+)?((can|could|would|will)\s+you\s+(please\s+)?)?/i, '')
    .replace(/^(i|we)\s+(want|need|would like|'d like)\s+(you\s+)?(to\s+)?/i, '')
    .replace(
      /^(build|make|create|write|design|develop|set up|setup|implement|draft|generate|produce|prepare|research|put together|code)\s+(me|us)?\s*/i,
      '',
    )
    .replace(/[\s.!?]+$/, '')
    .trim();
  const words = (stripped.length > 0 ? stripped : firstLine).split(/\s+/);
  let name = '';
  for (const word of words) {
    if ((name + ' ' + word).trim().length > 60) break;
    name = (name + ' ' + word).trim();
  }
  if (name.length === 0) return 'New project';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `<home>/<slug>`, with `-2`, `-3`… when another project already has it. */
function uniqueWorkspacePath(db: Database.Database, home: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'project';
  const taken = new Set(
    (db.prepare('SELECT path FROM projects').all() as { path: string }[]).map((row) =>
      row.path.toLowerCase(),
    ),
  );
  for (let n = 1; ; n += 1) {
    const candidate = path.join(home, n === 1 ? slug : `${slug}-${n}`);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
