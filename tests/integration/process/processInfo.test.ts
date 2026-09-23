import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { getProcessStartTime } from '../../../src/main/process/processInfo';
import { shadowPowerShellModules } from '../../helpers/shadowedPowerShellModules';

/**
 * §4.4's PID-reuse guard reads a process's start time through PowerShell,
 * and M11 S1-21 found two things wrong with how.
 *
 * **One:** the spawn was a bare `powershell.exe` off PATH, inheriting the
 * parent's `PSModulePath`. From a PowerShell 7 parent — every GitHub
 * Actions step, and any VS Code terminal running `pwsh` —
 * `Microsoft.PowerShell.Management` resolves to a Core-only copy and
 * `Get-Process` cannot load.
 *
 * **Two, and worse:** that failure was caught and returned as `null`,
 * which the function's own contract defined as "the process doesn't exist
 * (already dead)". So a **live** orphan read as dead. `sweepOrphans` left
 * it running, emitted no `employee.orphan_killed`, revoked no secret, and
 * said nothing at all. A defence that silently stops defending.
 *
 * These cases drive the real function against a real PowerShell.
 */
describe('getProcessStartTime (§4.4, the PSModulePath row)', () => {
  let child: ChildProcess | undefined;
  let shadowed: ReturnType<typeof shadowPowerShellModules>;

  beforeEach(() => {
    shadowed = shadowPowerShellModules();
  });

  afterEach(() => {
    child?.kill();
    child = undefined;
    shadowed.cleanup();
  });

  async function spawnLiveProcess(): Promise<number> {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });
    const pid = child.pid;
    expect(pid).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200)); // let it fully start
    return pid as number;
  }

  it('reads a live process as alive, from a parent whose PSModulePath shadows Get-Process', async () => {
    // The row's failing test: before the fix this returns "not found" —
    // the live process reads as dead — because Get-Process never ran.
    const pid = await spawnLiveProcess();

    const read = getProcessStartTime(pid, shadowed.env);

    expect(read.kind, read.kind === 'unreadable' ? read.reason : '').toBe('alive');
    expect(read.kind === 'alive' && read.startedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('the shadowing is real: the same manifests do break Get-Process when the path is inherited', async () => {
    // Standing rule 9. The case above only means something if the poisoned
    // environment genuinely breaks an unprotected read — otherwise it is
    // asserting that a normal call works, which every other test does too.
    const { execFileSync } = await import('node:child_process');
    const pid = await spawnLiveProcess();
    const powershell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

    let stderr = '';
    let stdout = '';
    try {
      stdout = execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime }`,
        ],
        { encoding: 'utf8', env: shadowed.env, windowsHide: true },
      );
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '');
    }

    // Collapsed: PowerShell hard-wraps stderr at the console width.
    expect(`${stderr}${stdout}`.replace(/\s+/g, ' ')).toContain('could not be loaded');
    expect(stdout.trim()).toBe('');
  });

  it('a process that is genuinely not there is not_found, not unreadable', async () => {
    // The distinction has to cut both ways, or "unreadable" would just be
    // a rename of the old conflation.
    const pid = await spawnLiveProcess();
    child?.kill();
    child = undefined;
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(getProcessStartTime(pid).kind).toBe('not_found');
  });

  it('a read that could not be made is unreadable, and says why — never not_found', async () => {
    const pid = await spawnLiveProcess();

    // A SystemRoot that holds no PowerShell: the spawn itself fails. The
    // process is demonstrably alive, so any answer but `unreadable` is the
    // conflation this row exists to remove.
    const read = getProcessStartTime(pid, { ...shadowed.env, SystemRoot: 'Z:\\no-such-windows' });

    expect(read.kind, 'a live process must never read as not_found when the read failed').toBe(
      'unreadable',
    );
    expect(read.kind === 'unreadable' && read.reason.length).toBeGreaterThan(0);
  });
});
