import { handleReportStatus } from './reportStatus';
import { handleTaskDone } from './taskDone';
import { handleTaskBlocked } from './taskBlocked';
import { handleAskDirector } from './askDirector';
import { handleRaiseCheckpoint } from './raiseCheckpoint';
import { handleSendMessage } from './sendMessage';
import { handleProposeMemory } from './proposeMemory';
import { handleReadMemory } from './readMemory';
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
 * The Director's 19 tools (§7.9) are NOT here — M11's job. Nothing about
 * this map's shape stops that: a Director build adds its own entries
 * keyed the same way, sharing this exact ToolHandler type.
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
