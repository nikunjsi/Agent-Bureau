import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ClaudeCodeAdapter } from '../../../src/main/engine/claudeCodeAdapter';
import {
  DIRECTOR_TOOL_HANDLERS,
  EMPLOYEE_TOOL_HANDLERS,
} from '../../../src/main/controlChannel/toolHandlers';
import { adapterTestContext } from '../../helpers/adapterContext';
import type { EmployeeContext } from '../../../src/shared/engine/types';

/**
 * What the model is offered (M11 row S1-12a).
 *
 * §8.0 gives the Director `Read(${project}/**)`, `Grep`, `Glob` and its own
 * tools — and **no `Write`, no `Edit`, no `Bash`: "the Director directs; it
 * does not build"**. The offer is not the gate (the hook is), but offering
 * an employee's tools to the Director would invite calls that the control
 * channel then has to refuse.
 */
describe('the Director is offered its own tools, and no way to build', () => {
  /** The hook path is injected for the reason AUDIT #7 named: the real
   * resolver reads Electron's app, which plain-Node vitest has none of. */
  const adapterForTests = () =>
    new ClaudeCodeAdapter({
      resolveBureauHookScriptPath: () => path.resolve('dist/resources/bin/bureau-hook.js'),
    });

  function directorContext(): EmployeeContext {
    const ctx = adapterTestContext('claude-code', { mode: 'structured' });
    return { ...ctx, employee: { ...ctx.employee, is_director: true } };
  }

  it("names the Director's tools, and none of an employee's", async () => {
    const adapter = adapterForTests();

    const spec = await adapter.buildLaunchSpec(directorContext());
    const allowed = spec.args[spec.args.indexOf('--allowed-tools') + 1] ?? '';
    const allowedList = spec.args.slice(spec.args.indexOf('--allowed-tools') + 1);

    for (const name of Object.keys(DIRECTOR_TOOL_HANDLERS)) {
      expect(allowedList).toContain(`mcp__bureau__${name}`);
    }
    expect(allowedList).toContain('Read');
    expect(allowedList).toContain('Grep');
    expect(allowedList).toContain('Glob');
    // The employee-only tools, by name: a Director has no task to finish
    // and no status bubble on the floor.
    expect(allowedList).not.toContain('mcp__bureau__bureau_task_done');
    expect(allowedList).not.toContain('mcp__bureau__bureau_report_status');
    expect(allowedList).not.toContain('mcp__bureau__bureau_propose_memory');
    // §8.0's "no Write, no Edit, no Bash".
    expect(allowed).not.toMatch(/^(Write|Edit|Bash)$/);
    expect(allowedList).not.toContain('Write');
    expect(allowedList).not.toContain('Edit');
    expect(allowedList).not.toContain('Bash');
  });

  it('still offers an employee its own tools, unchanged', async () => {
    const adapter = adapterForTests();

    const spec = await adapter.buildLaunchSpec(
      adapterTestContext('claude-code', {
        mode: 'structured',
      }),
    );
    const allowedList = spec.args.slice(spec.args.indexOf('--allowed-tools') + 1);

    for (const name of Object.keys(EMPLOYEE_TOOL_HANDLERS)) {
      expect(allowedList).toContain(`mcp__bureau__${name}`);
    }
    expect(allowedList).not.toContain('mcp__bureau__bureau_report');
  });

  it('advertises exactly the Director tools the Core implements', () => {
    // bureau-tools runs as a child of the engine CLI, so it cannot be
    // imported here without starting a server. Its list is read as source:
    // a tool advertised but not implemented is one the model will call and
    // be refused for.
    const source = readFileSync(path.resolve('resources/bin/bureau-tools.ts'), 'utf8');
    const block = /const DIRECTOR_TOOL_DEFINITIONS[\s\S]*?\n\];/.exec(source)?.[0] ?? '';
    const advertised = [...block.matchAll(/name: '([^']+)'/g)].map((match) => match[1]).sort();

    expect(advertised).toEqual(Object.keys(DIRECTOR_TOOL_HANDLERS).sort());
  });
});
