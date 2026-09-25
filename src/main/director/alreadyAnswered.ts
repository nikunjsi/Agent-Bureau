import type Database from 'better-sqlite3';
import { diceSimilarity } from '../checkpoints/similarity';
import { DUPLICATE_THRESHOLD } from '../checkpoints/duplicateDetection';
import { searchMemory } from '../memory/searchMemory';

/**
 * **Invariant #9: never ask a question that memory, the brief, or the
 * workspace already answers** — checked in plain code before a question is
 * posted (M11 S2-2a), not left to the prompt.
 *
 * The same division of labour as checkpoint duplicate detection
 * (`duplicateDetection.ts`): **FTS narrows, Dice decides.** Memory's FTS
 * index finds the few notes worth reading (the decision log is a note too,
 * `project/decisions.md`), the brief is read directly, and each is split
 * into the units a question could match — a decision entry's title and why
 * it was asked, a line of the brief, a sentence of a note. A unit scoring
 * at or above `DUPLICATE_THRESHOLD` is the same question, and its answer is
 * handed back.
 *
 * **Below the threshold the question is asked**, as a near-miss checkpoint
 * is raised when no provider is configured: an extra question costs the
 * user a moment and is recoverable; suppressing one they have not answered
 * would leave the brief built on a guess.
 *
 * The workspace half of the invariant is the Director's own reading
 * (`Read(${project}/**)`, `bureau_search_workspace`); a question's text
 * cannot be matched against source code.
 */
export interface EarlierAnswer {
  readonly source: 'decision log' | 'brief' | 'memory';
  /** What was asked or stated before, as it was written. */
  readonly matched: string;
  /** The answer to hand back. */
  readonly answer: string;
}

const CANDIDATE_NOTES = 10;

export function findEarlierAnswer(
  db: Database.Database,
  input: { readonly projectId: string | null; readonly question: string },
): EarlierAnswer | null {
  const best: { score: number; answer: EarlierAnswer | null } = { score: 0, answer: null };
  const consider = (score: number, answer: EarlierAnswer): void => {
    if (score >= DUPLICATE_THRESHOLD && score > best.score) {
      best.score = score;
      best.answer = answer;
    }
  };

  const notes = searchMemory(db, input.question, {
    scopes: ['company', 'user', 'project'],
    projectScopeRef: input.projectId,
    limit: CANDIDATE_NOTES,
  });
  for (const note of notes) {
    if (note.path.endsWith('decisions.md')) {
      for (const entry of decisionEntries(note.body)) {
        consider(diceSimilarity(input.question, entry.title), {
          source: 'decision log',
          matched: entry.title,
          answer: entry.text,
        });
      }
      continue;
    }
    for (const sentence of sentencesOf(note.body)) {
      consider(diceSimilarity(input.question, sentence.question), {
        source: 'memory',
        matched: sentence.question,
        answer: sentence.text,
      });
    }
  }

  if (input.projectId !== null) {
    const brief = db
      .prepare(
        'SELECT markdown FROM briefs WHERE project_id = ? ORDER BY version DESC, created_at DESC LIMIT 1',
      )
      .get(input.projectId) as { markdown: string } | undefined;
    for (const line of linesOf(brief?.markdown ?? '')) {
      consider(diceSimilarity(input.question, line), {
        source: 'brief',
        matched: line,
        answer: line,
      });
    }
  }

  return best.answer;
}

/** §12.5's entries: `## <date> — <title>` and the lines under it. */
function decisionEntries(body: string): { title: string; text: string }[] {
  return body
    .split(/\n(?=## )/)
    .filter((block) => block.startsWith('## '))
    .map((block) => {
      const [heading = '', ...rest] = block.split('\n');
      const title = heading.replace(/^##\s+(\d{4}-\d{2}-\d{2}\s+—\s+)?/, '').trim();
      return { title, text: rest.join('\n').trim() || title };
    });
}

/**
 * A note's sentences. A sentence that is itself a question keeps what
 * follows it as its answer ("Italian as well? Yes, both."); any other
 * sentence answers itself.
 */
function sentencesOf(body: string): { question: string; text: string }[] {
  const sentences = body
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.replace(/^[#>*\-\s]+/, '').trim())
    .filter((s) => s.length > 0);
  return sentences.map((sentence, index) =>
    sentence.endsWith('?') && index + 1 < sentences.length
      ? { question: sentence, text: `${sentence} ${sentences[index + 1]}` }
      : { question: sentence, text: sentence },
  );
}

/** A brief's statements, one per line, without their markdown markers. */
function linesOf(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) => line.replace(/^[#>*\-\s]+/, '').trim())
    .filter((line) => line.length > 0);
}
