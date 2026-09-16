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

/**
 * Every `on.*` subscription — `ipcRenderer.on`, not `invoke`.
 *
 * AUDIT M0–M2 #11: `checkpointRaised` was removed rather than marked. All
 * four of §9.4's surfaces are served without it — the chat card and the
 * Checkpoints badge render from the `checkpoints` slice that `liveState`
 * pushes on every `checkpoint.*` event, the floor signal is M12's, and the
 * desktop notification is raised in the main process and never crosses
 * IPC. A second channel carrying the same state would be standing rule 6's
 * "same decision in two places", and a declared event the architecture no
 * longer needs is worse than a late one: it is a map to a road nobody is
 * going to build.
 */
export const IPC_EVENTS = [
  'stateDelta',
  'chatMessage',
  'terminalChunk',
  'activityEvent',
  'floorEvent',
  'toast',
] as const;
export type IpcEvent = (typeof IPC_EVENTS)[number];

/**
 * AUDIT M0–M2 #11 — events that exist in the contract and that **nothing
 * sends yet**, each with its owner, the same way a handler stub carries its
 * milestone.
 *
 * Five of seven events had no sender while `checkIpcSurface.mjs` reported
 * the surface as matching, so someone tracing a feature from §17.1 followed
 * an event into a mechanism that did not exist. That script now fails on
 * any event with neither a literal `.send('<event>', …)` in `src/main` nor
 * an entry here — and on an entry here for an event that has since gained
 * a sender. **Wiring one of these means deleting its entry.**
 */
export const IPC_EVENTS_NOT_YET_SENT: Readonly<
  Partial<Record<IpcEvent, { readonly owner: string; readonly note: string }>>
> = {
  terminalChunk: {
    owner: 'M14',
    note:
      "§28 M14 item 2's Inspector Terminal tab. The mechanism is built and tested " +
      '(TerminalBroadcaster: coalescing, ring-buffer replay, and the fromSeq/resync protocol ' +
      '§17.2 describes); M3 deliberately deferred the IPC wiring and the xterm.js component.',
  },
  activityEvent: {
    owner: 'M14',
    note:
      "§28 M14 item 3's live Activity timeline. activity.query already serves history; " +
      'nothing pushes new events to an open window.',
  },
  floorEvent: {
    owner: 'M12',
    note: 'One-shot floor animations (§13). M12 draws the floor they animate.',
  },
  toast: {
    owner: 'unassigned',
    note:
      'No §28 item owns in-app toasts and no section of the spec consumes this event; ' +
      "§9.4's notification is a native desktop one raised in the main process. Recorded rather " +
      'than given an invented owner. ToastSchema also carries a kind and a pre-formatted ' +
      'message, the presentation-in-the-payload shape M9 removed from errors; whoever claims ' +
      'this should revisit that before sending anything.',
  },
};

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
