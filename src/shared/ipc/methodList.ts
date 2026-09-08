/**
 * The single source of truth for the §17.1 `window.bureau` surface — every
 * request/response method, grouped by namespace. Everything else that
 * needs to know "what methods exist" reads from this file rather than
 * re-enumerating it:
 *   - `src/preload/index.ts` builds `window.bureau` from it.
 *   - `src/main/ipc/router.ts` registers one `ipcMain.handle` per entry.
 *   - `scripts/checkIpcSurface.mjs` diffs it against §17.1 in
 *     docs/BUILD-SPEC.md so the two can never silently drift apart.
 *
 * Includes four namespaces (`workspace`, `costs`) and five methods
 * (`projects.exportData`/`deleteData`, `system.backupDb`/`compactDb`/
 * `openDataFolder`) that §17.1's own code block was missing despite being
 * required by §14.5 and §16 elsewhere in the spec — see the M2 plan for
 * the full reasoning. `docs/BUILD-SPEC.md` §17.1 is corrected to match
 * this file in the same commit that adds it.
 */
export const IPC_METHODS = {
  setup: [
    'getState',
    'detectPrereqs',
    'installPrereq',
    'connectEngine',
    'setHomeFolder',
    'complete',
  ],
  company: [
    'get',
    'update',
    'hire',
    'fire',
    'rename',
    'moveDesk',
    'listDepartments',
    'addDepartment',
    'removeDepartment',
  ],
  projects: [
    'list',
    'get',
    'create',
    'open',
    'pause',
    'resume',
    'abandon',
    'setBudget',
    'exportData',
    'deleteData',
  ],
  chat: ['listMessages', 'send', 'stop', 'markRead', 'listConversations'],
  brief: ['get', 'approve', 'requestEdit', 'saveEdit'],
  plan: ['get', 'approve', 'requestEdit'],
  tasks: ['list', 'get', 'cancel', 'retry', 'reassign'],
  checkpoints: ['listPending', 'get', 'answer', 'answerPermission'],
  employees: [
    'list',
    'get',
    'pause',
    'resumeEmployee',
    'interrupt',
    'updateSettings',
    'takeControl',
    'releaseControl',
    'sendInput',
    'resizePty',
  ],
  phases: ['list', 'get', 'submitReview', 'accept', 'requestChanges'],
  deliverables: ['list', 'get', 'accept', 'reject', 'openFolder'],
  artifacts: ['listForTask', 'get'],
  memory: ['list', 'read', 'write', 'remove', 'search', 'reindex'],
  packs: ['list', 'install', 'validate', 'scaffold', 'setEnabled'],
  activity: ['query', 'export', 'openRawLog'],
  floor: ['getLayout', 'moveDesk', 'resetLayout'],
  settings: ['get', 'set', 'getSecretsStatus', 'setSecret', 'clearSecret'],
  system: [
    'health',
    'openPath',
    'openExternal',
    'supportBundle',
    'checkUpdate',
    'restart',
    'scanFolder',
    'backupDb',
    'compactDb',
    'openDataFolder',
  ],
  workspace: ['diffForTask', 'diffForEmployee', 'fileTree'],
  costs: ['summary', 'byProject', 'byEmployee', 'byRole', 'topTasks', 'pricingTable'],
} as const;

export type IpcNamespace = keyof typeof IPC_METHODS;
export type IpcMethod<N extends IpcNamespace> = (typeof IPC_METHODS)[N][number];

/** Every `on.*` subscription — `ipcRenderer.on`, not `invoke`. */
export const IPC_EVENTS = [
  'stateDelta',
  'chatMessage',
  'terminalChunk',
  'activityEvent',
  'checkpointRaised',
  'floorEvent',
  'toast',
] as const;
export type IpcEvent = (typeof IPC_EVENTS)[number];

/** `"namespace.method"` — the literal `ipcMain.handle`/`ipcRenderer.invoke`
 * channel string for one method. */
export function ipcChannel<N extends IpcNamespace>(namespace: N, method: IpcMethod<N>): string {
  return `${namespace}.${method}`;
}

/** Every `[namespace, method]` pair, flattened — what the preload
 * generator and the router both loop over. */
export function allIpcChannels(): Array<{
  namespace: IpcNamespace;
  method: string;
  channel: string;
}> {
  const out: Array<{ namespace: IpcNamespace; method: string; channel: string }> = [];
  for (const namespace of Object.keys(IPC_METHODS) as IpcNamespace[]) {
    for (const method of IPC_METHODS[namespace]) {
      out.push({ namespace, method, channel: `${namespace}.${method}` });
    }
  }
  return out;
}
