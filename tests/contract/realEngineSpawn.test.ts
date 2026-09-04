import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { newId, nowIso } from '../../src/shared/models/ids';
import { EmployeeSchema } from '../../src/shared/models/employee';
import { RoleSchema } from '../../src/shared/models/role';
import { ClaudeCodeAdapter } from '../../src/main/engine/claudeCodeAdapter';
import { buildResolvedPath, resolveBinaryAbsolutePath } from '../../src/main/engine/resolvedPath';
import { noopSecretBroker, placeholderControlChannel, placeholderToolServer } from '../../src/shared/engine/seams';
import type { AgentEvent } from '../../src/shared/engine/events';
import type { EmployeeContext } from '../../src/shared/engine/types';

/**
 * §7.8/§19.1: "contract/ — every engine adapter, one suite (FakeAdapter
 * always; real engines when present)." This file is the "real engines when
 * present" half — genuinely spends real money, so it is gated behind TWO
 * independent conditions, not one:
 *
 *   1. The real `claude` CLI must actually resolve on this machine (CI
 *      safety — §7.8: "most of the suite must run offline and free").
 *   2. BUREAU_RUN_REAL_ENGINE_TESTS must be explicitly set — because even a
 *      machine WITH the CLI installed should not silently spend real money
 *      on every `npm test`. "Skipped by default, run explicitly."
 *
 * Replaces M3 session 2 part 1's ad-hoc fix (manually listing every other
 * integration test file to exclude this one from a final sweep) with an
 * actual mechanism.
 */
const resolvedPathForRealClaude = await buildResolvedPath();
const realClaudePathForGate = resolveBinaryAbsolutePath('claude', resolvedPathForRealClaude);
const explicitlyOptedIn = process.env.BUREAU_RUN_REAL_ENGINE_TESTS === '1';
const shouldRun = realClaudePathForGate !== null && explicitlyOptedIn;

function skipReason(): string {
  if (!realClaudePathForGate) return 'claude CLI not found via the resolved-PATH service on this machine';
  if (!explicitlyOptedIn) return 'BUREAU_RUN_REAL_ENGINE_TESTS is not set — real-engine tests are opt-in, not automatic';
  return '';
}

if (!shouldRun) {
  // Deliberate, explicit skip reason (§7.8), not a silent no-op.
  console.log(`[realEngineSpawn.test.ts] skipping all real-engine tests: ${skipReason()}`);
}

function fakeEmployeeContext(stateDir: string, worktreePath: string, engineOptions: unknown = null): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(), name: 'Ravi', role_key: 'engineering:developer', is_director: 0, desk_x: 0, desk_y: 0,
    sprite_variant: 'a', status: 'idle', status_detail: null, engine: 'claude-code', engine_mode: null,
    engine_version: null, model: null, session_id: null, pid: null, process_start_time: null,
    worktree_id: null, current_task_id: null, autonomy: 'ask', autonomous_confirmed_at: null, daily_budget_usd_micros: null,
    resume_at: null, heartbeat_at: null, consecutive_failures: 0, lifetime_spend_usd_micros: 0,
    hired_at: now, created_at: now, updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(), key: 'developer', full_key: 'engineering:developer', department_key: 'engineering',
    pack_id: 'engineering', priority: 50, version: '1.0.0', title: 'Developer', description: 'Writes code',
    system_prompt_path: 'prompts/developer.md', skills: '[]', deliverable_types: '[]',
    engine_preference: '["claude-code"]', model_preference: null, tools_allow: '[]', tools_deny: '[]',
    network_allow: '[]', memory_scopes: '[]', autonomy_default: 'ask', max_turns: 1, max_attempts: 1,
    wall_clock_timeout_s: 60, budget_usd_micros: null, sprite_key: 'dev', role_options: '{}',
    engine_options: engineOptions === null ? null : JSON.stringify(engineOptions),
    enabled: 1, created_at: now, updated_at: now,
  });
  return {
    employee, role, task: null, worktreePath, stateDir, memoryPack: '', decisionLog: '',
    toolServer: placeholderToolServer, controlChannel: placeholderControlChannel, broker: noopSecretBroker,
    effectiveAutonomy: 'ask',
    modelId: null,
    turnBudgetCapUsdMicros: null,
  };
}

/**
 * §0 (M3 session 2 part 2): the REAL mechanism, confirmed twice this
 * session — copying *both* `~/.claude.json` and `~/.claude/.credentials.json`
 * (the actual token, in a separate file part 1's investigation missed)
 * into an isolated `<stateDir>/claude/` restores a genuinely working,
 * authenticated session. `claude auth status` against the copy alone
 * confirmed `loggedIn:true`; a real generation call confirmed it bills for
 * real (session 2 part 2's own $0.042 verification). This is a stand-in
 * for real per-employee credential provisioning (SecretBroker, M6) — not
 * production code.
 */
function seedIsolatedAuth(stateDir: string): boolean {
  const claudeJson = path.join(homedir(), '.claude.json');
  const credentials = path.join(homedir(), '.claude', '.credentials.json');
  if (!existsSync(claudeJson) || !existsSync(credentials)) return false;
  const claudeConfigDir = path.join(stateDir, 'claude');
  mkdirSync(claudeConfigDir, { recursive: true });
  copyFileSync(claudeJson, path.join(claudeConfigDir, '.claude.json'));
  copyFileSync(credentials, path.join(claudeConfigDir, '.credentials.json'));
  return true;
}

async function safeRmSync(targetPath: string, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) {
        console.warn(`[realEngineSpawn.test.ts] could not clean up ${targetPath}: ${String(err)}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function collectUntilFinished(events: AsyncIterable<AgentEvent>, timeoutMs: number): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collectUntilFinished timed out; got so far: ${JSON.stringify(collected)}`);
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('per-event timeout')), remaining)),
    ]);
    if (result.done) break;
    collected.push(result.value);
    if (result.value.t === 'finished') break;
  }
  return collected;
}

describe('Real ClaudeCodeAdapter spawns (§19.1 contract/ "real engines when present")', () => {
  it.skipIf(!shouldRun)(
    'structured mode: a real, properly-authenticated exchange produces a real generated reply',
    async () => {
      const tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-contract-real-structured-'));
      try {
        const adapter = new ClaudeCodeAdapter();
        const probeResult = await adapter.probe();
        expect(probeResult.installed, probeResult.error ?? '').toBe(true);

        const seeded = seedIsolatedAuth(tmpDir);
        expect(seeded, 'no real ~/.claude.json + ~/.claude/.credentials.json to copy on this machine').toBe(true);

        const ctx = fakeEmployeeContext(tmpDir, tmpDir, { mode: 'structured' });
        await adapter.start(ctx);

        const eventsPromise = collectUntilFinished(adapter.events(), 30_000);
        await adapter.send('Reply with exactly one word: OK', 'task');
        const events = await eventsPromise;

        const textDeltas = events.filter((e) => e.t === 'text.delta');
        const fullText = textDeltas.map((e) => (e.t === 'text.delta' ? e.text : '')).join('');
        // With real auth now genuinely working (confirmed this session),
        // this is finally the literal assertion part 1 could not make.
        expect(fullText.toUpperCase()).toContain('OK');

        const finished = events.find((e) => e.t === 'finished');
        expect(finished).toMatchObject({ t: 'finished', reason: 'completed' });

        await adapter.stop();
      } finally {
        await safeRmSync(tmpDir);
      }
    },
    40_000,
  );

  if (!shouldRun) {
    it.skip(`(all real-engine tests skipped: ${skipReason()})`, () => {});
  }
});
