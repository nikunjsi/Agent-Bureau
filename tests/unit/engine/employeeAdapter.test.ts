import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { createEmployeeAdapter } from '../../../src/main/engine/employeeAdapter';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { GenericPtyAdapter } from '../../../src/main/engine/genericPtyAdapter';
import type { Employee } from '../../../src/shared/models/employee';
import type { Role } from '../../../src/shared/models/role';

/**
 * M11 S3-1, pre-M11 §F P-2: an employee's adapter is built from its engine,
 * and a generic-pty employee's is **bound to its role's
 * `engine_options.command`**. Unbound, `probe()` answers "no command
 * configured" and `assign()` refuses it, so the binding is what lets a
 * generic-pty employee start at all.
 */
const employee = (engine: string) => ({ name: 'Meera', engine }) as unknown as Employee;
const role = (engineOptions: unknown) => ({ engine_options: engineOptions }) as unknown as Role;

// The settings factory reads hook timing from settings, so a migrated
// database with the defaults.
let tmpDir: string;
let db: Database.Database;
beforeAll(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-employee-adapter-'));
  const dbPath = path.join(tmpDir, 'bureau.db');
  db = openConnection(dbPath);
  await runMigrations({
    db,
    dbPath,
    migrationsDir: path.resolve('src/main/db/migrations'),
    backupsDir: path.join(tmpDir, 'backups'),
  });
  seedSettingsDefaults(db);
});
afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('an employee’s adapter', () => {
  it('claude-code: the settings factory’s adapter', () => {
    expect(createEmployeeAdapter(db, employee('claude-code'), role(null))).toBeInstanceOf(
      ClaudeCodeAdapter,
    );
  });

  it('generic-pty: bound to the role’s command, so probe answers about that binary', async () => {
    const bound = createEmployeeAdapter(
      db,
      employee('generic-pty'),
      role({
        mode: 'pty',
        command: process.execPath,
        args: [],
        ready_pattern: '>',
        done_pattern: null,
        interrupt: '\u0003',
        ready_debounce_ms: 300,
      }),
    );
    expect(bound).toBeInstanceOf(GenericPtyAdapter);
    const probe = await bound.probe({ budgetMs: 10_000 });
    expect(probe.installed).toBe(true);
  });

  it('generic-pty with no command is unbound, and says so', async () => {
    const unbound = createEmployeeAdapter(db, employee('generic-pty'), role({ mode: 'pty' }));
    const probe = await unbound.probe({ budgetMs: 10_000 });
    expect(probe.installed).toBe(false);
  });

  it('an engine Bureau has no adapter for is refused', () => {
    expect(() => createEmployeeAdapter(db, employee('mystery-cli'), role(null))).toThrow(
      /no adapter/,
    );
  });
});
