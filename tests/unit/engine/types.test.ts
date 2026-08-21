import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import { TaskSchema } from '../../../src/shared/models/task';
import type { EmployeeContext } from '../../../src/shared/engine/types';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';

/**
 * §7.1.1's types are pure interfaces — the only way to prove they actually
 * compose (not just that each file typechecks in isolation) is to build one
 * real `EmployeeContext` out of real, schema-validated fixtures plus the M4/
 * M6 placeholders, the way a supervisor eventually will. This also pins the
 * placeholders' own runtime behaviour: inert-but-loud (toolServer/
 * controlChannel), and genuinely empty, not silently fabricated (broker).
 */
describe('§7.1.1 EmployeeContext composes from real fixtures + M4/M6 placeholders', () => {
  it('builds a full EmployeeContext with no type errors and sane placeholder values', async () => {
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
      skills: JSON.stringify(['code']),
      deliverable_types: JSON.stringify(['code']),
      engine_preference: JSON.stringify(['claude-code']),
      model_preference: null,
      tools_allow: JSON.stringify(['Read(**)']),
      tools_deny: JSON.stringify(['Bash(git commit *)']),
      network_allow: '[]',
      memory_scopes: JSON.stringify(['role']),
      autonomy_default: 'guided',
      max_turns: 40,
      max_attempts: 2,
      wall_clock_timeout_s: 2400,
      budget_usd_micros: null,
      sprite_key: 'dev',
      role_options: '{}',
      enabled: 1,
      created_at: now,
      updated_at: now,
    });

    const task = TaskSchema.parse({
      id: newId(),
      display_key: 'T-0001',
      project_id: newId(),
      phase_id: null,
      parent_task_id: null,
      title: 'Wire the login form',
      body: 'x',
      acceptance_criteria: JSON.stringify(['it builds']),
      required_skills: '[]',
      deliverable_type: 'code',
      assignee_employee_id: employee.id,
      excluded_employees: '[]',
      status: 'assigned',
      status_reason: null,
      priority: 50,
      attempts: 0,
      reassignments: 0,
      estimated_cost_usd_micros: null,
      spend_usd_micros: null,
      result_summary: null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    });

    const ctx: EmployeeContext = {
      employee,
      role,
      task,
      worktreePath: 'C:\\Users\\test\\.bureau\\worktrees\\ravi',
      stateDir: 'C:\\Users\\test\\.bureau\\state\\ravi',
      memoryPack: '',
      decisionLog: '',
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: employee.autonomy,
    };

    // Compiles ⇒ the seam types genuinely satisfy EmployeeContext's fields.
    expect(ctx.employee.id).toBe(employee.id);

    // toolServer/controlChannel: inert, not merely present. Anything that
    // actually tried to launch these would fail loudly, not silently no-op.
    expect(ctx.toolServer.command).toBe('__bureau_tool_server_not_yet_implemented__');
    expect(ctx.controlChannel.url).toContain(':0/');

    // broker: genuinely empty, never fabricated credentials.
    const secrets = await ctx.broker.resolveForSpawn({ employeeId: employee.id, engineKey: 'claude-code' });
    expect(secrets).toEqual({ env: {}, secretValues: [] });
    await expect(ctx.broker.revokeForEmployee(employee.id)).resolves.toBeUndefined();
  });

  it('the Director legitimately has an empty worktreePath (§8.0: no worktree)', () => {
    // Not a full fixture — just pinning the documented rule so a future
    // change to EmployeeContext can't quietly require worktreePath to be
    // non-empty without someone noticing this test break.
    const worktreePath: EmployeeContext['worktreePath'] = '';
    expect(worktreePath).toBe('');
  });
});
