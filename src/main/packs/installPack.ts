import type Database from 'better-sqlite3';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { ActivityLog } from '../db/activityLog';
import { insertDepartment } from '../db/repositories/departments';
import { insertRole } from '../db/repositories/roles';
import { deletePackContent, upsertPack } from '../db/repositories/packs';
import { getPackDir } from '../db/paths';
import { usdToMicros } from '../../shared/models/money';
import type { PackOrigin, ParsedPack, RoleYaml } from '../../shared/models/pack';
import { seedPackMemory } from '../memory/seedPackMemory';
import { loadPack } from './loadPack';
import { validatePack } from './validatePack';

/**
 * §6.7 — "**A pack that fails validation is disabled with a readable
 * error, never partially loaded.**"
 *
 * "Never partially loaded" is guaranteed twice over, deliberately:
 *
 * 1. The WHOLE pack is loaded and validated before any DB write happens.
 *    Four roles where one is broken produce zero writes, not three.
 * 2. The writes themselves run inside one `better-sqlite3` transaction, so
 *    a failure the validator did not anticipate (an FK, a CHECK) still
 *    leaves nothing behind.
 *
 * Either alone would be a plausible-looking implementation with a real
 * hole: validation cannot predict every DB constraint, and a transaction
 * alone would let a pack with a broken role write its good ones and then
 * roll back only if SQLite happened to object.
 */

export interface InstallPackOptions {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  /** Electron's userData root — where user packs are copied to. */
  readonly baseDir: string;
  /** The directory to install FROM. */
  readonly sourceDir: string;
  readonly origin: PackOrigin;
  readonly appVersion: string;
}

export interface InstallPackResult {
  readonly installed: boolean;
  readonly packKey: string | null;
  readonly errors: string[];
  readonly warnings: string[];
  /** §6.2 `memory-seed/` files written into layer 1. */
  readonly memorySeeded?: number;
  /** Seed files left alone because the user had edited them. */
  readonly memorySkippedUserEdited?: string[];
}

export function installPack(options: InstallPackOptions): InstallPackResult {
  const loaded = loadPack(options.sourceDir);
  if (loaded.pack === null) {
    return { installed: false, packKey: null, errors: loaded.errors, warnings: [] };
  }
  const pack = loaded.pack;

  const validation = validatePack(pack, {
    appVersion: options.appVersion,
    installedDepartmentKeys: installedDepartmentKeysExcluding(options.db, pack.manifest.key),
  });
  if (validation.errors.length > 0) {
    // Deliberately writes NOTHING, not even a failure annotation on an
    // existing row of the same key. What failed is the SOURCE being
    // offered; a previously-installed version of the same pack is still
    // intact and working, and marking its row `failed` would report a
    // healthy pack as broken. Recording a validation failure belongs to
    // `revalidateInstalledPacks`, which validates what is actually
    // installed.
    return {
      installed: false,
      packKey: pack.manifest.key,
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }

  // Copy before the transaction, not inside it: a filesystem copy is not
  // transactional and cannot be rolled back by SQLite, so doing it first
  // means the failure mode is a stray directory (harmless, overwritten on
  // the next attempt) rather than DB rows pointing at files that are not
  // there.
  const installedDir = materialise(options, pack);

  const writePack = options.db.transaction(() => {
    deletePackContent(options.db, pack.manifest.key);

    for (const department of pack.departments) {
      insertDepartment(options.db, {
        key: department.key,
        name: department.name,
        pack_id: pack.manifest.key,
        // Placement is the floor generator's job (§13.3, M7 session 2).
        // Installing a pack records the department's PREFERRED size; where
        // it actually sits on the floor is decided when it is added to a
        // company, which is a separate act — §6.4's `default_hires` ("who
        // exists when this department is FIRST ADDED") says so.
        room_rect: { x: 0, y: 0, w: department.room.preferred_size.w, h: department.room.preferred_size.h },
        theme: department.room.theme
          ? {
              floor: department.room.theme.floor,
              wall: department.room.theme.wall,
              props: department.room.theme.props,
            }
          : null,
      });
    }

    for (const role of pack.roles) {
      insertRole(options.db, newRoleInputFrom(role, pack.manifest.key));
    }

    upsertPack(options.db, {
      key: pack.manifest.key,
      name: pack.manifest.name,
      version: pack.manifest.version,
      origin: options.origin,
      // Provenance — where it came FROM. `installedDir` is where it lives.
      source_path: options.sourceDir,
      last_validation_status: 'ok',
      last_validation_error: null,
    });
  });

  writePack();

  // §6.2's `memory-seed/`. After the pack transaction, not inside it: this
  // writes FILES (layer 1 is the source of truth, §12.1), and a filesystem
  // write inside a SQLite transaction would be rolled back on the DB side
  // and left behind on the disk side. Its own index rows go in as it
  // writes each file, in the same file-then-row order `writeMemory`
  // documents.
  const seeded = seedPackMemory(options.db, {
    packRootDir: installedDir,
    baseDir: options.baseDir,
  });

  // CLAUDE.md invariant #3: committed before the side effect, exactly one
  // event. The install is ONE state change, so it gets ONE event —
  // `company.department_added` belongs to a department being placed on a
  // real floor, which is a different act (see the room_rect note above).
  options.activityLog.logEvent({
    actor: 'system',
    type: 'company.pack_installed',
    severity: 'info',
    project_id: null,
    task_id: null,
    employee_id: null,
    checkpoint_id: null,
    payload: {
      key: pack.manifest.key,
      version: pack.manifest.version,
      origin: options.origin,
      sourcePath: options.sourceDir,
      installedPath: installedDir,
      departments: pack.departments.map((d) => d.key),
      roles: pack.roles.map((r) => r.key),
      memorySeeded: seeded.written.length,
      memorySkippedUserEdited: seeded.skippedUserEdited,
      warnings: validation.warnings,
    },
  });

  return {
    installed: true,
    packKey: pack.manifest.key,
    errors: [],
    warnings: validation.warnings,
    memorySeeded: seeded.written.length,
    memorySkippedUserEdited: seeded.skippedUserEdited,
  };
}

/**
 * Copies a user pack into `%APPDATA%/Bureau/packs/<key>/`, so what Bureau
 * reads is what it validated. A bundled pack is already inside the
 * installer and read-only — copying it would create a second, drifting
 * copy — so it installs in place and this returns its own directory.
 */
function materialise(options: InstallPackOptions, pack: ParsedPack): string {
  if (options.origin === 'bundled') return pack.rootDir;

  const target = getPackDir(options.baseDir, pack.manifest.key);
  if (path.resolve(target) === path.resolve(pack.rootDir)) return target;
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(pack.rootDir, target, { recursive: true });
  return target;
}

function installedDepartmentKeysExcluding(db: Database.Database, packKey: string): string[] {
  const rows = db.prepare('SELECT key FROM departments WHERE pack_id IS NOT ?').all(packKey) as { key: string }[];
  return rows.map((row) => row.key);
}

/**
 * §6.5's YAML to §5.1's row. The one real conversion is money: `budget_usd`
 * is a decimal in YAML and integer micros everywhere downstream of here
 * (CLAUDE.md invariant #12), and this is the conversion boundary.
 */
function newRoleInputFrom(role: RoleYaml, packKey: string) {
  return {
    key: role.key,
    department_key: role.department,
    pack_id: packKey,
    version: role.version,
    title: role.title,
    description: role.description,
    system_prompt_path: role.system_prompt_path,
    shared_prompts: [...role.shared_prompts],
    skills: [...role.skills],
    deliverable_types: [...role.deliverable_types],
    input_types: [...role.input_types],
    engine_preference: [...role.engine_preference],
    model_preference: role.model_preference.length > 0 ? [...role.model_preference] : null,
    tools_allow: [...role.tools_allow],
    tools_deny: [...role.tools_deny],
    network_allow: [...role.network_allow],
    memory_scopes: [...role.memory_scopes],
    memory_budget_tokens: role.memory_budget_tokens,
    autonomy_default: role.autonomy_default,
    max_turns: role.max_turns,
    max_attempts: role.max_attempts,
    wall_clock_timeout_s: role.wall_clock_timeout_s,
    budget_usd_micros: role.budget_usd === null ? null : usdToMicros(role.budget_usd),
    escalate_when: [...role.escalate_when],
    reports: { on_complete: role.reports.on_complete, on_block: role.reports.on_block },
    sprite_key: role.sprite_key,
    role_options: role.role_options,
    engine_options: role.engine_options,
  };
}
