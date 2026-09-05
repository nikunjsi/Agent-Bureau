import path from 'node:path';
import { ClaudeCodeAdapter } from '../../src/main/engine/claudeCodeAdapter';

/**
 * The one construction of a real `ClaudeCodeAdapter` for tests that run
 * outside Electron — which is every test in this repo, since vitest never
 * runs inside it.
 *
 * AUDIT #7 exists because this was not shared. `realAgentGate.test.ts`
 * knew to inject `resolveBureauHookScriptPath` (the real resolver reads
 * Electron's `app`, which is `undefined` under plain-Node vitest);
 * `realEngineSpawn.test.ts`, written earlier, constructed
 * `new ClaudeCodeAdapter()` bare. When M4 introduced the Electron
 * dependency, the second file started throwing `TypeError: Cannot read
 * properties of undefined (reading 'isPackaged')` and nobody noticed for
 * a milestone — it is gated behind real API spend, so nothing ever ran it.
 *
 * Both gated tests now build their adapter here, and
 * `realEngineAdapterWiring.test.ts` exercises this function for free in
 * CI. That is the anti-rot mechanism: the wiring an expensive test depends
 * on is checked by a cheap one, so this class of breakage surfaces without
 * anyone opting into spend.
 */
export function createRealClaudeCodeAdapterForTests(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    // The real bundled file `npm run build` produces. Not a stub path:
    // resourcePaths.test.ts separately proves the packaged app resolves
    // the same script under process.resourcesPath.
    resolveBureauHookScriptPath: () => path.resolve('dist/resources/bin/bureau-hook.js'),
  });
}

/** The bundled `bureau-tools.js` entry point, resolved the same way and
 *  for the same reason. */
export function resolveBureauToolsScriptPathForTests(): string {
  return path.resolve('dist/resources/bin/bureau-tools.js');
}
