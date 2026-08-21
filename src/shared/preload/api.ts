import type { HealthResult } from '../ipc/health';

/**
 * The full surface exposed on `window.bureau` by the preload script
 * (src/preload/index.ts). This is the single source of truth for that
 * shape — preload, the renderer's ambient `Window` typing, and tests all
 * import it, so the three can never silently drift apart.
 */
export interface BureauApi {
  system: {
    health(): Promise<HealthResult>;
  };
}
