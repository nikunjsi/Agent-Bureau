import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getConversationById } from '../db/repositories/conversations';
import { getDirectorEmployee } from '../db/repositories/employees';
import { getRoleByFullKey } from '../db/repositories/roles';
import { getProjectById } from '../db/repositories/projects';
import { getSetting } from '../db/repositories/settings';
import { getPacksDir } from '../db/paths';
import { composeMemoryPack, type MemoryPackItem } from '../memory/memoryPack';
import { listPinnedMemory } from '../memory/searchMemory';
import { toolHandlersFor } from '../controlChannel/toolHandlers';
import { describeDirectorStateForContext } from './directorState';
import { microsToUsd } from '../../shared/models/money';
import type { Memory } from '../../shared/models/memory';

/**
 * **§8.0.1: the Director's context, bounded** (M11 context assembly), and
 * Appendix A.2's system prompt with every slot filled from real rows.
 *
 * Seven layers, in §8.0.1's order, dropped from the bottom when the estimate
 * is over `director.contextBudgetTokens`:
 *
 * 1. the system prompt (`packs/operations/prompts/director.md`) — never dropped
 * 2. pinned company standards and the user's pinned preferences
 * 3. the current project: stage, brief, plan, task counts, spend
 * 4. the decision log
 * 5. the roster, with each employee's current status
 * 6. memory retrieved for the current topic (the latest user message)
 * 7. recent conversation turns, newest first, with their attachments
 *
 * Layers 2, 4 and 6 come from ONE `composeMemoryPack` call, grouped by item
 * kind, as that module asks M11 to do. A dropped layer's slot says it was
 * left out, so the Director knows to use its tools rather than assume there
 * is nothing.
 *
 * **Attachments (decision E-3)** are folded in here, from the message
 * payload: a path inside the project is named as readable (the Director's
 * `Read(${project}/**)`); one outside is named, and the Director is told it
 * cannot open it.
 *
 * The estimate is `chars / 4`, over-counted by 10 % (§8.0.1).
 */
export const DIRECTOR_CONTEXT_LAYERS = [
  'system',
  'standards',
  'project',
  'decisions',
  'team',
  'memory',
  'conversation',
] as const;
export type DirectorContextLayerName = (typeof DIRECTOR_CONTEXT_LAYERS)[number];

export { DIRECTOR_CONTEXT_FILE } from '../../shared/engine/directorContextFile';

const RECENT_TURNS = 20;
const TURN_BODY_LIMIT = 2_000;
const DROPPED_NOTE =
  '(Not included this turn: the context budget was full. Use your tools, such as ' +
  'bureau_get_project_state, if you need it.)';

const SLOT_OF_LAYER: Readonly<Record<Exclude<DirectorContextLayerName, 'system'>, string>> = {
  standards: 'standards',
  project: 'project',
  decisions: 'decision_log',
  team: 'team',
  memory: 'memory_pack',
  conversation: 'recent_conversation',
};

export function estimateContextTokens(text: string): number {
  // Integer arithmetic: `len / 4 * 1.1` is 110.00000000000001 for 400.
  return Math.ceil((text.length * 11) / 40);
}

/**
 * Which layers to leave out: from the bottom, one whole layer at a time,
 * until the rest fits. The system prompt is never dropped, even when it
 * alone is over the budget. An empty layer frees nothing, so it is passed
 * over rather than counted as a drop.
 */
export function fitDirectorLayers(
  layers: ReadonlyArray<{ readonly name: DirectorContextLayerName; readonly text: string }>,
  budgetTokens: number,
): Set<DirectorContextLayerName> {
  const dropped = new Set<DirectorContextLayerName>();
  let total = layers.reduce((sum, layer) => sum + estimateContextTokens(layer.text), 0);
  for (let i = layers.length - 1; i >= 0 && total > budgetTokens; i -= 1) {
    const layer = layers[i]!;
    if (layer.name === 'system' || layer.text.length === 0) continue;
    dropped.add(layer.name);
    total -= estimateContextTokens(layer.text);
  }
  return dropped;
}

export interface AssembleDirectorContextDeps {
  readonly db: Database.Database;
  /** Electron's userData: memory, and user-installed packs. */
  readonly baseDir: string;
  /** Where bundled packs live (`resolveBundledPacksDirPath()` in the app). */
  readonly bundledPacksDir: string;
}

export interface AssembledDirectorContext {
  readonly text: string;
  readonly estimatedTokens: number;
  readonly budgetTokens: number;
  /** Bottom-first, in the order they were dropped. */
  readonly dropped: DirectorContextLayerName[];
}

export function assembleDirectorContext(
  deps: AssembleDirectorContextDeps,
  input: { readonly conversationId: string; readonly budgetTokens?: number },
): AssembledDirectorContext {
  const { db } = deps;
  const conversation = getConversationById(db, input.conversationId);
  if (conversation === null) throw new Error(`no conversation ${input.conversationId}`);
  const director = getDirectorEmployee(db);
  const role = director === null ? null : getRoleByFullKey(db, director.role_key);
  if (director === null || role === null) throw new Error('there is no Director to assemble for');

  const project = conversation.project_id ? getProjectById(db, conversation.project_id) : null;
  const turns = recentTurns(db, conversation.id);
  const latestUserText = turns.find((turn) => turn.author === 'user')?.body ?? '';

  // Layers 2, 4 and 6, from one composition.
  const pack = composeMemoryPack(db, {
    role,
    projectId: project?.id ?? null,
    taskText: latestUserText,
  });
  const standardsItems = pack.items.filter((item) => item.kind === 'company_standard');
  const userPreferences = listPinnedMemory(db, 'user', null);
  const decisionItems = pack.items.filter((item) => item.kind === 'project_decision');
  const shown = new Set([...standardsItems, ...decisionItems].map((item) => item.memoryId));
  const memoryItems = pack.items.filter((item) => !shown.has(item.memoryId));

  const companyName =
    (
      db.prepare('SELECT name FROM companies WHERE id = ?').get(conversation.company_id) as
        { name: string } | undefined
    )?.name ?? 'your company';

  const layers: Array<{ name: DirectorContextLayerName; text: string }> = [
    { name: 'system', text: '' },
    { name: 'standards', text: renderStandards(standardsItems, userPreferences) },
    { name: 'project', text: renderProject(db, project) },
    { name: 'decisions', text: renderItems(decisionItems, 'None yet.') },
    { name: 'team', text: renderTeam(db, director.id) },
    { name: 'memory', text: renderItems(memoryItems, 'Nothing relevant found.') },
    { name: 'conversation', text: renderTurns(turns, project?.path ?? null) },
  ];

  const template = readFileSync(
    directorPromptPath(deps, role.pack_id, role.system_prompt_path),
    'utf8',
  );
  const fixed: Record<string, string> = {
    company_name: companyName,
    // No row stores the user's name (M11 §F); A.2's slot reads honestly.
    user_name: 'the user',
    director_state: describeDirectorStateForContext(conversation),
    max_intake_rounds: String(getSetting(db, 'intake.maxRounds')),
    tool_list: Object.keys(toolHandlersFor(true))
      .map((name) => `- ${name}`)
      .join('\n'),
  };
  const systemOnly = fillSlots(template, fixed);
  layers[0] = { name: 'system', text: stripLayerSlots(systemOnly) };

  const budgetTokens = input.budgetTokens ?? getSetting(db, 'director.contextBudgetTokens');
  const dropped = fitDirectorLayers(layers, budgetTokens);

  const slots: Record<string, string> = { ...fixed };
  for (const layer of layers) {
    if (layer.name === 'system') continue;
    slots[SLOT_OF_LAYER[layer.name]] = dropped.has(layer.name) ? DROPPED_NOTE : layer.text;
  }
  const text = fillSlots(template, slots);
  return {
    text,
    estimatedTokens: layers
      .filter((layer) => !dropped.has(layer.name))
      .reduce((sum, layer) => sum + estimateContextTokens(layer.text), 0),
    budgetTokens,
    dropped: [...dropped],
  };
}

function fillSlots(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) => values[name] ?? whole);
}

function stripLayerSlots(text: string): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, '');
}

/** The Director's role prompt, from the pack it was installed from. */
function directorPromptPath(
  deps: AssembleDirectorContextDeps,
  packKey: string,
  relativePath: string,
): string {
  const origin = (
    deps.db.prepare('SELECT origin FROM packs WHERE key = ?').get(packKey) as
      { origin: string } | undefined
  )?.origin;
  const packDir =
    origin === 'bundled'
      ? path.join(deps.bundledPacksDir, packKey)
      : path.join(getPacksDir(deps.baseDir), packKey);
  return path.join(packDir, relativePath);
}

function renderNote(title: string, body: string): string {
  return `### ${title}\n${body.trim()}`;
}

function renderItems(items: readonly MemoryPackItem[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((item) => renderNote(item.title, item.body)).join('\n\n');
}

function renderStandards(
  standards: readonly MemoryPackItem[],
  preferences: readonly Memory[],
): string {
  const parts = [
    ...standards.map((item) => renderNote(item.title, item.body)),
    ...preferences.map((note) => renderNote(note.title, note.body ?? '')),
  ];
  return parts.length === 0 ? 'None recorded.' : parts.join('\n\n');
}

function renderProject(db: Database.Database, project: ReturnType<typeof getProjectById>): string {
  if (project === null) return 'No active project.';
  const brief = db
    .prepare(
      'SELECT content, markdown FROM briefs WHERE project_id = ? ORDER BY version DESC, created_at DESC LIMIT 1',
    )
    .get(project.id) as { content: string; markdown: string } | undefined;
  const plan = db
    .prepare(
      'SELECT id FROM plans WHERE project_id = ? ORDER BY version DESC, created_at DESC LIMIT 1',
    )
    .get(project.id) as { id: string } | undefined;
  const phases = plan
    ? (
        db
          .prepare('SELECT name FROM phases WHERE plan_id = ? ORDER BY ordinal')
          .all(plan.id) as Array<{ name: string }>
      ).map((phase) => phase.name)
    : [];
  const counts = db
    .prepare(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done FROM tasks WHERE project_id = ?",
    )
    .get(project.id) as { total: number; done: number | null };

  const lines = [`**${project.name}** — stage: ${project.stage}`];
  lines.push(`Brief: ${briefSummary(brief)}`);
  lines.push(`Plan: ${phases.length > 0 ? `phases ${phases.join(', ')}` : 'not written yet'}`);
  const budget =
    project.budget_usd_micros === null ? 'no budget set' : usd(project.budget_usd_micros);
  lines.push(
    `Progress: ${counts.done ?? 0}/${counts.total} tasks done · spent ${usd(project.spend_usd_micros)} of ${budget}`,
  );
  return lines.join('\n');
}

function briefSummary(brief: { content: string; markdown: string } | undefined): string {
  if (brief === undefined) return 'not written yet';
  try {
    const content = JSON.parse(brief.content) as Record<string, unknown>;
    if (typeof content['summary'] === 'string' && content['summary'].length > 0) {
      return content['summary'];
    }
  } catch {
    // Fall through to the markdown.
  }
  return brief.markdown.trim().slice(0, 600);
}

/** Invariant #12: micro-dollars everywhere; this is display. */
function usd(micros: number): string {
  return `$${microsToUsd(micros).toFixed(2)}`;
}

function renderTeam(db: Database.Database, directorId: string): string {
  const rows = db
    .prepare(
      `SELECT e.name AS name, e.status AS status, e.status_detail AS detail,
              r.title AS title, r.skills AS skills
         FROM employees e JOIN roles r ON r.full_key = e.role_key
        WHERE e.archived_at IS NULL AND e.id != ?
        ORDER BY e.hired_at`,
    )
    .all(directorId) as Array<{
    name: string;
    status: string;
    detail: string | null;
    title: string;
    skills: string;
  }>;
  if (rows.length === 0) return 'Nobody is hired yet.';
  return rows
    .map((row) => {
      let skills: string[] = [];
      try {
        skills = JSON.parse(row.skills) as string[];
      } catch {
        skills = [];
      }
      return `- **${row.name}** — ${row.title}. Skills: ${skills.join(', ') || 'none listed'}. Currently: ${row.detail ?? row.status}.`;
    })
    .join('\n');
}

interface Turn {
  readonly author: string;
  readonly body: string;
  readonly attachments: string[];
}

function recentTurns(db: Database.Database, conversationId: string): Turn[] {
  const rows = db
    .prepare(
      `SELECT author, body, payload FROM conversation_messages
        WHERE conversation_id = ? AND status != 'streaming'
        ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(conversationId, RECENT_TURNS) as Array<{
    author: string;
    body: string;
    payload: string | null;
  }>;
  return rows.map((row) => {
    let attachments: string[] = [];
    if (row.payload !== null) {
      try {
        const payload = JSON.parse(row.payload) as { attachments?: unknown };
        if (Array.isArray(payload.attachments)) {
          attachments = payload.attachments.filter((a): a is string => typeof a === 'string');
        }
      } catch {
        attachments = [];
      }
    }
    return { author: row.author, body: row.body, attachments };
  });
}

const AUTHOR_LABEL: Readonly<Record<string, string>> = {
  user: 'User',
  director: 'You',
  system: 'Bureau',
};

function renderTurns(turns: readonly Turn[], projectRoot: string | null): string {
  if (turns.length === 0) return 'No messages yet.';
  return turns
    .map((turn) => {
      const lines = [
        `${AUTHOR_LABEL[turn.author] ?? turn.author}: ${turn.body.slice(0, TURN_BODY_LIMIT)}`,
      ];
      for (const attachment of turn.attachments) {
        lines.push(`  Attached: ${describeAttachment(attachment, projectRoot)}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Decision E-3: a path inside the project is readable by the Director's
 *  `Read(${project}/**)`; one outside is named, and it is told it cannot. */
function describeAttachment(attachment: string, projectRoot: string | null): string {
  if (projectRoot !== null) {
    const relative = path.relative(path.resolve(projectRoot), path.resolve(attachment));
    if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      return `${attachment} (inside the project — you can Read it)`;
    }
  }
  return `${attachment} (outside the project — you cannot open it; ask the user for what you need from it)`;
}
