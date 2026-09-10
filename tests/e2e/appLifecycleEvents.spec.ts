import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolvePackagedExePath, packagedAppEnv } from '../helpers/packagedApp';

/**
 * AUDIT M0–M2 #18 — §5.2 / CLAUDE.md invariant #3.
 *
 * Five of §5.2's seven `app.*` types had no emitter anywhere:
 * `app.started`, `app.stopping`, `app.migrated`, `app.updated`,
 * `app.crashed`. `app.migrated` is the one that mattered most —
 * **applying a migration is unambiguously a state change**, and invariant
 * #3 says every state change emits exactly one activity event.
 * `runMigrations` already returned `{ applied: [...] }` and `index.ts`
 * discarded it.
 *
 * ## Why this is an e2e spec and not a unit test
 *
 * The emission is boot wiring in `main/index.ts`. A unit test of a
 * `emitBootEvents()` helper would prove the helper works and prove nothing
 * about whether boot calls it — which is exactly the shape of finding #6,
 * where the test named for a rebuild ran the rebuild itself and never
 * called the handler (standing rule 1). The only honest way to assert that
 * booting the app writes these events is to boot the app.
 *
 * A fresh `--user-data-dir` makes this a genuine first run, so every
 * migration applies and `app.migrated` has something real to report.
 */

interface LoggedEvent {
  readonly seq: number;
  readonly type: string;
  readonly actor: string;
  readonly payload: Record<string, unknown> | null;
}

function readActivityLog(userDataDir: string): LoggedEvent[] {
  const logPath = path.join(userDataDir, 'activity.jsonl');
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent);
}

test('§5.2: a real boot emits app.migrated and app.started, and quitting emits app.stopping', async () => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-lifecycle-'));
  const app = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');

    const afterBoot = readActivityLog(userDataDir);
    const types = afterBoot.map((e) => e.type);

    // `app.migrated` — this is a first run against an empty directory, so
    // every migration in the tree applies and this must report them.
    expect(types, 'a first run applies migrations and must say so').toContain('app.migrated');
    const migrated = afterBoot.find((e) => e.type === 'app.migrated');
    const applied = migrated?.payload?.['applied'];
    expect(Array.isArray(applied), 'app.migrated carries the applied version list').toBe(true);
    expect(
      (applied as number[]).length,
      'a first run applies at least migration 0001',
    ).toBeGreaterThan(0);
    expect((applied as number[])[0], 'the list is the migration versions, in order').toBe(1);

    // Exactly one — invariant #3 is "exactly one activity event", not "at
    // least one". A boot that emitted per-migration would be wrong.
    expect(types.filter((t) => t === 'app.migrated')).toHaveLength(1);

    // `app.started` — after reconcile(), so it means "the app is up and
    // its state has been made consistent", not "main() began".
    expect(types, 'boot completed').toContain('app.started');
    expect(types.indexOf('app.migrated')).toBeLessThan(types.indexOf('app.started'));

    // Not yet — the app is still running.
    expect(types, 'app.stopping must not be emitted while running').not.toContain('app.stopping');
  } finally {
    await app.close();
  }

  // `app.stopping`, written by the shutdown sequence on the way out.
  const afterQuit = readActivityLog(userDataDir);
  const quitTypes = afterQuit.map((e) => e.type);
  expect(quitTypes, 'quitting is a state change too').toContain('app.stopping');
  expect(quitTypes.filter((t) => t === 'app.stopping')).toHaveLength(1);

  // The log is still gapless and ordered — the new writes go through
  // `logEvent` like everything else, not around it (§11.6).
  const seqs = afterQuit.map((e) => e.seq);
  expect(seqs).toEqual([...Array(seqs.length).keys()].map((n) => n + 1));

  rmSync(userDataDir, { recursive: true, force: true });
});

test('§5.2: a SECOND boot on the same data directory does not re-emit app.migrated', async () => {
  // Invariant #3 again, from the other side: no migrations applied is not
  // a state change, so it must produce no event. A boot that emitted
  // `app.migrated` unconditionally would turn "exactly one event per state
  // change" into "an event whenever we looked" — the same distinction
  // §5.2's `pack_validated` row already draws for pack validation.
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'bureau-lifecycle-2nd-'));

  const first = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  await (await first.firstWindow()).waitForLoadState('domcontentloaded');
  await first.close();

  const afterFirst = readActivityLog(userDataDir).filter((e) => e.type === 'app.migrated').length;
  expect(afterFirst, 'the first boot migrated').toBe(1);

  const second = await electron.launch({
    executablePath: resolvePackagedExePath(),
    args: [`--user-data-dir=${userDataDir}`],
    env: packagedAppEnv(),
  });
  try {
    await (await second.firstWindow()).waitForLoadState('domcontentloaded');
    const afterSecond = readActivityLog(userDataDir).filter(
      (e) => e.type === 'app.migrated',
    ).length;
    expect(afterSecond, 'the second boot applied nothing, so emitted nothing').toBe(1);

    // But it did start, and that IS a state change every time.
    const starts = readActivityLog(userDataDir).filter((e) => e.type === 'app.started').length;
    expect(starts, 'every boot emits app.started').toBe(2);
  } finally {
    await second.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
