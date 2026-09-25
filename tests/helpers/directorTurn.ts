import type Database from 'better-sqlite3';
import { getDirectorEmployee } from '../../src/main/db/repositories/employees';
import type { SupervisorRegistry } from '../../src/main/engine/supervisorRegistry';

/**
 * Puts the running Director inside a turn for `conversationId`, the way the
 * trigger queue does (M11 S2-1a): through `deliverDirectorTurn`, so the
 * turn's conversation is the one its tools, its prose and `${project}`
 * resolve to until the turn ends. A test that calls a project-scoped
 * Director tool is describing a call made during a turn, and says so here.
 */
export async function inDirectorTurn(
  db: Database.Database,
  supervisorRegistry: SupervisorRegistry,
  conversationId: string,
): Promise<void> {
  const director = getDirectorEmployee(db);
  const supervisor = director === null ? undefined : supervisorRegistry.get(director.id);
  if (supervisor === undefined) throw new Error('inDirectorTurn: the Director is not running');
  await supervisor.deliverDirectorTurn('(a scripted turn)', [], conversationId);
}
