/**
 * §7.9's real stdio MCP server. The agent CLI is the MCP client and spawns
 * this itself (`{command, args, env}` from the employee's explicit MCP
 * config — never repo discovery, §7.6) — Bureau never launches it
 * directly, so its stdio pipe is not an authentication boundary (§7.9's own
 * words); every tool call still authenticates to the Core with the
 * per-employee bearer token read from `BUREAU_CONTROL_FILE`.
 *
 * Run via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (§7.10/§18.1) —
 * no bundled second Node runtime, no dependency on the user's own Node/PATH.
 *
 * Tool set is parameterised at construction (M4 session 2 prompt, explicit)
 * so a future Director build (§7.9's 19 tools, §8.0) is a new definitions
 * array passed to the same buildBureauToolServer(), not a refactor of this
 * file.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { ZodRawShape } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ControlJsonSchema, type ToolCallResponse } from '../../src/shared/controlChannel/schemas';
import { BUREAU_MCP_SERVER_NAME } from '../../src/shared/policy/evaluator';
import {
  ReportStatusArgsSchema,
  TaskDoneArgsSchema,
  TaskBlockedArgsSchema,
  AskDirectorArgsSchema,
  RaiseCheckpointArgsSchema,
  SendMessageArgsSchema,
  ProposeMemoryArgsSchema,
  ReadMemoryArgsSchema,
  ReportArgsSchema,
  GetProjectStateArgsSchema,
  WriteMemoryArgsSchema,
  SearchWorkspaceArgsSchema,
  SetProjectStageArgsSchema,
} from '../../src/main/controlChannel/toolHandlers/schemas';

interface BureauToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
}

// §7.9's eight employee tools — the schemas are the exact same ones
// server.ts's real handlers validate against (toolHandlers/schemas.ts),
// so the tool description the agent sees and the validation it actually
// hits can never quietly disagree.
const EMPLOYEE_TOOL_DEFINITIONS: BureauToolDefinition[] = [
  {
    name: 'bureau_report_status',
    description:
      'Report a short (<=120 char) status line, shown as your speech bubble on the floor. Rate-limited to once per 3 seconds.',
    inputSchema: ReportStatusArgsSchema.shape,
  },
  {
    name: 'bureau_task_done',
    description:
      'The ONLY way to complete your current task. Call this when you are finished, with a summary of what you did and what you verified.',
    inputSchema: TaskDoneArgsSchema.shape,
  },
  {
    name: 'bureau_task_blocked',
    description:
      'Report that your current task cannot proceed right now, and why. The Director decides whether to answer, reassign, or escalate.',
    inputSchema: TaskBlockedArgsSchema.shape,
  },
  {
    name: 'bureau_ask_director',
    description:
      'Ask the Director a question. Your turn ends after this call; you will be given the answer when it arrives.',
    inputSchema: AskDirectorArgsSchema.shape,
  },
  {
    name: 'bureau_raise_checkpoint',
    description:
      'Raise a checkpoint for a human to decide. Every option must state its consequence.',
    inputSchema: RaiseCheckpointArgsSchema.shape,
  },
  {
    name: 'bureau_send_message',
    description:
      'Send a message (handoff, finding, question, answer, or status) to another employee or role.',
    inputSchema: SendMessageArgsSchema.shape,
  },
  {
    name: 'bureau_propose_memory',
    description: 'Propose writing something to shared memory, for future employees to find.',
    inputSchema: ProposeMemoryArgsSchema.shape,
  },
  {
    name: 'bureau_read_memory',
    description: 'Search memory relevant to your current work.',
    inputSchema: ReadMemoryArgsSchema.shape,
  },
];
/**
 * §7.9's Director tools, as far as they are built (M11 row S1-12a). The
 * Director never reports a status bubble, never completes a task and has
 * no worktree, so it is offered its own list rather than the employee's
 * plus extras. It must match DIRECTOR_TOOL_HANDLERS in the Core: a tool
 * advertised here and missing there is a tool the model will call and be
 * refused for, which a test asserts against.
 */
const DIRECTOR_TOOL_DEFINITIONS: BureauToolDefinition[] = [
  {
    name: 'bureau_report',
    description:
      'Post a progress report or a phase summary into the conversation with the user. Your own prose reaches them without a tool; this is for the structured card.',
    inputSchema: ReportArgsSchema.shape,
  },
  {
    name: 'bureau_raise_checkpoint',
    description:
      'Raise a checkpoint for the user to decide. Every option must state its consequence.',
    inputSchema: RaiseCheckpointArgsSchema.shape,
  },
  {
    name: 'bureau_send_message',
    description: 'Send a message to an employee — an answer, an instruction, or a question.',
    inputSchema: SendMessageArgsSchema.shape,
  },
  {
    name: 'bureau_read_memory',
    description: 'Search memory: company standards, project decisions, and past lessons.',
    inputSchema: ReadMemoryArgsSchema.shape,
  },
  {
    name: 'bureau_get_project_state',
    description:
      'Read the current project: its tasks and their statuses, what has been spent, what is blocked, and which checkpoints are open. Cheaper and more current than remembering it.',
    inputSchema: GetProjectStateArgsSchema.shape,
  },
  {
    name: 'bureau_write_memory',
    description:
      'Write a note to memory. Project-scope notes are written immediately; company-scope notes are queued for the user to accept, and are not readable until they do.',
    inputSchema: WriteMemoryArgsSchema.shape,
  },
  {
    name: 'bureau_search_workspace',
    description:
      'Search the project for a pattern, optionally limited by a glob. Reads only inside the project folder.',
    inputSchema: SearchWorkspaceArgsSchema.shape,
  },
  {
    name: 'bureau_set_project_stage',
    description:
      "Move the project to its next lifecycle stage, or start a new project with stage 'intake'. Moves that are the user's (approving the brief or the plan, accepting a phase) are refused.",
    inputSchema: SetProjectStageArgsSchema.shape,
  },
];

interface ControlChannelTarget {
  port: number;
  token: string;
}

function callToolEndpoint(
  target: ControlChannelTarget,
  toolName: string,
  args: unknown,
): Promise<ToolCallResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ idempotencyKey: randomBytes(16).toString('hex'), args });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: target.port,
        method: 'POST',
        path: `/v1/tool/${encodeURIComponent(toolName)}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          authorization: `Bearer ${target.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ToolCallResponse);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function buildBureauToolServer(
  definitions: readonly BureauToolDefinition[],
  target: ControlChannelTarget,
): McpServer {
  const server = new McpServer({ name: BUREAU_MCP_SERVER_NAME, version: '1.0.0' });
  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      { description: definition.description, inputSchema: definition.inputSchema },
      async (args: unknown) => {
        const response = await callToolEndpoint(target, definition.name, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(response) }],
          isError: !response.ok,
        };
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const controlFilePath = process.env['BUREAU_CONTROL_FILE'];
  if (!controlFilePath) {
    process.stderr.write(
      'bureau-tools: BUREAU_CONTROL_FILE is not set — cannot authenticate to the Core.\n',
    );
    process.exit(1);
  }
  const raw = readFileSync(controlFilePath, 'utf8');
  const controlJson = ControlJsonSchema.parse(JSON.parse(raw));

  // M11 row S1-12a: the Director and an employee are offered different
  // tools, and this process is spawned by the engine CLI — control.json is
  // the only thing that tells it which it is serving.
  const definitions = controlJson.isDirector
    ? DIRECTOR_TOOL_DEFINITIONS
    : EMPLOYEE_TOOL_DEFINITIONS;
  const server = buildBureauToolServer(definitions, {
    port: controlJson.port,
    token: controlJson.token,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `bureau-tools failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
