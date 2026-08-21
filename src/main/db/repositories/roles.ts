import type Database from 'better-sqlite3';
import { newId, nowIso } from '../../../shared/models/ids';
import { toJsonColumn } from '../../../shared/models/json';
import { RoleSchema, NewRoleInputSchema, type Role, type NewRoleInput } from '../../../shared/models/role';

export function insertRole(db: Database.Database, input: NewRoleInput): Role {
  const parsed = NewRoleInputSchema.parse(input);
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
    key: parsed.key,
    department_key: parsed.department_key,
    pack_id: parsed.pack_id,
    priority: parsed.priority,
    version: parsed.version,
    title: parsed.title,
    description: parsed.description,
    system_prompt_path: parsed.system_prompt_path,
    skills: toJsonColumn(parsed.skills),
    deliverable_types: toJsonColumn(parsed.deliverable_types),
    engine_preference: toJsonColumn(parsed.engine_preference),
    model_preference: parsed.model_preference === null ? null : toJsonColumn(parsed.model_preference),
    tools_allow: toJsonColumn(parsed.tools_allow),
    tools_deny: toJsonColumn(parsed.tools_deny),
    network_allow: toJsonColumn(parsed.network_allow),
    memory_scopes: toJsonColumn(parsed.memory_scopes),
    autonomy_default: parsed.autonomy_default,
    max_turns: parsed.max_turns,
    max_attempts: parsed.max_attempts,
    wall_clock_timeout_s: parsed.wall_clock_timeout_s,
    budget_usd_micros: parsed.budget_usd_micros,
    sprite_key: parsed.sprite_key,
    role_options: toJsonColumn(parsed.role_options),
    enabled: parsed.enabled ? 1 : 0,
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
