import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { classifyTool } from '../../../src/main/controlChannel/policy/toolClassify';
import { evaluate } from '../../../src/shared/policy/evaluator';
import { buildRuleSet } from '../../../src/shared/policy/ruleLoader';
import { CANONICAL_POLICY_VARIABLES } from '../../../src/shared/policy/immutableWidening';
import type { ProbeResult } from '../../../src/shared/engine/types';

/**
 * P-9 (pre-M11): the opt-in real M4 gate, run once, failed. Claude Code
 * 2.1.238 defers MCP tool schemas behind a `ToolSearch` meta-tool, so an agent
 * must call `ToolSearch` before it can call any `bureau_*` tool. `ToolSearch`
 * was not in the adapter's tool-class table, classified as `other`, and was
 * denied, so the agent could never reach `bureau_task_done` and the task ended
 * without a report.
 *
 * `ToolSearch` reads the schemas of tools the session already has. It reaches
 * nothing outside the session, and every tool it surfaces is still gated by
 * the hook when called. So it is a `read`, allowed at every autonomy level.
 */
describe('ToolSearch is a read for claude-code (P-9)', () => {
  const caps = new ClaudeCodeAdapter().capabilities({} as ProbeResult, 'structured');

  it('classifies as read, not other', () => {
    expect(classifyTool('ToolSearch', caps)).toBe('read');
  });

  it.each(['ask', 'guided', 'autonomous'] as const)(
    'is allowed at autonomy=%s by the real rule set',
    (autonomy) => {
      const verdict = evaluate(buildRuleSet({ roleRules: [] }), 'ToolSearch', {
        toolClass: classifyTool('ToolSearch', caps),
        canonicalPath: null,
        canonicalArg: '{"query":"select:mcp__bureau__bureau_task_done","max_results":3}',
        domain: null,
        variables: CANONICAL_POLICY_VARIABLES,
        effectiveAutonomy: autonomy,
        now: new Date('2026-09-17T12:00:00Z'),
        rawArgs: { query: 'select:mcp__bureau__bureau_task_done', max_results: 3 },
      });
      expect(verdict.effect).toBe('allow');
    },
  );
});
