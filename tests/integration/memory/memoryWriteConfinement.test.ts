import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../../src/main/db/settingsLoader';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee } from '../../../src/main/db/repositories/employees';
import { insertCompany } from '../../../src/main/db/repositories/companies';
import { getDbPaths, getMemoryDir } from '../../../src/main/db/paths';
import { loadPricingYaml } from '../../../src/main/cost/pricingYaml';
import { dispatchIpcCall, getMethodSchema } from '../../../src/main/ipc/router';
import { memoryHandlers } from '../../../src/main/ipc/handlers/memory';
import { newId } from '../../../src/shared/models/ids';
import type { HandlerContext } from '../../../src/main/ipc/handlers/types';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const REAL_PRICING = loadPricingYaml(path.resolve('resources/pricing.yaml'));

/**
 * **S2 — `cannot_escape_workspace`**, for the write path M10 introduced.
 *
 * ## Why this file has to exist, and why a policy test would not do
 *
 * AUDIT #10: `evaluator.ts` returns `{effect:'allow'}` for every
 * `bureau_`/`mcp__bureau__` tool **before** the seven immutable denies are
 * scanned. That is spec-sanctioned (§23.2, "always allowed") and correct.
 * Its consequence is the thing this file tests:
 *
 * §12.1 says memory is unreachable to an employee's own file tools because
 * `deny.system_paths` covers `AppData/Roaming/Bureau/` — true, and verified
 * elsewhere. But `bureau_propose_memory` **skips that scan by
 * construction**. So for memory, *policy is not the guard; the handler is*,
 * and the only test that means anything is one that proves the handler
 * refuses — not one that proves policy would have (standing rule 2).
 *
 * Both entry points are covered, because there are two ways a path reaches
 * the memory tree and neither is more trusted than the other:
 *
 *  - an **agent**, through the real HTTP control channel and the real
 *    `bureau_propose_memory` handler;
 *  - a **person**, through the real IPC dispatcher and `memory.write`.
 *
 * ## Mutation-confirmed, and the first attempt failed
 *
 * Disabling `isInside` in `resolveMemoryTarget` left the **whole file
 * green** on its first draft. Every case it had — `..`, an absolute path, a
 * UNC path — is caught by a syntactic check that runs *before* the
 * containment test, so nothing here reached the guard the file claimed to
 * be about. That is this project's own central audit finding arriving in
 * new code, and it was found by running the mutation rather than by reading.
 *
 * The junction case below is what fixes it, and it now fails under that
 * mutation and passes without it.
 */

function rawPost(
  port: number,
  urlPath: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: { ok: boolean; error?: { message: string } } }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: urlPath,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? JSON.parse(raw) : { ok: false },
          });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('S2: a memory write cannot escape the memory tree, at the handler', () => {
  let tmpDir: string;
  let baseDir: string;
  let outsideDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: ControlChannelServer;
  let tokenRegistry: TokenRegistry;
  let port: number;
  let ctx: HandlerContext;
  let employeeId: string;
  let otherEmployeeId: string;
  let token: string;

  /** The real tool route: auth, idempotency, rate limiting and the real
   *  handler, exactly as `bureau-tools` calls it. */
  async function propose(args: Record<string, unknown>) {
    return rawPost(port, '/v1/tool/bureau_propose_memory', token, {
      idempotencyKey: newId(),
      args,
    });
  }

  /** The real IPC dispatcher, so the input schema, the handler and the
   *  output re-validation are all production. */
  async function write(input: Record<string, unknown>) {
    return dispatchIpcCall(
      'memory:write',
      getMethodSchema('memory', 'write'),
      memoryHandlers['write']!,
      ctx,
      true,
      input,
    );
  }

  /** Every file under the memory tree, so "nothing was written" is checked
   *  against the disk rather than against the absence of an error. */
  function memoryTreeFiles(): string[] {
    const root = getMemoryDir(baseDir);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(full);
      }
    };
    walk(root);
    return out;
  }

  function proposalCount(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM memory_proposals').get() as { n: number }).n;
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-memconfine-'));
    // Real directories, because `canonicalizePath` resolves through the
    // real filesystem — a test over paths that never exist would exercise
    // only its fallback branch.
    baseDir = path.join(tmpDir, 'Bureau');
    outsideDir = path.join(tmpDir, 'Elsewhere');
    mkdirSync(getMemoryDir(baseDir), { recursive: true });
    mkdirSync(path.join(outsideDir, '.ssh'), { recursive: true });
    writeFileSync(path.join(outsideDir, '.ssh', 'id_rsa'), 'PRIVATE KEY\n');
    // The near-miss a naive `startsWith` admits: a sibling whose name
    // begins with the memory root's name.
    mkdirSync(`${getMemoryDir(baseDir)}2`, { recursive: true });

    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    seedSettingsDefaults(db);
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    insertCompany(db, { name: 'Test Co', home_path: path.join(tmpDir, 'home') });

    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run(
      'dept1',
      'engineering',
      'Engineering',
      '{}',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    const role = insertRole(db, {
      key: 'developer',
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'Writes code',
      system_prompt_path: 'prompts/developer.md',
      skills: ['code'],
      deliverable_types: ['code'],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: ['role', 'company'],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    const employee = insertEmployee(db, {
      name: 'Ravi',
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'working',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    const other = insertEmployee(db, {
      name: 'Meera',
      role_key: role.full_key,
      is_director: false,
      desk_x: 1,
      desk_y: 0,
      sprite_variant: 'b',
      status: 'idle',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    employeeId = employee.id;
    otherEmployeeId = other.id;

    tokenRegistry = new TokenRegistry();
    const supervisorRegistry = new SupervisorRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir,
    });
    port = await server.start();
    token = tokenRegistry.mint(employeeId);

    ctx = {
      db,
      activityLog,
      dbPaths: getDbPaths(baseDir, REAL_MIGRATIONS_DIR),
      pricing: REAL_PRICING,
      baseDir,
      bundledPacksDir: path.resolve('packs'),
      appVersion: '0.0.1',
    } as HandlerContext;
  });

  afterEach(async () => {
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- the agent's door ---------------------------------------------

  it.each([
    ['traversal out of the tree', '../../../Elsewhere/.ssh/stolen.md'],
    ['traversal within a scope ref', 'a/../../../../Elsewhere/stolen.md'],
    ['an absolute path', 'C:\\Windows\\System32\\evil.md'],
    ['a UNC path', '\\\\attacker\\share\\evil.md'],
    ['a bare drive-relative path', 'C:evil.md'],
  ])('bureau_propose_memory refuses %s, and writes nothing at all', async (_label, badPath) => {
    const before = memoryTreeFiles();

    const response = await propose({
      scope: 'company',
      path: badPath,
      content: '# Owned\n',
      rationale: 'testing the boundary',
    });

    expect(response.body.ok).toBe(false);
    // §7.9: an agent reads this, so it has to say what a legal path is.
    expect(response.body.error?.message ?? '').toMatch(/memory|path|scope/i);

    // The load-bearing half. A refusal that had already written the file
    // would be a refusal in name only — and the queue must not hold a row
    // pointing outside the tree either, because accepting it later would
    // write it.
    expect(memoryTreeFiles()).toEqual(before);
    expect(proposalCount()).toBe(0);
    expect(existsSync(path.join(outsideDir, '.ssh', 'stolen.md'))).toBe(false);
  });

  it('bureau_propose_memory refuses a path that escapes only through a junction — the canonical check', async () => {
    /**
     * **This test exists because the first version of this file did not
     * have it, and the mutation proved that.**
     *
     * Deleting the `isInside(root, canonicalizePath(...))` call left every
     * other case in this file green: `..`, an absolute path and a UNC path
     * are all caught by the syntactic checks that run before it, so the
     * containment check itself was never reached by a single assertion. A
     * guard with no test that reaches it is the audit's own central
     * finding, and it survived here until the mutation was actually run.
     *
     * What only the canonical check can catch: a path that is textually
     * innocent and lands outside the tree because a directory *inside* the
     * tree is a link to somewhere else. Junctions need no privileges on
     * Windows, so this is a real thing a user (or a restored backup, or a
     * synced folder) can create by accident.
     */
    const junction = path.join(getMemoryDir(baseDir), 'company', 'escape');
    mkdirSync(path.join(getMemoryDir(baseDir), 'company'), { recursive: true });
    symlinkSync(outsideDir, junction, 'junction');

    const response = await propose({
      scope: 'company',
      // Nothing syntactically wrong with it: no `..`, no drive letter, ends
      // in `.md`, two ordinary segments.
      path: 'escape/stolen.md',
      content: '# Owned\n',
      rationale: 'testing the boundary',
    });

    expect(response.body.ok).toBe(false);
    expect(response.body.error?.message ?? '').toMatch(/outside/i);
    expect(existsSync(path.join(outsideDir, 'stolen.md'))).toBe(false);
    expect(proposalCount()).toBe(0);
  });

  it('bureau_propose_memory refuses another employee’s notebook', async () => {
    // §12.4 makes `employee/` writes free — which is exactly why the owner
    // cannot be taken from the request. The scope ref comes from the
    // verified bearer token; naming somebody else's is refused rather than
    // silently redirected, so the agent learns the rule.
    const response = await propose({
      scope: 'employee',
      path: `${otherEmployeeId}/notes.md`,
      content: '# Not mine\n',
      rationale: 'testing ownership',
    });

    expect(response.body.ok).toBe(false);
    expect(response.body.error?.message ?? '').toMatch(/own folder|somebody else/i);
    expect(
      existsSync(path.join(getMemoryDir(baseDir), 'employee', otherEmployeeId, 'notes.md')),
    ).toBe(false);
  });

  it('bureau_propose_memory allows the employee’s OWN notebook — the guard is not just "refuse everything"', async () => {
    // A confinement test that only ever asserts refusals passes just as
    // well against a handler that refuses unconditionally. This is the
    // control: the legal case has to work.
    const response = await propose({
      scope: 'employee',
      path: 'notes.md',
      content: '# What I learned\n\nThe build needs node 22.',
      rationale: 'worth remembering',
    });

    expect(response.body.ok).toBe(true);
    expect(existsSync(path.join(getMemoryDir(baseDir), 'employee', employeeId, 'notes.md'))).toBe(
      true,
    );
  });

  // ---- the person's door --------------------------------------------

  it.each([
    ['traversal', '../../Elsewhere/stolen.md'],
    ['an absolute path', 'C:\\Windows\\System32\\evil.md'],
    ['a near-miss sibling of the memory root', '../memory2/evil.md'],
  ])('memory.write refuses %s through the real IPC dispatcher', async (_label, badPath) => {
    const before = memoryTreeFiles();

    const result = await write({ scope: 'company', path: badPath, body: '# Owned\n' });

    expect(result.ok).toBe(false);
    expect(memoryTreeFiles()).toEqual(before);
  });

  it('refuses an employee-scope write from a person, readably (X-18)', async () => {
    // `employee/` is an individual's notebook, and a person using the UI is
    // not that employee — so there is no owning employee id and the write is
    // refused. That is deliberate and is not going to change, which is why
    // the Memory view no longer offers Edit, Pin or Delete on these notes
    // (X-18): three buttons that always failed. The message says what to do
    // instead, per §14.6.
    const before = memoryTreeFiles();

    const result = await write({ scope: 'employee', path: 'notes.md', body: '# Theirs\n' });

    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: { message: string } }).error;
    expect(error.message).toMatch(/employee/i);
    expect(error.message).not.toMatch(/§|ENOENT|undefined/);
    expect(memoryTreeFiles()).toEqual(before);
  });

  it('refuses every write when no memory root is configured — fail closed, not fall back to the cwd', async () => {
    /**
     * Found by a test rather than by reading: `toolHandlers.test.ts`
     * constructs its control-channel server without a `baseDir`, which is a
     * shape a real caller could have. `getMemoryDir('')` is the bare
     * relative path `memory`, and `path.resolve` anchors that to whatever
     * the process's current directory happens to be — so every containment
     * check would have passed while writing into somewhere nobody chose.
     *
     * Invariant #6, and the same sentence `attachments.ts` already uses for
     * an unset company home: the absence of a workspace does not mean
     * everything is inside it.
     */
    const rootless = { ...ctx, baseDir: '' } as HandlerContext;
    const result = await dispatchIpcCall(
      'memory:write',
      getMethodSchema('memory', 'write'),
      memoryHandlers['write']!,
      rootless,
      true,
      { scope: 'company', path: 'standards.md', body: '# Standards\n' },
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/no memory folder/i);
    expect(memoryTreeFiles()).toEqual([]);
  });

  it('memory.write refuses a non-markdown path, because layer 1 is markdown', async () => {
    const result = await write({ scope: 'company', path: 'standards.exe', body: 'MZ' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.message).toMatch(/markdown/i);
  });

  it('memory.write writes a legal path — the control for the person’s door', async () => {
    const result = await write({
      scope: 'company',
      path: 'standards.md',
      body: '# Standards\n\nWrite tests first.',
    });

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(getMemoryDir(baseDir), 'company', 'standards.md'))).toBe(true);
  });
});
