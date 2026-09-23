import type Database from 'better-sqlite3';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { getProjectById } from '../db/repositories/projects';
import type { Project } from '../../shared/models/project';

/**
 * **Which project the Director is on** — one decision, one place (standing
 * rule 6).
 *
 * An employee's project is its worktree's: the checkout it was assigned.
 * The Director has no worktree (§8.0), so its project is the one its
 * conversation is about, and `null` when it is between projects. That
 * answer is needed in three places that would otherwise each derive it:
 * `${project}` for the policy evaluator (M11 S1-11b), and the two Director
 * tools that read a project — `bureau_get_project_state` and
 * `bureau_search_workspace` (S1-12b).
 *
 * `null` is a real state, not an error, and every caller must treat it as
 * "refuse", never as "no restriction": for the policy variable it matches
 * nothing (§11.3), and for a tool it is a plain refusal. That is the
 * fail-closed direction (invariant #6) and the reason this returns the
 * project rather than, say, a path defaulting to somewhere.
 */
export function resolveDirectorProject(db: Database.Database): Project | null {
  const conversation = resolveConversationForDelivery(db, null);
  if (!conversation?.project_id) return null;
  return getProjectById(db, conversation.project_id);
}
