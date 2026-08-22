import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { nowIso } from '../../../src/shared/models/ids';
import { insertRole, getRoleById } from '../../../src/main/db/repositories/roles';
import type { NewRoleInput } from '../../../src/shared/models/role';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

function baseRoleInput(overrides: Partial<NewRoleInput> = {}): NewRoleInput {
  return {
    key: 'developer',
    department_key: 'engineering',
    pack_id: 'engineering',
    version: '1.0.0',
    title: 'Developer',
    description: 'Writes code',
    system_prompt_path: 'prompts/developer.md',
    skills: ['code'],
    deliverable_types: ['code'],
    engine_preference: ['claude-code'],
    tools_allow: ['Read(**)'],
    tools_deny: [],
    memory_scopes: ['role'],
    autonomy_default: 'guided',
    sprite_key: 'dev',
    ...overrides,
  };
}

/**
 * §7.1.1/§6.5, M3 session 2: engine_options is validated against the
 * specific schema for the role's own engine_preference[0] at insertRole
 * time (role-load time) — real round trip through a real migrated DB, not
 * just the schema-level unit tests in tests/unit/models/engineOptions.
 * test.ts.
 */
describe('roles.engine_options — real insertRole validation (§7.1.1/§6.5)', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-role-engine-options-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', JSON.stringify({ x: 0, y: 0, w: 1, h: 1 }), now, now);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a role with no engine_options at all persists as real SQL NULL, not a JSON null', () => {
    const role = insertRole(db, baseRoleInput());
    expect(role.engine_options).toBeNull();
    const raw = db.prepare('SELECT engine_options FROM roles WHERE id = ?').get(role.id) as {
      engine_options: unknown;
    };
    expect(raw.engine_options).toBeNull();
  });

  it('a claude-code role with valid engine_options round-trips with defaults applied', () => {
    const role = insertRole(
      db,
      baseRoleInput({ engine_preference: ['claude-code'], engine_options: { mode: 'structured' } }),
    );
    expect(role.engine_options).toEqual({ mode: 'structured' });
    expect(getRoleById(db, role.id)?.engine_options).toEqual({ mode: 'structured' });
  });

  it('a generic-pty role with valid engine_options round-trips, including its required fields', () => {
    const role = insertRole(
      db,
      baseRoleInput({
        key: 'my-agent-runner',
        engine_preference: ['generic-pty'],
        engine_options: { command: 'my-agent', ready_pattern: '(?m)^> $' },
      }),
    );
    expect(role.engine_options).toEqual({
      mode: 'auto',
      command: 'my-agent',
      args: [],
      ready_pattern: '(?m)^> $',
      done_pattern: null,
      interrupt: '\x03',
      ready_debounce_ms: 150,
    });
  });

  it('a generic-pty role missing command/ready_pattern is rejected at load time, not silently persisted malformed', () => {
    expect(() =>
      insertRole(
        db,
        baseRoleInput({
          key: 'broken-runner',
          engine_preference: ['generic-pty'],
          engine_options: { mode: 'auto' }, // missing command + ready_pattern
        }),
      ),
    ).toThrow();

    // Provably did not execute — no row exists.
    const row = db.prepare('SELECT id FROM roles WHERE key = ?').get('broken-runner');
    expect(row).toBeUndefined();
  });

  it('engine_options is validated against engine_preference[0] specifically, not just "any known engine"', () => {
    // Valid generic-pty shape, but this role's primary engine is
    // claude-code — both per-engine schemas are `.strict()`, so
    // claude-code's schema genuinely rejects generic-pty-shaped fields
    // (command/ready_pattern) as unrecognised, rather than silently
    // stripping them. Proves the selection keys off engine_preference[0]
    // specifically: the exact same value is accepted in the generic-pty
    // test above and rejected here, purely because the role's own engine
    // differs.
    expect(() =>
      insertRole(
        db,
        baseRoleInput({
          key: 'mismatched-engine-role',
          engine_preference: ['claude-code'],
          engine_options: { mode: 'auto', command: 'my-agent', ready_pattern: '(?m)^> $' },
        }),
      ),
    ).toThrow();

    const row = db.prepare('SELECT id FROM roles WHERE key = ?').get('mismatched-engine-role');
    expect(row).toBeUndefined();
  });
});
