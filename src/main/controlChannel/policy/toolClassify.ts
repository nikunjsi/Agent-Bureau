import type { EngineCapabilities, ProbeResult } from '../../../shared/engine/types';
import type { ToolClass } from '../../../shared/policy/types';
import { isBureauTool } from '../../../shared/policy/evaluator';

/**
 * §11.3: tool classes are "declared by each adapter." Nothing in
 * production today maps `employee.engine` (a free-form string —
 * `employees.engine` is `z.string()`, not an enum) to an adapter
 * instance; each adapter is constructed directly by whichever test or
 * (not-yet-built) orchestrator wants one. This is the minimum possible
 * bridge the policy evaluator needs — a static classification lookup, not
 * a general spawn-time adapter registry (that's a separate, likely
 * already-latent gap for whichever milestone builds the real
 * orchestrator, not this one's to fix).
 *
 * The adapter imports below are dynamic (`await import(...)`), not
 * top-level, DELIBERATELY: `ClaudeCodeAdapter` pulls in `resourceScripts.ts`,
 * which imports `electron` at module scope. A top-level import here would
 * make merely LOADING this module (and therefore `server.ts`, and
 * therefore anything that bundles it — bureau-hook, bureau-tools, and
 * every test worker under tests/integration/fixtures/) require a working
 * `electron` install, even for a plain-Node test worker whose own injected
 * `evaluatePolicy` never calls this function at all. Found for real:
 * `tests/integration/controlChannel/coreDiesMidHold.test.ts`'s esbuild-
 * bundled worker failed at process startup ("Electron failed to install
 * correctly") the moment this file imported the adapters eagerly, even
 * though that worker's own evaluator never reaches this code path. Lazy
 * import defers the cost to the one real call site that actually needs
 * it — a real `claude-code` employee's policy check, which only happens
 * inside a real Electron main process anyway.
 *
 * Each adapter is cheap to construct (no I/O in the constructor) and
 * `capabilities()` itself does no I/O either — called fresh each time
 * rather than cached, since the cost is negligible and caching would be
 * one more piece of state to keep correct across engine-capability
 * changes.
 */
export async function capabilitiesForEngine(engine: string): Promise<EngineCapabilities | null> {
  switch (engine) {
    case 'claude-code': {
      const { ClaudeCodeAdapter } = await import('../../engine/claudeCodeAdapter');
      return new ClaudeCodeAdapter().capabilities({} as ProbeResult);
    }
    case 'generic-pty': {
      const { GenericPtyAdapter } = await import('../../engine/genericPtyAdapter');
      return new GenericPtyAdapter().capabilities({} as ProbeResult);
    }
    case 'fake': {
      const { FakeAdapter } = await import('../../engine/fakeAdapter');
      return new FakeAdapter().capabilities({} as ProbeResult);
    }
    default:
      // An unrecognised engine string classifies nothing — every tool
      // call from it falls through to `other`, which denies by default
      // (§11.3). Fail closed on an engine Bureau doesn't know, rather
      // than guessing at its tool surface.
      return null;
  }
}

/**
 * `bureau` is checked centrally (§23.2: "Bureau's own tools, always
 * allowed" is cross-engine by construction — every engine reaches the
 * same MCP tool server, §7.9), never delegated to a per-adapter map.
 * Everything else falls through to the engine's own `toolClasses`
 * declaration, defaulting to `other` (deny by default) when the tool
 * name isn't in it or the engine itself isn't recognised.
 */
export function classifyTool(tool: string, capabilities: EngineCapabilities | null): ToolClass {
  if (isBureauTool(tool)) return 'bureau';
  return capabilities?.toolClasses[tool] ?? 'other';
}
