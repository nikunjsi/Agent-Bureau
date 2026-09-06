import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';

/**
 * Writes a real pack DIRECTORY to disk — real `pack.yaml`, real
 * `departments/*.yaml`, real `roles/*.yaml`, real prompt files — so tests
 * drive `loadPack`/`validatePack`/`installPack` over a real filesystem
 * rather than hand-constructing the parsed shape those functions exist to
 * produce.
 *
 * The distinction matters: a test that builds a `ParsedPack` object by
 * hand and passes it to `validatePack` never exercises the YAML parse, the
 * Zod schema, the file-existence checks, or the readable-error formatting
 * — which is most of what a pack loader IS. This helper is deliberately
 * the only shortcut, and it stops at "write the files".
 */

export interface RoleOverrides {
  readonly key?: string;
  readonly [field: string]: unknown;
}

export const APP_VERSION_FOR_TESTS = '0.0.1';

export function validRoleYaml(overrides: RoleOverrides = {}): Record<string, unknown> {
  return {
    key: 'developer',
    title: 'Developer',
    department: 'engineering',
    version: '1.0.0',
    description: 'Writes and modifies code to satisfy a task’s acceptance criteria.',
    system_prompt_path: 'prompts/developer.md',
    shared_prompts: ['prompts/_shared/standards.md'],
    skills: ['code', 'debug'],
    deliverable_types: ['code'],
    input_types: ['code'],
    engine_preference: ['claude-code'],
    model_preference: ['balanced', 'capable'],
    tools_allow: ['Read(**)', 'Grep(**)', 'Write(${worktree}/**)', 'Bash(npm *|pytest *)'],
    tools_deny: ['Bash(git *)'],
    network_allow: [],
    memory_scopes: ['role', 'project'],
    memory_budget_tokens: 8000,
    autonomy_default: 'guided',
    max_turns: 40,
    max_attempts: 2,
    wall_clock_timeout_s: 2400,
    budget_usd: 2.0,
    escalate_when: ['the acceptance criteria are ambiguous or contradict the brief'],
    reports: {
      on_complete: 'what changed, why, what you verified, what you did NOT verify',
      on_block: 'what you tried, what you observed, what you need',
    },
    sprite_key: 'dev',
    role_options: {},
    ...overrides,
  };
}

export interface WritePackOptions {
  readonly key?: string;
  readonly manifest?: Record<string, unknown>;
  readonly departments?: Record<string, unknown>[];
  readonly roles?: Record<string, unknown>[];
  /** Extra prompt files, pack-relative path → content. */
  readonly prompts?: Record<string, string>;
  /** Prompt files to deliberately NOT write, even though a role names them. */
  readonly omitPrompts?: readonly string[];
}

export function writePack(rootDir: string, options: WritePackOptions = {}): string {
  const key = options.key ?? 'engineering';
  const roles = options.roles ?? [validRoleYaml()];

  mkdirSync(path.join(rootDir, 'departments'), { recursive: true });
  mkdirSync(path.join(rootDir, 'roles'), { recursive: true });
  mkdirSync(path.join(rootDir, 'prompts', '_shared'), { recursive: true });

  const manifest = {
    key,
    name: 'Engineering',
    version: '1.0.0',
    description: 'Builds and ships software.',
    author: 'Bureau',
    license: 'Apache-2.0',
    bureau_min_version: APP_VERSION_FOR_TESTS,
    departments: ['engineering'],
    requires: { tools: ['git'], engines: ['claude-code'] },
    project_kinds: ['software'],
    ...options.manifest,
  };
  writeFileSync(path.join(rootDir, 'pack.yaml'), stringify(manifest), 'utf8');

  const departments = options.departments ?? [
    {
      key: 'engineering',
      name: 'Engineering',
      description: 'Where the software gets built.',
      roles: roles.map((role) => role['key'] as string),
      room: {
        preferred_size: { w: 12, h: 8 },
        theme: { floor: 'floor_carpet_blue', wall: 'wall_office', props: ['whiteboard'] },
      },
      default_hires: [roles[0]?.['key'] as string],
    },
  ];
  for (const department of departments) {
    writeFileSync(
      path.join(rootDir, 'departments', `${department['key'] as string}.yaml`),
      stringify(department),
      'utf8',
    );
  }

  const omit = new Set(options.omitPrompts ?? []);
  for (const role of roles) {
    writeFileSync(path.join(rootDir, 'roles', `${role['key'] as string}.yaml`), stringify(role), 'utf8');
    const promptPaths = [
      role['system_prompt_path'] as string | undefined,
      ...((role['shared_prompts'] as string[] | undefined) ?? []),
    ].filter((p): p is string => typeof p === 'string');
    for (const relPath of promptPaths) {
      if (omit.has(relPath)) continue;
      const absolute = path.join(rootDir, relPath);
      mkdirSync(path.dirname(absolute), { recursive: true });
      writeFileSync(absolute, `# ${role['key'] as string}\n\nReal prompt content.\n`, 'utf8');
    }
  }

  for (const [relPath, content] of Object.entries(options.prompts ?? {})) {
    const absolute = path.join(rootDir, relPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }

  return rootDir;
}
