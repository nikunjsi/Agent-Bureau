import { describe, expect, it } from 'vitest';
import { newId, nowIso } from '../../../src/shared/models/ids';
import { CompanySchema } from '../../../src/shared/models/company';
import { DepartmentSchema } from '../../../src/shared/models/department';
import { RoleSchema } from '../../../src/shared/models/role';
import { EmployeeSchema } from '../../../src/shared/models/employee';

describe('CompanySchema', () => {
  it('parses a well-formed row, JSON columns included', () => {
    const now = nowIso();
    const row = {
      id: newId(),
      name: "Niksi's Studio",
      home_path: 'C:\\Users\\niksi\\Bureau',
      director_employee_id: null,
      floor_layout: JSON.stringify({ rooms: [] }),
      settings: JSON.stringify({}),
      created_at: now,
      updated_at: now,
    };
    const parsed = CompanySchema.parse(row);
    expect(parsed.floor_layout).toEqual({ rooms: [] });
  });

  it('rejects a floor_layout that is not valid JSON', () => {
    const now = nowIso();
    expect(() =>
      CompanySchema.parse({
        id: newId(),
        name: 'x',
        home_path: 'x',
        director_employee_id: null,
        floor_layout: 'not json',
        settings: '{}',
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });
});

describe('DepartmentSchema', () => {
  it('parses enabled as a boolean from SQLite 0/1', () => {
    const now = nowIso();
    const base = {
      id: newId(),
      key: 'engineering',
      name: 'Engineering',
      pack_id: null,
      room_rect: JSON.stringify({ x: 0, y: 0, w: 10, h: 8 }),
      theme: null,
      created_at: now,
      updated_at: now,
    };
    expect(DepartmentSchema.parse({ ...base, enabled: 1 }).enabled).toBe(true);
    expect(DepartmentSchema.parse({ ...base, enabled: 0 }).enabled).toBe(false);
  });
});

describe('RoleSchema', () => {
  it('parses full_key and every JSON array column', () => {
    const now = nowIso();
    const row = {
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
      skills: JSON.stringify(['code', 'debug']),
      deliverable_types: JSON.stringify(['code']),
      engine_preference: JSON.stringify(['claude-code']),
      model_preference: JSON.stringify(['balanced']),
      tools_allow: JSON.stringify(['Read(**)']),
      tools_deny: JSON.stringify(['Bash(git *)']),
      network_allow: '[]',
      memory_scopes: JSON.stringify(['role', 'project']),
      autonomy_default: 'guided',
      max_turns: 40,
      max_attempts: 2,
      wall_clock_timeout_s: 2400,
      budget_usd_micros: 2_000_000,
      sprite_key: 'dev',
      role_options: '{}',
      enabled: 1,
      created_at: now,
      updated_at: now,
    };
    const parsed = RoleSchema.parse(row);
    expect(parsed.full_key).toBe('engineering:developer');
    expect(parsed.skills).toEqual(['code', 'debug']);
    expect(parsed.deliverable_types).toEqual(['code']);
  });

  it('rejects an unknown deliverable_types member', () => {
    const now = nowIso();
    expect(() =>
      RoleSchema.parse({
        id: newId(),
        key: 'x',
        full_key: 'pack:x',
        department_key: 'engineering',
        pack_id: 'pack',
        priority: 50,
        version: '1.0.0',
        title: 'x',
        description: 'x',
        system_prompt_path: 'p.md',
        skills: '[]',
        deliverable_types: JSON.stringify(['not-a-real-kind']),
        engine_preference: '[]',
        model_preference: null,
        tools_allow: '[]',
        tools_deny: '[]',
        network_allow: '[]',
        memory_scopes: '[]',
        autonomy_default: 'guided',
        max_turns: 1,
        max_attempts: 1,
        wall_clock_timeout_s: 1,
        budget_usd_micros: null,
        sprite_key: 'x',
        role_options: '{}',
        enabled: 1,
        created_at: now,
        updated_at: now,
      }),
    ).toThrow();
  });
});

describe('EmployeeSchema', () => {
  it('parses every documented status value', () => {
    const now = nowIso();
    const statuses = [
      'off',
      'starting',
      'idle',
      'working',
      'thinking',
      'waiting',
      'blocked',
      'parked',
      'stopping',
      'failed',
    ];
    for (const status of statuses) {
      const parsed = EmployeeSchema.parse({
        id: newId(),
        name: 'Ravi',
        role_key: 'engineering:developer',
        is_director: 0,
        desk_x: 0,
        desk_y: 0,
        sprite_variant: 'a',
        status,
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
      expect(parsed.status).toBe(status);
    }
  });

  it('rejects the invented "awaiting" status — §5.1 is explicit there is no such state', () => {
    const now = nowIso();
    expect(() =>
      EmployeeSchema.parse({
        id: newId(),
        name: 'Ravi',
        role_key: 'engineering:developer',
        is_director: 0,
        desk_x: 0,
        desk_y: 0,
        sprite_variant: 'a',
        status: 'awaiting',
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
      }),
    ).toThrow();
  });
});
