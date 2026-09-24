import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { ControlJsonSchema, type ControlJsonInput } from '../../shared/controlChannel/schemas';
import { runWindowsPowerShell, windowsSystem32 } from '../process/windowsPowerShell';

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
  contents: ControlJsonInput,
  /** The read-back, and the environment both OS calls are made in; the ACL
   *  itself is always set by the real `icacls`. */
  verifyDeps: AclReadDeps = {},
): Promise<string> {
  const parsed = ControlJsonSchema.parse(contents);
  fs.mkdirSync(stateDir, { recursive: true });
  const filePath = path.join(stateDir, 'control.json');
  fs.writeFileSync(filePath, JSON.stringify(parsed), { encoding: 'utf8' });

  // Fail closed (CLAUDE.md invariant #6): a token file whose ACL cannot be
  // confirmed restrictive is worse than no file at all, so it is deleted on
  // EVERY way out that is not a confirmed ACL — a "no" from verification,
  // and equally a throw from `icacls` or from verification itself (M11 S1-2:
  // a throw used to skip the delete and leave the token on disk, possibly
  // still carrying the directory's default ACL).
  try {
    await restrictFileToCurrentUser(filePath, verifyDeps.env);

    // Read back and assert, per the explicit instruction not to trust the
    // call's own exit code — a non-zero icacls exit already throws via
    // execFileAsync; this additionally confirms the RESULT is what was
    // actually asked for, not just that the command didn't error.
    const verification = await readControlJsonAcl(filePath, verifyDeps);
    if (!verification.ok) {
      // The reason AND what it was read from. S1-21: the runner refused
      // every write and the descriptor never reached the log, because the
      // throw dropped the one piece of evidence that would have explained
      // it.
      throw new Error(
        `control.json ACL verification failed for ${filePath}: ${verification.reason}` +
          ` [read: ${verification.raw === '' ? '(empty)' : describeForLog(verification.raw)}]`,
      );
    }
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    throw err;
  }

  return filePath;
}

/**
 * Narrows a file's ACL to exactly the current user and SYSTEM — the one
 * place that does it (M11 S1-21, attempt 4). `writeControlJsonWithAcl`
 * calls it, and so does every test fixture that restricts a file: a
 * fixture that re-implements this re-implements its trap too, which is how
 * the CI runner's key-file test kept an explicit Administrators entry.
 *
 * `/inheritance:r` removes INHERITED entries only; an EXPLICIT entry
 * survives it and then fails verification. On the elevated CI runner
 * (runs 35724599688 and 35728894428) a freshly written file carries
 * explicit SYSTEM, BUILTIN\Administrators and user entries, so every write
 * failed closed — an administrator would have had no control channel at
 * all. Making the user the owner first does NOT help (measured on the
 * runner: the explicit entry stays). `/reset` drops every explicit entry,
 * whatever put it there, back to the inherited set — which the next call
 * then removes — so the result is exactly the two grants, never "the two
 * grants plus whatever was already there".
 *
 * Windows' own `icacls` by absolute path, for the same reason `whoami` is:
 * PATH is not ours to trust (M11 S1-21).
 */
export async function restrictFileToCurrentUser(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const icacls = path.join(windowsSystem32(env), 'icacls.exe');
  await execFileAsync(icacls, [filePath, '/reset']);
  await execFileAsync(icacls, [
    filePath,
    '/inheritance:r',
    '/grant:r',
    `${userInfo().username}:(R,W)`,
    '/grant:r',
    'SYSTEM:(F)',
  ]);
}

/**
 * Compared by SID, never by display name (M11 S1-1). `icacls` prints
 * localised names — `Jeder` for Everyone on a German Windows — so a
 * name match let a broadened ACL verify as restrictive on any machine not
 * set to English. The names here are only for the error message.
 */
const FORBIDDEN_ACL_SIDS: Readonly<Record<string, string>> = {
  'S-1-1-0': 'Everyone',
  'S-1-5-32-545': 'BUILTIN\\Users',
  'S-1-5-11': 'Authenticated Users',
  'S-1-5-32-544': 'BUILTIN\\Administrators',
};

/**
 * Why the reader's output could not be turned into a list of trustee SIDs.
 * Two different failures used to share one sentence, which is how M11
 * S1-21 reached a red CI run nobody could diagnose from the log. They are
 * told apart so the refusal can name the cause, and neither is ever a pass.
 */
export type AclParseFailure =
  { readonly kind: 'empty' } | { readonly kind: 'unrecognised_line'; readonly line: string };

export type AclParseResult =
  | { readonly ok: true; readonly sids: string[] }
  | { readonly ok: false; readonly failure: AclParseFailure };

/**
 * The trustee SIDs of every ACE, from the reader's `Allow|Deny <SID>`
 * lines (M11 S1-21, attempt 4). Every trustee arrives as a raw SID, so
 * there is no alias table to be incomplete: attempt 2 read SDDL, which
 * writes well-known accounts as two-letter aliases, and refused the CI
 * runner's correct ACL because its user — the built-in Administrator — is
 * `LA`, which is domain-relative and was not in the table. A line of any
 * other shape is refused and quoted, never skipped (invariant #6): a
 * skipped line is an ACE nobody checked.
 */
export function aclTrusteeSids(listing: string): AclParseResult {
  const lines = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return { ok: false, failure: { kind: 'empty' } };
  const sids: string[] = [];
  for (const line of lines) {
    const sid = /^(?:Allow|Deny) (S-1-[0-9-]+)$/.exec(line)?.[1];
    if (!sid) return { ok: false, failure: { kind: 'unrecognised_line', line } };
    sids.push(sid);
  }
  return { ok: true, sids };
}

let cachedUserSid: Promise<string> | null = null;

/**
 * The current user's SID, from `whoami /user` (its SID column is not
 * localised). Windows' own binary by absolute path: a bare `whoami`
 * resolves through PATH, and Git for Windows puts a coreutils `whoami`
 * there that rejects `/user` (measured on the dev box).
 */
async function realCurrentUserSid(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const whoami = path.join(windowsSystem32(env), 'whoami.exe');
  cachedUserSid ??= execFileAsync(whoami, ['/user', '/fo', 'csv', '/nh']).then(({ stdout }) => {
    const sid = /"(S-1-[0-9-]+)"\s*$/.exec(stdout.trim())?.[1];
    if (!sid) throw new Error(`could not read the current user's SID from whoami: ${stdout}`);
    return sid;
  });
  // A failure is not cached: the next verification asks again.
  return cachedUserSid.catch((err: unknown) => {
    cachedUserSid = null;
    throw err;
  });
}

export interface AclVerification {
  ok: boolean;
  reason: string;
  raw: string;
}

/**
 * The two OS reads verification makes, injectable so a test can stand in
 * for a machine whose display language this one does not have. Production
 * always uses the real commands.
 */
export interface AclReadDeps {
  /** Returns the file's ACEs, one `Allow|Deny <SID>` line each. */
  readSecurityDescriptor?: (filePath: string) => Promise<string>;
  currentUserSid?: () => Promise<string>;
  /**
   * The environment the real OS calls are spawned in (M11 S1-21).
   * Injectable rather than read from `process.env` at the point of use, so
   * a test can hand in the `PSModulePath` that breaks the descriptor read
   * without mutating the environment of the process running the suite.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * The file's ACEs, one `Allow|Deny <SID>` line each (M11 S1-21).
 *
 * **Why not `icacls /save`**, which this used to do: `/save` is documented
 * for a *directory* — it walks the name and writes the ACLs of whatever it
 * matched into a second file, in UTF-16, which then has to be read back and
 * deleted. That is three ways to end up with an empty string (nothing
 * matched, the temp file could not be written, the read raced the delete)
 * and every one of them arrived as the same "could not be read as SIDs".
 * `Get-Acl` names the file directly.
 *
 * **Why not SDDL** (attempt 4): SDDL writes well-known accounts as
 * aliases, and `LA` — the built-in Administrator, which is the CI runner's
 * own user — is domain-relative, so no fixed table resolves it.
 * `GetAccessRules(…, [SecurityIdentifier])` translates every trustee to a
 * raw SID, the same in every display language, and leaves nothing to
 * resolve. Explicit and inherited rules both: an inherited ACE grants
 * access as much as an explicit one does.
 *
 * Through `windowsPowerShell.ts` (M11 S1-21): absolute path, for the reason
 * `whoami` is — PATH is not ours to trust — and an explicit `PSModulePath`,
 * because a PowerShell 7 parent's inherited one shadows `Get-Acl`'s own
 * module and made every control.json on the CI runner fail to verify. It
 * costs a process launch per control.json write, which is once per employee
 * spawn — paid deliberately, for a read that cannot silently return nothing.
 */
async function realSecurityDescriptor(
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  // -LiteralPath: a path containing [ ] is a wildcard to Get-Acl otherwise.
  // Single quotes make the path literal to PowerShell, and a single quote
  // inside it is escaped by doubling, which is PowerShell's own rule.
  const quoted = filePath.replace(/'/g, "''");
  return runWindowsPowerShell(
    `$ErrorActionPreference='Stop'; ` +
      `(Get-Acl -LiteralPath '${quoted}').GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ` +
      `ForEach-Object { '{0} {1}' -f $_.AccessControlType, $_.IdentityReference.Value }`,
    env,
  );
}

/** A descriptor, short enough for one log line. An ACL holds no secret. */
function describeForLog(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > 400 ? `${oneLine.slice(0, 400)}…` : oneLine;
}

/** Exported (not just called internally) so a test can assert the exact evidence, not just trust a boolean. */
export async function readControlJsonAcl(
  filePath: string,
  deps: AclReadDeps = {},
): Promise<AclVerification> {
  const readSecurityDescriptor =
    deps.readSecurityDescriptor ?? ((file: string) => realSecurityDescriptor(file, deps.env));
  const currentUserSid = deps.currentUserSid ?? (() => realCurrentUserSid(deps.env));

  // Every trustee as a raw SID, in every display language — which is the
  // whole reason the comparison is made on it.
  const raw = await readSecurityDescriptor(filePath);

  const parsed = aclTrusteeSids(raw);
  if (!parsed.ok) {
    // What was read goes in the reason, not only in `raw`: this refusal is
    // read from a CI log more often than from a debugger, and an ACL
    // carries no secret.
    const evidence = `read: ${raw === '' ? '(empty)' : describeForLog(raw)}`;
    return {
      ok: false,
      reason:
        parsed.failure.kind === 'empty'
          ? `the ACL read back with no entries (${evidence})`
          : `the ACL listing has a line this check does not recognise: ${parsed.failure.line} (${evidence})`,
      raw,
    };
  }
  const sids = parsed.sids;
  const forbidden = sids.find((sid) => sid in FORBIDDEN_ACL_SIDS);
  if (forbidden) {
    return {
      ok: false,
      reason: `forbidden principal ${forbidden} (${FORBIDDEN_ACL_SIDS[forbidden]}) present in ACL`,
      raw,
    };
  }
  const userSid = await currentUserSid();
  if (!sids.includes(userSid)) {
    return { ok: false, reason: `the current user (${userSid}) is not in the ACL`, raw };
  }
  return { ok: true, reason: 'ok', raw };
}
