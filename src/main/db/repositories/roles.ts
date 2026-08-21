import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { RoleSchema, type Role, type NewRoleInput } from '../../../shared/models/role';

export function insertRole(db: Database.Database, input: NewRoleInput): Role {
  const id = newId();
  const now = nowIso();
  db.prepare(
    `INSERT INTO roles (
       id, key, department_key, pack_id, priority, version, title, description,
       system_prompt_path, skills, deliverable_types, engine_preference, model_preference,
       tools_allow, tools_deny, network_allow, memory_scopes, autonomy_default,
       max_turns, max_attempts, wall_clock_timeout_s, budget_usd_micros, sprite_key,
       role_options, enabled, created_at, updated_at
     ) VALUES (
       @id, @key, @department_key, @pack_id, @priority, @version, @title, @description,
       @system_prompt_path, @skills, @deliverable_types, @engine_preference, @model_preference,
       @tools_allow, @tools_deny, @network_allow, @memory_scopes, @autonomy_default,
       @max_turns, @max_attempts, @wall_clock_timeout_s, @budget_usd_micros, @sprite_key,
       @role_options, @enabled, @created_at, @updated_at
     )`,
  ).run({
    id,
    key: input.key,
    department_key: input.department_key,
    pack_id: input.pack_id,
    priority: input.priority,
    version: input.version,
    title: input.title,
    description: input.description,
    system_prompt_path: input.system_prompt_path,
    skills: toJsonColumn(input.skills),
    deliverable_types: toJsonColumn(input.deliverable_types),
    engine_preference: toJsonColumn(input.engine_preference),
    model_preference: input.model_preference === null ? null : toJsonColumn(input.model_preference),
    tools_allow: toJsonColumn(input.tools_allow),
    tools_deny: toJsonColumn(input.tools_deny),
    network_allow: toJsonColumn(input.network_allow),
    memory_scopes: toJsonColumn(input.memory_scopes),
    autonomy_default: input.autonomy_default,
    max_turns: input.max_turns,
    max_attempts: input.max_attempts,
    wall_clock_timeout_s: input.wall_clock_timeout_s,
    budget_usd_micros: input.budget_usd_micros,
    sprite_key: input.sprite_key,
    role_options: toJsonColumn(input.role_options),
    enabled: input.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  });
  return getRoleById(db, id) as Role;
}

export function getRoleById(db: Database.Database, id: string): Role | null {
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  return row ? RoleSchema.parse(row) : null;
}

/** Roles are addressed everywhere as `pack:key` (§5.1) — this is that lookup. */
export function getRoleByFullKey(db: Database.Database, fullKey: string): Role | null {
  const row = db.prepare('SELECT * FROM roles WHERE full_key = ?').get(fullKey);
  return row ? RoleSchema.parse(row) : null;
}
