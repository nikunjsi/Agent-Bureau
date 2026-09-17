import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPack } from '../../../src/main/packs/loadPack';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { classifyTool } from '../../../src/main/controlChannel/policy/toolClassify';
import { extractArgs } from '../../../src/main/controlChannel/policy/argExtraction';
import { canonicalizePath } from '../../../src/main/controlChannel/policy/pathCanonicalize';
import { evaluate } from '../../../src/shared/policy/evaluator';
import { IMMUTABLE_RULES } from '../../../src/shared/policy/immutableRules';
import {
  buildRuleSet,
  networkDenyRuleFor,
  roleRulesFrom,
} from '../../../src/shared/policy/ruleLoader';
import { isInside } from '../../../src/main/security/pathConfinement';
import type { Autonomy } from '../../../src/shared/models/enums';
import type { MatchContext, PolicyVariables, Rule } from '../../../src/shared/policy/types';
import type { ProbeResult } from '../../../src/shared/engine/types';

/**
 * T-3 (§19, policy evaluator): a fuzz pass asserting **no input produces an
 * accidental allow**, on top of the table-driven tests.
 *
 * Generated tool calls go through the same pipeline `policyEvaluator.ts` runs:
 * `classifyTool` with the real claude-code capabilities, `extractArgs` (which
 * canonicalises paths through the real filesystem), and the real `evaluate()`
 * over the immutable denies plus the SHIPPED developer role's rules. Paths are
 * built from real directories: the worktree, the project, the scratch space,
 * somewhere outside, a junction inside the worktree that points outside, and
 * traversal and credential-shaped segments. Tool names include mixed-case
 * look-alikes and `mcp__` shapes; commands are assembled from git, destructive
 * and ordinary words with random whitespace.
 *
 * Two oracles, each independent of the evaluator's own logic:
 *  1. Deny wins: whatever an immutable rule denies ON ITS OWN is denied by the
 *     full rule set.
 *  2. Nothing out of policy is allowed: an allowed write lands inside the
 *     worktree or scratch space; an allowed read lands inside the worktree,
 *     project or scratch space and is not credential-shaped; an unclassified
 *     tool (including any mixed-case look-alike) is never allowed.
 */
describe('T-3: no generated tool call produces an accidental allow (fuzz)', () => {
  let root: string;
  let dirs: { worktree: string; project: string; state: string; outside: string; junction: string };
  let rules: Rule[];
  let variables: PolicyVariables;
  const caps = new ClaudeCodeAdapter().capabilities({} as ProbeResult, 'structured');

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bureau-t3-'));
    const make = (...parts: string[]) => {
      const dir = path.join(root, ...parts);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const worktree = make('home', 'wt');
    const project = make('proj');
    const state = make('state', 'tmp');
    const outside = make('outside');
    make('outside', '.ssh');
    writeFileSync(path.join(outside, '.ssh', 'id_rsa'), 'x');
    const junction = path.join(worktree, 'linked');
    symlinkSync(outside, junction, 'junction');
    dirs = { worktree, project, state, outside, junction };
    variables = {
      worktree: canonicalizePath(worktree),
      project: canonicalizePath(project),
      home: canonicalizePath(path.join(root, 'home')),
      bureau_state: canonicalizePath(path.join(root, 'state')),
    };

    const loaded = loadPack(path.resolve('packs/engineering'));
    const developer = loaded.pack!.roles.find((role) => role.key === 'developer')!;
    const fullKey = 'engineering:developer';
    rules = buildRuleSet({
      roleRules: [
        ...roleRulesFrom({
          full_key: fullKey,
          tools_allow: developer.tools_allow,
          tools_deny: developer.tools_deny,
        }),
        networkDenyRuleFor(developer.network_allow, fullKey),
      ],
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const toolArb = fc.oneof(
    fc.constantFrom(
      'Read',
      'Write',
      'Edit',
      'MultiEdit',
      'Grep',
      'Glob',
      'LS',
      'Bash',
      'WebFetch',
      'WebSearch',
      'Task',
      'Agent',
      'ToolSearch',
      'NotebookEdit',
      'mcp__evil__spawn_worker',
      'mcp__bureau__bureau_task_done',
    ),
    fc.constantFrom('read', 'WRITE', 'bash', 'edit ', ' Read', 'Wr1te', 'mcp__bureau__x'),
    fc.string({ minLength: 1, maxLength: 12 }),
  );

  const pathArb = fc
    .tuple(
      fc.constantFrom('worktree', 'project', 'state', 'outside', 'junction', 'relative', 'system'),
      fc.array(
        fc.constantFrom(
          '..',
          'src',
          'sub',
          '.ssh',
          'id_rsa',
          '.env',
          '.env.local',
          'key.pem',
          'a.ts',
          '.aws',
          'credentials',
        ),
        { maxLength: 5 },
      ),
    )
    .map(([base, segments]) => {
      const tail = segments.join('/');
      switch (base) {
        case 'relative':
          return tail.length > 0 ? tail : 'a.ts';
        case 'system':
          return `C:/Windows/System32/${tail}`;
        default:
          // Joined as text, not with path.join, so a `..` reaches the real
          // canonicalisation in extractArgs rather than being resolved here.
          return tail.length > 0
            ? `${dirs[base as keyof typeof dirs]}/${tail}`
            : dirs[base as keyof typeof dirs];
      }
    });

  const commandArb = fc
    .array(
      fc.constantFrom(
        'git',
        'commit',
        'push',
        'reset',
        '--hard',
        'rebase',
        '-C',
        '.',
        'rm',
        '-rf',
        '/',
        'npm',
        'test',
        'node',
        '-e',
        'format',
        'shutdown',
        'echo',
        'origin',
        'main',
      ),
      { minLength: 1, maxLength: 6 },
    )
    .chain((words) =>
      fc
        .array(fc.constantFrom(' ', '  ', '\t'), {
          minLength: words.length,
          maxLength: words.length,
        })
        .map((gaps) => words.map((w, i) => `${w}${gaps[i]}`).join('')),
    );

  const callArb = fc.record({
    tool: toolArb,
    filePath: pathArb,
    command: commandArb,
    url: fc.constantFrom(
      'https://docs.python.org/3/',
      'https://attacker.example.com/x',
      'not a url',
    ),
    autonomy: fc.constantFrom<Autonomy>('ask', 'guided', 'autonomous'),
  });

  interface Call {
    tool: string;
    filePath: string;
    command: string;
    url: string;
    autonomy: Autonomy;
  }

  function contextFor(call: Call): {
    ctx: MatchContext;
    toolClass: ReturnType<typeof classifyTool>;
  } {
    const toolClass = classifyTool(call.tool, caps);
    const rawArgs = { file_path: call.filePath, command: call.command, url: call.url };
    const extracted = extractArgs(toolClass, rawArgs, variables.worktree);
    return {
      toolClass,
      ctx: {
        toolClass,
        canonicalPath: extracted.canonicalPath,
        canonicalArg: extracted.canonicalArg,
        domain: extracted.domain,
        variables,
        effectiveAutonomy: call.autonomy,
        now: new Date('2026-09-17T12:00:00Z'),
        rawArgs,
      },
    };
  }

  // §11.3's own globs, literally: inside `.ssh/` or `.aws/`, a `.env*` file, a `.pem`.
  const credentialShaped = (p: string) =>
    /(^|\/)\.ssh\/|(^|\/)\.aws\/|(^|\/)\.env[^/]*$|\.pem$/i.test(p);
  const PATH_READERS = new Set(['Read', 'Grep', 'Glob', 'LS']);
  const insideAny = (p: string, roots: string[]) =>
    roots.some((r) => isInside(canonicalizePath(r), p));

  it('deny wins: anything one immutable rule denies alone, the full rule set denies', () => {
    fc.assert(
      fc.property(callArb, (call) => {
        const { ctx } = contextFor(call);
        const full = evaluate(rules, call.tool, ctx);
        for (const rule of IMMUTABLE_RULES) {
          if (evaluate([rule], call.tool, ctx).effect === 'deny') {
            expect(full.effect, `${rule.id} denies ${call.tool} alone`).toBe('deny');
          }
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('nothing out of policy is allowed', () => {
    fc.assert(
      fc.property(callArb, (call) => {
        const { ctx, toolClass } = contextFor(call);
        const verdict = evaluate(rules, call.tool, ctx);
        if (verdict.effect !== 'allow') return;
        if (verdict.ruleId === 'bureau.always_allow') return;

        expect(toolClass, `${call.tool} is unclassified`).not.toBe('other');
        if (toolClass === 'write') {
          expect(ctx.canonicalPath).not.toBeNull();
          expect(
            insideAny(ctx.canonicalPath!, [realpathSync.native(dirs.worktree), dirs.state]),
            `write allowed outside the worktree: ${ctx.canonicalPath}`,
          ).toBe(true);
        }
        // Only tools whose real API reads a path. ToolSearch is a read that never
        // touches the filesystem, so a path argument to it is not a read of that path.
        if (toolClass === 'read' && ctx.canonicalPath !== null && PATH_READERS.has(call.tool)) {
          expect(
            insideAny(ctx.canonicalPath, [dirs.worktree, dirs.project, dirs.state]),
            `read allowed outside the workspace: ${ctx.canonicalPath}`,
          ).toBe(true);
          expect(
            credentialShaped(ctx.canonicalPath),
            `credential read allowed: ${ctx.canonicalPath}`,
          ).toBe(false);
        }
      }),
      { numRuns: 1500 },
    );
  });
});
