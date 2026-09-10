import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AUDIT M0–M2 #16 — the part that stops the finding coming back.
 *
 * `IpcErrorAction` was a correct, fully-modelled, thoroughly-commented
 * five-variant union for **nine milestones**, and it rendered nowhere. The
 * comment beside it even anticipated the failure ("a bare string would
 * leave `action` vestigial") and then it was vestigial anyway — six
 * handlers set it, seventeen renderer call sites dropped it on the floor,
 * and every one of those call sites individually looked fine.
 *
 * That is the shape standing rule 2 is about: a mechanism can be correct
 * and have nothing reach it, and no test of the mechanism can see that.
 * Fixing the seventeen sites fixes today. What fixes tomorrow is that the
 * eighteenth cannot quietly go back to `{error.message}` — so this scans
 * for it.
 *
 * The rule is deliberately blunt and easy to obey: **only `ErrorNotice`
 * reads `.message` off an error.** Everything else hands the whole error
 * to `<ErrorNotice>`, which is where §14.6's "concrete next action" lives.
 */

const RENDERER = path.resolve('src/renderer/src');
const NOTICE = path.join(RENDERER, 'components', 'ErrorNotice.tsx');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** `result.error.message`, `error.message`, `err.error.message` — any read
 * of `.message` from something called `error`. */
const READS_MESSAGE = /\berror\.message\b/;

describe('§14.6: every error path renders through ErrorNotice (AUDIT #16)', () => {
  const files = sourceFiles(RENDERER);

  it('the scan finds the renderer at all', () => {
    // Standing rule 9 in test form: a path that silently stopped matching
    // would make every assertion below pass over an empty list.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('ErrorNotice.tsx'))).toBe(true);
  });

  it('no component reads .message off an error itself', () => {
    const offenders = files
      .filter((file) => path.resolve(file) !== NOTICE)
      .flatMap((file) => {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        return lines
          .map((line, i) => ({ line, n: i + 1 }))
          .filter(({ line }) => READS_MESSAGE.test(line) && !line.trimStart().startsWith('//'))
          .map(({ line, n }) => `${path.relative(RENDERER, file)}:${n}  ${line.trim()}`);
      });

    expect(
      offenders,
      'these render an error message directly, so §14.6s "concrete next action" is dropped — ' +
        'store the whole error and hand it to <ErrorNotice> instead',
    ).toEqual([]);
  });

  it('ErrorNotice itself does read it — otherwise the rule above is vacuous', () => {
    // If the one permitted reader stopped reading, the scan above would go
    // on passing while nothing rendered a message at all.
    expect(READS_MESSAGE.test(fs.readFileSync(NOTICE, 'utf8'))).toBe(true);
  });

  it('ErrorNotice handles every variant of the action union', () => {
    // A new variant added to `IpcErrorAction` with no branch here would
    // render no button, silently — which is the original bug, one variant
    // at a time. The switch is exhaustive by construction in TypeScript;
    // this asserts each literal is actually mentioned, so a variant added
    // to the union and forgotten here is visible.
    const envelope = fs.readFileSync(path.resolve('src/shared/ipc/envelope.ts'), 'utf8');
    const variants = [...envelope.matchAll(/z\.literal\('([a-z_]+)'\)/g)].map((m) => m[1]!);
    expect(variants.length, 'the action union scan found no variants').toBeGreaterThanOrEqual(5);

    const notice = fs.readFileSync(NOTICE, 'utf8');
    const unhandled = variants.filter((v) => !notice.includes(`case '${v}'`));
    expect(
      unhandled,
      'these IpcErrorAction variants have no branch in ErrorNotice and would render no button',
    ).toEqual([]);
  });

  it('the renderer does not branch on an error code — that is the Core’s vocabulary, not a UI one', () => {
    // §14.6's contract is message + action. A renderer switching on
    // `error.code` would be re-deciding what the Core already decided when
    // it chose those two, and would couple the UI to a closed enum it does
    // not own — the boundary M9 removed two fields to protect.
    const offenders = files.flatMap((file) => {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      return lines
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\berror\.code\b/.test(line) && !line.trimStart().startsWith('//'))
        .map(({ n }) => `${path.relative(RENDERER, file)}:${n}`);
    });
    expect(offenders).toEqual([]);
  });
});
