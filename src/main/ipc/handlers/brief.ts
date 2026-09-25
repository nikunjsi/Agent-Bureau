import { approveBriefWithDeliverables } from '../../projects/briefApproval';
import { requestBriefChanges } from '../../projects/documentChanges';
import {
  getBriefById,
  insertBrief,
  latestBriefVersion,
  supersedeBrief,
} from '../../db/repositories/briefs';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Brief as BriefSchemas } from '../../../shared/ipc/schemas/brief';
import { type Handler, type HandlerContext } from './types';
import type { Brief } from '../../../shared/models/brief';

function requireBrief(ctx: HandlerContext, id: string): Brief | ReturnType<typeof ipcError> {
  const brief = getBriefById(ctx.db, id);
  if (brief === null) return ipcError('NOT_FOUND', `No brief with id "${id}".`, { type: 'retry' });
  return brief;
}

/**
 * §8.2's three buttons, Core half. §28 M9 item 4 gives them to this
 * milestone, and session 1 recommended making them real here rather than
 * shipping a card whose Approve button returns `NOT_IMPLEMENTED`.
 *
 * **Only *drafting* is M11's.** Approving and editing are row state
 * changes against a schema that already models them: `VersionedDocStatus`
 * is `draft → awaiting_approval → approved/superseded`, `approved_at`
 * exists, `version` is an int, and `project.brief_approved` /
 * `project.brief_drafted` are already in §5.2. What M11 owns is the thing
 * that writes the first row — and nothing in `src/` does yet, which is
 * exactly why §28's M9 gate ("a full conversation including approving a
 * brief") cannot pass in this milestone. See PROGRESS.md.
 *
 * **Discuss is not here.** §8.2 says it "goes back to conversation", so it
 * is `chat.send` with the card as context — a message, not a fourth state
 * change. Building a handler for it would be a second producer of
 * director-addressed messages differing only in a status side effect.
 */
export const briefHandlers: Record<string, Handler> = {
  get: (input, ctx) => {
    const { projectId } = BriefSchemas.get.input.parse(input);
    const row = ctx.db
      .prepare('SELECT id FROM briefs WHERE project_id = ? ORDER BY version DESC LIMIT 1')
      .get(projectId) as { id: string } | undefined;
    return ipcOk({ item: row ? getBriefById(ctx.db, row.id) : null });
  },

  /**
   * **Invariant #2's only producer**: *nothing is built before the brief is
   * approved.* This is the first code in Bureau that can make that
   * sentence true, and M11's task-creation path is where it must be
   * enforced — by requiring `briefs.status = 'approved'` for the project
   * before a single task row is written. Recorded here and in
   * NEXT-VERSION rather than as a guard with no caller (standing rule 2).
   */
  approve: (input, ctx) => {
    const { id } = BriefSchemas.approve.input.parse(input);
    let outcome: ReturnType<typeof approveBriefWithDeliverables>;
    try {
      // M11 S2-3a: the approval, the brief's deliverables, planning and the
      // Director's state — one transaction (`briefApproval.ts`).
      outcome = approveBriefWithDeliverables(
        {
          db: ctx.db,
          activityLog: ctx.activityLog,
          ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
        },
        id,
      );
    } catch (err) {
      console.error('[brief.approve] the approval could not be written:', err);
      return ipcError(
        'INTERNAL_ERROR',
        'The brief could not be approved just now, and nothing was changed. Try again.',
        { type: 'retry' },
      );
    }
    switch (outcome.kind) {
      case 'not_found':
        return ipcError('NOT_FOUND', `No brief with id "${id}".`, { type: 'retry' });
      case 'already_approved':
        return ipcOk(BriefSchemas.approve.output.parse({ ok: true }));
      case 'superseded':
        // The CAS lost to a newer version: "you are looking at an old one".
        return ipcError(
          'VALIDATION_FAILED',
          'This version of the brief was replaced by a newer one, so it can no longer be ' +
            'approved. Scroll down to the latest version and approve that.',
        );
      case 'approved':
        // The Director is waiting on exactly this: its next turn is planning.
        if (outcome.conversationId !== null) {
          ctx.directorTriggers?.offerUserDecision?.({
            conversationId: outcome.conversationId,
            key: `brief_approved:${id}`,
            text:
              'The user approved the brief. Plan the work now: phases that end where the user ' +
              'would want to look, tasks with acceptance criteria, and the cost of each phase.',
          });
        }
        return ipcOk(BriefSchemas.approve.output.parse({ ok: true }));
    }
  },

  /**
   * §28 item 4, verbatim: "Edit opens the markdown in an editor and saves
   * a **new version**." Not an in-place rewrite — `version` is an int and
   * `superseded` is a real status precisely so the text the user was shown
   * before survives alongside what they changed it to.
   *
   * The new row's structured `content` is **carried over unchanged**, and
   * that is deliberate rather than lazy: deriving §8.3's twenty-odd fields
   * back out of edited markdown is a language task, which is the
   * Director's (M11). The row is honest about it — the markdown is the
   * user's and the content is the Director's last structured reading of a
   * previous version — and the card shows the live row's status, so a
   * user who edits sees "awaiting approval" rather than a stale approved
   * badge.
   */
  saveEdit: (input, ctx) => {
    const { id, markdown } = BriefSchemas.saveEdit.input.parse(input);
    const brief = requireBrief(ctx, id);
    if ('ok' in brief) return brief;

    if (brief.status === 'superseded') {
      return ipcError(
        'VALIDATION_FAILED',
        'This version of the brief was already replaced by a newer one. Edit the latest version ' +
          'instead, so your changes are not made to text that has been superseded.',
      );
    }

    const write = ctx.db.transaction(() => {
      const next = insertBrief(ctx.db, {
        project_id: brief.project_id,
        version: latestBriefVersion(ctx.db, brief.project_id) + 1,
        content: brief.content ?? {},
        markdown,
        status: 'awaiting_approval',
        approved_at: null,
      });
      supersedeBrief(ctx.db, brief.id);
      return next;
    });
    const next = write();

    // §5.2's own type for "a new brief version exists". `actor` is what
    // distinguishes a user edit from a Director draft — the taxonomy was
    // closed in session 1 and a `brief_edited` type would widen it for a
    // distinction the actor already carries.
    ctx.activityLog.logEvent({
      actor: 'user',
      type: 'project.brief_drafted',
      severity: 'info',
      project_id: brief.project_id,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: { briefId: next.id, version: next.version, supersededBriefId: brief.id },
    });
    return ipcOk(BriefSchemas.saveEdit.output.parse({ ok: true }));
  },

  /**
   * M11 S2-3b, `NEXT-VERSION` §L.4: "ask for changes" — the card's action
   * beside Edit (which is the user rewriting the markdown themselves). The
   * Director goes back to drafting, `project.brief_changes_requested` records
   * it, the words go into the conversation, and the Director gets them as a
   * turn (`documentChanges.ts`).
   */
  requestEdit: (input, ctx) => {
    const { id, feedback } = BriefSchemas.requestEdit.input.parse(input);
    const outcome = requestBriefChanges(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        ...(ctx.chatBroadcaster ? { broadcaster: ctx.chatBroadcaster } : {}),
      },
      { briefId: id, feedback },
    );
    switch (outcome.kind) {
      case 'not_found':
        return ipcError('NOT_FOUND', `No brief with id "${id}".`, { type: 'retry' });
      case 'refused':
        return ipcError('VALIDATION_FAILED', outcome.message);
      case 'requested':
        ctx.directorTriggers?.offerUserDecision?.({
          conversationId: outcome.conversationId,
          key: `brief_changes:${outcome.messageId}`,
          text: outcome.directorText,
        });
        return ipcOk(BriefSchemas.requestEdit.output.parse({ ok: true }));
    }
  },
};
