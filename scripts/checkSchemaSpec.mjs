// AUDIT M0–M2 #24 — §5.1's tables and columns against the real migrations.
//
// Applies every migration in src/main/db/migrations to an in-memory SQLite
// database and compares the resulting tables and columns with §5.1. Checked
// in both directions: a column §5.1 documents that no migration creates,
// and a column a migration creates that §5.1 never mentions.
//
// §5.1 describes a table in one of four shapes, all of which are read:
//   1. **`name`** heading followed by a markdown table — every backticked
//      identifier in each row's FIRST cell is a column.
//   2. **`name`** — prose: `col, col (nullable), col` — a backticked,
//      comma-separated span on the heading line.
//   3. **`name`** heading followed by a line that is ONLY such a span.
//   4. CREATE VIRTUAL TABLE name USING fts5(col, col, option=…) in a ```sql
//      fence — the entries without an "=" are its columns.
// A span of the form `(a, b)` (task_deps' composite key) is shape 2.
//
// Columns come from PRAGMA table_xinfo, not table_info: table_info hides
// generated columns, and roles.full_key is one — the Phase 1 prototype
// reported it as missing for exactly that reason.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { report, rootDir, specSection } from './specLists.mjs';

const require = createRequire(path.join(rootDir, 'package.json'));
const Database = require('better-sqlite3');

// ---- the spec -----------------------------------------------------------
const spec = {};
let current = null;
let inSql = false;
const addColumns = (table, span) => {
  for (const item of span.replace(/^\(|\)$/g, '').split(',')) {
    const name = item.trim().split(/\s+/)[0];
    if (/^[a-z_][a-z_0-9]*$/.test(name)) spec[table].add(name);
  }
};
/** The contents of each `code span` on a line. Splitting on backticks and
 * taking the odd pieces is the honest tokenisation: a regex over the raw
 * line can match from the closing backtick of one span to the opening
 * backtick of the next, and read the prose between them as columns (the
 * first draft of this script did exactly that). */
const codeSpans = (text) => text.split('`').filter((_, index) => index % 2 === 1);
const lines = specSection('### 5.1 Tables', '### 5.3');
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  if (line.startsWith('```')) {
    inSql = !inSql && line.startsWith('```sql');
    continue;
  }
  if (inSql) {
    const fts = /CREATE VIRTUAL TABLE (\w+) USING fts5\(([\s\S]*?)\);/.exec(
      lines.slice(i, i + 12).join(' '),
    );
    if (fts && line.includes('CREATE VIRTUAL TABLE')) {
      spec[fts[1]] = new Set(
        fts[2]
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0 && !s.includes('=')),
      );
    }
    continue;
  }

  if (/^#{3,4} /.test(line)) {
    current = null;
    continue;
  }

  const heading = /^\*\*`([a-z_0-9]+)`\*\*(.*)$/.exec(line);
  if (heading) {
    current = heading[1];
    spec[current] ??= new Set();
    for (const span of codeSpans(heading[2])) {
      if (span.includes(',')) addColumns(current, span);
    }
    continue;
  }

  if (current === null) continue;

  if (/^\|\s*`/.test(line)) {
    const firstCell = line.split('|')[1] ?? '';
    for (const m of firstCell.matchAll(/`([a-z_][a-z_0-9]*)`/g)) spec[current].add(m[1]);
  } else if (/^`[^`]*,[^`]*`\s*$/.test(line.trim())) {
    addColumns(current, line.trim().slice(1, -1));
  }
}

// ---- the migrations -----------------------------------------------------
const db = new Database(':memory:');
db.pragma('foreign_keys = OFF');
const migrationsDir = path.join(rootDir, 'src', 'main', 'db', 'migrations');
for (const file of readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  db.exec(readFileSync(path.join(migrationsDir, file), 'utf8'));
}
const allTables = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
  .all();
const virtual = new Set(
  allTables.filter((t) => /CREATE VIRTUAL TABLE/i.test(t.sql ?? '')).map((t) => t.name),
);
const shadowOf = (name) =>
  [...virtual].some((v) => new RegExp(`^${v}_(data|idx|content|docsize|config)$`).test(name));
const actual = {};
for (const { name } of allTables) {
  if (shadowOf(name)) continue;
  actual[name] = new Set(
    db
      .prepare(`PRAGMA table_xinfo(${name})`)
      .all()
      .filter((c) => c.hidden !== 1)
      .map((c) => c.name),
  );
}
db.close();

// ---- the diff -----------------------------------------------------------
const problems = [];
if (Object.keys(spec).length === 0)
  problems.push('  found no §5.1 tables at all — the parser is broken');

for (const table of [...new Set([...Object.keys(spec), ...Object.keys(actual)])].sort()) {
  if (!actual[table]) {
    problems.push(`  ${table}: documented in §5.1, created by no migration`);
    continue;
  }
  if (!spec[table]) {
    problems.push(`  ${table}: created by a migration, not documented in §5.1`);
    continue;
  }
  for (const col of [...spec[table]].sort()) {
    if (!actual[table].has(col))
      problems.push(`  ${table}.${col}: in §5.1, created by no migration`);
  }
  for (const col of [...actual[table]].sort()) {
    if (!spec[table].has(col))
      problems.push(`  ${table}.${col}: created by a migration, not in §5.1`);
  }
}

const columnCount = Object.values(actual).reduce((n, cols) => n + cols.size, 0);
report(
  'check:schema-spec',
  problems,
  `§5.1 matches the migrations: ${Object.keys(actual).length} tables, ${columnCount} columns.`,
);
