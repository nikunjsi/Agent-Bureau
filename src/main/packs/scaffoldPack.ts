import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { getPackDir } from '../db/paths';
import { UserFacingError } from '../../shared/errors/userFacing';

/**
 * §6.6: "`bureau pack scaffold <name>` (and a Settings → Packs → Create
 * button) generates a valid skeleton so a user can author their own from
 * day one. **This is how the product covers 'everything' without lying
 * about it.**"
 *
 * "Valid" is the load-bearing word, and it is a testable claim rather than
 * an aspiration: the test scaffolds a pack and runs the real validator
 * over the result, asserting zero errors AND zero warnings. A skeleton
 * that needs fixing before it validates is a worse starting point than no
 * skeleton, because the author cannot tell their own mistakes from the
 * generator's.
 *
 * The generated content is deliberately opinionated — a real prompt, a
 * real `escalate_when`, a real tools list — because a skeleton full of
 * `TODO` teaches nothing about the shape of a good role. What it does not
 * do is pretend to be finished: every file says what to change.
 */

export interface ScaffoldPackOptions {
  readonly baseDir: string;
  /** The pack key: lowercase, dashes. Also the directory name. */
  readonly key: string;
  /** Display name; defaults to a title-cased key. */
  readonly name?: string;
  readonly author?: string;
  /** The app's own version — the scaffold's `bureau_min_version`. */
  readonly appVersion: string;
}

export interface ScaffoldPackResult {
  readonly rootDir: string;
  readonly files: string[];
}

export class PackAlreadyExistsError extends UserFacingError {
  constructor(rootDir: string) {
    super(`a pack already exists at ${rootDir} — scaffolding would overwrite it`);
    this.name = 'PackAlreadyExistsError';
  }
}

const KEY_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

function titleCase(key: string): string {
  return key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function scaffoldPack(options: ScaffoldPackOptions): ScaffoldPackResult {
  if (!KEY_SHAPE.test(options.key)) {
    // AUDIT #16: written for a person, so it opts in to being shown.
    throw new UserFacingError(
      `A pack key must be lowercase letters, numbers and dashes, starting with a letter or digit — "${options.key}" is not.`,
    );
  }

  const rootDir = getPackDir(options.baseDir, options.key);
  // Never overwrite. A user who scaffolds over their own half-finished
  // pack loses work that has no other copy.
  if (existsSync(rootDir)) throw new PackAlreadyExistsError(rootDir);

  const name = options.name ?? titleCase(options.key);
  const departmentKey = options.key;
  const roleKey = 'specialist';
  const files: string[] = [];

  const write = (relPath: string, content: string): void => {
    const absolute = path.join(rootDir, relPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
    files.push(relPath);
  };

  write(
    'pack.yaml',
    `# ${name} — a Bureau pack. Everything here is data: no recompile needed.\n` +
      `# See docs/BUILD-SPEC.md §6 for the full reference.\n\n` +
      stringify({
        key: options.key,
        name,
        version: '0.1.0',
        description: `Change this: what does the ${name} department do?`,
        author: options.author ?? '',
        license: '',
        bureau_min_version: options.appVersion,
        departments: [departmentKey],
        requires: { tools: [], engines: ['claude-code'] },
        project_kinds: [],
      }),
  );

  write(
    `departments/${departmentKey}.yaml`,
    stringify({
      key: departmentKey,
      name,
      description: `Change this: what happens in the ${name} room?`,
      roles: [roleKey],
      room: {
        preferred_size: { w: 10, h: 8 },
        theme: { floor: 'floor_carpet_blue', wall: 'wall_office', props: ['plant'] },
      },
      default_hires: [roleKey],
    }),
  );

  write(
    `roles/${roleKey}.yaml`,
    `# Copy this file to add another role. The key must match the filename,\n` +
      `# and departments/${departmentKey}.yaml must list it under \`roles:\`.\n\n` +
      stringify({
        key: roleKey,
        title: 'Specialist',
        department: departmentKey,
        version: '0.1.0',
        description: 'Change this: it is shown to the user when hiring.',
        system_prompt_path: `prompts/${roleKey}.md`,
        shared_prompts: [`prompts/_shared/standards.md`],
        skills: ['research', 'writing'],
        deliverable_types: ['document'],
        input_types: ['document'],
        engine_preference: ['claude-code'],
        model_preference: ['balanced', 'capable'],
        tools_allow: [
          'Read(**)',
          'Grep(**)',
          'Glob(**)',
          'Write(${worktree}/**)',
          'Edit(${worktree}/**)',
        ],
        tools_deny: ['Bash(git *)'],
        network_allow: [],
        memory_scopes: ['role', 'project', 'company'],
        memory_budget_tokens: 8000,
        autonomy_default: 'guided',
        max_turns: 40,
        max_attempts: 2,
        wall_clock_timeout_s: 2400,
        budget_usd: 2.0,
        escalate_when: [
          'the task is ambiguous in a way that changes what you would produce',
          'the task needs information, access, or a decision you do not have',
          'the same approach has failed twice',
        ],
        reports: {
          on_complete: 'what you produced, why, what you verified, and what you did NOT verify',
          on_block: 'what you tried, what you observed, what you need',
        },
        sprite_key: 'generic',
        role_options: {},
      }) +
      `\n# network_allow is EMPTY on purpose: this role gets no network tools\n` +
      `# at all. If you grant WebFetch or WebSearch above, you MUST list the\n` +
      `# domains here — validation rejects the pack otherwise (§6.7 check 4a).\n`,
  );

  write(
    `prompts/${roleKey}.md`,
    `# Specialist\n\n` +
      `Replace this with the role's real instructions. What follows is a\n` +
      `starting shape, not filler — a prompt that says nothing produces an\n` +
      `employee that does nothing useful.\n\n` +
      `## What you do\n\n` +
      `Describe the job in one or two sentences. Be concrete about the\n` +
      `output: a document, a spreadsheet, a piece of code, a decision.\n\n` +
      `## How to approach a task\n\n` +
      `Numbered steps. What to read first, what to produce, how to check it.\n\n` +
      `## What you do not do\n\n` +
      `The boundaries matter more than the instructions. Name the things\n` +
      `that are someone else's job, and the shortcuts that look reasonable\n` +
      `and are not.\n\n` +
      `## Reporting\n\n` +
      `Say what you did, what you verified, and what you did not verify.\n`,
  );

  write(
    'prompts/_shared/standards.md',
    `# Shared standards\n\n` +
      `Every role in this pack that lists this file under \`shared_prompts\`\n` +
      `gets this text appended to its own prompt. Put here what applies to\n` +
      `all of them: house style, what "done" means, how to report.\n\n` +
      `## Your checkout is yours\n\n` +
      `Write only inside your own checkout. Never commit — Bureau commits\n` +
      `when the work passes its validators.\n\n` +
      `## Say what you did not do\n\n` +
      `Distinguish what you verified from what you assumed. The second is\n` +
      `not a failure to admit; it is the most useful line in the report.\n`,
  );

  write(
    'memory-seed/conventions.md',
    `# ${name} conventions\n\n` +
      `Seeded into company memory when this pack is installed, and editable\n` +
      `afterwards — Bureau will not overwrite changes the user makes here.\n\n` +
      `Put the standing knowledge this department needs on every task.\n`,
  );

  write(
    'README.md',
    `# ${name}\n\n` +
      `A Bureau pack. To change what these employees do, edit the YAML and\n` +
      `markdown here — there is no code to compile.\n\n` +
      `\`\`\`\n` +
      `pack.yaml                     the pack itself\n` +
      `departments/${departmentKey}.yaml${' '.repeat(Math.max(1, 18 - departmentKey.length))}the room and who works in it\n` +
      `roles/${roleKey}.yaml            one employee's whole definition\n` +
      `prompts/${roleKey}.md            what that employee is told\n` +
      `prompts/_shared/standards.md  appended to every role that lists it\n` +
      `memory-seed/conventions.md    seeded into company memory on install\n` +
      `\`\`\`\n\n` +
      `## Adding a role\n\n` +
      `1. Copy \`roles/${roleKey}.yaml\`; change \`key\`, \`title\`, and the\n` +
      `   filename to match.\n` +
      `2. Write \`prompts/<key>.md\` and point \`system_prompt_path\` at it.\n` +
      `3. Add the key to \`roles:\` in \`departments/${departmentKey}.yaml\`.\n` +
      `4. Validate before installing — Settings → Packs → Validate. Every\n` +
      `   error names the file and the field.\n\n` +
      `## Two rules that are easy to miss\n\n` +
      `- \`network_allow: []\` means the role gets **no network tools at\n` +
      `  all**. Granting \`WebFetch\` with an empty list is rejected.\n` +
      `- A \`tools_allow\` pattern aimed at something Bureau permanently\n` +
      `  denies (committing, writing outside the worktree, reading\n` +
      `  credentials, spawning sub-agents) is rejected at load. Broad\n` +
      `  patterns like \`Read(**)\` are fine — the denies carve out the\n` +
      `  exceptions.\n`,
  );

  return { rootDir, files };
}
