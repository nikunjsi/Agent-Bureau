import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openConnection } from '../../../src/main/db/connection';
import { runMigrations } from '../../../src/main/db/migrate';
import { ActivityLog } from '../../../src/main/db/activityLog';
import { ControlChannelServer } from '../../../src/main/controlChannel/server';
import { TokenRegistry } from '../../../src/main/controlChannel/tokens';
import { SupervisorRegistry } from '../../../src/main/engine/supervisorRegistry';
import { insertRole } from '../../../src/main/db/repositories/roles';
import { insertEmployee, getEmployeeById } from '../../../src/main/db/repositories/employees';
import { newId, nowIso } from '../../../src/shared/models/ids';

const REAL_MIGRATIONS_DIR = path.resolve('src/main/db/migrations');
const BUREAU_TOOLS_SOURCE = path.resolve('resources/bin/bureau-tools.ts');

let bundledToolsPath: string;

beforeEach(async () => {
  const outDir = path.resolve('dist', 'test-bundles');
  mkdirSync(outDir, { recursive: true });
  bundledToolsPath = path.join(outDir, 'bureau-tools-mcp-test.js');
  await esbuild.build({
    entryPoints: [BUREAU_TOOLS_SOURCE],
    outfile: bundledToolsPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
  });
}, 30_000);

afterAll(() => {
  rmSync(path.dirname(bundledToolsPath), { recursive: true, force: true });
});

/**
 * The real MCP round-trip: a real MCP `Client` (the same protocol layer
 * the agent CLI itself uses) spawns the real, bundled `bureau-tools.js`
 * over stdio exactly as `StdioServerParameters` describes it (§7.9: "the
 * agent CLI is the MCP client and spawns the server itself"), lists its
 * tools, and calls one for real — proving the whole path bureau_tools.ts's
 * own header describes: MCP tool call -> this process's own HTTP POST to
 * the real control channel -> the real tool handler -> a real DB write.
 */
describe('bureau-tools.js — real MCP round-trip (M4 session 2)', () => {
  let tmpDir: string;
  let db: Database.Database;
  let activityLog: ActivityLog;
  let server: ControlChannelServer;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-mcp-'));
    const dbPath = path.join(tmpDir, 'bureau.db');
    db = openConnection(dbPath);
    await runMigrations({
      db,
      dbPath,
      migrationsDir: REAL_MIGRATIONS_DIR,
      backupsDir: path.join(tmpDir, 'backups'),
    });
    activityLog = ActivityLog.open(path.join(tmpDir, 'activity.jsonl'), db);
    const now = nowIso();
    db.prepare(
      'INSERT INTO departments (id,key,name,room_rect,enabled,created_at,updated_at) VALUES (?,?,?,?,1,?,?)',
    ).run('dept1', 'engineering', 'Engineering', '{}', now, now);

    const tokenRegistry = new TokenRegistry();
    server = new ControlChannelServer({
      db,
      activityLog,
      tokenRegistry,
      supervisorRegistry: new SupervisorRegistry(),
    });
    const port = await server.start();

    const role = insertRole(db, {
      key: `developer-${newId()}`,
      department_key: 'engineering',
      pack_id: 'engineering',
      version: '1.0.0',
      title: 'Developer',
      description: 'd',
      system_prompt_path: 'p.md',
      skills: [],
      deliverable_types: [],
      engine_preference: ['claude-code'],
      tools_allow: [],
      tools_deny: [],
      memory_scopes: [],
      autonomy_default: 'guided',
      sprite_key: 'dev',
    } as never);
    const employee = insertEmployee(db, {
      name: `emp-${newId()}`,
      role_key: role.full_key,
      is_director: false,
      desk_x: 0,
      desk_y: 0,
      sprite_variant: 'a',
      status: 'working',
      engine: 'claude-code',
      autonomy: 'guided',
    } as never);
    const token = tokenRegistry.mint(employee.id);

    // §7.10: control.json — exactly what buildLaunchSpec (M4 session 2)
    // writes for a real employee, read by BUREAU_CONTROL_FILE.
    const controlJsonPath = path.join(tmpDir, 'control.json');
    writeFileSync(
      controlJsonPath,
      JSON.stringify({ port, token, employeeId: employee.id }),
      'utf8',
    );

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledToolsPath],
      env: { BUREAU_CONTROL_FILE: controlJsonPath },
    });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await server.stop();
    activityLog.close();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists all eight employee tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'bureau_ask_director',
        'bureau_propose_memory',
        'bureau_raise_checkpoint',
        'bureau_read_memory',
        'bureau_report_status',
        'bureau_send_message',
        'bureau_task_blocked',
        'bureau_task_done',
      ].sort(),
    );
  });

  it('calling bureau_report_status through the real MCP client actually updates the DB', async () => {
    const employeeRow = db.prepare('SELECT id FROM employees LIMIT 1').get() as { id: string };
    const result = await client.callTool({
      name: 'bureau_report_status',
      arguments: { status_detail: 'writing the gate test' },
    });
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    expect(getEmployeeById(db, employeeRow.id)?.status_detail).toBe('writing the gate test');
  });

  it("a malformed call surfaces isError:true with the real handler's specific message", async () => {
    const result = await client.callTool({ name: 'bureau_report_status', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toMatch(/status_detail/);
  });
});
