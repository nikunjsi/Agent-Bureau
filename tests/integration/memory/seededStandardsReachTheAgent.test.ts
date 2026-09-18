import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import { getMemoryRowByPath } from '../../../src/main/memory/memoryStore';
import { composeMemoryPack } from '../../../src/main/memory/memoryPack';
import { installShippedPack } from '../../helpers/companyFixture';
import type { Role } from '../../../src/shared/models/role';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const CONVENTIONS = 'company/engineering-conventions.md';

/**
 * X-14 / §12.3: **"pinned company standards + role playbook + project
 * decisions"** — against the pack that actually ships.
 *
 * The clause reads pinned notes, and `seedPackMemory` wrote the pack's
 * standards unpinned. So the engineering pack's own conventions — the one
 * piece of company memory a fresh install has — reached an employee only if
 * the task text happened to hit it in keyword search. The clause was present,
 * the file was present, and the two never met.
 *
 * A pack's seeded standards are pinned on the way in: being the standing rule
 * is what a pack seeding company memory *means*, and pinning at the seed is
 * the smaller claim than teaching composition to read unpinned notes (which
 * would pull in every scratch note anyone ever wrote in company scope).
 *
 * The user stays in charge of it: `writeMemory` never rewrites `pinned` on an
 * existing row (§12.1), so a re-install does not undo an unpin.
 */
describe('a pack’s seeded standards reach the agent (X-14)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let role: Role;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-seed-pack-mem-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });
    role = getRoleByFullKey(db, 'engineering:developer') as Role;
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const pack = () =>
    composeMemoryPack(db, {
      role,
      projectId: null,
      taskText: 'Rename a column in the orders table',
    });

  it('puts the shipped engineering conventions in the pack as a company standard', () => {
    const standards = pack().items.filter((item) => item.kind === 'company_standard');

    expect(standards.map((item) => item.path)).toContain(CONVENTIONS);
  });

  it('pins them at the seed, so §12.3’s clause can see them', () => {
    expect(getMemoryRowByPath(db, CONVENTIONS)?.pinned).toBe(true);
  });

  it('does not re-pin a note the user unpinned, when the pack is installed again', () => {
    db.prepare('UPDATE memory SET pinned = 0 WHERE path = ?').run(CONVENTIONS);
    // A real re-install: same bytes on disk, so the seeder's own
    // user-edit check lets it through and refreshes the row.
    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });

    expect(getMemoryRowByPath(db, CONVENTIONS)?.pinned).toBe(false);
    // Only the clause under test: an unpinned note can still arrive as a
    // keyword hit for a task that mentions it, which is the search clause
    // working and says nothing about this one.
    expect(
      pack()
        .items.filter((item) => item.kind === 'company_standard')
        .map((item) => item.path),
    ).not.toContain(CONVENTIONS);
  });

  it('leaves a note the user edited alone, pin and all', () => {
    // §6.2's rule: the pack loses to the user's own edit. Asserted here
    // because pinning at the seed must not become a reason to overwrite.
    const absolute = path.join(tmpDir, 'memory', 'company', 'engineering-conventions.md');
    const edited = `${readFileSync(absolute, 'utf8')}\n\nAnd always run the linter.\n`;
    writeFileSync(absolute, edited, 'utf8');

    installShippedPack({ db, activityLog, baseDir: tmpDir, packKey: 'engineering' });

    expect(readFileSync(absolute, 'utf8')).toBe(edited);
  });
});
