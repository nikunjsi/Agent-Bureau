/**
 * §7.10's PreToolUse hook — a plain command-type hook registered against
 * every tool call, gating each one through the Core's /v1/policy/check.
 * Run via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, ships via
 * `extraResources`, same reasoning as bureau-tools.ts's own header.
 *
 * Fail-closed is THIS FILE's own responsibility, never an assumption about
 * the engine's hook-timeout behaviour (confirmed against the current docs:
 * a timed-out PreToolUse `command` hook fails OPEN — the tool call proceeds
 * through normal permission flow regardless). Three durations, reconciled:
 *   1. settings.permissions.maxHoldMinutes — how long the Core holds a
 *      pending checkpoint open for a human (not this file's concern).
 *   2. The registered PreToolUse hook timeout (claudeCodeAdapter.ts writes
 *      this into the hook config as maxHoldMinutes + 5min) — how long the
 *      ENGINE waits for this script before giving up on it (fails open).
 *   3. settings.permissions.hookSelfDeadlineMs (this file) — strictly LESS
 *      than (2), validated at adapter build time. This script always
 *      answers with a real deny before (2) could ever be the thing that
 *      decides, which is the actual fail-closed mechanism.
 *
 * Reuses checkPolicyFailClosed (M4 session 1) — the one place the judgment
 * call "what counts as deny" lives, now proven by three different callers
 * (a unit test, the real-process-kill integration test, and this real
 * production script).
 */
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { ControlJsonSchema, type PolicyCheckRequest } from '../../src/shared/controlChannel/schemas';
import { checkPolicyFailClosed } from '../../src/shared/controlChannel/policyCheckClient';

interface HookStdinPayload {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function buildPreview(input: HookStdinPayload): string {
  try {
    return JSON.stringify(input.tool_input).slice(0, 500);
  } catch {
    return '(unrenderable tool_input)';
  }
}

/** Races the real HTTP call against this script's own self-deadline —
 * whichever loses, the caller (checkPolicyFailClosed) treats as a
 * transport failure and denies. The timer is exactly what makes "the Core
 * is taking a long time to answer" (fine — the whole point of the
 * long-poll) distinguishable from "this script gave up waiting" (deny). */
function policyCheckWithSelfDeadline(
  port: number,
  token: string,
  request: PolicyCheckRequest,
  selfDeadlineMs: number,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(request);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`bureau-hook: self-deadline of ${selfDeadlineMs}ms exceeded waiting for the Core`));
    }, selfDeadlineMs);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/v1/policy/check',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), authorization: `Bearer ${token}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      },
    );
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    req.write(payload);
    req.end();
  });
}

function printDecision(verdict: 'allow' | 'deny', reason: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict,
        permissionDecisionReason: reason,
      },
    })}\n`,
  );
}

async function main(): Promise<void> {
  const stdinRaw = await readAllStdin();
  const hookInput = JSON.parse(stdinRaw) as HookStdinPayload;

  const controlFilePath = process.env['BUREAU_CONTROL_FILE'];
  if (!controlFilePath) {
    printDecision('deny', 'bureau-hook: BUREAU_CONTROL_FILE is not set — cannot reach the Core.');
    process.exit(2);
  }

  const selfDeadlineMs = Number.parseInt(process.env['BUREAU_HOOK_SELF_DEADLINE_MS'] ?? '', 10) || 30 * 60_000;

  let controlJson;
  try {
    controlJson = ControlJsonSchema.parse(JSON.parse(readFileSync(controlFilePath, 'utf8')));
  } catch (err) {
    // A missing/unreadable/malformed control.json is the same class of
    // problem as the Core being unreachable — fail closed identically.
    printDecision('deny', `bureau-hook: could not read control.json (${err instanceof Error ? err.message : String(err)})`);
    process.exit(2);
    return;
  }

  const request: PolicyCheckRequest = {
    callId: hookInput.tool_use_id,
    tool: hookInput.tool_name,
    rawTool: hookInput.tool_name,
    args: hookInput.tool_input,
    preview: buildPreview(hookInput),
  };

  const outcome = await checkPolicyFailClosed(() =>
    policyCheckWithSelfDeadline(controlJson.port, controlJson.token, request, selfDeadlineMs),
  );

  printDecision(outcome.verdict, outcome.reason);
  process.exit(outcome.verdict === 'allow' ? 0 : 2);
}

main().catch((err) => {
  // Anything unexpected (stdin unreadable, a bug in this script) is still
  // a case where no real verdict was obtained — fail closed, never let an
  // unhandled exception here fall through to the engine's own fail-open
  // hook-timeout behaviour.
  printDecision('deny', `bureau-hook: unexpected error (${err instanceof Error ? err.message : String(err)})`);
  process.exit(2);
});
