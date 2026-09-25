import { describe, expect, it } from 'vitest';
import {
  renderEmployeePrompt,
  type EmployeePromptInput,
} from '../../../src/main/engine/employeePrompt';

/**
 * Appendix B, slot by slot (M11 S3-1). The integration test proves the slots
 * are filled from real rows; this proves each one lands under its heading,
 * and that an empty slot says so instead of leaving a heading over nothing.
 */
const input: EmployeePromptInput = {
  name: 'Quinn',
  roleTitle: 'Developer',
  companyName: 'Luigi & Co',
  rolePrompt: '# Developer\n\nYou write code.',
  task: {
    displayKey: 'T-0007',
    title: 'Menu page',
    body: 'Build the menu page.',
    acceptanceCriteria: ['Every dish shows its price', 'It reads well on a phone'],
  },
  briefSummary: '**Luigi Trattoria website** — a small site.',
  decisionLog: '### Booking\nBy phone.',
  memoryPack: '## Company standards\n\n### House style\nLora.',
  worktreePath: 'E:\\Bureau\\.bureau\\worktrees\\quinn',
  autonomy: 'guided',
  escalateWhen: ['the acceptance criteria are ambiguous'],
};

/** The text between one heading and the next. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  expect(start, heading).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Appendix B, rendered', () => {
  const text = renderEmployeePrompt(input);

  it('opens with who, and the role’s prompt', () => {
    expect(text.startsWith('You are Quinn, a Developer at Luigi & Co.')).toBe(true);
    expect(text).toContain('You write code.');
  });

  it('the task, its body and each acceptance criterion', () => {
    const task = section(text, '## Your current task');
    expect(task).toContain('**T-0007 — Menu page**');
    expect(task).toContain('Build the menu page.');
    expect(task).toContain(
      '**This task is done when:**\n\n- Every dish shows its price\n- It reads well on a phone',
    );
  });

  it('the brief, the decision log and the memory pack each under their own heading', () => {
    expect(section(text, '## Project context')).toContain('Luigi Trattoria website');
    expect(section(text, '## Decisions already made — follow these, do not revisit')).toContain(
      'By phone.',
    );
    expect(section(text, '## What you know')).toContain('Lora.');
    expect(section(text, '## What you know')).not.toContain('By phone.');
  });

  it('the workspace, the rules, the autonomy level and when to ask', () => {
    const env = section(text, '## Your working environment');
    expect(env).toContain('Your workspace: `E:\\Bureau\\.bureau\\worktrees\\quinn`');
    expect(env).toContain('You do NOT run git commands.');
    expect(env).toContain('Autonomy level: **guided**.');
    expect(env).not.toContain('Most actions will ask for permission first.');
    expect(section(text, '## When to stop and ask')).toContain(
      '- the acceptance criteria are ambiguous',
    );
    expect(section(text, '## When you finish')).toContain('what you did NOT');
  });

  it('says what ask means, only under ask', () => {
    expect(renderEmployeePrompt({ ...input, autonomy: 'ask' })).toContain(
      'Most actions will ask for permission first.',
    );
  });

  it('an empty slot says so', () => {
    const empty = renderEmployeePrompt({
      ...input,
      briefSummary: '',
      decisionLog: '',
      memoryPack: ' ',
      escalateWhen: [],
      task: { ...input.task, acceptanceCriteria: [] },
    });
    expect(section(empty, '## Project context')).toContain('There is no approved brief');
    expect(section(empty, '## Decisions already made — follow these, do not revisit')).toContain(
      'None yet.',
    );
    expect(section(empty, '## What you know')).toContain('Nothing relevant was found in memory.');
    expect(section(empty, '## Your current task')).toContain('Ask the Director.');
  });
});
