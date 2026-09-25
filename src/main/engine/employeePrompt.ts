import type { Autonomy } from '../../shared/models/enums';

/**
 * Appendix B, the employee prompt template, as the text of an employee's
 * first message on a task (M11 S3-1, `NEXT-VERSION` §M.5).
 *
 * Pure: every slot is handed in, already read from rows by the Supervisor
 * (and the role's prompt by `composeEmployeeContext`). Nothing is decided
 * here; this is the template with its slots filled, and a slot with nothing
 * to say says so rather than leaving a heading over nothing.
 */
export interface EmployeePromptInput {
  readonly name: string;
  readonly roleTitle: string;
  readonly companyName: string;
  /** The role's prompt; the role's description when there is none. */
  readonly rolePrompt: string;
  readonly task: {
    readonly displayKey: string;
    readonly title: string;
    readonly body: string;
    readonly acceptanceCriteria: readonly string[];
  };
  readonly briefSummary: string;
  /** Rendered decision-log items: the `project_decision` part of the pack. */
  readonly decisionLog: string;
  /** Rendered memory items: the rest of the same pack. */
  readonly memoryPack: string;
  readonly worktreePath: string;
  readonly autonomy: Autonomy;
  readonly escalateWhen: readonly string[];
}

export function renderEmployeePrompt(input: EmployeePromptInput): string {
  const bullets = (items: readonly string[], none: string): string =>
    items.length === 0 ? none : items.map((item) => `- ${item}`).join('\n');
  const orNone = (text: string, none: string): string => (text.trim() === '' ? none : text.trim());
  // A slot under a `##` heading keeps its own headings below it: the memory
  // pack groups by kind with `##`, which would otherwise read as a sibling
  // section of Appendix B rather than part of "What you know".
  const nested = (text: string): string => text.replace(/^(#{1,4}) /gm, '##$1 ');

  return [
    `You are ${input.name}, a ${input.roleTitle} at ${input.companyName}.`,
    orNone(input.rolePrompt, `(${input.roleTitle}.)`),
    '## Your current task',
    `**${input.task.displayKey} — ${input.task.title}**`,
    input.task.body.trim(),
    '**This task is done when:**',
    bullets(
      input.task.acceptanceCriteria,
      '- (No acceptance criteria were written. Ask the Director.)',
    ),
    '## Project context',
    orNone(input.briefSummary, 'There is no approved brief to summarise.'),
    '## Decisions already made — follow these, do not revisit',
    orNone(nested(input.decisionLog), 'None yet.'),
    '## What you know',
    orNone(nested(input.memoryPack), 'Nothing relevant was found in memory.'),
    '## Your working environment',
    [
      `- Your workspace: \`${input.worktreePath}\` — you may read and write here.`,
      '- You may NOT read or write anything outside it. Do not try.',
      '- You do NOT run git commands. Bureau commits your work when you are done.',
      `- Autonomy level: **${input.autonomy}**.`,
      ...(input.autonomy === 'ask' ? ['  Most actions will ask for permission first.'] : []),
    ].join('\n'),
    '## When to stop and ask',
    'Send a question to the Director rather than guessing when:',
    bullets(input.escalateWhen, '- anything in the task is unclear.'),
    'Asking is cheap. Building the wrong thing is expensive.',
    '## When you finish',
    'Report: what you changed, why, what you verified, and — importantly — what you did NOT\n' +
      'verify or deliberately left out. Be specific and honest. The Director relays this to a\n' +
      'human who is relying on it being accurate.',
  ].join('\n\n');
}
