import { PROBE_LIVENESS_CEILING_MS } from '../../src/shared/engine/types';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newId, nowIso } from '../../src/shared/models/ids';
import { EmployeeSchema } from '../../src/shared/models/employee';
import { RoleSchema } from '../../src/shared/models/role';
import { createRealClaudeCodeAdapterForTests } from '../helpers/realEngineAdapter';
import { provisionTestAnthropicKey, testKeyUnavailableReason } from '../helpers/realEngineKey';
import { applyRealRunBudgets, reportRealRunCost } from '../helpers/realRunBudgets';
import { openConnection } from '../../src/main/db/connection';
import { runMigrations } from '../../src/main/db/migrate';
import { seedSettingsDefaults } from '../../src/main/db/settingsLoader';
import { buildResolvedPath, resolveBinaryAbsolutePath } from '../../src/main/engine/resolvedPath';
import {
  placeholderControlChannel,
  placeholderToolServer,
  type SecretBroker,
} from '../../src/shared/engine/seams';
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
// M11 row S1-6 (E-2): the key comes from a protected file, through the
// secret store and the real broker, never from the subscription sign-in.
const keyUnavailable = testKeyUnavailableReason();
const shouldRun = realClaudePathForGate !== null && explicitlyOptedIn && keyUnavailable === null;

function skipReason(): string {
  if (!realClaudePathForGate)
    return 'claude CLI not found via the resolved-PATH service on this machine';
  if (!explicitlyOptedIn)
    return 'BUREAU_RUN_REAL_ENGINE_TESTS is not set — real-engine tests are opt-in, not automatic';
  if (keyUnavailable !== null) return keyUnavailable;
  return '';
}

if (!shouldRun) {
  // Deliberate, explicit skip reason (§7.8), not a silent no-op.
  console.log(`[realEngineSpawn.test.ts] skipping all real-engine tests: ${skipReason()}`);
}

function fakeEmployeeContext(
  stateDir: string,
  worktreePath: string,
  broker: SecretBroker,
  engineOptions: unknown = null,
  turnBudgetCapUsdMicros: number | null = null,
): EmployeeContext {
  const now = nowIso();
  const employee = EmployeeSchema.parse({
    id: newId(),
    name: 'Quinn',
    role_key: 'engineering:developer',
    is_director: 0,
    desk_x: 0,
    desk_y: 0,
    sprite_variant: 'a',
    status: 'idle',
    status_detail: null,
    engine: 'claude-code',
    engine_mode: null,
    engine_version: null,
    model: null,
    model_tier_override: null,
    session_id: null,
    pid: null,
    process_start_time: null,
    worktree_id: null,
    current_task_id: null,
    autonomy: 'ask',
    autonomous_confirmed_at: null,
    daily_budget_usd_micros: null,
    escalate_when: '[]',
    reports: '{}',
    resume_at: null,
    heartbeat_at: null,
    consecutive_failures: 0,
    lifetime_spend_usd_micros: 0,
    hired_at: now,
    archived_at: null,
    created_at: now,
    updated_at: now,
  });
  const role = RoleSchema.parse({
    id: newId(),
    key: 'developer',
    full_key: 'engineering:developer',
    department_key: 'engineering',
    pack_id: 'engineering',
    priority: 50,
    version: '1.0.0',
    title: 'Developer',
    description: 'Writes code',
    system_prompt_path: 'prompts/developer.md',
    skills: '[]',
    deliverable_types: '[]',
    shared_prompts: '[]',
    input_types: '[]',
    engine_preference: '["claude-code"]',
    model_preference: null,
    tools_allow: '[]',
    tools_deny: '[]',
    network_allow: '[]',
    memory_scopes: '[]',
    memory_budget_tokens: 8000,
    autonomy_default: 'ask',
    max_turns: 1,
    max_attempts: 1,
    wall_clock_timeout_s: 60,
    budget_usd_micros: null,
    escalate_when: '[]',
    reports: '{}',
    sprite_key: 'dev',
    role_options: '{}',
    engine_options: engineOptions === null ? null : JSON.stringify(engineOptions),
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  return {
    employee,
    role,
    task: null,
    worktreePath,
    stateDir,
    baseDir: stateDir,
    toolServer: placeholderToolServer,
    controlChannel: placeholderControlChannel,
    broker,
    modelId: null,
    turnBudgetCapUsdMicros,
  };
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

async function collectUntilFinished(
  events: AsyncIterable<AgentEvent>,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const iterator = events[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new Error(`collectUntilFinished timed out; got so far: ${JSON.stringify(collected)}`);
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('per-event timeout')), remaining),
      ),
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
        const dbPath = path.join(tmpDir, 'bureau.db');
        const db = openConnection(dbPath);
        await runMigrations({
          db,
          dbPath,
          migrationsDir: path.resolve('src/main/db/migrations'),
          backupsDir: path.join(tmpDir, 'backups'),
        });
        seedSettingsDefaults(db);
        // M11 rule 12 / E-7: a real run is capped before it spends. There is
        // no Supervisor on this path to derive the per-turn cap, so the
        // per-task budget is passed into the context here, which is what
        // becomes the CLI's own --max-budget-usd.
        const budgets = applyRealRunBudgets(db);
        const broker = await provisionTestAnthropicKey(db);

        const adapter = createRealClaudeCodeAdapterForTests(db);
        const probeResult = await adapter.probe({ budgetMs: PROBE_LIVENESS_CEILING_MS });
        expect(probeResult.installed, probeResult.error ?? '').toBe(true);

        const ctx = fakeEmployeeContext(
          tmpDir,
          tmpDir,
          broker,
          { mode: 'structured' },
          budgets.perTaskMicros,
        );
        await adapter.start(ctx);

        const eventsPromise = collectUntilFinished(adapter.events(), 30_000);
        await adapter.send('Reply with exactly one word: OK', 'task');
        const events = await eventsPromise;

        const textDeltas = events.filter((e) => e.t === 'text.delta');
        const fullText = textDeltas.map((e) => (e.t === 'text.delta' ? e.text : '')).join('');
        // With real auth now genuinely working (confirmed this session),
        // this is finally the literal assertion part 1 could not make.
        expect(fullText.toUpperCase()).toContain('OK');

        reportRealRunCost('realEngineSpawn structured', events);

        const finished = events.find((e) => e.t === 'finished');
        expect(finished).toMatchObject({ t: 'finished', reason: 'completed' });

        await adapter.stop();
        db.close();
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
