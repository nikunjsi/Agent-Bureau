import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { EmployeeSchema } from '../../../src/shared/models/employee';
import { RoleSchema } from '../../../src/shared/models/role';
import {
  createRealClaudeCodeAdapterForTests,
  resolveBureauToolsScriptPathForTests,
} from '../../helpers/realEngineAdapter';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import type { EmployeeContext } from '../../../src/shared/engine/types';

/**
 * AUDIT #7 — the cheap guard for the expensive gates.
 *
 * `realEngineSpawn.test.ts` and `realAgentGate.test.ts` are gated behind
 * real API spend, so nothing runs them in CI or in a normal session. That
 * is how `realEngineSpawn.test.ts` came to throw `TypeError: Cannot read
 * properties of undefined (reading 'isPackaged')` for a whole milestone
 * without anyone noticing: M4 gave `resourceScripts.ts` an Electron
 * dependency, and the one file that constructed its adapter without the
 * injection simply stopped working, silently.
 *
 * The break was in the WIRING, not in anything that needs a model. So the
 * wiring is checked here, for free, in CI: this drives exactly the
 * construction path both gated tests use, all the way through
 * `buildLaunchSpec` — the call that actually touches Electron — without
 * spawning anything or spending anything.
 *
 * If this test fails, the gated tests would fail too, the next time
 * somebody paid to find out.
 */
describe('the real-engine gated tests can still construct their adapter (AUDIT #7)', () => {
  function ctxFor(stateDir: string): EmployeeContext {
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
      model_tier_override: null,
      session_id: null,
      pid: null,
      process_start_time: null,
      worktree_id: null,
      current_task_id: null,
      autonomy: 'guided',
      autonomous_confirmed_at: null,
      daily_budget_usd_micros: null,
      escalate_when: '[]',
      reports: '{}',
      resume_at: null,
      heartbeat_at: null,
      consecutive_failures: 0,
      lifetime_spend_usd_micros: 0,
      hired_at: now,
      archived_at: null,
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
      shared_prompts: '[]',
      input_types: '[]',
      engine_preference: '["claude-code"]',
      model_preference: null,
      tools_allow: '[]',
      tools_deny: '[]',
      network_allow: '[]',
      memory_scopes: '[]',
      memory_budget_tokens: 8000,
      autonomy_default: 'guided',
      max_turns: 40,
      max_attempts: 2,
      wall_clock_timeout_s: 2400,
      budget_usd_micros: null,
      escalate_when: '[]',
      reports: '{}',
      sprite_key: 'dev',
      role_options: '{}',
      engine_options: JSON.stringify({ mode: 'structured' }),
      enabled: 1,
      created_at: now,
      updated_at: now,
    });
    return {
      employee,
      role,
      task: null,
      worktreePath: stateDir,
      stateDir,
      baseDir: stateDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    };
  }

  it('builds a launch spec without touching a live Electron app — the exact failure that went unnoticed for a milestone', async () => {
    const adapter = createRealClaudeCodeAdapterForTests();
    // This is the call that reaches `resolveBureauHookScriptPath`. Bare
    // construction alone would NOT have caught the original break.
    const spec = await adapter.buildLaunchSpec(ctxFor('C:\\fake\\bureau\\state\\wiring'));
    expect(spec.command.length).toBeGreaterThan(0);
    expect(spec.args).toContain('--settings');
  });

  it('the bundled scripts the gated tests point at actually exist — run `npm run build` if this fails', () => {
    expect(fs.existsSync(resolveBureauToolsScriptPathForTests())).toBe(true);
  });
});
