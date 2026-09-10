import type Database from 'better-sqlite3';
import { getSetting } from '../db/repositories/settings';
import { listPinnedMemory, searchMemory } from './searchMemory';
import { memoryScopeRefForRole } from './memoryStore';
import { MemoryScopeSchema, type MemoryScope } from '../../shared/models/enums';
import type { Memory } from '../../shared/models/memory';
import type { Role } from '../../shared/models/role';

/**
 * §12.3 — "On task assignment, the supervisor composes a **memory pack**:
 * pinned company standards + role playbook + project decisions + top-K
 * search hits for the task text + relevant past lessons, capped at
 * `memory_budget_tokens`. What was injected is recorded as a
 * `memory.injected` event, so *what did the agent know?* is always
 * answerable."
 *
 * ## This is not the Director's context assembly, and must not become it
 *
 * §8.0.1's Director context is M11's, it answers a different question (what
 * does the Director need to hold a conversation), and it has different
 * inputs. Two callers sharing one function here would mean the next change
 * to either has to be safe for both — which is how a function ends up
 * serving neither. M11 may *call* `composeMemoryPack`; it must not fold its
 * own assembly into it.
 *
 * ## Facts, not a formatted string
 *
 * `composeMemoryPack` returns the items and what they cost. `renderMemoryPack`
 * turns them into the text an agent reads. The split is what lets
 * `memory.injected` record *what* was included (ids, paths, token estimates)
 * rather than a blob nobody can query, and it is why Appendix B's two prompt
 * slots — `{{decision_log}}` and `{{memory_pack}}` — can be filled from ONE
 * composition: each item carries its `kind`, so M11 groups rather than
 * composes twice.
 *
 * That last point is also why there is no separate decision-log fetch here.
 * `project/decisions.md` **is** a pinned project memory note — `appendDecisionLog`
 * writes it through `writeMemory` with `pinned: true` — so it arrives with
 * the pinned project notes. Fetching it a second time by name would be the
 * same content derived in two places.
 */

/** Which §12.3 clause put an item in the pack. Presentation groups on this;
 *  the Core does not decide how a group looks. */
export type MemoryPackItemKind =
  'company_standard' | 'role_playbook' | 'project_decision' | 'task_match' | 'lesson';

export interface MemoryPackItem {
  readonly kind: MemoryPackItemKind;
  readonly memoryId: string;
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly estimatedTokens: number;
}

export type SemanticState = 'off' | 'unavailable';

export interface MemoryPack {
  readonly items: readonly MemoryPackItem[];
  readonly budgetTokens: number;
  readonly estimatedTokens: number;
  /** Notes that matched but did not fit. Reported, never silently dropped. */
  readonly droppedCount: number;
  /** §12.1 layer 3, degrading loudly. See `semanticSearchState`. */
  readonly semantic: SemanticState;
}

export interface ComposeMemoryPackInput {
  readonly role: Role;
  readonly projectId: string | null;
  /** The task's own text — §12.3 searches on it. Passed raw; `toFtsQuery`
   *  is what makes it safe, and it already exists. */
  readonly taskText: string;
  readonly topK?: number;
}

const DEFAULT_TOP_K = 8;

/** §12.1's tree names these explicitly. Both spellings, because a pack
 *  author writing `lesson.md` has not made a mistake worth punishing. */
const LESSON_FILE_NAMES = ['lessons.md', 'lesson.md'] as const;

/**
 * §12.1 layer 3: *"optional semantic search. Off by default, behind a
 * setting. If enabled, uses a local embedding model so nothing leaves the
 * machine. Everything works without it — this is the degrade-loudly
 * principle in practice."*
 *
 * M10 builds the flag and the degradation, **not the model**: a local
 * embedding model is a dependency, a large download and a licence question
 * (invariant #14), and nothing else in this milestone needs it. So with the
 * setting on there is no provider, and the honest report of that is
 * `'unavailable'` — carried in the pack, in `memory.injected` and in
 * `memory.search`'s result, never swallowed into a silent FTS fallback that
 * looks like it worked as asked.
 */
export function semanticSearchState(db: Database.Database): SemanticState {
  return getSetting(db, 'memory.semanticSearch') ? 'unavailable' : 'off';
}

/**
 * A deliberate approximation, named as one. Four characters per token is the
 * usual rough figure for English prose and it is what the budget needs: the
 * budget exists to stop a pack crowding out the task, and being 20% wrong in
 * the safe direction costs nothing. A real tokenizer would be a per-engine
 * dependency for a number nothing else reads.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function composeMemoryPack(
  db: Database.Database,
  input: ComposeMemoryPackInput,
): MemoryPack {
  const budgetTokens =
    input.role.memory_budget_tokens > 0
      ? input.role.memory_budget_tokens
      : getSetting(db, 'memory.defaultBudgetTokens');

  const allowed = allowedScopes(input.role);
  const roleRef = memoryScopeRefForRole(input.role.full_key);

  // §12.3's own order, which doubles as the priority order when the budget
  // bites: a role's standing instructions matter more than a keyword match.
  const candidates: Array<{ kind: MemoryPackItemKind; row: Memory }> = [];
  const take = (kind: MemoryPackItemKind, rows: readonly Memory[]): void => {
    for (const row of rows) candidates.push({ kind, row });
  };

  if (allowed.has('company')) take('company_standard', listPinnedMemory(db, 'company', null));
  if (allowed.has('role')) take('role_playbook', listPinnedMemory(db, 'role', roleRef));
  if (allowed.has('project') && input.projectId !== null) {
    take('project_decision', listPinnedMemory(db, 'project', input.projectId));
  }

  const scopes = [...allowed];
  if (scopes.length > 0) {
    take(
      'task_match',
      searchMemory(db, input.taskText, {
        scopes,
        limit: input.topK ?? DEFAULT_TOP_K,
        pinnedFirst: true,
      }),
    );
    // §12.3's "relevant past lessons" — a **separate clause with its own
    // budget**, not a filter over the previous one.
    //
    // The first draft ran the same search again and filtered the results to
    // lesson files, which is a branch that can never contribute: anything it
    // found was already in `task_match` and would be dropped by the dedupe
    // below. A clause that is always empty while carrying a comment saying
    // what it does is worse than no clause. So the filter is pushed into the
    // query, where it buys real slots: `lessons.md` competes with other
    // lessons for its K, not with every note in the index.
    take(
      'lesson',
      searchMemory(db, input.taskText, {
        scopes,
        limit: input.topK ?? DEFAULT_TOP_K,
        fileNames: LESSON_FILE_NAMES,
      }),
    );
  }

  const items: MemoryPackItem[] = [];
  const seen = new Set<string>();
  let estimatedTokens = 0;
  let droppedCount = 0;

  for (const candidate of candidates) {
    // A note that is both pinned and a search hit is one note. First
    // occurrence wins, which is why the loop runs in §12.3's order.
    if (seen.has(candidate.row.id)) continue;
    seen.add(candidate.row.id);

    const cost = estimateTokens(candidate.row.body) + estimateTokens(candidate.row.title);
    if (estimatedTokens + cost > budgetTokens) {
      // Taken whole or not at all. A note cut in half is worse than an
      // absent one — an agent cannot tell that a standard it is reading
      // stops mid-sentence, and half a rule reads like a whole one.
      droppedCount += 1;
      continue;
    }

    items.push({
      kind: candidate.kind,
      memoryId: candidate.row.id,
      path: candidate.row.path,
      title: candidate.row.title,
      body: candidate.row.body,
      estimatedTokens: cost,
    });
    estimatedTokens += cost;
  }

  return {
    items,
    budgetTokens,
    estimatedTokens,
    droppedCount,
    semantic: semanticSearchState(db),
  };
}

/**
 * A role's `memory_scopes` (§6.5), filtered to the five real scopes. A key
 * the role names that is not a scope is dropped rather than guessed at —
 * the same discipline `discoverMemoryFiles` applies to a stray directory.
 *
 * An empty list means the role reads no memory at all, which is a legal and
 * meaningful configuration; it is not read as "everything".
 */
function allowedScopes(role: Role): Set<MemoryScope> {
  const scopes = new Set<MemoryScope>();
  for (const raw of role.memory_scopes) {
    const parsed = MemoryScopeSchema.safeParse(raw);
    if (parsed.success) scopes.add(parsed.data);
  }
  return scopes;
}

const KIND_HEADINGS: Record<MemoryPackItemKind, string> = {
  company_standard: 'Company standards',
  role_playbook: 'Your role',
  project_decision: 'Decisions already made on this project — follow these, do not revisit',
  task_match: 'Relevant to this task',
  lesson: 'Lessons from earlier work',
};

/**
 * The agent-facing text. Distinct from `composeMemoryPack` on purpose: this
 * is the only part that would change if Appendix B's wording changed, and
 * nothing that records or inspects a pack has to go through it.
 *
 * Note the audience — this string is read by an agent, not shown to a user,
 * so it is not the presentation boundary the UI rules are about.
 */
export function renderMemoryPack(pack: MemoryPack): string {
  if (pack.items.length === 0) return '';

  const sections: string[] = [];
  for (const kind of Object.keys(KIND_HEADINGS) as MemoryPackItemKind[]) {
    const items = pack.items.filter((item) => item.kind === kind);
    if (items.length === 0) continue;
    sections.push(`## ${KIND_HEADINGS[kind]}`);
    for (const item of items) {
      sections.push(`### ${item.title}\n_(${item.path})_\n\n${item.body.trim()}`);
    }
  }
  return sections.join('\n\n');
}

/** The `memory.injected` payload — what was included, not the text of it.
 *  §12.3's whole purpose for that event is that "what did the agent know?"
 *  is answerable later, and a blob of markdown in an event is not queryable. */
export function memoryInjectedPayload(pack: MemoryPack): Record<string, unknown> {
  return {
    itemCount: pack.items.length,
    droppedCount: pack.droppedCount,
    budgetTokens: pack.budgetTokens,
    estimatedTokens: pack.estimatedTokens,
    semantic: pack.semantic,
    items: pack.items.map((item) => ({
      kind: item.kind,
      memoryId: item.memoryId,
      path: item.path,
      estimatedTokens: item.estimatedTokens,
    })),
  };
}
