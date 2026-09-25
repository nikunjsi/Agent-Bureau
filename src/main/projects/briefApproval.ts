import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { ChatBroadcaster } from '../chat/chatBroadcaster';
import { appendChatMessage } from '../chat/appendMessage';
import {
  approveBrief,
  getBriefById,
  insertBrief,
  latestBriefVersion,
  supersedeBrief,
} from '../db/repositories/briefs';
import { insertDeliverable } from '../db/repositories/deliverables';
import { getProjectById, setProjectApprovedBrief } from '../db/repositories/projects';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import {
  emitDirectorTransition,
  getDirectorState,
  writeDirectorTransition,
  type WrittenDirectorTransition,
} from '../director/directorState';
import {
  emitProjectStageChanged,
  writeUserProjectStage,
  type WrittenProjectStage,
} from './projectStage';
import { BriefDocumentSchema, type BriefDocument } from '../../shared/models/brief';
import type { Deliverable } from '../../shared/models/deliverable';

/**
 * **Whether a project's brief is approved — decided in one place**
 * (standing rule 6; M11 S2-3a). Every later step that invariant #2 guards
 * asks this, never a status column of its own: `bureau_write_plan` (S2-4)
 * refuses without it, and so does anything that creates work.
 *
 * Approved means: the brief the project runs on (`projects.brief_id`, set by
 * the approval) is still the approved version. Editing an approved brief
 * makes a new version and supersedes the old one (`brief.saveEdit`), so the
 * answer goes back to *no* until the user approves the new text — the brief
 * that work follows is always one the user approved as written.
 */
export function isBriefApproved(db: Database.Database, projectId: string): boolean {
  const row = db
    .prepare(
      `SELECT b.status FROM projects p JOIN briefs b ON b.id = p.brief_id
        WHERE p.id = ? AND b.project_id = p.id`,
    )
    .get(projectId) as { status: string } | undefined;
  return row?.status === 'approved';
}

/**
 * The brief's markdown, from §8.3's fields: what the user reads, edits with
 * `brief.saveEdit`, and approves. Plain code — the structured brief is the
 * Director's; turning it into readable text is not a judgement call.
 */
export function renderBriefMarkdown(brief: BriefDocument): string {
  const list = (items: readonly string[]): string =>
    items.length === 0 ? '_None._' : items.map((item) => `- ${item}`).join('\n');
  const constraints = [
    ...brief.constraints.tech.map((c) => `Technology: ${c}`),
    ...brief.constraints.platform.map((c) => `Platform: ${c}`),
    ...(brief.constraints.deadline === null ? [] : [`Deadline: ${brief.constraints.deadline}`]),
    ...(brief.constraints.budget_usd === null ? [] : [`Budget: $${brief.constraints.budget_usd}`]),
    ...brief.constraints.other,
  ];
  return [
    `# ${brief.title}`,
    '',
    brief.one_liner,
    '',
    '## Goal',
    brief.goal,
    '',
    '## Who it is for',
    brief.users || '_Not stated._',
    '',
    '## In scope',
    list(brief.scope),
    '',
    '## Not in scope',
    list(brief.non_goals),
    '',
    '## Deliverables',
    brief.deliverables
      .map(
        (d) =>
          `- **${d.name}** (${d.type}): ${d.description}\n${d.acceptance.map((a) => `  - Done when: ${a}`).join('\n')}`,
      )
      .join('\n'),
    '',
    '## Constraints',
    list(constraints),
    '',
    '## What already exists',
    list(brief.existing_assets),
    '',
    '## How we will know it is done',
    list(brief.success_criteria),
    '',
    '## Assumptions — correct any that are wrong',
    list(brief.assumptions),
    '',
    '## Open questions',
    list(brief.open_questions),
    '',
    '## Risks',
    brief.risks.length === 0
      ? '_None._'
      : brief.risks.map((r) => `- ${r.risk} (${r.impact}): ${r.mitigation}`).join('\n'),
    '',
  ].join('\n');
}

export interface BriefDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly broadcaster?: ChatBroadcaster;
}

export class BriefRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BriefRefusedError';
  }
}

/**
 * `bureau_write_brief`'s work (§7.9: "creates a `briefs` row, posts a
 * `brief` chat message, sets `awaiting_approval`"). One transaction for the
 * new version (any version still waiting is superseded by it) and the
 * Director's `DRAFTING_BRIEF → AWAITING_BRIEF_APPROVAL`; then its events;
 * then the card, which is its own state change with its own event.
 */
export function writeBriefFromDirector(
  deps: BriefDeps,
  input: { readonly projectId: string; readonly conversationId: string; readonly brief: unknown },
): { readonly briefId: string; readonly version: number } {
  const parsed = BriefDocumentSchema.safeParse(input.brief);
  if (!parsed.success) {
    throw new BriefRefusedError(
      `the brief is not §8.3's: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const brief = parsed.data;
  const { db, activityLog } = deps;
  const markdown = renderBriefMarkdown(brief);

  let transition: WrittenDirectorTransition | null = null;
  const written = db.transaction(() => {
    const waiting = db
      .prepare(
        "SELECT id FROM briefs WHERE project_id = ? AND status IN ('draft', 'awaiting_approval')",
      )
      .all(input.projectId) as { id: string }[];
    for (const row of waiting) supersedeBrief(db, row.id);
    const row = insertBrief(db, {
      project_id: input.projectId,
      version: latestBriefVersion(db, input.projectId) + 1,
      content: brief,
      markdown,
      status: 'awaiting_approval',
      approved_at: null,
    });
    transition = writeDirectorTransition(db, input.conversationId, 'AWAITING_BRIEF_APPROVAL', {
      trigger: 'brief_written',
    });
    return { row, superseded: waiting.map((w) => w.id) };
  })();

  activityLog.logEvent({
    actor: 'director',
    type: 'project.brief_drafted',
    severity: 'info',
    project_id: input.projectId,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      briefId: written.row.id,
      version: written.row.version,
      supersededBriefIds: written.superseded,
    },
  });
  emitDirectorTransition(activityLog, transition!);

  appendChatMessage(
    { db, activityLog, ...(deps.broadcaster ? { broadcaster: deps.broadcaster } : {}) },
    {
      conversationId: input.conversationId,
      projectId: input.projectId,
      author: 'director',
      kind: 'brief',
      body: `Here is the brief for ${brief.title}. Approve it, edit it, or tell me what to change.`,
      payload: {
        briefId: written.row.id,
        title: brief.title,
        goal: brief.goal,
        scope: brief.scope,
        outOfScope: brief.non_goals,
        deliverables: brief.deliverables.map((d) => d.name),
        assumptions: brief.assumptions,
      },
    },
  );
  return { briefId: written.row.id, version: written.row.version };
}

export type ApproveBriefOutcome =
  | {
      readonly kind: 'approved';
      readonly projectId: string;
      readonly conversationId: string | null;
    }
  | { readonly kind: 'already_approved' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'not_found' };

/**
 * `brief.approve` (§8.2): **one transaction** for the approval (the
 * compare-and-swap M9 built), one `deliverables` row per
 * `Brief.deliverables[]` the project does not have yet (`draft`), the
 * project's `brief_id` and its `kind`, the user's `brief → planning`, and the
 * Director's `AWAITING_BRIEF_APPROVAL → PLANNING`. A failure anywhere leaves
 * none of it (M11 S2-3a's kill-point test). Then one event per change.
 *
 * The two moves are made only where they apply. A brief approved again
 * later in the project (after an edit) leaves the stage where work is; a
 * Director not waiting on this approval keeps its state. Deliverables are
 * matched by name, so a re-approval adds only what the new version added.
 */
export function approveBriefWithDeliverables(
  deps: BriefDeps,
  briefId: string,
): ApproveBriefOutcome {
  const { db, activityLog } = deps;
  const brief = getBriefById(db, briefId);
  if (brief === null) return { kind: 'not_found' };
  const document = BriefDocumentSchema.safeParse(brief.content ?? {});
  const conversation = resolveConversationForDelivery(db, brief.project_id);
  const projectConversationId =
    conversation !== null && conversation.project_id === brief.project_id ? conversation.id : null;

  let created: Deliverable[] = [];
  let stage: WrittenProjectStage | null = null;
  let transition: WrittenDirectorTransition | null = null;
  const approved = db.transaction((): boolean => {
    if (!approveBrief(db, briefId)) return false;
    const project = getProjectById(db, brief.project_id)!;
    if (document.success) {
      const existing = new Set(
        (
          db.prepare('SELECT title FROM deliverables WHERE project_id = ?').all(project.id) as {
            title: string;
          }[]
        ).map((row) => row.title),
      );
      created = document.data.deliverables
        .filter((d) => !existing.has(d.name))
        .map((d) =>
          insertDeliverable(db, {
            project_id: project.id,
            type: d.type,
            title: d.name,
            summary: d.description,
            status: 'draft',
          }),
        );
    }
    setProjectApprovedBrief(
      db,
      project.id,
      briefId,
      document.success ? document.data.kind : project.kind,
    );
    if (project.stage === 'brief') {
      stage = writeUserProjectStage(db, {
        projectId: project.id,
        to: 'planning',
        reason: 'The user approved the brief.',
      });
    }
    if (
      projectConversationId !== null &&
      getDirectorState(db, projectConversationId).state === 'AWAITING_BRIEF_APPROVAL'
    ) {
      transition = writeDirectorTransition(db, projectConversationId, 'PLANNING', {
        trigger: 'brief_approved',
      });
    }
    return true;
  })();

  if (!approved) {
    return getBriefById(db, briefId)?.status === 'approved'
      ? { kind: 'already_approved' }
      : { kind: 'superseded' };
  }

  activityLog.logEvent({
    actor: 'user',
    type: 'project.brief_approved',
    severity: 'info',
    project_id: brief.project_id,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: { briefId, version: brief.version, deliverables: created.length },
  });
  for (const deliverable of created) {
    activityLog.logEvent({
      actor: 'system',
      type: 'deliverable.created',
      severity: 'info',
      project_id: brief.project_id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: {
        deliverableId: deliverable.id,
        type: deliverable.type,
        title: deliverable.title,
        briefId,
      },
    });
  }
  if (stage !== null) emitProjectStageChanged(activityLog, 'user', stage);
  if (transition !== null) emitDirectorTransition(activityLog, transition);
  return { kind: 'approved', projectId: brief.project_id, conversationId: projectConversationId };
}
