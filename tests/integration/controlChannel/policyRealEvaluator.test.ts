import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { Supervisor } from '../../../src/main/engine/supervisor';
import { FakeAdapter } from '../../../src/main/engine/fakeAdapter';
import { getRoleByFullKey } from '../../../src/main/db/repositories/roles';
import {
  noopSecretBroker,
  placeholderControlChannel,
  placeholderToolServer,
} from '../../../src/shared/engine/seams';
import { newId } from '../../../src/shared/models/ids';
import type { Autonomy } from '../../../src/shared/models/enums';
import type { Employee } from '../../../src/shared/models/employee';
import { seedEmployeeWithWorktree, seedProject } from '../../helpers/dbFixtures';
import { confirmEmployeeAutonomous } from '../../../src/main/db/repositories/employees';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');

interface RawResponse {
  status: number;
  body: unknown;
}

function rawRequest(
  port: number,
  opts: { path: string; headers: Record<string, string>; body: unknown },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(opts.body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: opts.path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : null });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * §11.7 S1, S2, S9 — through the REAL default evaluator, wired exactly as
 * production wires it (`ControlChannelServer` constructed with no
 * `evaluatePolicy` override), not an injected fake. Real DB, real roles/
 * employees/worktrees (via tests/helpers/dbFixtures.ts), real directories
 * on disk — every worktree/project path used here is overridden to a real
 * `mkdtempSync` temp directory, not dbFixtures.ts's own fake default
 * `C:\bureau-test\...` path (which nothing before this test ever needed
 * to actually exist on disk).
 */
describe('the real policy evaluator through /v1/policy/check (S1, S2, S9)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let tokenRegistry: TokenRegistry;
  let supervisorRegistry: SupervisorRegistry;
  let server: ControlChannelServer;
  let port: number;
  let liveSupervisors: Supervisor[];

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-policyeval-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    tokenRegistry = new TokenRegistry();
    supervisorRegistry = new SupervisorRegistry();
    liveSupervisors = [];
    // No evaluatePolicy override — this exercises the REAL default
    // (createPolicyEvaluator), exactly as main/index.ts wires it.
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry,
      baseDir: tmpDir,
      // Small on purpose: an inside-workspace Write at autonomy="ask"
      // genuinely resolves to 'ask' (§11.2 — even in-workspace writes
      // need confirmation at the strictest level), which this session's
      // real evaluator has no way to resolve except the hold timing out
      // to deny. None of the other tests below ever reach the hold path
      // (outside-workspace hits an immutable deny directly; inside-
      // workspace at guided/autonomous hits an unconditional allow) — this
      // only matters for that one case, and 3s beats waiting out a real
      // 30-minute default in a test.
      maxHoldMinutes: 0.05,
    });
    port = await server.start();
  });

  afterEach(async () => {
    await Promise.all(liveSupervisors.map((s) => s.stop()));
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function realWorktreeDir(): string {
    return mkdtempSync(path.join(tmpDir, 'wt-'));
  }

  /**
   * M6 session 2, Fix B: `policyEvaluator.ts` now reads an employee's real
   * `EngineCapabilities` from its LIVE, registered `Supervisor`
   * (`supervisorRegistry.get(employeeId)?.getCapabilities()`) rather than
   * fabricating one fresh per call — see toolClassify.ts's own comment. In
   * real production this is never absent: `/v1/policy/check` is only ever
   * reachable via a token `spawnSupervisedEmployee` minted, which
   * registers this employee's Supervisor in the exact same function,
   * atomically. This test file predates that change and inserted only DB
   * rows, no live Supervisor — found as a real regression while running
   * this session's full suite (every "should allow"/"should ask" case
   * fell to 'deny', since `capabilities: null` classifies every tool as
   * `'other'`, and `'other'` defaults to `deny`, not `ask` — §11.3's own
   * rule). Fixed here, not by loosening the production code: a real
   * `Supervisor`, wired to a `FakeAdapter` (empty script — no events to
   * consume, so this resolves near-instantly) so `getCapabilities()`
   * returns real, `Write`-classified-as-`'write'` capabilities, exactly
   * matching what a genuinely running employee would have. `task: null`
   * is the same "no task assigned yet" shape several `supervisor.test.ts`
   * cases already use safely.
   */
  async function registerLiveSupervisorFor(employee: Employee): Promise<void> {
    const role = getRoleByFullKey(db, employee.role_key);
    if (!role)
      throw new Error(
        `no role row for ${employee.role_key} — dbFixtures.ts should always create one`,
      );
    const adapter = new FakeAdapter({ events: [] });
    const supervisor = new Supervisor(employee.id, {
      db,
      activityLog,
      adapter,
      supervisorRegistry,
      // Real, but far longer than any test in this file could possibly
      // run — the point is "never fires here", not "fires eventually".
      heartbeatCheckIntervalMs: 999_999_999,
    });
    liveSupervisors.push(supervisor);
    await supervisor.assign({
      employee,
      role,
      task: null,
      worktreePath: tmpDir,
      stateDir: tmpDir,
      baseDir: tmpDir,
      toolServer: placeholderToolServer,
      controlChannel: placeholderControlChannel,
      broker: noopSecretBroker,
      effectiveAutonomy: 'ask',
      modelId: null,
      turnBudgetCapUsdMicros: null,
    });
    supervisorRegistry.register(employee.id, supervisor);
  }

  async function policyCheck(token: string, tool: string, args: unknown): Promise<RawResponse> {
    return rawRequest(port, {
      path: '/v1/policy/check',
      headers: { authorization: `Bearer ${token}` },
      body: { callId: newId(), tool, rawTool: tool, args, preview: '' },
    });
  }

  describe('S1: a denied tool provably does not execute — filesystem sentinel, not a log line', () => {
    it('a Write outside the worktree is denied, and the conditionally-executed write never lands', async () => {
      const wtPath = realWorktreeDir();
      const { employee } = seedEmployeeWithWorktree(db, {}, { path: wtPath });
      await registerLiveSupervisorFor(employee);
      const token = tokenRegistry.mint(employee.id);
      const outsidePath = path.join(tmpDir, 'outside-the-worktree.txt');

      const res = await policyCheck(token, 'Write', { file_path: outsidePath, content: 'x' });
      expect(res.status).toBe(200);
      const verdict = (res.body as { verdict: string }).verdict;
      expect(verdict).toBe('deny');

      // The actual proof: perform the write only the way a real adapter
      // would (only on 'allow'), then assert the sentinel was never
      // created — not "the response body said deny".
      if (verdict === 'allow') writeFileSync(outsidePath, 'x');
      expect(existsSync(outsidePath)).toBe(false);
    });

    /**
     * AUDIT #9. Every other case in this file leaves the seeded project on
     * `seedProject`'s fake default (`C:\bureau-test\...`) while the
     * "outside" target is a real temp dir — so `${project}` can never
     * contain the target, and adding `${project}` to
     * `deny.write_outside_worktree`'s roots (the change that rule's own
     * comment says "silently undoes all of M5") was invisible to the
     * suite that reads as the real proof of M5's write isolation.
     *
     * Here the project path is a real directory that genuinely CONTAINS
     * the worktree, and the target sits inside the project but outside
     * the worktree — the one arrangement where the widening changes the
     * verdict. §11.3: writes are confined to the employee's own worktree;
     * reads may also see the project. So this same path must deny a Write
     * and allow a Read, which is asserted below as a pair.
     */
    it('AUDIT #9: a Write INSIDE the project but outside the worktree is denied — ${project} is never a write root', async () => {
      const projectDir = mkdtempSync(path.join(tmpDir, 'proj-'));
      const project = seedProject(db, { path: projectDir });
      const wtPath = mkdtempSync(path.join(projectDir, 'wt-')); // genuinely inside the project
      const { employee } = seedEmployeeWithWorktree(
        db,
        {},
        { path: wtPath, project_id: project.id },
      );
      await registerLiveSupervisorFor(employee);
      const token = tokenRegistry.mint(employee.id);

      const inProjectOutsideWorktree = path.join(projectDir, 'src-file.txt');

      const write = await policyCheck(token, 'Write', {
        file_path: inProjectOutsideWorktree,
        content: 'x',
      });
      const writeVerdict = (write.body as { verdict: string }).verdict;
      expect(
        writeVerdict,
        'a write into the project checkout must be denied — that is M5 write isolation',
      ).toBe('deny');
      if (writeVerdict === 'allow') writeFileSync(inProjectOutsideWorktree, 'x');
      expect(existsSync(inProjectOutsideWorktree)).toBe(false);

      // The paired half, proving the deny above is the write-scope rule
      // and not simply "this path is unreachable": §11.3 lets reads see
      // the canonical project.
      const read = await policyCheck(token, 'Read', { file_path: inProjectOutsideWorktree });
      expect((read.body as { verdict: string }).verdict, 'reads may see the project (§11.3)').toBe(
        'allow',
      );
    });

    it('parallel allow-path proof: the identical setup with a target INSIDE the worktree really gets written — not a placebo', async () => {
      const wtPath = realWorktreeDir();
      const { employee } = seedEmployeeWithWorktree(db, {}, { path: wtPath });
      await registerLiveSupervisorFor(employee);
      const token = tokenRegistry.mint(employee.id);
      const insidePath = path.join(wtPath, 'inside-the-worktree.txt');

      const res = await policyCheck(token, 'Write', { file_path: insidePath, content: 'x' });
      const verdict = (res.body as { verdict: string }).verdict;
      expect(verdict).toBe('allow');

      if (verdict === 'allow') writeFileSync(insidePath, 'x');
      expect(existsSync(insidePath)).toBe(true);
    });
  });

  describe('S2: reads and writes outside the workspace fail at EVERY autonomy level — not just "ask"', () => {
    const LEVELS: Autonomy[] = ['ask', 'guided', 'autonomous'];

    for (const level of LEVELS) {
      it(`denies an outside-workspace Write at autonomy="${level}"`, async () => {
        const wtPath = realWorktreeDir();
        const { employee } = seedEmployeeWithWorktree(db, { autonomy: level }, { path: wtPath });
        await registerLiveSupervisorFor(employee);
        const token = tokenRegistry.mint(employee.id);
        const outsidePath = path.join(tmpDir, `outside-write-${level}.txt`);

        const res = await policyCheck(token, 'Write', { file_path: outsidePath });
        expect((res.body as { verdict: string }).verdict).toBe('deny');
      });

      it(`denies an outside-workspace Read at autonomy="${level}"`, async () => {
        const wtPath = realWorktreeDir();
        const { employee } = seedEmployeeWithWorktree(db, { autonomy: level }, { path: wtPath });
        await registerLiveSupervisorFor(employee);
        const token = tokenRegistry.mint(employee.id);
        const outsidePath = path.join(tmpDir, `outside-read-${level}.txt`);
        writeFileSync(outsidePath, 'not for this employee');

        const res = await policyCheck(token, 'Read', { file_path: outsidePath });
        expect((res.body as { verdict: string }).verdict).toBe('deny');
      });

      // N-10: the credential-path and system-path denies through the real
      // HTTP path, not only the unit table. The credential files sit INSIDE
      // the worktree, so only `deny.credential_paths` can be what denies
      // them, and the ruleId is asserted to prove it.
      for (const credential of [
        '.env',
        '.ssh/id_ed25519',
        '.aws/credentials',
        'certs/server.pem',
      ]) {
        it(`denies a Read of the credential-shaped "${credential}" inside the worktree at autonomy="${level}"`, async () => {
          const wtPath = realWorktreeDir();
          const { employee } = seedEmployeeWithWorktree(db, { autonomy: level }, { path: wtPath });
          await registerLiveSupervisorFor(employee);
          const token = tokenRegistry.mint(employee.id);

          const res = await policyCheck(token, 'Read', {
            file_path: path.join(wtPath, credential),
          });
          const body = res.body as { verdict: string; ruleId: string | null };
          expect(body.verdict).toBe('deny');
          expect(body.ruleId).toBe('deny.credential_paths');
        });
      }

      it(`denies a Read under Program Files at autonomy="${level}"`, async () => {
        const wtPath = realWorktreeDir();
        const { employee } = seedEmployeeWithWorktree(db, { autonomy: level }, { path: wtPath });
        await registerLiveSupervisorFor(employee);
        const token = tokenRegistry.mint(employee.id);

        // Verdict only, not ruleId: Program Files is also outside the workspace,
        // and `deny.read_outside_project` is listed first, so it is the one
        // that answers. The unit table pins `deny.system_paths` alone.
        const res = await policyCheck(token, 'Read', {
          file_path: 'C:/Program Files/Git/etc/gitconfig',
        });
        expect((res.body as { verdict: string }).verdict).toBe('deny');
      });

      // §11.2's own table: Writes-in-workspace is "allow" at guided/
      // autonomous but "ask" at the strictest level — an inside-workspace
      // write genuinely isn't a blanket allow at every level, only the
      // OUTSIDE-workspace deny above is unconditional across all three.
      if (level === 'guided' || level === 'autonomous') {
        it(`(parallel proof, not a blanket deny) allows an INSIDE-workspace Write at autonomy="${level}"`, async () => {
          const wtPath = realWorktreeDir();
          const { employee } = seedEmployeeWithWorktree(db, { autonomy: level }, { path: wtPath });
          await registerLiveSupervisorFor(employee);
          const token = tokenRegistry.mint(employee.id);
          const insidePath = path.join(wtPath, 'ok.txt');

          const res = await policyCheck(token, 'Write', { file_path: insidePath });
          expect((res.body as { verdict: string }).verdict).toBe('allow');
        });
      } else {
        it(
          '(parallel proof, not a blanket deny) an INSIDE-workspace Write at autonomy="ask" still requires ' +
            'confirmation (§11.2) — resolves to deny only via the hold timing out, never an immediate deny like the outside-workspace case',
          async () => {
            const wtPath = realWorktreeDir();
            const { employee } = seedEmployeeWithWorktree(
              db,
              { autonomy: level },
              { path: wtPath },
            );
            await registerLiveSupervisorFor(employee);
            const token = tokenRegistry.mint(employee.id);
            const insidePath = path.join(wtPath, 'ok.txt');

            const start = Date.now();
            const res = await policyCheck(token, 'Write', { file_path: insidePath });
            const elapsedMs = Date.now() - start;
            expect((res.body as { verdict: string }).verdict).toBe('deny');
            // It went through the hold (took close to the 3s maxHoldMinutes
            // timeout), not an immediate deny — proving this really is
            // "ask, unresolved, fails closed", not the same code path as
            // the outside-workspace immutable deny.
            expect(elapsedMs).toBeGreaterThan(2000);
          },
        );
      }
    }
  });

  // N-8: the unconfirmed-`autonomous` → `guided` downgrade (§11.2) was pinned
  // by unit tests only. An unlisted command is the call that separates the
  // two levels: `autonomous` allows it, `guided` asks. Asserted through the
  // real HTTP path by the permission checkpoint the ask raises, then the
  // hold timing out to deny; the confirmed employee is the parallel proof.
  describe('S2: an unconfirmed autonomous employee is treated as guided (N-8, §11.2)', () => {
    async function commandCheck(confirmed: boolean) {
      const wtPath = realWorktreeDir();
      const { employee } = seedEmployeeWithWorktree(
        db,
        { autonomy: 'autonomous' },
        { path: wtPath },
      );
      if (confirmed) confirmEmployeeAutonomous(db, employee.id);
      await registerLiveSupervisorFor(employee);
      const token = tokenRegistry.mint(employee.id);
      const res = await policyCheck(token, 'Bash', { command: 'echo an-unlisted-command' });
      const checkpoints = db
        .prepare("SELECT type FROM checkpoints WHERE employee_id = ? AND type = 'permission'")
        .all(employee.id);
      return { verdict: (res.body as { verdict: string }).verdict, checkpoints };
    }

    it('unconfirmed: asks (a permission checkpoint is raised), and the unanswered hold denies', async () => {
      const { verdict, checkpoints } = await commandCheck(false);
      expect(checkpoints).toHaveLength(1);
      expect(verdict).toBe('deny');
    });

    it('(parallel proof) confirmed: the same command is allowed with no checkpoint', async () => {
      const { verdict, checkpoints } = await commandCheck(true);
      expect(checkpoints).toHaveLength(0);
      expect(verdict).toBe('allow');
    });
  });

  describe('S9: employee A cannot read or write employee B\u2019s worktree', () => {
    it('A is denied a Write targeting B\u2019s worktree, sentinel-proven', async () => {
      const wtA = realWorktreeDir();
      const wtB = realWorktreeDir();
      const { employee: employeeA } = seedEmployeeWithWorktree(db, {}, { path: wtA });
      seedEmployeeWithWorktree(db, {}, { path: wtB });
      await registerLiveSupervisorFor(employeeA);
      const tokenA = tokenRegistry.mint(employeeA.id);
      const targetInB = path.join(wtB, 'b-owns-this.txt');

      const res = await policyCheck(tokenA, 'Write', { file_path: targetInB });
      const verdict = (res.body as { verdict: string }).verdict;
      expect(verdict).toBe('deny');

      if (verdict === 'allow') writeFileSync(targetInB, 'intrusion');
      expect(existsSync(targetInB)).toBe(false);
    });

    it('A is denied a Read targeting B\u2019s worktree', async () => {
      const wtA = realWorktreeDir();
      const wtB = realWorktreeDir();
      const { employee: employeeA } = seedEmployeeWithWorktree(db, {}, { path: wtA });
      seedEmployeeWithWorktree(db, {}, { path: wtB });
      await registerLiveSupervisorFor(employeeA);
      writeFileSync(path.join(wtB, 'private.txt'), 'b secret');
      const tokenA = tokenRegistry.mint(employeeA.id);

      const res = await policyCheck(tokenA, 'Read', { file_path: path.join(wtB, 'private.txt') });
      expect((res.body as { verdict: string }).verdict).toBe('deny');
    });

    it('(parallel proof, not a blanket deny) A can read/write its own worktree', async () => {
      const wtA = realWorktreeDir();
      const { employee: employeeA } = seedEmployeeWithWorktree(db, {}, { path: wtA });
      await registerLiveSupervisorFor(employeeA);
      const tokenA = tokenRegistry.mint(employeeA.id);
      const own = path.join(wtA, 'own.txt');

      const res = await policyCheck(tokenA, 'Write', { file_path: own });
      expect((res.body as { verdict: string }).verdict).toBe('allow');
    });
  });
});
