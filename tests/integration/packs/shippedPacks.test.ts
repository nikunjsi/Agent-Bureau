import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { loadPack } from '../../../src/main/packs/loadPack';
import { validatePack } from '../../../src/main/packs/validatePack';
import { installPack } from '../../../src/main/packs/installPack';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const PACKS_DIR = path.resolve('packs');
const APP_VERSION = (
  JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }
).version;

/**
 * The **shipped** packs, validated by the real validator against the real
 * app version. Without this, a typo in `packs/engineering/roles/*.yaml`
 * would ship and only surface the first time a user installed it — the
 * pack tests elsewhere all build their own fixtures and would stay green.
 *
 * `package.json`'s version is read rather than hardcoded, so bumping the
 * app cannot silently break a `bureau_min_version` these packs declare.
 */
describe('the packs Bureau ships', () => {
  let tmpDir: string;
  let baseDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-shipped-'));
    baseDir = path.join(tmpDir, 'userData');
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const packKey of ['engineering', 'operations']) {
    it(`${packKey} passes all eight §6.7 checks with no errors and no warnings`, () => {
      const loaded = loadPack(path.join(PACKS_DIR, packKey));
      expect(loaded.errors).toEqual([]);
      expect(loaded.pack).not.toBeNull();

      const result = validatePack(loaded.pack!, { appVersion: APP_VERSION });
      expect(result.errors).toEqual([]);
      // Warnings too: a shipped pack using an unknown sprite key or a dead
      // network_allow is an authoring bug, not an acceptable state.
      expect(result.warnings).toEqual([]);
    });
  }

  it('installs both packs, engineering’s five roles and operations’ Director', () => {
    for (const packKey of ['engineering', 'operations']) {
      const result = installPack({
        db,
        activityLog,
        baseDir,
        sourceDir: path.join(PACKS_DIR, packKey),
        origin: 'bundled',
        appVersion: APP_VERSION,
      });
      expect(result.errors, packKey).toEqual([]);
      expect(result.installed, packKey).toBe(true);
    }

    for (const fullKey of [
      'engineering:architect',
      'engineering:developer',
      'engineering:tester',
      'engineering:reviewer',
      'engineering:devops',
      'operations:director',
    ]) {
      expect(getRoleByFullKey(db, fullKey), fullKey).not.toBeNull();
    }
  });

  it('gives the Director exactly the tools §8.0 allows it, and none it forbids', () => {
    installPack({
      db,
      activityLog,
      baseDir,
      sourceDir: path.join(PACKS_DIR, 'operations'),
      origin: 'bundled',
      appVersion: APP_VERSION,
    });

    const director = getRoleByFullKey(db, 'operations:director');
    expect(director).not.toBeNull();

    // §8.0: "No Write, no Edit, no Bash. The Director directs; it does not
    // build." Asserted against the installed row, not the YAML — the row
    // is what the policy engine will read.
    const allow = director!.tools_allow.join(' ');
    expect(allow).not.toMatch(/\bWrite\(/);
    expect(allow).not.toMatch(/\bEdit\(/);
    expect(allow).not.toMatch(/\bBash\(/);
    expect(director!.tools_allow).toContain('Read(${project}/**)');

    // §8.0: capable tier, guided autonomy, no per-task budget ceiling.
    expect(director!.model_preference).toEqual(['capable']);
    expect(director!.autonomy_default).toBe('guided');
    expect(director!.budget_usd_micros).toBeNull();
  });

  it('seeds engineering’s conventions note into company memory', () => {
    installPack({
      db,
      activityLog,
      baseDir,
      sourceDir: path.join(PACKS_DIR, 'engineering'),
      origin: 'bundled',
      appVersion: APP_VERSION,
    });

    const row = db
      .prepare('SELECT scope FROM memory WHERE path = ?')
      .get('company/engineering-conventions.md');
    expect(row).toEqual({ scope: 'company' });
  });

  it('gives every shipped role a non-empty escalate_when and both report shapes', () => {
    // §6.5 requires them, and the schema enforces it — but a role could
    // satisfy the schema with placeholder text. This asserts the shipped
    // packs actually say something, since these are what make an employee
    // behave like a colleague rather than a text generator.
    for (const packKey of ['engineering', 'operations']) {
      const loaded = loadPack(path.join(PACKS_DIR, packKey));
      for (const role of loaded.pack!.roles) {
        expect(role.escalate_when.length, `${packKey}:${role.key}`).toBeGreaterThanOrEqual(3);
        expect(role.reports.on_complete.length, `${packKey}:${role.key}`).toBeGreaterThan(20);
        expect(role.reports.on_block.length, `${packKey}:${role.key}`).toBeGreaterThan(10);
      }
    }
  });

  it('denies git to every engineering role that can write files', () => {
    // CLAUDE.md invariant #4 is enforced by the immutable deny regardless,
    // but a role that can write and does not name `Bash(git *)` is one
    // whose author forgot — and §6.5 calls this out as easy to miss.
    const loaded = loadPack(path.join(PACKS_DIR, 'engineering'));
    for (const role of loaded.pack!.roles) {
      const writes = role.tools_allow.some((p) => p.startsWith('Write(') || p.startsWith('Edit('));
      if (!writes) continue;
      expect(role.tools_deny, role.key).toContain('Bash(git *)');
    }
  });
});
