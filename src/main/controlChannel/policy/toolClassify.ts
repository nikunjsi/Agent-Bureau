import type { EngineCapabilities } from '../../../shared/engine/types';
import type { ToolClass } from '../../../shared/policy/types';
import { isBureauTool } from '../../../shared/policy/evaluator';

/**
 * M6 session 2, Fix B: this file used to construct its own adapter per
 * engine string and fabricate a `{} as ProbeResult}` to answer
 * `capabilities()` with. That answer could disagree with the employee's
 * REAL, running capabilities (mode-aware — `usageReporting` in
 * particular, which item 7/8's cost and budget logic depend on), and
 * re-deriving "which adapter for this engine" a second way (keyed by
 * engine string, not by employee) duplicated exactly what `Supervisor`
 * already holds for that employee's whole lifetime. Removed in favour of
 * `Supervisor.getCapabilities()` (real, probe-and-mode-aware, cached
 * once at `assign()`) — `policyEvaluator.ts` now looks it up via
 * `supervisorRegistry.get(employeeId)`.
 *
 * `bureau` is checked centrally (§23.2: "Bureau's own tools, always
 * allowed" is cross-engine by construction — every engine reaches the
 * same MCP tool server, §7.9), never delegated to a per-adapter map.
 * Everything else falls through to the engine's own `toolClasses`
 * declaration, defaulting to `other` (deny by default) when the tool
 * name isn't in it or `capabilities` is null (no live Supervisor found,
 * or assign() hasn't run yet — fail closed, not a crash).
 */
export function classifyTool(tool: string, capabilities: EngineCapabilities | null): ToolClass {
  if (isBureauTool(tool)) return 'bureau';
  return capabilities?.toolClasses[tool] ?? 'other';
}
