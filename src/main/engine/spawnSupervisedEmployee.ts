import type Database from 'better-sqlite3';
import type { ActivityLog } from '../db/activityLog';
import type { EngineAdapter } from '../../shared/engine/adapter';
import type { EmployeeContext } from '../../shared/engine/types';
import { getEmployeeStateDir } from '../db/paths';
import { writeControlJsonWithAcl, type TokenRegistry } from '../controlChannel/tokens';
import { resolveBureauToolsScriptPath } from './resourceScripts';
import { Supervisor, type SupervisorOptions } from './supervisor';
import type { SupervisorRegistry } from './supervisorRegistry';

/**
 * The one real place §7.10's control.json gets minted and §7.9's MCP tool
 * server descriptor gets built for a real employee — the actual wiring
 * point EmployeeContext.controlChannel/toolServer describe as "M4
 * placeholder until then" (seams.ts). Nothing in production calls this yet
 * (hiring a real hired-for-work employee is a later milestone); it exists
 * now because the M4 gate needs a real, non-placeholder spawn to prove
 * against, and the exact sequence here (mint -> write control.json ->
 * build descriptors -> register) is what any future hiring flow needs
 * unchanged, not something worth re-deriving twice.
 */
export interface SpawnSupervisedEmployeeOptions {
  db: Database.Database;
  activityLog: ActivityLog;
  tokenRegistry: TokenRegistry;
  supervisorRegistry: SupervisorRegistry;
  /** The real bound control-channel port (ControlChannelServer.assignedPort). */
  controlChannelPort: number;
  employeeId: string;
  adapter: EngineAdapter;
  /** baseDir the rest of the app's paths are rooted at (app.getPath('userData') in production). */
  baseDir: string;
  supervisorOptions?: Partial<Omit<SupervisorOptions, 'db' | 'activityLog' | 'adapter' | 'tokenRegistry' | 'supervisorRegistry'>>;
}

export interface SpawnSupervisedEmployeeResult {
  supervisor: Supervisor;
  stateDir: string;
  controlJsonPath: string;
  /** Everything needed to fill EmployeeContext.controlChannel/toolServer —
   * see buildControlChannelAndToolServerContext below. */
  controlChannelPort: number;
  token: string;
}

/**
 * Mints this employee's token, writes control.json with a real, verified
 * ACL (§7.10, M4 session 1), constructs a real Supervisor wired for
 * revocation-on-stop, and registers it — everything needed before
 * `supervisor.assign(ctx)` can be called with a real, complete
 * EmployeeContext. Does NOT call assign() itself, and does NOT build the
 * EmployeeContext itself: the caller still owns the role/task/worktree/
 * memory parts of the context, which this function has no reason to know
 * about. Use buildControlChannelAndToolServerContext (below) with this
 * function's own result to fill in the two fields it IS responsible for.
 */
export async function spawnSupervisedEmployee(options: SpawnSupervisedEmployeeOptions): Promise<SpawnSupervisedEmployeeResult> {
  const { db, activityLog, tokenRegistry, supervisorRegistry, controlChannelPort, employeeId, adapter, baseDir } = options;

  const stateDir = getEmployeeStateDir(baseDir, employeeId);
  const token = tokenRegistry.mint(employeeId);
  const controlJsonPath = await writeControlJsonWithAcl(stateDir, { port: controlChannelPort, token, employeeId });

  const supervisor = new Supervisor(employeeId, {
    db,
    activityLog,
    adapter,
    tokenRegistry,
    supervisorRegistry,
    ...options.supervisorOptions,
  });
  supervisorRegistry.register(employeeId, supervisor);

  return { supervisor, stateDir, controlJsonPath, controlChannelPort, token };
}

/**
 * The two EmployeeContext fields this module exists to stop being M4
 * placeholders for — a small, pure builder so a caller assembling the
 * rest of EmployeeContext (role/task/worktree/memory) can spread this
 * result in without duplicating the URL/env-shape logic.
 *
 * `resolveToolsScriptPath` is injectable for the exact reason
 * ClaudeCodeAdapterOptions.resolveBureauHookScriptPath is: the real
 * resourceScripts.ts function needs a live Electron `app`, which plain-
 * Node tests (vitest never runs inside Electron) don't have.
 */
export function buildControlChannelAndToolServerContext(
  spawned: Pick<SpawnSupervisedEmployeeResult, 'controlChannelPort' | 'token' | 'controlJsonPath'>,
  resolveToolsScriptPath: () => string = resolveBureauToolsScriptPath,
): Pick<EmployeeContext, 'controlChannel' | 'toolServer'> {
  return {
    controlChannel: { url: `http://127.0.0.1:${spawned.controlChannelPort}`, token: spawned.token },
    toolServer: {
      command: process.execPath,
      args: [resolveToolsScriptPath()],
      // §7.10 TRAP #2: set explicitly, never relied on via inheritance
      // through the CLI (see ToolServerDescriptor's own doc comment).
      env: {
        BUREAU_CONTROL_FILE: spawned.controlJsonPath,
        ELECTRON_RUN_AS_NODE: '1',
      },
    },
  };
}
