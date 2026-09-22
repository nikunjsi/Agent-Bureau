import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import { adapterTestContext } from '../../helpers/adapterContext';
import type { LaunchSpec } from '../../../src/shared/engine/types';

/**
 * The flag that makes the Director's conversation survive a restart
 * (M11 row S1-11). `--resume <id>` sits inside a spawn, so the argv is
 * built by its own method and asserted here without launching anything.
 */
describe('a structured turn resumes the engine session it was given', () => {
  const spec: LaunchSpec = {
    command: 'claude',
    args: ['--settings', 'x.json'],
    cwd: 'C:/work',
    env: {},
    configFiles: [],
  };

  it('carries no --resume before any session is known', async () => {
    const adapter = new ClaudeCodeAdapter();

    const args = adapter.buildTurnArgs('hello', spec);

    expect(args).not.toContain('--resume');
    expect(args.slice(0, 2)).toEqual(['-p', 'hello']);
    // Whatever buildLaunchSpec computed is still passed through.
    expect(args).toContain('--settings');
  });

  it('carries --resume with the session id once resume() has been told one', async () => {
    const adapter = new ClaudeCodeAdapter();
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });

    expect(await adapter.resume('sess-alpha', ctx)).toBe(true);
    const args = adapter.buildTurnArgs('hello', spec);

    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-alpha');
  });
});
