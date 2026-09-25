import type Database from 'better-sqlite3';
import { getProjectById } from '../db/repositories/projects';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import type { Project } from '../../shared/models/project';
import { resolveDirectorConversation } from './directorConversation';

/**
 * **Which project the Director is on** — one decision, one place (standing
 * rule 6).
 *
 * An employee's project is its worktree's: the checkout it was assigned.
 * The Director has no worktree (§8.0), so its project is the one its
 * conversation is about, and `null` when it is between projects. That
 * answer is needed in three places that would otherwise each derive it:
 * `${project}` for the policy evaluator (M11 S1-11b), and the Director
 * tools that read a project — `bureau_get_project_state`,
 * `bureau_search_workspace` and `bureau_write_memory` (S1-12b).
 *
 * "Its conversation" is the conversation of the turn it is taking (M11
 * S2-1a, `directorConversation.ts`), so the registry is how the answer is
 * found. Without one, or between turns, it is the company conversation,
 * which has no project.
 *
 * `null` is a real state, not an error, and every caller must treat it as
 * "refuse", never as "no restriction": for the policy variable it matches
 * nothing (§11.3), and for a tool it is a plain refusal. That is the
 * fail-closed direction (invariant #6) and the reason this returns the
 * project rather than, say, a path defaulting to somewhere.
 */
export function resolveDirectorProject(
  db: Database.Database,
  supervisorRegistry?: SupervisorRegistry,
): Project | null {
  const conversation = resolveDirectorConversation(db, supervisorRegistry);
  if (!conversation?.project_id) return null;
  return getProjectById(db, conversation.project_id);
}
