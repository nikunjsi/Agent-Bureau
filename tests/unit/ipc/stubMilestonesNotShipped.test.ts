import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AUDIT M0–M2 #25 — a stub must not name a milestone that has shipped.
 *
 * `stub('M3')` becomes `ipcNotImplemented('M3')`, whose message a user can
 * read: *"This isn't built yet — it belongs to M3, not the current
 * milestone."* Six handlers said exactly that about M3 and M5 long after
 * both closed, so the app told a user a feature was coming in a milestone
 * already behind them. Each stub was right when written; nothing noticed
 * the milestone passing.
 *
 * "Complete" is read from `PROJECT-CHECKLIST.md` §2's milestone table — a
 * row whose status cell begins with ✅ — because that table is where this
 * project records a milestone as closed, and a second list here would be
 * a second definition of "done" free to disagree with the first.
 */

const HANDLERS = path.resolve('src/main/ipc/handlers');
const CHECKLIST = path.resolve('PROJECT-CHECKLIST.md');

function handlerFiles(): string[] {
  return fs
    .readdirSync(HANDLERS)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(HANDLERS, f));
}

/** Every `stub('Mn')` and `ipcNotImplemented('Mn')` in the handler files,
 * skipping comment lines (one handler's comment quotes an old tag). */
function stubTags(): Array<{ where: string; milestone: string }> {
  return handlerFiles().flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !/^\s*(\/\/|\*)/.test(line))
      .flatMap(({ line, n }) =>
        [...line.matchAll(/\b(?:stub|ipcNotImplemented)\('(M\d+)'\)/g)].map((m) => ({
          where: `${path.basename(file)}:${n}`,
          milestone: m[1]!,
        })),
      ),
  );
}

function completedMilestones(): Set<string> {
  const done = new Set<string>();
  for (const line of fs.readFileSync(CHECKLIST, 'utf8').split('\n')) {
    const cells = line.split('|');
    const id = /^\s*(M\d+)\s+—/.exec(cells[1] ?? '');
    if (id && (cells[3] ?? '').trim().startsWith('✅')) done.add(id[1]!);
  }
  return done;
}

describe('AUDIT #25: no stub promises a feature in a milestone that has shipped', () => {
  it('the scans find something — stubs, and at least one completed milestone', () => {
    // Standing rule 9 in test form: two empty scans agree trivially.
    expect(stubTags().length).toBeGreaterThan(10);
    expect(completedMilestones().size).toBeGreaterThan(0);
  });

  it('every stub names a milestone that is not recorded as complete', () => {
    const done = completedMilestones();
    const stale = stubTags()
      .filter(({ milestone }) => done.has(milestone))
      .map(({ where, milestone }) => `${where} → ${milestone}`);
    expect(
      stale,
      'these stubs tell a user a feature belongs to a milestone PROJECT-CHECKLIST.md records as done — ' +
        're-tag each to the milestone that will actually build it',
    ).toEqual([]);
  });
});
