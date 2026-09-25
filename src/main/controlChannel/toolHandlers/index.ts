import { handleReportStatus } from './reportStatus';
import { handleTaskDone } from './taskDone';
import { handleTaskBlocked } from './taskBlocked';
import { handleAskDirector } from './askDirector';
import { handleRaiseCheckpoint } from './raiseCheckpoint';
import { handleSendMessage } from './sendMessage';
import { handleProposeMemory } from './proposeMemory';
import { handleReadMemory } from './readMemory';
import { handleReport } from './report';
import { handleGetProjectState } from './getProjectState';
import { handleWriteMemory } from './writeMemory';
import { handleSearchWorkspace } from './searchWorkspace';
import { handleSetProjectStage } from './setProjectStage';
import type { ToolHandler } from './types';

export type { ToolHandlerContext, ToolHandlerResult, ToolHandler } from './types';

/**
 * §7.9's eight employee tools, all real this session (M4 session 2) —
 * FULL, ROW ONLY, or HONEST EMPTY per the prompt's own per-tool
 * breakdown, never a partial/half-built implementation of any one of
 * them. Keyed by the exact tool name bureau-tools registers with the MCP
 * server (the name after `mcp__bureau__` is stripped — server.ts's own
 * /v1/tool/:name route already carries the tool name as its own URL
 * segment, independent of the MCP-namespaced form the policy evaluator
 * has to match; see policyEvaluator.ts's own comment on why those two
 * names differ).
 *
 * The Director's tools live in DIRECTOR_TOOL_HANDLERS below, keyed the
 * same way and sharing this exact ToolHandler type (M11 row S1-12a).
 */
export const EMPLOYEE_TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  bureau_report_status: handleReportStatus,
  bureau_task_done: handleTaskDone,
  bureau_task_blocked: handleTaskBlocked,
  bureau_ask_director: handleAskDirector,
  bureau_raise_checkpoint: handleRaiseCheckpoint,
  bureau_send_message: handleSendMessage,
  bureau_propose_memory: handleProposeMemory,
  bureau_read_memory: handleReadMemory,
};

/**
 * §7.9's Director tools, as far as they are built (M11 row S1-12a).
 *
 * The Director is not an employee with a task: it has no worktree, never
 * reports a status bubble and never completes a task, so it gets its own
 * set rather than the employee set plus extras. Three tools are genuinely
 * the same act for either caller and are shared, not copied — asking a
 * person something, sending a message, and reading memory.
 *
 * §S2 and §S3 add the rest; a tool that is not in this map is not
 * advertised to the model, and answers NOT_IMPLEMENTED if called.
 */
export const DIRECTOR_TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = {
  bureau_report: handleReport,
  bureau_raise_checkpoint: handleRaiseCheckpoint,
  bureau_send_message: handleSendMessage,
  bureau_read_memory: handleReadMemory,
  // S1-12b. The last two touch the filesystem on the agent's say-so, and
  // policy never sees a `bureau_` tool (§23.2) — each carries its own
  // confinement, tested at the handler.
  bureau_get_project_state: handleGetProjectState,
  bureau_write_memory: handleWriteMemory,
  bureau_search_workspace: handleSearchWorkspace,
  // S2-1b: creates a project (intake) or moves its stage (§8 with A.3).
  bureau_set_project_stage: handleSetProjectStage,
};

/** The tools this caller may use: the Director's set, or an employee's. */
export function toolHandlersFor(isDirector: boolean): Readonly<Record<string, ToolHandler>> {
  return isDirector ? DIRECTOR_TOOL_HANDLERS : EMPLOYEE_TOOL_HANDLERS;
}

/** Every tool name Bureau knows, whoever may call it. */
export function isKnownBureauTool(toolName: string): boolean {
  return toolName in EMPLOYEE_TOOL_HANDLERS || toolName in DIRECTOR_TOOL_HANDLERS;
}
