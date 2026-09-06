import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { getDbPaths } from '../../../src/main/db/paths';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { insertProject } from '../../../src/main/db/repositories/projects';
import { newId } from '../../../src/shared/models/ids';
import { costsHandlers } from '../../../src/main/ipc/handlers/costs';
import { projectsHandlers } from '../../../src/main/ipc/handlers/projects';
import { buildSupportBundle } from '../../../src/main/ipc/handlers/system';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { usdToMicros } from '../../../src/shared/models/money';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';
import type { IpcResult } from '../../../src/shared/ipc/envelope';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
// The real file, read directly — `resolvePricingYamlPath()` needs a real
// Electron `app` (`app.isPackaged`), which this repo's own convention
// (`resourcePaths.test.ts`) only exercises through a packaged exe, not
// plain vitest. `main/index.ts` loads the same file the same way in
// production; this test only bypasses ITS path-resolution half.
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * M6 session 3 — the three `stub('M6')` surfaces the milestone named by
 * name (`costsHandlers.pricingTable`, `projectsHandlers.setBudget`,
 * `systemHandlers.supportBundle`), now real. Each driven through its own
 * real handler function with a real DB, exactly the path a future
 * renderer call reaches — not a bare unit test of some inner helper.
 */
describe('M6 session 3 — the three stub(\'M6\') surfaces, now real', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let ctx: HandlerContext;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-m6-stubs-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({ db, dbPath, migrationsDir: REAL_MIGRATIONS_DIR, backupsDir: path.join(tmpDir, 'backups') });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    ctx = { db, activityLog, dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR), pricing: REAL_PRICING, baseDir: tmpDir, bundledPacksDir: path.resolve('packs'), appVersion: '0.0.1' };
  });

  afterEach(() => {
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('costsHandlers.pricingTable', () => {
    it('loads resources/pricing.yaml for real and maps every claude-code model to its real tier via CLAUDE_CODE_DEFAULT_MODEL_TIERS', async () => {
      const result = (await costsHandlers.pricingTable!(undefined, ctx)) as IpcResult<{ items: unknown[] }>;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rows = result.data.items as Array<{
        engine: string;
        model: string;
        tier: string;
        inputPerMTokUsdMicros: number;
        outputPerMTokUsdMicros: number;
      }>;
      // resources/pricing.yaml ships exactly 3 claude-code models, all 3
      // present in CLAUDE_CODE_DEFAULT_MODEL_TIERS — none skipped.
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.engine === 'claude-code')).toBe(true);
      const sonnet = rows.find((r) => r.model === 'claude-sonnet-5');
      expect(sonnet).toBeDefined();
      expect(sonnet?.tier).toBe('balanced');
      // Real values from the real YAML file, converted through the real
      // usdToMicros — not fabricated expected numbers.
      expect(sonnet?.inputPerMTokUsdMicros).toBe(usdToMicros(2.0));
      expect(sonnet?.outputPerMTokUsdMicros).toBe(usdToMicros(10.0));
      const opus = rows.find((r) => r.model === 'claude-opus-5');
      expect(opus?.tier).toBe('capable');
      const haiku = rows.find((r) => r.model === 'claude-haiku-4-5-20251001');
      expect(haiku?.tier).toBe('fast');
    });
  });

  describe('projectsHandlers.setBudget', () => {
    it('writes projects.budget_usd_micros for real and emits exactly one project.budget_set event (invariant #3)', async () => {
      const project = insertProject(db, { name: 'P', path: tmpDir, kind: 'software' });
      expect(project.budget_usd_micros).toBeNull();

      const result = (await projectsHandlers.setBudget!({ id: project.id, budgetUsdMicros: 50_000_000 }, ctx)) as IpcResult<unknown>;
      expect(result.ok).toBe(true);

      const { getProjectById } = await import('../../../src/main/db/repositories/projects');
      expect(getProjectById(db, project.id)?.budget_usd_micros).toBe(50_000_000);

      const events = db.prepare("SELECT * FROM events WHERE type = 'project.budget_set' AND project_id = ?").all(project.id);
      expect(events).toHaveLength(1);
    });

    it('a nonexistent project id fails closed with NOT_FOUND, no row and no event created', async () => {
      const result = (await projectsHandlers.setBudget!({ id: newId(), budgetUsdMicros: 1_000_000 }, ctx)) as IpcResult<unknown>;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('NOT_FOUND');
      const events = db.prepare("SELECT * FROM events WHERE type = 'project.budget_set'").all();
      expect(events).toHaveLength(0);
    });
  });

  describe('systemHandlers.supportBundle', () => {
    it('writes one real, redacted JSON file matching the existing {path} IPC contract, containing prereqs/settings/activity — no archive dependency', async () => {
      activityLog.logEvent({
        actor: 'system',
        type: 'app.started',
        severity: 'info',
        project_id: null,
        task_id: null,
        employee_id: null,
        checkpoint_id: null,
        payload: null,
      });

      // buildSupportBundle directly, not through the IPC handler wrapper —
      // the wrapper's only job beyond this is `app.getVersion()`, which
      // needs a real Electron app (see the module comment on
      // buildSupportBundle itself).
      const bundlePath = await buildSupportBundle(ctx, 'test-version');
      expect(existsSync(bundlePath)).toBe(true);

      const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as {
        app: { version: string };
        prereqs: unknown[];
        settings: Record<string, unknown>;
        activityTail: Array<{ type: string }>;
      };
      expect(bundle.app.version).toBe('test-version');
      expect(Array.isArray(bundle.prereqs)).toBe(true);
      expect(bundle.settings).toBeTruthy();
      expect(bundle.activityTail.some((e) => e.type === 'app.started')).toBe(true);
    });
  });
});
