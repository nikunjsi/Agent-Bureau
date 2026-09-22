import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newId, nowIso } from '../../src/shared/models/ids';
import { EmployeeSchema } from '../../src/shared/models/employee';
import { RoleSchema } from '../../src/shared/models/role';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../src/shared/engine/seams';
import type { EmployeeContext } from '../../src/shared/engine/types';

/**
 * An `EmployeeContext` for driving a REAL adapter directly, with no
 * database, no Supervisor and no control channel — the same shape
 * `turnBoundaryQueueRealAdapters.test.ts` builds inline. The state
 * directory is a fresh temp directory, never the repo root (pre-M11 N-4).
 */
export function adapterTestContext(engineKey: string, engineOptions: unknown): EmployeeContext {
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
    engine: engineKey,
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
    engine_preference: JSON.stringify([engineKey]),
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
    engine_options: engineOptions === null ? null : JSON.stringify(engineOptions),
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  return {
    employee,
    role,
    task: null,
    worktreePath: process.cwd(),
    // N-4: never the repo root. The claude-code adapter writes its engine
    // config files into stateDir, and this used to leave
    // `mcp-config.json`/`claude-settings.json` (with this machine's
    // absolute paths in them) at the root, where they got committed.
    stateDir: mkdtempSync(path.join(tmpdir(), 'bureau-adapter-state-')),
    baseDir: process.cwd(),
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker: noopSecretBroker,
    modelId: null,
    turnBudgetCapUsdMicros: null,
  };
}
