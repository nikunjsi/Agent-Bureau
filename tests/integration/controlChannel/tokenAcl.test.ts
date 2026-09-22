import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import path from 'node:path';
import {
  writeControlJsonWithAcl,
  readControlJsonAcl,
  TokenRegistry,
} from '../../../src/main/controlChannel/tokens';
import { ControlJsonSchema } from '../../../src/shared/controlChannel/schemas';
import { newId } from '../../../src/shared/models/ids';

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
    // `raw` is the SDDL the check compared: no Everyone (WD), Users (BU)
    // or Administrators (BA) trustee, by alias or by SID.
    expect(verification.raw).not.toMatch(/;(WD|BU|BA|S-1-1-0|S-1-5-32-545|S-1-5-32-544)\)/);
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
    // Presence first: the entry really is there, and really is explicit.
    expect(before.raw).toMatch(/\(A;[^)]*;BA\)/);

    await writeControlJsonWithAcl(stateDir, {
      port: 2,
      token: 'c'.repeat(64),
      employeeId: newId(),
    });

    const after = await readControlJsonAcl(filePath);
    expect(after.ok, after.raw).toBe(true);
    expect(after.raw).not.toMatch(/;(BA|S-1-5-32-544)\)/);
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
 * a machine through the injected `icacls`, answering both the display
 * listing and `/save` (SDDL, which is the same in every language), so they
 * pass or fail on what the check compares, not on this machine's language.
 */
describe('readControlJsonAcl compares SIDs, not display names', () => {
  const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A German machine: localised display listing, and SDDL for `/save`. */
  function germanMachine(listing: string, sddl: string) {
    return async (args: string[]) => {
      const saveAt = args.indexOf('/save');
      if (saveAt !== -1) {
        const out = args[saveAt + 1] as string;
        writeFileSync(out, Buffer.from(`control.json\r\n${sddl}\r\n`, 'utf16le'));
        return { stdout: '1 Dateien erfolgreich verarbeitet' };
      }
      return { stdout: listing };
    };
  }

  const username = userInfo().username;

  it('refuses Everyone granted on a German machine (Jeder), which a name match lets through', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const runIcacls = germanMachine(
      `${filePath} Jeder:(R)\n   NT-AUTORITÄT\\SYSTEM:(F)\n   DESKTOP\\${username}:(R,W)\n`,
      `D:PAI(A;;FR;;;WD)(A;;FA;;;SY)(A;;0x12019f;;;${USER_SID})`,
    );

    const verification = await readControlJsonAcl(filePath, {
      runIcacls,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(false);
    expect(verification.reason).toMatch(/S-1-1-0/);
  });

  it('refuses Administrators on a German machine (VORDEFINIERT\\Administratoren)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const runIcacls = germanMachine(
      `${filePath} VORDEFINIERT\\Administratoren:(F)\n   DESKTOP\\${username}:(R,W)\n`,
      `D:PAI(A;;FA;;;BA)(A;;0x12019f;;;${USER_SID})`,
    );

    const verification = await readControlJsonAcl(filePath, {
      runIcacls,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(false);
    expect(verification.reason).toMatch(/S-1-5-32-544/);
  });

  it('accepts exactly SYSTEM plus the current user, whatever the display language', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const runIcacls = germanMachine(
      `${filePath} NT-AUTORITÄT\\SYSTEM:(F)\n   DESKTOP\\${username}:(R,W)\n`,
      `D:PAI(A;;FA;;;SY)(A;;0x12019f;;;${USER_SID})`,
    );

    const verification = await readControlJsonAcl(filePath, {
      runIcacls,
      currentUserSid: async () => USER_SID,
    });

    expect(verification.ok, verification.raw).toBe(true);
  });

  it("refuses an ACL that lacks the current user's SID, even when a same-named account appears", async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'bureau-acl-sid-'));
    const filePath = path.join(dir, 'control.json');
    writeFileSync(filePath, '{}', 'utf8');
    const runIcacls = germanMachine(
      `${filePath} NT-AUTORITÄT\\SYSTEM:(F)\n   OTHERDOMAIN\\${username}:(R,W)\n`,
      `D:PAI(A;;FA;;;SY)(A;;0x12019f;;;S-1-5-21-9-9-9-5000)`,
    );

    const verification = await readControlJsonAcl(filePath, {
      runIcacls,
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
