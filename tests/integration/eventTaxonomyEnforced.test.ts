import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { ActivityLog, readActivityLogTail, getMaxMirrorSeq } from '../../src/main/db/activityLog';
import { activityHandlers } from '../../src/main/ipc/handlers/activity';
import { getDbPaths } from '../../src/main/db/paths';
import { loadPricingYaml } from '../../src/main/cost/pricingYaml';
import type { HandlerContext } from '../../src/main/ipc/handlers/types';
import type { NewEventInput } from '../../src/shared/models/event';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * AUDIT M0–M2 #2 — §5.2's event taxonomy and §11.6's activity log.
 *
 * The taxonomy was closed at **typecheck only**. `EventTypeSchema` is a
 * `z.enum`, so an undocumented type fails compilation — but nothing
 * enforced it at write time, and nothing enforced the *shape* of a row at
 * all. `NewEventInputSchema` and `ActivityLogEntrySchema` both existed and
 * had **zero production callers**; a grep found them only in `tests/`.
 * `logEvent` never parsed its input, `insertMirrorRow` wrote raw, and
 * `tryParseLine` was `JSON.parse(line) as ActivityLogEntry` — a cast, not
 * a check.
 *
 * ## The consequence that matters is the silent one
 *
 * `events.seq` is `INTEGER PRIMARY KEY`, which in SQLite means it aliases
 * the rowid: **binding NULL to it auto-assigns a value.** So a JSONL entry
 * whose `seq` is missing or `undefined` does not fail — it gets a
 * *fabricated* sequence number, and the mirror silently desynchronises
 * from the file that `getMaxMirrorSeq()` uses as its high-water mark.
 * Every later repair then replays from the wrong place.
 *
 * A row with an out-of-taxonomy `type` is written just as happily
 * (`events.type` has no CHECK) and then makes `activity.query` throw for
 * the **entire** timeline, because one unparseable row rejects the whole
 * result set.
 *
 * These tests assert the three fixes: validate on the way in, validate on
 * the way back out of the file, and degrade one row at a time in the view.
 */
describe('the event taxonomy is enforced where events are actually written (audit #2)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let log: ReturnType<typeof ActivityLog.open>;
  let logPath: string;
  let ctx: HandlerContext;

  const anEvent = (over: Record<string, unknown> = {}) =>
    ({
      actor: 'system',
      type: 'app.started',
      severity: 'info',
      project_id: null,
      task_id: null,
      employee_id: null,
      checkpoint_id: null,
      payload: null,
      ...over,
    }) as unknown as NewEventInput;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-taxonomy-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    logPath = path.join(tmpDir, 'activity.jsonl');
    log = ActivityLog.open(logPath, db);
    ctx = {
      db,
      activityLog: log,
      dbPaths: getDbPaths(tmpDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir: tmpDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    } as HandlerContext;
  });

  afterEach(() => {
    log.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- 1. the write door ------------------------------------------------

  describe('logEvent validates its input', () => {
    it('refuses an out-of-taxonomy type, and writes nothing', () => {
      expect(() => log.logEvent(anEvent({ type: 'totally.made.up' }))).toThrow();

      // Nothing durable, in either half. A validation that happened after
      // the file write would leave the file ahead of the mirror forever.
      expect(getMaxMirrorSeq(db)).toBe(0);
      expect(readActivityLogTail(logPath, 0)).toEqual([]);
    });

    it('refuses an empty actor', () => {
      expect(() => log.logEvent(anEvent({ actor: '' }))).toThrow();
    });

    it('refuses a severity that is not a non-empty string', () => {
      expect(() => log.logEvent(anEvent({ severity: '' }))).toThrow();
      expect(() => log.logEvent(anEvent({ severity: 7 }))).toThrow();
    });

    it('accepts any non-empty severity — the vocabulary is open, on purpose', () => {
      // Worth pinning so the next reader does not take this for an
      // oversight. `SeveritySchema` is `z.string().min(1)`, not an enum,
      // and §5.2 never declares a closed severity set: it uses `info`,
      // `warn`, `error` and `security` inline in its type table's prose
      // without ever listing them as the permitted values. Tightening this
      // to an enum would be inventing a rule the spec does not state, so
      // it is left open and recorded rather than quietly narrowed.
      // Unlike `type`, which IS closed and is what #2 is about.
      expect(() => log.logEvent(anEvent({ severity: 'security' }))).not.toThrow();
    });

    it('still writes a valid event, and applies the schema defaults', () => {
      // `NewEventInputSchema` defaults severity and all four correlation
      // ids. Before this finding, `NewEventInput` was `z.infer` — the
      // OUTPUT type — so every defaulted field was falsely REQUIRED and
      // every caller passed four explicit nulls to satisfy a type that
      // lied about its own optionality (August finding #1's live
      // residual). It is `z.input` now, so this compiles.
      const entry = log.logEvent({ actor: 'system', type: 'app.started' });

      expect(entry.seq).toBe(1);
      expect(entry.severity).toBe('info');
      expect(entry.project_id).toBeNull();
      expect(entry.task_id).toBeNull();
      expect(entry.employee_id).toBeNull();
      expect(entry.checkpoint_id).toBeNull();
      expect(getMaxMirrorSeq(db)).toBe(1);
    });
  });

  // ---- 2. the read-back door -------------------------------------------

  describe('reading the file back validates each line', () => {
    /**
     * The dangerous shape, and the reason this is a SERIOUS finding rather
     * than a tidiness one. A line whose `seq` is absent parses as JSON
     * perfectly well, so the old cast let it through as a trusted
     * `ActivityLogEntry`. Downstream, `insertMirrorRow` binds `undefined`
     * to an `INTEGER PRIMARY KEY` and SQLite invents a sequence number.
     */
    it('rejects a line with no seq rather than trusting it', () => {
      log.logEvent(anEvent());
      writeFileSync(
        logPath,
        `${JSON.stringify({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'app.started', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n` +
          `${JSON.stringify({ seq: 2, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'app.started', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n`,
      );

      expect(() => readActivityLogTail(logPath, 0)).toThrow(/line 1/);
    });

    it('rejects a line whose type is outside the taxonomy', () => {
      writeFileSync(
        logPath,
        `${JSON.stringify({ seq: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'not.a.real.type', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n` +
          `${JSON.stringify({ seq: 2, id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'app.started', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n`,
      );

      expect(() => readActivityLogTail(logPath, 0)).toThrow(/line 1/);
    });

    it('still tolerates a torn LAST line — the one case that is not corruption', () => {
      // §11.6's existing, correct behaviour, pinned here so tightening the
      // check above cannot quietly remove it. A hard kill mid-`writeSync`
      // is the only way a line can be incomplete, and an incompletely
      // written line was never durable.
      writeFileSync(
        logPath,
        `${JSON.stringify({ seq: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'app.started', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n` +
          `{"seq":2,"id":"01ARZ3NDEK`,
      );

      const tail = readActivityLogTail(logPath, 0);
      expect(tail).toHaveLength(1);
      expect(tail[0]?.seq).toBe(1);
    });

    it('tolerates a STRUCTURALLY invalid last line too, for the same reason', () => {
      // A torn write can land on a byte boundary that still parses as
      // JSON. That is the same event as the case above and gets the same
      // treatment — dropped, not fatal.
      writeFileSync(
        logPath,
        `${JSON.stringify({ seq: 1, id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', ts: '2026-01-01T00:00:00.000Z', actor: 'system', type: 'app.started', severity: 'info', project_id: null, task_id: null, employee_id: null, checkpoint_id: null, payload: null })}\n` +
          `${JSON.stringify({ seq: 2 })}\n`,
      );

      const tail = readActivityLogTail(logPath, 0);
      expect(tail).toHaveLength(1);
    });
  });

  // ---- 3. the view -----------------------------------------------------

  describe('activity.query degrades one row at a time', () => {
    /**
     * A single unparseable row used to reject the whole result set, so the
     * user's entire timeline became `INTERNAL_ERROR` — the §14.6 failure
     * where a local defect presents as total breakage.
     */
    it('skips a corrupt row instead of blacking out the timeline', () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        log.logEvent(anEvent());
        log.logEvent(anEvent());

        // A writer that is not `logEvent` — which audit #4 shows is not
        // hypothetical in this codebase.
        db.prepare(
          `INSERT INTO events (seq, id, ts, actor, type, severity, project_id, task_id, employee_id, checkpoint_id, payload, created_at)
           VALUES (99, '01ARZ3NDEKTSV4RRFFQ69G5FAV', '2026-01-01T00:00:00.000Z', 'system', 'not.a.real.type', 'info', NULL, NULL, NULL, NULL, NULL, '2026-01-01T00:00:00.000Z')`,
        ).run();

        const result = activityHandlers['query']!({ limit: 50 }, ctx) as {
          ok: boolean;
          data: { items: unknown[] };
        };

        expect(result.ok).toBe(true);
        expect(result.data.items).toHaveLength(2);
        // Skipped is not the same as ignored: the row is real corruption
        // and something has to say so.
        expect(consoleError).toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});
