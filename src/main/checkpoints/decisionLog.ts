import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { memoryAbsolutePath, writeMemory, type MemoryLocation } from '../memory/memoryStore';
import type { Checkpoint, CheckpointOption } from '../../shared/models/checkpoint';

/**
 * §12.5 — "the decision log: small feature, large value". Every answered
 * `decision` checkpoint is appended to `project/decisions.md`.
 *
 * ## Why this is what makes duplicate detection honest
 *
 * §12.5's closing claim is that "the same question is never asked twice".
 * `duplicateDetection.ts` can only deliver that if answers actually become
 * durable, readable knowledge — otherwise invariant #9 is a rule with
 * nothing behind it. This function is the "becomes memory" half; the FTS
 * check is the "is it already answered" half. Neither works alone.
 *
 * ## Written through M7's real memory store, not straight to disk
 *
 * `writeMemory` owns the ordering that matters (§12.1: the markdown file
 * is layer 1 and the source of truth, the SQLite row is a disposable
 * layer-2 index, so the file is written first and a crash between the two
 * is repaired by `rebuildMemoryIndex`). Writing the file here directly
 * would either duplicate that ordering or quietly get it backwards.
 *
 * **Pinned**, because §12.5 says "every employee reads this" and
 * `listPinnedMemory` is how §12.3's memory pack picks a note up
 * regardless of the query.
 *
 * ## Append, by read-modify-write
 *
 * `writeMemory` replaces a file's content — it is an upsert, not an
 * appender. So the existing file is read first and the new entry added to
 * it. The file, not the `memory` row, is read: layer 1 is the source of
 * truth, and a user who edited `decisions.md` by hand (which §12.1
 * explicitly supports — "human-editable, greppable, survives the app")
 * must not have that edit silently reverted by the next answer.
 */

const FILE_NAME = 'decisions.md';

const HEADER = [
  '# Decisions',
  '',
  'Every decision this project has made, and why. Written by Bureau when a',
  'decision checkpoint is answered (§12.5); safe to read, edit or grep.',
  '',
].join('\n');

export function decisionLogLocation(projectId: string): MemoryLocation {
  return { scope: 'project', scopeRef: projectId, fileName: FILE_NAME };
}

export interface AppendDecisionInput {
  readonly baseDir: string;
  readonly projectId: string;
  readonly checkpoint: Checkpoint;
  readonly chosenOption: CheckpointOption | null;
  readonly freeText: string | null;
  /** True when a timeout applied the default rather than a person choosing. */
  readonly byTimeout: boolean;
  /** Injected so the entry's date is the answer's, not the test run's. */
  readonly answeredAtIso: string;
}

export interface AppendDecisionResult {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly entry: string;
}

export function appendDecisionLog(
  db: Database.Database,
  input: AppendDecisionInput,
): AppendDecisionResult {
  return appendDecisionEntry(db, {
    baseDir: input.baseDir,
    projectId: input.projectId,
    entry: renderEntry(input),
  });
}

/**
 * M11 S2-2b: a decision the Director records itself, through
 * `bureau_record_decision` — most often the user saying "you decide"
 * (§8.1: decide, state the consequence, move on). §7.9's fields, written as
 * the same §12.5 entry a decision checkpoint's answer is, so the log reads
 * as one thing and invariant #9's check finds both the same way.
 */
export interface DirectorDecision {
  readonly title: string;
  readonly askedBecause: string;
  readonly options: readonly string[];
  readonly chosen: string;
  readonly consequence: string;
  readonly decidedAtIso: string;
}

export function appendDirectorDecision(
  db: Database.Database,
  input: {
    readonly baseDir: string;
    readonly projectId: string;
    readonly decision: DirectorDecision;
  },
): AppendDecisionResult {
  const { decision } = input;
  const lines = [
    `## ${decision.decidedAtIso.slice(0, 10)} — ${decision.title}`,
    `**Asked because:** ${decision.askedBecause}`,
  ];
  if (decision.options.length > 0) lines.push(`**Options:** ${decision.options.join(' · ')}`);
  lines.push(`**Chosen:** ${decision.chosen}`);
  lines.push(`**Consequence:** ${decision.consequence}`);
  return appendDecisionEntry(db, {
    baseDir: input.baseDir,
    projectId: input.projectId,
    entry: lines.join('\n'),
  });
}

/** One entry appended to the project's log, through the memory store. */
function appendDecisionEntry(
  db: Database.Database,
  input: { readonly baseDir: string; readonly projectId: string; readonly entry: string },
): AppendDecisionResult {
  const location = decisionLogLocation(input.projectId);
  const absolutePath = memoryAbsolutePath(input.baseDir, location);
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : HEADER;

  const entry = input.entry;
  const body = `${existing.trimEnd()}\n\n${entry}\n`;

  const written = writeMemory(db, {
    ...location,
    baseDir: input.baseDir,
    title: 'Decisions',
    body,
    source: 'observed',
    tags: ['decision-log'],
    pinned: true,
  });

  return { absolutePath: written.absolutePath, relativePath: written.relativePath, entry };
}

/** §12.5's own example block, followed exactly. */
function renderEntry(input: AppendDecisionInput): string {
  const { checkpoint, chosenOption, freeText } = input;
  const date = input.answeredAtIso.slice(0, 10);
  const options = (checkpoint.options ?? []).map((option) => option.label).join(' · ');

  const chosen = chosenOption === null ? (freeText ?? 'answered in free text') : chosenOption.label;
  const why = input.byTimeout
    ? 'nobody answered within the timeout, so the safe default applied'
    : (freeText ?? chosenOption?.detail ?? 'chosen by the user');

  const lines = [`## ${date} — ${checkpoint.title}`, `**Asked because:** ${checkpoint.context}`];
  if (options.length > 0) lines.push(`**Options:** ${options}`);
  lines.push(`**Chosen:** ${chosen} — ${why}`);
  // The consequence comes from the chosen option, which is precisely why
  // §9.2 requires every option to state one: without it this line would be
  // the empty half of the entry that matters most three months later.
  if (chosenOption !== null) lines.push(`**Consequence:** ${chosenOption.consequence}`);
  // Free text alongside a chosen option is a third answer the user had
  // (§9.2: "users often have a third answer") and is not discarded.
  if (freeText !== null && chosenOption !== null) lines.push(`**They also said:** ${freeText}`);

  return lines.join('\n');
}
