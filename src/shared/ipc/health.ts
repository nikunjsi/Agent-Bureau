import { z } from 'zod';

/**
 * Result of `window.bureau.system.health()`. M0's one IPC method, used to
 * prove the renderer <-> preload <-> main bridge works end to end inside the
 * packaged app. The general IPC envelope (`{ok:true,data}|{ok:false,error}`)
 * and the full schema registry both belong to M2 (§28); this stays deliberately
 * small until that exists.
 */
export const HealthResultSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.literal('win32'),
});

export type HealthResult = z.infer<typeof HealthResultSchema>;
