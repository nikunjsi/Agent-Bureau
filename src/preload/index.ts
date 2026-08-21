import { contextBridge, ipcRenderer } from 'electron';
import { HealthResultSchema } from '../shared/ipc/health';
import type { BureauApi } from '../shared/preload/api';

// The only surface the renderer gets. contextIsolation + sandbox are on, so
// this is genuinely the entire boundary — see §4.2.
const bureauApi: BureauApi = {
  system: {
    async health() {
      const result = await ipcRenderer.invoke('system.health');
      // Validated on the way out of main (src/main/ipc/health.ts) and again
      // here on the way into the renderer — §4.2 requires both directions.
      return HealthResultSchema.parse(result);
    },
  },
};

contextBridge.exposeInMainWorld('bureau', bureauApi);
