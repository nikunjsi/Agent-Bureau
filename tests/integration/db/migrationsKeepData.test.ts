import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

/**
 * T-5 (§19, migrations): **each migration applied to a database built at the
 * previous version, with representative rows**, keeps its data. Until now each
 * migration was only ever applied to an empty database.
 *
 * The chain: apply 0001 and put a row in every table. Then for each later
 * migration N: snapshot every row of every table, apply N alone through the
 * real `runMigrations`, and assert every row that existed at N−1 still exists
 * with every column it had at N−1 unchanged (a migration that rebuilds a
 * table, as 0006 does, is exactly where data goes missing). Then put a row in
 * any table N created, so the next step has data there too.
 *
 * Rows come from a generic seeder that reads each table's real shape
 * (`table_xinfo`, `foreign_key_list`, and its CHECK constraints), so it keeps
 * working as migrations are added: required columns are filled by type, FKs
 * point at already-seeded parents, `json_valid(...)` columns get `{}`, and
 * `col IN (...)` columns get their first allowed value.
 */

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
  hidden: number;
}

function userTables(db: Database.Database): string[] {
  return (
    db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'",
      )
      .all() as Array<{ name: string; sql: string }>
  )
    .filter((t) => !/VIRTUAL TABLE/i.test(t.sql) && !/_fts(_|$)/.test(t.name))
    .map((t) => t.name);
}

function seedRow(
  db: Database.Database,
  table: string,
  seeded: Map<string, Record<string, unknown>>,
): boolean {
  const sql = (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as {
      sql: string;
    }
  ).sql;
  const columns = (db.prepare(`PRAGMA table_xinfo("${table}")`).all() as Column[]).filter(
    (c) => c.hidden === 0,
  );
  const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Array<{
    table: string;
    from: string;
    to: string | null;
  }>;
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const fk = fks.find((f) => f.from === column.name);
    if (fk) {
      const parent = seeded.get(fk.table);
      if (parent === undefined) {
        if (column.notnull && column.dflt_value === null) return false; // parent not seeded yet
        continue;
      }
      // An FK may target a column other than the parent's primary key
      // (e.g. a role key), so the parent row's own value for it is used.
      const pkName = (db.prepare(`PRAGMA table_info("${fk.table}")`).all() as Column[]).find(
        (c) => c.pk === 1,
      )?.name;
      values[column.name] = parent[fk.to ?? pkName ?? 'rowid'];
      continue;
    }
    const inList = new RegExp(`\\b${column.name}\\s+IN\\s*\\(\\s*'([^']+)'`, 'i').exec(sql);
    const isJson = new RegExp(`json_valid\\(\\s*${column.name}\\s*\\)`, 'i').test(sql);
    const required = column.notnull === 1 && column.dflt_value === null;
    if (column.pk === 1 && /INT/i.test(column.type)) continue; // rowid alias
    if (!required && column.pk !== 1 && !inList && !isJson) continue;
    if (!required && column.pk !== 1 && (inList || isJson) && column.notnull === 0) continue;
    if (inList) values[column.name] = inList[1];
    else if (isJson) values[column.name] = '{}';
    else if (/INT/i.test(column.type)) values[column.name] = 7;
    else if (/REAL/i.test(column.type)) values[column.name] = 1.5;
    else values[column.name] = `${table}.${column.name}.seed`;
  }
  const names = Object.keys(values);
  const info = db
    .prepare(
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...names.map((n) => values[n]));
  seeded.set(
    table,
    db
      .prepare(`SELECT rowid AS rowid, * FROM "${table}" WHERE rowid = ?`)
      .get(info.lastInsertRowid) as Record<string, unknown>,
  );
  return true;
}

function seedEmptyTables(
  db: Database.Database,
  seeded: Map<string, Record<string, unknown>>,
): void {
  let pending = userTables(db).filter(
    (t) => (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n === 0,
  );
  for (let pass = 0; pass < 10 && pending.length > 0; pass += 1) {
    pending = pending.filter((table) => !seedRow(db, table, seeded));
  }
  expect(pending, `could not seed: ${pending.join(', ')}`).toEqual([]);
}

function snapshot(db: Database.Database): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const table of userTables(db)) {
    out.set(
      table,
      db.prepare(`SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid`).all() as Array<
        Record<string, unknown>
      >,
    );
  }
  return out;
}

describe('T-5: every migration keeps the data of the version before it', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-t5-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('applies 0001..N one at a time over representative rows, and no row or column value is lost', async () => {
    const files = readdirSync(REAL_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(10);

    const stepDir = path.join(tmpDir, 'migrations');
    mkdirSync(stepDir);
    const dbPath = path.join(tmpDir, 'bureau.db');
    const db: Database.Database = openConnection(dbPath);
    const seeded = new Map<string, Record<string, unknown>>();
    try {
      for (const [index, file] of files.entries()) {
        const before = index === 0 ? null : snapshot(db);
        copyFileSync(path.join(REAL_MIGRATIONS_DIR, file), path.join(stepDir, file));
        const result = await runMigrations({
          db,
          dbPath,
          migrationsDir: stepDir,
          backupsDir: path.join(tmpDir, 'backups'),
        });
        expect(result.applied, file).toHaveLength(1);

        if (before !== null) {
          const after = snapshot(db);
          for (const [table, rows] of before) {
            const now = after.get(table);
            expect(now, `${file} dropped table ${table}`).toBeDefined();
            expect(now!.length, `${file} changed the row count of ${table}`).toBe(rows.length);
            for (const row of rows) {
              const match = now!.find((r) => r['__rowid'] === row['__rowid']);
              expect(match, `${file} lost a row of ${table}`).toBeDefined();
              for (const [column, value] of Object.entries(row)) {
                expect(match![column], `${file} changed ${table}.${column}`).toEqual(value);
              }
            }
          }
        }
        seedEmptyTables(db, seeded);
      }
    } finally {
      db.close();
    }
  });
});
