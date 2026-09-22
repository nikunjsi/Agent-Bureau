import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { EmployeeContext } from '../../src/shared/engine/types';

/**
 * Makes a scripted FakeAdapter turn call a Bureau tool **for real** (M11
 * row S1-11a).
 *
 * FakeAdapter only emits scripted events, so a "tool call" in a script
 * reaches nothing. With the real engine a call travels CLI → the
 * `bureau-tools` MCP server → the control channel → the handler, and a
 * test that skipped that path would be asserting against a stand-in —
 * standing rule 1's exact failure.
 *
 * This is the same request `resources/bin/bureau-tools.ts` makes: real
 * loopback HTTP, the employee's real bearer token, a fresh idempotency
 * key, and the handler the Core actually registered. It deliberately does
 * NOT reimplement anything the server does; it is the wire, nothing else.
 *
 * The result is returned so the next scripted step can use it, exactly as
 * a real agent would see the tool's reply mid-turn.
 */
export interface BureauToolResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly [key: string]: unknown;
}

export interface ControlChannelTarget {
  readonly url: string;
  readonly token: string;
}

/** The control-channel target an adapter was started with. */
export function targetFromContext(ctx: EmployeeContext): ControlChannelTarget {
  return { url: ctx.controlChannel.url, token: ctx.controlChannel.token };
}

export function callBureauTool(
  target: ControlChannelTarget,
  toolName: string,
  args: unknown,
): Promise<BureauToolResponse> {
  const port = Number(new URL(target.url).port);
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ idempotencyKey: randomBytes(16).toString('hex'), args });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
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
          const body = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(body) as BureauToolResponse);
          } catch {
            // A non-JSON body is itself the answer a real agent would get.
            reject(
              new Error(`tool ${toolName} replied with non-JSON (${res.statusCode}): ${body}`),
            );
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
