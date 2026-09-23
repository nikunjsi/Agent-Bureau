import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * M11 S1-21, standing rule 6 in test form: **one decision, one place.**
 *
 * Bureau spawns Windows PowerShell from two unrelated places — the
 * control.json ACL read (`tokens.ts`) and the PID-reuse guard
 * (`processInfo.ts`). Both had the same defect and neither knew about the
 * other: the child inherits the parent's `PSModulePath`, and from a
 * PowerShell 7 parent (every GitHub Actions step) that path shadows the
 * built-in module the cmdlet lives in, so the command cannot load. One of
 * the two also spawned a bare `powershell.exe` off PATH.
 *
 * Fixing both is not the same as fixing the defect. A third caller written
 * next month would have it again. So there is exactly one module that
 * knows how to spawn PowerShell, and this test is what keeps it that way:
 * any other file in `src/` naming `powershell` fails here, with the reason
 * in the message rather than in a commit log nobody will find.
 */
const HELPER = 'src/main/process/windowsPowerShell.ts';

/** Anything that names the executable, or `powershell` as a bare command. */
const POWERSHELL_MENTION = /powershell\.exe|['"`]powershell['"`]|\bpwsh\b/i;

/**
 * Comments are prose, and prose about the defect belongs next to the code
 * that had it. `processInfo.ts` says in so many words that it must never
 * spawn a bare `powershell.exe` — a rule stated in a comment is not a rule
 * broken in code. Same shape as `securitySuiteCoverage.test.ts`'s stripper,
 * and the same accepted cost: a trailing `//` comment is not stripped,
 * which only ever hides a mention, never invents one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (full.endsWith('.ts')) out.push(full.split(path.sep).join('/'));
  }
  return out;
}

// The row ID stays out of the title: securitySuiteCoverage reads a bare
// `S1` in code as a claim to cover security test S1 (the §F practice
// M11 S1-12b recorded). It belongs in the comment above.
describe('every PowerShell spawn in src/ goes through one helper (standing rule 6)', () => {
  const files = walk('src');

  it('the scan sees the helper itself — it is not silently matching nothing', () => {
    // Standing rule 9. A regex that stopped matching would make the rule
    // below pass while checking nothing, which is the exact failure mode
    // this file exists to prevent.
    expect(files, 'the walk found source files at all').not.toHaveLength(0);
    const helper = stripComments(readFileSync(HELPER, 'utf8'));
    expect(POWERSHELL_MENTION.test(helper), `${HELPER} must name powershell.exe`).toBe(true);
  });

  it('no other module names powershell — they call the helper', () => {
    const offenders = files.filter(
      (f) => f !== HELPER && POWERSHELL_MENTION.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `These files name PowerShell directly instead of calling ${HELPER}:\n` +
            offenders.map((f) => `  ${f}`).join('\n') +
            `\n\nA direct spawn inherits the parent's PSModulePath. From a PowerShell 7 parent ` +
            `(every GitHub Actions step, and VS Code with pwsh as its shell) that shadows the ` +
            `built-in module the cmdlet lives in, and the command cannot load — silently, in ` +
            `processInfo.ts's case. Use runWindowsPowerShell / runWindowsPowerShellSync.`,
    ).toEqual([]);
  });

  it('the two known callers really do import the helper', () => {
    // The reverse direction: the rule above is also satisfied by a file
    // that stopped spawning PowerShell at all, so name the callers.
    for (const caller of ['src/main/controlChannel/tokens.ts', 'src/main/process/processInfo.ts']) {
      expect(readFileSync(caller, 'utf8'), `${caller} must call the helper`).toMatch(
        /from '.*windowsPowerShell'/,
      );
    }
  });

  it('the helper sets PSModulePath explicitly rather than inheriting it', () => {
    // Named, not left to the integration tests: this single line is the
    // whole fix, and a refactor that dropped it would leave every other
    // test in this file green.
    const helper = readFileSync(HELPER, 'utf8');
    expect(helper).toMatch(/PSModulePath:/);
  });
});
