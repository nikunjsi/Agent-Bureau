import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';

function fakeEmployeeContext(stateDir: string, worktreePath: string): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(),
    name: 'Ravi',
    role_key: 'engineering:developer',
    is_director: 0,
    desk_x: 0,
    desk_y: 0,
    sprite_variant: 'a',
    status: 'idle',
    status_detail: null,
    engine: 'claude-code',
    engine_mode: null,
    engine_version: null,
    model: null,
    session_id: null,
    pid: null,
    process_start_time: null,
    worktree_id: null,
    current_task_id: null,
    autonomy: 'guided',
    daily_budget_usd_micros: null,
    resume_at: null,
    heartbeat_at: null,
    consecutive_failures: 0,
    lifetime_spend_usd_micros: 0,
    hired_at: now,
    created_at: now,
    updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(),
    key: 'developer',
    full_key: 'engineering:developer',
    department_key: 'engineering',
    pack_id: 'engineering',
    priority: 50,
    version: '1.0.0',
    title: 'Developer',
    description: 'Writes code',
    system_prompt_path: 'prompts/developer.md',
    skills: '[]',
    deliverable_types: '[]',
    engine_preference: '["claude-code"]',
    model_preference: null,
    tools_allow: '[]',
    tools_deny: '[]',
    network_allow: '[]',
    memory_scopes: '[]',
    autonomy_default: 'guided',
    max_turns: 40,
    max_attempts: 2,
    wall_clock_timeout_s: 2400,
    budget_usd_micros: null,
    sprite_key: 'dev',
    role_options: '{}',
    engine_options: null,
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  return {
    employee,
    role,
    task: null,
    worktreePath,
    stateDir,
    memoryPack: '',
    decisionLog: '',
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker: noopSecretBroker,
    effectiveAutonomy: 'ask',
  };
}

/**
 * §7.6/M3 step 5: "The adapter builds a valid launch spec, verified against
 * the real binary." No spawning here — buildLaunchSpec's job is composing
 * a spec, not running anything; this checks that composition is correct
 * and that the command it names genuinely exists on this machine.
 */
describe('ClaudeCodeAdapter.buildLaunchSpec (§7.6)', () => {
  it('composes exactly what §7.6 lists — nothing else — and the command is a real, existing binary', async () => {
    const adapter = new ClaudeCodeAdapter();
    const probeResult = await adapter.probe();
    expect(probeResult.installed, probeResult.error ?? '').toBe(true);

    const stateDir = 'C:\\fake\\bureau\\state\\ravi';
    const worktreePath = 'C:\\fake\\bureau\\worktrees\\ravi';
    const ctx = fakeEmployeeContext(stateDir, worktreePath);

    const spec = await adapter.buildLaunchSpec(ctx);

    // command: absolute, and a real file that actually exists.
    expect(spec.command).toBe(probeResult.binaryPath);
    expect(fs.existsSync(spec.command)).toBe(true);

    // cwd: the employee's worktree, not the state dir, not process.cwd().
    expect(spec.cwd).toBe(worktreePath);

    // env: exactly the fields §7.6 lists, nothing else.
    expect(spec.env.CLAUDE_CONFIG_DIR).toBe('C:\\fake\\bureau\\state\\ravi\\claude');
    expect(spec.env.HOME).toBe(stateDir);
    expect(spec.env.USERPROFILE).toBe(stateDir);
    expect(spec.env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(spec.env.PATH).toBeTruthy();
    expect(spec.env.TEMP).toBe('C:\\fake\\bureau\\state\\ravi\\tmp');
    expect(spec.env.TMP).toBe('C:\\fake\\bureau\\state\\ravi\\tmp');
    // Windows base allowlist keys are present (real values, machine-dependent).
    expect(spec.env.ComSpec).toBeTruthy();
    // No ANTHROPIC_API_KEY, no secrets — the broker is a separate step (session 1's design).
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();

    // MCP discovery suppression is present.
    expect(spec.args).toContain('--strict-mcp-config');
    expect(spec.args).toContain('--setting-sources');

    expect(spec.configFiles).toEqual([]);
  }, 10_000);

  it('the Director (no worktree, §8.0) falls back to stateDir as cwd', async () => {
    const adapter = new ClaudeCodeAdapter();
    await adapter.probe();

    const stateDir = 'C:\\fake\\bureau\\state\\director';
    const ctx = fakeEmployeeContext(stateDir, ''); // '' — legitimately empty, per §8.0

    const spec = await adapter.buildLaunchSpec(ctx);
    expect(spec.cwd).toBe(stateDir);
  }, 10_000);

  it('throws a clear error if called before a successful probe()', async () => {
    const adapter = new ClaudeCodeAdapter();
    const ctx = fakeEmployeeContext('C:\\fake\\state', 'C:\\fake\\worktree');
    await expect(adapter.buildLaunchSpec(ctx)).rejects.toThrow(/probe/);
  });
});
