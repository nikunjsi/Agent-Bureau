import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { DIRECTOR_CONTEXT_FILE } from '../../../src/shared/engine/directorContextFile';
import { adapterTestContext } from '../../helpers/adapterContext';
import type { EmployeeContext } from '../../../src/shared/engine/types';

/**
 * How the Director's assembled context (§8.0.1) reaches the CLI: the file
 * the trigger queue writes before each turn, as an appended system prompt,
 * with the CLI's system-prompt snapshot off. Measured on 2.1.276 (free, no
 * key): the CLI accepts both flags. Its --help says a snapshot, on by
 * default, resends the FIRST turn's system prompt on every resume "even when
 * a later launch passes different text" — which would freeze a resumed
 * Director's picture of the project at its first turn.
 */
describe("the Director's context file reaches the CLI, fresh every turn", () => {
  const adapter = () =>
    new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: () => path.resolve('dist/resources/bin/bureau-hook.js'),
    });

  function context(isDirector: boolean): EmployeeContext {
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    return { ...ctx, employee: { ...ctx.employee, is_director: isDirector } };
  }

  it('the Director with a context file: appended from the file, snapshot off', async () => {
    const ctx = context(true);
    const file = path.join(ctx.stateDir, DIRECTOR_CONTEXT_FILE);
    writeFileSync(file, 'context', 'utf8');
    const { args } = await adapter().buildLaunchSpec(ctx);
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe(file);
    expect(args[args.indexOf('--system-prompt-snapshot') + 1]).toBe('off');
  });

  it('no file yet (before the first turn): neither flag, so the CLI is never pointed at nothing', async () => {
    const { args } = await adapter().buildLaunchSpec(context(true));
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).not.toContain('--system-prompt-snapshot');
  });

  it('an employee never gets the Director’s context, even if the file is there', async () => {
    const ctx = context(false);
    writeFileSync(path.join(ctx.stateDir, DIRECTOR_CONTEXT_FILE), 'context', 'utf8');
    const { args } = await adapter().buildLaunchSpec(ctx);
    expect(args).not.toContain('--append-system-prompt-file');
  });
});
