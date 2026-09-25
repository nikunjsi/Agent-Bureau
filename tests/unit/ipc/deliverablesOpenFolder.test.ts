import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { insertDeliverable } from '../../../src/main/db/repositories/deliverables';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const openPath = vi.fn(async (_target: string) => '');
vi.mock('electron', () => ({ shell: { openPath: (target: string) => openPath(target) } }));

/**
 * M11 S3-5b, §8.7: "a button to open the folder". `deliverables.openFolder`
 * opens where the deliverable is — here, with no path of its own, the
 * project's folder — through the one `openInShell` (Electron's shell is the
 * only thing stubbed).
 */
describe('deliverables.openFolder', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-open-folder-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: path.resolve('src/main/db/migrations'),
      backupsDir: path.join(tmpDir, 'backups'),
    });
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('opens the project folder for a deliverable with no path of its own', async () => {
    const { insertProject } = await import('../../../src/main/db/repositories/projects');
    const project = insertProject(db, {
      name: 'Luigi',
      path: path.join(tmpDir, 'luigi'),
      kind: 'software',
    });
    const deliverable = insertDeliverable(db, {
      project_id: project.id,
      type: 'repository',
      title: 'Website',
      summary: 'The site.',
      status: 'in_review',
    });
    const { deliverablesHandlers } = await import('../../../src/main/ipc/handlers/deliverables');
    const result = await deliverablesHandlers['openFolder']!({ id: deliverable.id }, {
      db,
    } as unknown as HandlerContext);
    expect(result).toMatchObject({ ok: true });
    expect(openPath).toHaveBeenCalledWith(project.path);
  });
});
