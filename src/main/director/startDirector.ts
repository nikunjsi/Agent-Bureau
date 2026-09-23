import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { TokenRegistry } from '../controlChannel/tokens';
import type { SupervisorRegistry } from '../engine/supervisorRegistry';
import { getDirectorEmployee } from '../db/repositories/employees';
import { resolveConversationForDelivery } from '../db/repositories/conversations';
import { UserFacingError } from '../../shared/errors/userFacing';
import { appendChatMessage } from '../chat/appendMessage';
import { getRoleByFullKey } from '../db/repositories/roles';
import {
  buildControlChannelAndToolServerContext,
  spawnSupervisedEmployee,
  type SpawnSupervisedEmployeeOptions,
} from '../engine/spawnSupervisedEmployee';
import { resolveBureauToolsScriptPath } from '../engine/resourceScripts';
import { createClaudeCodeAdapterFromSettings } from '../engine/claudeCodeAdapter';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { ContainProcess } from '../engine/containEngineChild';
import type { SecretBroker } from '../../shared/engine/seams';
import type { EmployeeContext } from '../../shared/engine/types';

/**
 * Starts the Director's Supervisor — the first production caller of
 * `spawnSupervisedEmployee` (M11 row S1-8; pre-M11 §M11 item 2).
 *
 * **At startup, not lazily.** §8.0 calls the Director "the only always-warm
 * agent process", and the restart report needs a live Director at boot.
 * Starting costs nothing: in structured mode the engine is spawned once per
 * turn, and no turn runs until something wakes the Director.
 *
 * **The adapter comes from `createClaudeCodeAdapterFromSettings(db)`**, the
 * only construction that carries the user's hook timing (pre-M11 §F, S-1).
 * `createAdapter` is the seam a test swaps the engine at; nothing else about
 * the chain is injectable.
 *
 * **The model is not decided here.** `Supervisor.assign()` is the one place
 * (standing rule 6); this passes no model.
 */
export interface StartDirectorDeps {
  readonly db: Database.Database;
  readonly activityLog: ActivityLog;
  readonly tokenRegistry: TokenRegistry;
  readonly supervisorRegistry: SupervisorRegistry;
  readonly controlChannelPort: number;
  readonly baseDir: string;
  readonly secretBroker: SecretBroker;
  /**
   * M11 row S1-9: puts each engine process the Director's adapter spawns
   * into Bureau's Job Object. Required, so the production caller cannot
   * forget it; `main()` passes the real `containProcess`.
   */
  readonly containProcess: ContainProcess;
  readonly createAdapter?: (db: Database.Database) => EngineAdapter;
  readonly resolveToolsScriptPath?: () => string;
  readonly supervisorOptions?: SpawnSupervisedEmployeeOptions['supervisorOptions'];
}

export type StartDirectorResult =
  | { readonly status: 'started'; readonly employeeId: string }
  | { readonly status: 'already_running'; readonly employeeId: string }
  | { readonly status: 'no_director' }
  | { readonly status: 'engine_unsuitable'; readonly employeeId: string; readonly message: string }
  /**
   * The engine could run, but something the user has to set is not set —
   * today, the Anthropic API key `assign()` requires before a real
   * claude-code launch (M11 S1-7a, risk #34's E-4a). Distinct from
   * `engine_unsuitable`, which is about what the engine cannot do: this
   * one the user can fix in Settings, and the message says how.
   */
  | { readonly status: 'not_configured'; readonly employeeId: string; readonly message: string };

/**
 * §8.0: "An engine without MCP support cannot host the Director, and Bureau
 * says so plainly at startup rather than failing obscurely." Plain words:
 * no capability names.
 */
export const DIRECTOR_ENGINE_UNSUITABLE_MESSAGE =
  "The Director can't run on this engine: it needs one that can use Bureau's tools and pick up " +
  'a conversation where it left off. Choose Claude in Settings to give the Director an engine it can use.';

export async function startDirector(deps: StartDirectorDeps): Promise<StartDirectorResult> {
  const { db, supervisorRegistry } = deps;
  const director = getDirectorEmployee(db);
  if (!director) return { status: 'no_director' };
  if (supervisorRegistry.get(director.id)) {
    return { status: 'already_running', employeeId: director.id };
  }

  const role = getRoleByFullKey(db, director.role_key);
  if (!role) throw new Error(`the Director's role ${director.role_key} is not installed`);

  const adapter = deps.createAdapter
    ? deps.createAdapter(db)
    : createClaudeCodeAdapterFromSettings(db, { containProcess: deps.containProcess });
  const spawned = await spawnSupervisedEmployee({
    db,
    activityLog: deps.activityLog,
    tokenRegistry: deps.tokenRegistry,
    supervisorRegistry,
    controlChannelPort: deps.controlChannelPort,
    employeeId: director.id,
    adapter,
    baseDir: deps.baseDir,
    ...(deps.supervisorOptions ? { supervisorOptions: deps.supervisorOptions } : {}),
  });

  const ctx: EmployeeContext = {
    employee: director,
    role,
    // §8.0: the Director has no task and no worktree. It is woken by
    // triggers, and works in its own state directory.
    task: null,
    worktreePath: '',
    stateDir: spawned.stateDir,
    baseDir: deps.baseDir,
    broker: deps.secretBroker,
    modelId: null,
    turnBudgetCapUsdMicros: null,
    ...buildControlChannelAndToolServerContext(
      spawned,
      deps.resolveToolsScriptPath ?? resolveBureauToolsScriptPath,
    ),
  };

  try {
    await spawned.supervisor.assign(ctx);
  } catch (err) {
    // Nothing is left half-running: a Director that could not start is
    // stopped and unregistered, and the caller reports why.
    await spawned.supervisor.stop();
    // A refusal written for the user is not an internal error. `main()`
    // calls this unawaited and its `.catch` only reaches the terminal, so
    // rethrowing one of these would mean the person who has to fix it is
    // the one person who never sees it (M11 S1-7a). Returned instead, and
    // `reportDirectorStart` puts it in the chat.
    if (err instanceof UserFacingError) {
      return { status: 'not_configured', employeeId: director.id, message: err.message };
    }
    throw err;
  }

  const capabilities = spawned.supervisor.getCapabilities();
  if (!capabilities?.mcpServers || !capabilities.sessionResume) {
    await spawned.supervisor.stop();
    return {
      status: 'engine_unsuitable',
      employeeId: director.id,
      message: DIRECTOR_ENGINE_UNSUITABLE_MESSAGE,
    };
  }

  return { status: 'started', employeeId: director.id };
}

/**
 * Tells the user when the Director could not start, in the chat when there
 * is a conversation to put it in, and in the log either way. Nothing is
 * said for `started`, `already_running` or `no_director`: the first two are
 * not news, and before a Director is hired the setup flow is what speaks.
 */
export function reportDirectorStart(
  deps: { readonly db: Database.Database; readonly activityLog: ActivityLog },
  result: StartDirectorResult,
): void {
  if (result.status !== 'engine_unsuitable' && result.status !== 'not_configured') return;
  console.error(`[director] not started: ${result.message}`);
  const conversation = resolveConversationForDelivery(deps.db, null);
  if (!conversation) return;
  appendChatMessage(deps, {
    conversationId: conversation.id,
    author: 'system',
    kind: 'error',
    body: result.message,
    payload: {
      code:
        result.status === 'not_configured'
          ? 'director_not_configured'
          : 'director_engine_unsuitable',
      explanation: result.message,
    },
  });
}
