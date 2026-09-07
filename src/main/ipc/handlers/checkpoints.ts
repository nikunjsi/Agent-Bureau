import { getCheckpointById, listPendingCheckpoints } from '../../db/repositories/checkpoints';
import { answerCheckpoint, answerPermissionCheckpoint } from '../../checkpoints/answerCheckpoint';
import { ipcError, ipcOk } from '../../../shared/ipc/envelope';
import { Checkpoints as CheckpointsSchemas } from '../../../shared/ipc/schemas/checkpoints';
import type { Handler, HandlerContext } from './types';

/**
 * §9.4's first surface is "a message in the Director chat", and none of
 * §9.4's four surfaces exists yet — the chat card and the Checkpoints
 * badge are M9/M14, the floor signal is M12, and the desktop notification
 * is M8 session 2. So **M8's gate line "answered from the UI" is satisfied
 * here, at the real IPC handler**, driven by a test: the same handler M9's
 * card will call, with no test-only path around it. Nothing in session 1
 * claims a screen exists.
 */

function requireBaseDir(ctx: HandlerContext): string {
  return ctx.baseDir;
}

export const checkpointsHandlers: Record<string, Handler> = {
  listPending: (_input, ctx) => ipcOk({ items: listPendingCheckpoints(ctx.db) }),

  get: (input, ctx) => {
    const { id } = CheckpointsSchemas.get.input.parse(input);
    return ipcOk({ item: getCheckpointById(ctx.db, id) });
  },

  answer: (input, ctx) => {
    const parsed = CheckpointsSchemas.answer.input.parse(input);
    const result = answerCheckpoint(
      { db: ctx.db, activityLog: ctx.activityLog, baseDir: requireBaseDir(ctx) },
      {
        checkpointId: parsed.id,
        optionId: parsed.optionId,
        freeText: parsed.freeText,
        source: 'user',
      },
    );

    if (!result.ok) {
      // Each reason is a different thing for a person to do about it, so
      // each gets its own sentence rather than one generic failure.
      switch (result.reason) {
        case 'not_found':
          return ipcError('NOT_FOUND', 'That checkpoint no longer exists.');
        case 'not_pending':
          return ipcError('CONFLICT', 'That checkpoint has already been answered or has expired.');
        case 'unknown_option':
          return ipcError('VALIDATION_FAILED', "That is not one of this checkpoint's options.");
        case 'no_answer_given':
          return ipcError('VALIDATION_FAILED', 'Choose an option or write an answer.');
      }
    }

    return ipcOk({
      ok: true,
      unblockedTaskId: result.unblockedTaskId,
      queuedMessageId: result.queuedMessageId,
      decisionLogged: result.decisionLogPath !== null,
    });
  },

  answerPermission: (input, ctx) => {
    const parsed = CheckpointsSchemas.answerPermission.input.parse(input);

    // The hold registry is the live, in-memory object the agent's HTTP
    // request is parked on. Without it there is nothing to release, and
    // saying "answered" would be a lie the user acts on — the agent would
    // sit there until its hold timed out to deny.
    if (ctx.policyHoldRegistry === undefined) {
      return ipcError(
        'INTERNAL_ERROR',
        'The control channel is not running, so this cannot be answered right now.',
      );
    }

    const result = answerPermissionCheckpoint(
      {
        db: ctx.db,
        activityLog: ctx.activityLog,
        baseDir: requireBaseDir(ctx),
        policyHoldRegistry: ctx.policyHoldRegistry,
      },
      { checkpointId: parsed.id, allow: parsed.allow },
    );

    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return ipcError('NOT_FOUND', 'That request no longer exists.');
        case 'not_permission':
          return ipcError('VALIDATION_FAILED', 'That checkpoint is not a permission request.');
        case 'not_pending':
          return ipcError(
            'CONFLICT',
            'That request has already been answered, or the employee stopped waiting.',
          );
      }
    }

    return ipcOk({ ok: true, allowed: result.allowed, holdReleased: result.holdReleased });
  },
};
