import type Database from 'better-sqlite3';

/**
 * §5.1.2: `MAX(...)+1` is a race under concurrent creation. This
 * increments (creating the row on first use) inside the **same**
 * `BEGIN IMMEDIATE` transaction that inserts the row using the resulting
 * number — callers must call this from inside their own `db.transaction`,
 * not as a separate connection round-trip.
 */
export function nextCounterValue(db: Database.Database, name: string): number {
  db.prepare('INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(
    name,
  );
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name) as { value: number };
  return row.value;
}

/** Formats a counter value as a display key, e.g. `formatDisplayKey('P', 3, 3)` → `"P-003"`. */
export function formatDisplayKey(prefix: string, value: number, padLength: number): string {
  return `${prefix}-${String(value).padStart(padLength, '0')}`;
}
