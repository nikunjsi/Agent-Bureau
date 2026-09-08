import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { nowIso } from '../../../src/shared/models/ids';
import { insertRole, getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import {
  upsertPack,
  getPackByKey,
  listPacks,
  recordPackValidation,
  setPackEnabled,
  deletePackContent,
} from '../../../src/main/db/repositories/packs';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * Migration 0006. Two things it exists to prove, both against the REAL
 * migrations directory and the real repositories, not a hand-written
 * schema:
 *
 * 1. Every field §6.5's `role.yaml` declares now has somewhere to land.
 *    Four of them (`shared_prompts`, `memory_budget_tokens`,
 *    `escalate_when`, `reports`) had no §5.1 column at all before M7, so a
 *    pack install would have parsed and validated them and then dropped
 *    them silently.
 * 2. `packs.enabled` is the user's intent and survives a re-validation and
 *    a reinstall — the "disabled with a readable error" semantics from
 *    §6.7 are a withheld pack WITH a reason, never a flipped user setting.
 */
describe('migration 0006 — the full §6.5 role shape and the packs table', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-role-shape-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,pack_id,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', 'engineering', '{}', now, now);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips every §6.5 field, including the four added at M7', () => {
    insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes and modifies code.',
      system_prompt_path: 'prompts/developer.md',
      shared_prompts: [
        'prompts/_shared/engineering-standards.md',
        'prompts/_shared/definition-of-done.md',
      ],
      skills: ['code', 'refactor'],
      deliverable_types: ['code'],
      input_types: ['code', 'document'],
      engine_preference: ['claude-code'],
      model_preference: ['balanced', 'capable'],
      tools_allow: ['Read(**)'],
      tools_deny: ['Bash(git *)'],
      network_allow: [],
      memory_scopes: ['role', 'project', 'company'],
      memory_budget_tokens: 12000,
      autonomy_default: 'guided',
      escalate_when: [
        'the acceptance criteria are ambiguous or contradict the brief',
        'the same approach has failed twice',
      ],
      reports: {
        on_complete: 'what changed, why, what you verified, what you did NOT verify',
        on_block: 'what you tried, what you observed, what you need',
      },
      sprite_key: 'dev',
    });

    const role = getRoleByFullKey(db, 'engineering:developer');
    expect(role).not.toBeNull();
    expect(role!.shared_prompts).toEqual([
      'prompts/_shared/engineering-standards.md',
      'prompts/_shared/definition-of-done.md',
    ]);
    expect(role!.input_types).toEqual(['code', 'document']);
    expect(role!.memory_budget_tokens).toBe(12000);
    expect(role!.escalate_when).toHaveLength(2);
    expect(role!.escalate_when[0]).toContain('acceptance criteria');
    expect(role!.reports.on_complete).toContain('what you did NOT verify');
    expect(role!.reports.on_block).toContain('what you need');
  });

  it('defaults the four new columns for a role that declares none of them', () => {
    insertRole(db, {
      key: 'minimal',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Minimal',
      description: 'Nothing optional declared.',
      system_prompt_path: 'prompts/minimal.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'ask',
      sprite_key: 'dev',
    });

    const role = getRoleByFullKey(db, 'engineering:minimal');
    expect(role!.shared_prompts).toEqual([]);
    expect(role!.input_types).toEqual([]);
    expect(role!.escalate_when).toEqual([]);
    expect(role!.memory_budget_tokens).toBe(8000); // §6.5's own default
    expect(role!.reports).toEqual({ on_complete: '', on_block: '' });
  });

  it("records a failed validation WITHOUT touching the user's enabled intent", () => {
    upsertPack(db, {
      key: 'engineering',
      name: 'Engineering',
      version: '1.0.0',
      origin: 'bundled',
      source_path: 'C:/app/resources/packs/engineering',
    });

    recordPackValidation(
      db,
      'engineering',
      'failed',
      'roles/developer.yaml: tools_allow[0] widens deny.git_write',
    );

    const pack = getPackByKey(db, 'engineering');
    expect(pack!.enabled).toBe(true); // withheld, not switched off
    expect(pack!.last_validation_status).toBe('failed');
    expect(pack!.last_validation_error).toContain('widens deny.git_write');
    expect(pack!.last_validated_at).not.toBeNull();
  });

  it('does not re-enable a pack the user switched off when it is reinstalled', () => {
    upsertPack(db, {
      key: 'engineering',
      name: 'Engineering',
      version: '1.0.0',
      origin: 'bundled',
      source_path: 'C:/app/resources/packs/engineering',
    });
    setPackEnabled(db, 'engineering', false);

    // A reinstall/upgrade carries `enabled: true` in its input, the way a
    // fresh install would. The user's own switch must still win.
    upsertPack(db, {
      key: 'engineering',
      name: 'Engineering',
      version: '1.1.0',
      origin: 'bundled',
      source_path: 'C:/app/resources/packs/engineering',
      enabled: true,
    });

    const pack = getPackByKey(db, 'engineering');
    expect(pack!.enabled).toBe(false);
    expect(pack!.version).toBe('1.1.0'); // the upgrade itself did land
  });

  it('clears a pack’s roles and departments in FK-safe order, keeping the pack row', () => {
    upsertPack(db, {
      key: 'engineering',
      name: 'Engineering',
      version: '1.0.0',
      origin: 'user',
      source_path: 'C:/downloads/engineering',
    });
    insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code.',
      system_prompt_path: 'prompts/developer.md',
      skills: [],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    });

    deletePackContent(db, 'engineering');

    // The row survives — it carries the user's `enabled` intent across an
    // upgrade, which is the only thing this function is used for.
    expect(listPacks(db)).toHaveLength(1);
    expect(getRoleByFullKey(db, 'engineering:developer')).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM departments').get()).toEqual({ n: 0 });
  });
});
