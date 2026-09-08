import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ControlJsonSchema, type ControlJson } from '../../shared/controlChannel/schemas';

const execFileAsync = promisify(execFile);

/**
 * §7.10 — per-employee bearer tokens. In-memory, deliberately, not a DB
 * table: the whole point is that a token is bound to the process that
 * minted it and dies with it. A DB row would need explicit cleanup on
 * every possible exit path (including a crash) to get that property; an
 * in-memory Map gets it for free — a fresh process starts with an empty
 * map, so nothing minted by a *previous* life can ever verify again, even
 * if its control.json is still sitting on disk (see reconcile's stale-file
 * sweep below, which relies on exactly this). `revoke()` is still real and
 * explicit for the *clean* stop case, not left to rely on process death
 * alone — the map should not silently accumulate revoked-but-still-
 * present entries while the Core keeps running across many employee
 * lifecycles in one session.
 */
export class TokenRegistry {
  private readonly tokenToEmployee = new Map<string, string>();
  private readonly employeeToToken = new Map<string, string>();

  mint(employeeId: string): string {
    // Already-revoke any prior token for this employee — mint is meant to
    // be called once per employee per process lifetime (§7.10: "never
    // reused"), but a second call should not silently leave two live
    // tokens for the same employee.
    this.revoke(employeeId);
    const token = randomBytes(32).toString('hex'); // 256 bits, §7.10
    this.tokenToEmployee.set(token, employeeId);
    this.employeeToToken.set(employeeId, token);
    return token;
  }

  /** Returns the employeeId a live token belongs to, or null — never throws, matches the fail-closed shape every caller needs. */
  verify(token: string): string | null {
    return this.tokenToEmployee.get(token) ?? null;
  }

  revoke(employeeId: string): void {
    const existing = this.employeeToToken.get(employeeId);
    if (existing) {
      this.tokenToEmployee.delete(existing);
      this.employeeToToken.delete(employeeId);
    }
  }

  /** Test/diagnostic only — never used to make an auth decision. */
  get liveEmployeeCount(): number {
    return this.employeeToToken.size;
  }

  /** Every employeeId with a currently-live token — used on a graceful server stop to deny any hold still open for a live employee (see server.ts's `stop()`). */
  listEmployeeIds(): string[] {
    return [...this.employeeToToken.keys()];
  }
}

/**
 * §7.10's "restrictive ACL (owner-only)" — THE WINDOWS ACL TRAP: `fs.chmod`
 * is a documented no-op for this on Windows (POSIX mode bits do not exist
 * on NTFS). Verified empirically before writing this function (not
 * assumed from docs): `icacls` — a real, always-present Windows tool, no
 * new dependency — genuinely restricts a file to exactly the current user
 * plus SYSTEM, confirmed by reading the ACL back afterward and checking
 * neither `Everyone` nor `BUILTIN\Users` nor `BUILTIN\Administrators`
 * appear. `/inheritance:r` breaks inheritance from the parent directory
 * first — without it, `/grant:r` only *adds* an entry on top of whatever
 * the parent already granted (e.g. a broader `Users` ACE), which would
 * silently defeat the whole point.
 *
 * A small, accepted residual: the file exists (world-default-ACL, briefly)
 * before the ACL is narrowed — a true zero-window write would need a
 * native call this project deliberately avoids adding for one file. Not
 * pretended away; recorded here and in PROGRESS.md.
 */
export async function writeControlJsonWithAcl(
  stateDir: string,
  contents: ControlJson,
): Promise<string> {
  const parsed = ControlJsonSchema.parse(contents);
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'control.json');
  fs.writeFileSync(filePath, JSON.stringify(parsed), { encoding: 'utf8' });

  const username = userInfo().username;
  await execFileAsync('icacls', [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${username}:(R,W)`,
    '/grant:r',
    'SYSTEM:(F)',
  ]);

  // Read back and assert, per the explicit instruction not to trust the
  // call's own exit code — a non-zero icacls exit already throws via
  // execFileAsync; this additionally confirms the RESULT is what was
  // actually asked for, not just that the command didn't error.
  const verification = await readControlJsonAcl(filePath);
  if (!verification.ok) {
    // Fail closed (CLAUDE.md invariant #6): a token file whose ACL cannot
    // be confirmed restrictive is worse than no file at all — delete it
    // rather than leave a readable-by-anyone bearer token on disk.
    fs.rmSync(filePath, { force: true });
    throw new Error(`control.json ACL verification failed for ${filePath}: ${verification.reason}`);
  }

  return filePath;
}

const FORBIDDEN_ACL_PRINCIPALS = [
  'Everyone',
  'BUILTIN\\Users',
  'Authenticated Users',
  'BUILTIN\\Administrators',
  'NT AUTHORITY\\Authenticated Users',
];

export interface AclVerification {
  ok: boolean;
  reason: string;
  raw: string;
}

/** Exported (not just called internally) so a test can assert the exact evidence, not just trust a boolean. */
export async function readControlJsonAcl(filePath: string): Promise<AclVerification> {
  const { stdout } = await execFileAsync('icacls', [filePath]);
  const forbiddenFound = FORBIDDEN_ACL_PRINCIPALS.find((p) => stdout.includes(p));
  if (forbiddenFound) {
    return {
      ok: false,
      reason: `forbidden principal "${forbiddenFound}" present in ACL`,
      raw: stdout,
    };
  }
  const username = userInfo().username;
  if (!stdout.includes(username)) {
    return { ok: false, reason: `expected owner "${username}" not present in ACL`, raw: stdout };
  }
  return { ok: true, reason: 'ok', raw: stdout };
}
