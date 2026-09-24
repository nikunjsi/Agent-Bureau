import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeControlJsonWithAcl,
  readControlJsonAcl,
  TokenRegistry,
} from '../../../src/main/controlChannel/tokens';
import { ControlJsonSchema } from '../../../src/shared/controlChannel/schemas';
import { newId } from '../../../src/shared/models/ids';
import { shadowPowerShellModules } from '../../helpers/shadowedPowerShellModules';

const execFileAsync = promisify(execFile);

/**
 * §7.10's "owner-only ACL" — THE WINDOWS ACL TRAP. fs.chmod is a
 * documented no-op on NTFS; this proves the real mechanism (icacls) for
 * real, on this OS, not against a mock. Every assertion reads the ACL
 * back afterward — never trusts a call's own exit code, per the explicit
 * instruction.
 */
describe('writeControlJsonWithAcl / readControlJsonAcl (§7.10, THE WINDOWS ACL TRAP)', () => {
  let stateDir: string;

  afterEach(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it('writes control.json with an ACL that verifies restrictive, for real', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-'));
    const contents = { port: 12345, token: 'a'.repeat(64), employeeId: newId() };

    const filePath = await writeControlJsonWithAcl(stateDir, contents);

    expect(existsSync(filePath)).toBe(true);
    expect(path.basename(filePath)).toBe('control.json');

    const onDisk = ControlJsonSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')));
    // isDirector is defaulted by the schema (M11 row S1-12a): bureau-tools
    // learns whose tools to serve from this file.
    expect(onDisk).toEqual({ ...contents, isDirector: false });

    // The whole point: read the ACL back and assert, don't assume the
    // icacls call worked just because it didn't throw.
    const verification = await readControlJsonAcl(filePath);
    expect(verification.ok, verification.raw).toBe(true);
    // `raw` is the listing the check compared: no Everyone, Users or
    // Administrators trustee.
    expect(verification.raw).not.toMatch(/ (S-1-1-0|S-1-5-32-545|S-1-5-32-544)$/m);
  });

  it('readControlJsonAcl genuinely detects a broadened ACL, not just a happy-path shape', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-broaden-'));
    const filePath = await writeControlJsonWithAcl(stateDir, {
      port: 1,
      token: 'b'.repeat(64),
      employeeId: newId(),
    });

    // Confirmed restrictive first.
    expect((await readControlJsonAcl(filePath)).ok).toBe(true);

    // Now deliberately widen it, the way a bug (or a hostile process) could
    // — and confirm the detector actually catches this, for real, rather
    // than trusting `ok: true` because the shape of the test happens to
    // match the happy path.
    await execFileAsync('icacls', [filePath, '/grant:r', 'Everyone:(R)']);
    const verification = await readControlJsonAcl(filePath);
    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/Everyone/);
  });

  it('an EXPLICIT Administrators ACE already on the file is removed, not left for verification to trip over (what the elevated CI runner gives a new file)', async () => {
    // CI run 35724599688: on the hosted runner (elevated), every write
    // failed verification with "forbidden principal BUILTIN\Administrators".
    // Run 35728894428 showed why: a new file there carries an EXPLICIT
    // BUILTIN\Administrators:(F) entry, and `/inheritance:r` removes only
    // inherited ones. A user running Bureau as administrator would have had
    // no control channel at all. Reproduced here without elevation: as the
    // file's owner we may add the explicit entry ourselves, before Bureau
    // writes over the same file.
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-explicit-admin-'));
    const filePath = path.join(stateDir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    await execFileAsync('icacls', [filePath, '/grant', '*S-1-5-32-544:(F)']);
    const before = await readControlJsonAcl(filePath);
    // Presence first: the entry really is there.
    expect(before.raw).toMatch(/^Allow S-1-5-32-544$/m);

    await writeControlJsonWithAcl(stateDir, {
      port: 2,
      token: 'c'.repeat(64),
      employeeId: newId(),
    });

    const after = await readControlJsonAcl(filePath);
    expect(after.ok, after.raw).toBe(true);
    expect(after.raw).not.toMatch(/S-1-5-32-544/);
  });

  // M11 S1-2: this was `expect(true).toBe(true)`, with a comment saying the
  // branch was "covered by code inspection". The real icacls still sets the
  // ACL here; only the read-back is made to fail, through the same injected
  // dependencies S1-1 added, so the branch under test is the real one.
  it('fails closed: deletes the file and throws when the ACL does not verify', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-failclosed-'));
    const filePath = path.join(stateDir, 'control.json');

    await expect(
      writeControlJsonWithAcl(
        stateDir,
        { port: 4, token: 'e'.repeat(64), employeeId: newId() },
        // A user SID the real ACL cannot contain, so verification fails.
        { currentUserSid: async () => 'S-1-5-21-9-9-9-9999' },
      ),
    ).rejects.toThrow(/ACL verification failed/);

    expect(existsSync(filePath)).toBe(false);
  });

  it('fails closed: deletes the file when verification itself errors, not only when it says no', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-failclosed-err-'));
    const filePath = path.join(stateDir, 'control.json');

    await expect(
      writeControlJsonWithAcl(
        stateDir,
        { port: 5, token: 'f'.repeat(64), employeeId: newId() },
        {
          currentUserSid: async () => {
            throw new Error('whoami failed');
          },
        },
      ),
    ).rejects.toThrow(/whoami failed/);

    expect(existsSync(filePath)).toBe(false);
  });
});

/**
 * M11 S1-1 (Known Issues 2026-09-22): `icacls` prints principals by their
 * DISPLAY name, and display names are localised — on a German Windows,
 * Everyone is `Jeder` and BUILTIN\Administrators is
 * `VORDEFINIERT\Administratoren`. A check that matches English names lets a
 * broadened ACL verify as restrictive there. These cases stand in for such
 * a machine through the injected reader, whose listing names every trustee
 * by raw SID (the same in every language), so they pass or fail on what the
 * check compares, not on this machine's language.
 */
describe('readControlJsonAcl compares SIDs, not display names', () => {
  const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A German machine, as the check now reads one: every trustee as a raw
   * SID, which is the same in every display language. The localised listing
   * that used to be injected alongside it was never read, and a fixture
   * nobody reads is a fixture that can disagree with reality without
   * anything failing.
   */
  function germanMachine(listing: string) {
    return async () => listing;
  }

  it('refuses Everyone granted on a German machine (Jeder), which a name match lets through', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const readSecurityDescriptor = germanMachine(
      ['Allow S-1-1-0', 'Allow S-1-5-18', `Allow ${USER_SID}`].join('\n'),
    );

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(false);
    expect(verification.reason).toMatch(/S-1-1-0/);
  });

  it('refuses Administrators on a German machine (VORDEFINIERT\\Administratoren)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const readSecurityDescriptor = germanMachine(
      ['Allow S-1-5-32-544', `Allow ${USER_SID}`].join('\n'),
    );

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(false);
    expect(verification.reason).toMatch(/S-1-5-32-544/);
  });

  it('accepts exactly SYSTEM plus the current user, whatever the display language', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const readSecurityDescriptor = germanMachine(
      ['Allow S-1-5-18', `Allow ${USER_SID}`].join('\n'),
    );

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(true);
  });

  it("refuses an ACL that lacks the current user's SID, even when a same-named account appears", async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const readSecurityDescriptor = germanMachine(
      ['Allow S-1-5-18', 'Allow S-1-5-21-9-9-9-5000'].join('\n'),
    );

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(false);
    expect(verification.reason).toMatch(/current user/);
  });

  it('refuses a real file granted Everyone BY SID (*S-1-1-0), through the real icacls', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-real-'));
    const filePath = await writeControlJsonWithAcl(dir, {
      port: 3,
      token: 'd'.repeat(64),
      employeeId: newId(),
    });
    expect((await readControlJsonAcl(filePath)).ok).toBe(true);

    await execFileAsync('icacls', [filePath, '/grant', '*S-1-1-0:(R)']);
    const verification = await readControlJsonAcl(filePath);

    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/S-1-1-0/);
  });
});

/**
 * The CI runner refused every control.json with one unhelpful sentence —
 * "the ACL could not be read as SIDs" — and threw away the descriptor that
 * would have said why. Two different failures shared that sentence, the
 * evidence was dropped on the way out, and the dev box cannot reproduce
 * either (Windows 10 unelevated vs Server 2022 elevated).
 *
 * So: the descriptor is read from the file itself rather than saved to a
 * temp file first, each parse failure says which one it was, and the
 * evidence travels with the refusal and with the throw. None of this makes
 * the check more permissive — every case below is still a refusal.
 */
describe('a refused ACL says why, and carries the descriptor it refused', () => {
  const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function tightenedFile(): string {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-evidence-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    return filePath;
  }

  it('reads the descriptor of the file itself — the injected reader is what decides', async () => {
    const filePath = tightenedFile();

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor: async () => 'Deny S-1-1-0',
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/S-1-1-0/);
  });

  it('a line that is not `Allow|Deny <SID>` is refused, and the reason quotes what was read', async () => {
    const filePath = tightenedFile();

    // SDDL is the shape this used to read — and an alias in it is exactly
    // what a raw-SID reader must never let through as "some trustee".
    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor: async () => ['Allow S-1-5-18', 'Allow LA'].join('\n'),
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/does not recognise: Allow LA /);
    // What was read itself, not a sentence about it: that distinction is
    // the whole point of the row — the CI log has to carry the evidence,
    // and only the runner can produce it.
    expect(verification.reason, 'the evidence must travel with the refusal').toContain(
      'Allow S-1-5-18 Allow LA',
    );
  });

  it('an empty read says so rather than quoting nothing', async () => {
    const filePath = tightenedFile();

    const verification = await readControlJsonAcl(filePath, {
      readSecurityDescriptor: async () => '',
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok).toBe(false);
    expect(verification.reason).toMatch(/no entries/i);
    expect(verification.reason).toContain('(empty)');
  });

  it('the throw from a failed write carries the descriptor, not just the verdict', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-throw-'));

    await expect(
      writeControlJsonWithAcl(
        dir,
        { port: 7, token: 'e'.repeat(64), employeeId: newId() },
        {
          readSecurityDescriptor: async () => 'Deny S-1-1-0',
          currentUserSid: async () => USER_SID,
        },
      ),
    ).rejects.toThrow('Deny S-1-1-0');

    // Still deleted: evidence in the message never makes the file safe.
    expect(existsSync(path.join(dir, 'control.json'))).toBe(false);
  });
});

describe('TokenRegistry (§7.10 — in-memory, revoked with the process that minted it)', () => {
  it('mint produces a verifiable token mapped to the right employee', () => {
    const registry = new TokenRegistry();
    const token = registry.mint('emp1');
    expect(registry.verify(token)).toBe('emp1');
  });

  it('verify rejects an unknown token', () => {
    const registry = new TokenRegistry();
    expect(registry.verify('not-a-real-token')).toBeNull();
  });

  it('revoke invalidates the token immediately', () => {
    const registry = new TokenRegistry();
    const token = registry.mint('emp1');
    registry.revoke('emp1');
    expect(registry.verify(token)).toBeNull();
  });

  it('minting twice for the same employee invalidates the first token — never two live tokens for one employee', () => {
    const registry = new TokenRegistry();
    const first = registry.mint('emp1');
    const second = registry.mint('emp1');
    expect(registry.verify(first)).toBeNull();
    expect(registry.verify(second)).toBe('emp1');
  });

  it('listEmployeeIds reflects exactly the currently-live set', () => {
    const registry = new TokenRegistry();
    registry.mint('emp1');
    registry.mint('emp2');
    expect(registry.listEmployeeIds().sort()).toEqual(['emp1', 'emp2']);
    registry.revoke('emp1');
    expect(registry.listEmployeeIds()).toEqual(['emp2']);
  });
});

/**
 * M11 S1-21, attempt 3 — the cause, not another symptom.
 *
 * Attempts 1 and 2 were red on the CI runner and green on the dev box, and
 * the second one's improved error message finally said why: the descriptor
 * read never ran. Windows PowerShell 5.1 could not load
 * `Microsoft.PowerShell.Security`, because GitHub Actions runs every step
 * in PowerShell 7 and the child inherited its `PSModulePath`. Every
 * control.json failed to verify, was deleted (correctly — invariant #6),
 * and no employee could start.
 *
 * This is that machine, here: a Core-only `Microsoft.PowerShell.Security`
 * manifest first on the `PSModulePath` handed to the write. It needs no
 * PowerShell 7 and mutates no environment — the env is a parameter.
 */
describe('a control.json verifies from a parent whose PSModulePath shadows Get-Acl', () => {
  let stateDir: string;
  let shadowed: ReturnType<typeof shadowPowerShellModules>;

  beforeEach(() => {
    shadowed = shadowPowerShellModules();
  });

  afterEach(() => {
    shadowed.cleanup();
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it('the shadowing is real: the same read from an unfixed spawn fails to load the module', async () => {
    // Standing rule 9, at the top of the file rather than after the fact.
    // If the manifest ever stopped shadowing anything, the two cases below
    // would pass without exercising the defect at all.
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-ps7-proof-'));
    const filePath = path.join(stateDir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const v1 = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
    );

    const inherited = await execFileAsync(
      path.join(v1, 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Acl -LiteralPath '${filePath}').GetSecurityDescriptorSddlForm('Access')`,
      ],
      { env: shadowed.env },
    ).catch((err: unknown) => ({
      stdout: '',
      stderr: String((err as { stderr?: string }).stderr),
    }));

    // PowerShell hard-wraps stderr at the console width, so the sentence
    // arrives with a newline in the middle of it. Collapse before matching.
    expect(inherited.stderr.replace(/\s+/g, ' ')).toContain('could not be loaded');
    expect(inherited.stdout.trim()).toBe('');
  });

  it('writeControlJsonWithAcl still verifies — the descriptor read does not inherit the broken path', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-ps7-'));

    const filePath = await writeControlJsonWithAcl(
      stateDir,
      { port: 9, token: '9'.repeat(64), employeeId: newId() },
      { env: shadowed.env },
    );

    // The file survives, which it only does when verification said yes.
    expect(existsSync(filePath)).toBe(true);
    const verification = await readControlJsonAcl(filePath, { env: shadowed.env });
    expect(verification.ok, verification.reason).toBe(true);
    // And the ACL really was read, not defaulted: real entries.
    expect(verification.raw).toMatch(/^Allow S-1-/m);
  });

  it('readControlJsonAcl reads a descriptor rather than failing to load the module', async () => {
    stateDir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-ps7-read-'));
    const filePath = path.join(stateDir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');

    const verification = await readControlJsonAcl(filePath, { env: shadowed.env });

    // Whatever the verdict on this untightened file, the READ worked: the
    // failure S1-21 is about is an empty read and a "no entries" refusal,
    // which is a refusal for a reason that has nothing to do with the ACL.
    expect(verification.raw, 'the ACL must have been read at all').not.toBe('');
    expect(verification.reason).not.toMatch(/no entries/i);
  });
});

/**
 * M11 S1-21, attempt 4. Attempt 3 made the descriptor readable on the CI
 * runner, and what it read was a CORRECT ACL the check refused:
 * `D:PAI(A;;FA;;;SY)(A;;0x12019f;;;LA)`. The runner's account is the
 * machine's built-in Administrator (RID 500), which SDDL writes as the alias
 * `LA`, and the SDDL reader refused every alias it had no table entry for.
 *
 * That machine, here: the built-in Administrator exists on every Windows
 * box, and its SID is the current user's with the last RID replaced by 500.
 * A file granted exactly SYSTEM and that SID reads back as the runner's
 * descriptor byte for byte.
 */
describe('the ACL is read as raw SIDs — the CI runner, whose user SDDL calls LA', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function currentUserSidOfThisMachine(): Promise<string> {
    const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    const { stdout } = await execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh']);
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.trim())?.[1];
    if (!sid) throw new Error(`no SID in whoami output: ${stdout}`);
    return sid;
  }

  it("a file granted SYSTEM and the built-in Administrator verifies when that is the current user (the runner's runneradmin)", async () => {
    const builtInAdmin = (await currentUserSidOfThisMachine()).replace(/-\d+$/, '-500');
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-la-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    // Not a narrowing to the current user (that is restrictFileToCurrentUser's
    // job): this builds the runner's ACL, for an account this test is not.
    const icacls = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
    await execFileAsync(icacls, [filePath, '/reset']);
    await execFileAsync(icacls, [
      filePath,
      '/inheritance:r',
      '/grant:r',
      '*S-1-5-18:(F)',
      '/grant:r',
      `*${builtInAdmin}:(R,W)`,
    ]);

    try {
      const verification = await readControlJsonAcl(filePath, {
        currentUserSid: async () => builtInAdmin,
      });

      // Standing rule 9: the file really is the runner's, not a lookalike.
      console.log(`[LA file] reads back as: ${verification.raw.replace(/\s+/g, ' | ')}`);
      expect(verification.raw.split(/\r?\n/).sort()).toEqual(
        [`Allow ${builtInAdmin}`, 'Allow S-1-5-18'].sort(),
      );
      expect(verification.ok, verification.reason).toBe(true);
    } finally {
      // The file no longer grants this user delete; as its owner we may
      // still rewrite its ACL, so hand it back to the folder's before cleanup.
      await execFileAsync(icacls, [filePath, '/reset']);
    }
  });

  it('the reader never emits an alias: SYSTEM comes back as S-1-5-18', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-noalias-'));
    const filePath = await writeControlJsonWithAcl(dir, {
      port: 11,
      token: '1'.repeat(64),
      employeeId: newId(),
    });

    const { raw } = await readControlJsonAcl(filePath);

    expect(raw).toMatch(/^Allow S-1-5-18$/m);
    expect(raw).not.toMatch(/\bSY\b/);
  });
});
