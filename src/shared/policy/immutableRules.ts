import type { Rule } from './types';
import { WILDCARD_TOOL_PATTERN } from './patternGrammar';

/**
 * §11.3's seven immutable global denies, translated verbatim from the
 * spec's own YAML — "cannot be overridden by any role, pack, or setting."
 * Never loaded from disk, never parameterised; `ruleLoader.ts` enforces
 * that nothing else can shadow one of these ids (S3).
 */
export const IMMUTABLE_RULE_PRIORITY = 0;

export const IMMUTABLE_RULES: readonly Rule[] = [
  {
    id: 'deny.write_outside_worktree',
    immutable: true,
    effect: 'deny',
    toolPattern: 'Write(**)|Edit(**)|MultiEdit(**)',
    condition: { kind: 'path_outside', roots: ['${worktree}', '${bureau_state}/tmp'] },
    // Writes are confined to the employee's OWN checkout. Allowing
    // ${project} here would bypass the branch, the validators, and the
    // single-committer model entirely (CLAUDE.md invariant #4). Reads may
    // also see the canonical project (below) — writes may not. Getting
    // this backwards silently undoes all of M5.
    reason: 'writes are confined to the employee\u2019s own worktree — never the project checkout',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.read_outside_project',
    immutable: true,
    effect: 'deny',
    toolPattern: 'Read(**)|Grep(**)|Glob(**)',
    // Reads may also see the canonical project — useful for the Director
    // and reviewers.
    condition: { kind: 'path_outside', roots: ['${worktree}', '${project}', '${bureau_state}/tmp'] },
    reason: 'reads are confined to the employee\u2019s worktree, the project, or its own scratch space',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.credential_paths',
    immutable: true,
    effect: 'deny',
    // The Bash(**) half is real per the spec's own YAML but permanently
    // inert — path conditions never apply to Bash (§11.3, see
    // conditions.ts's pathConditionsApply). Credential-path protection for
    // a shell command is the command allow-list's job, not this rule's;
    // kept verbatim rather than silently dropped or "fixed" with a
    // command-line path parser.
    toolPattern: 'Read(**)|Bash(**)',
    condition: {
      kind: 'path_matches',
      globs: ['**/.ssh/**', '**/.aws/**', '**/.env*', '**/*.pem', '**/.bureau/secrets/**'],
    },
    reason: 'credential-shaped paths are never readable by an employee',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.system_paths',
    immutable: true,
    effect: 'deny',
    // No tool_pattern in the spec's own YAML — read as "applies
    // regardless of tool" (the condition alone does the filtering), not a
    // spec gap. See WILDCARD_TOOL_PATTERN.
    toolPattern: WILDCARD_TOOL_PATTERN,
    condition: {
      kind: 'path_matches',
      globs: ['C:/Windows/**', 'C:/Program Files/**', '**/AppData/Roaming/Bureau/**'],
    },
    reason: 'system and Bureau-internal paths are never readable or writable by an employee',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.git_write',
    immutable: true,
    effect: 'deny',
    toolPattern: 'Bash(git commit *|git push *|git reset --hard *|git rebase *)',
    reason: 'employees never commit — the Core is the sole committer (CLAUDE.md invariant #4)',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.destructive',
    immutable: true,
    effect: 'deny',
    toolPattern: 'Bash(rm -rf /*|format *|del /f /s /q *|shutdown *|reg delete *)',
    reason: 'destructive commands are never allowed regardless of autonomy level',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
  {
    id: 'deny.subagent_spawn',
    immutable: true,
    effect: 'deny',
    toolPattern: 'Task|Agent|Spawn|Dispatch|mcp__*__spawn_*',
    // This matters more than it looks: several engines ship a sub-agent
    // tool by default, and without this rule the first thing a capable
    // model does on a large task is fan out into processes nothing is
    // watching — outside the supervisor, outside the concurrency cap,
    // outside per-employee budgets, and invisible on the floor. Bureau's
    // entire model is that every agent is a supervised employee.
    reason: 'sub-agent spawning creates unsupervised processes outside every one of Bureau\u2019s controls',
    priority: IMMUTABLE_RULE_PRIORITY,
  },
];

export const IMMUTABLE_RULE_IDS: ReadonlySet<string> = new Set(IMMUTABLE_RULES.map((r) => r.id));
