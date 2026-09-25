import type Database from 'better-sqlite3';
import {
  getCompanyConversation,
  getConversationById,
  resolveConversationForDelivery,
} from '../db/repositories/conversations';
import { getCheckpointById } from '../db/repositories/checkpoints';
import { getDirectorEmployee } from '../db/repositories/employees';
import { getTaskById } from '../db/repositories/tasks';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { Conversation } from '../../shared/models/conversation';
import type { OutboxMessage } from '../../shared/models/message';

/**
 * **Which conversation the Director is in** — one decision, one place
 * (standing rule 6; M11 S2-1a, Nikunj's decision of 2026-09-25).
 *
 * Until S2-1a this was "the most recently created conversation", which was
 * right while only one existed. With a company conversation plus one per
 * project it is wrong in the worst way: a message in one project's
 * conversation would be assembled, answered and resumed from another's.
 * So every Director turn carries its conversation, and every step that
 * needs "where is the Director" asks here:
 *
 * - a trigger names its conversation when it is offered
 *   (`conversationOfOutboxMessage`, `conversationForProject`);
 * - the turn built from it is delivered with that conversation, which the
 *   Director's Supervisor holds for the turn's length;
 * - everything that runs during the turn — the chat producer, the tool
 *   handlers, `${project}` for policy — reads it back through
 *   `resolveDirectorConversation`.
 *
 * **Outside a turn, the answer is the company conversation**, never "the
 * most recent". It has no project, so every project-scoped tool refuses —
 * the fail-closed direction (invariant #6).
 */

/** The company conversation (§5.1). The rule itself is the repository's. */
export const companyConversation = getCompanyConversation;

/** A project's own conversation, or the company one when there is no
 *  project (or the project has none) — the same rule the router and the
 *  checkpoint surfacer use, so there is one. */
export const conversationForProject = resolveConversationForDelivery;

/**
 * The conversation an outbox message addressed to the Director belongs to.
 * A user's chat message names its conversation in `thread_id` (`chat.send`);
 * an answer to a checkpoint carries the checkpoint's id there, and belongs to
 * the checkpoint's project; an employee's message belongs to its task's
 * project. Anything else is company business.
 */
export function conversationOfOutboxMessage(
  db: Database.Database,
  message: OutboxMessage,
): Conversation | null {
  if (message.thread_id !== null) {
    if (message.from_addr === 'user' && message.kind !== 'answer') {
      const named = getConversationById(db, message.thread_id);
      if (named !== null) return named;
    }
    const checkpoint = getCheckpointById(db, message.thread_id);
    if (checkpoint !== null) return conversationForProject(db, checkpoint.project_id);
  }
  if (message.task_id !== null) {
    return conversationForProject(db, getTaskById(db, message.task_id)?.project_id ?? null);
  }
  return companyConversation(db);
}

/**
 * Where the Director is right now: the conversation of the turn it is
 * taking, or the company conversation between turns.
 */
export function resolveDirectorConversation(
  db: Database.Database,
  supervisorRegistry?: SupervisorRegistry,
): Conversation | null {
  const director = getDirectorEmployee(db);
  const turnConversationId =
    director === null
      ? null
      : (supervisorRegistry?.get(director.id)?.directorTurnConversationId ?? null);
  if (turnConversationId !== null) {
    const conversation = getConversationById(db, turnConversationId);
    if (conversation !== null) return conversation;
  }
  return companyConversation(db);
}
