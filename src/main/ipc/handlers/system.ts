import { app, shell } from 'electron';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createBackup } from '../../db/backup';
import { getEmployeeStateDir } from '../../db/paths';
import { readActivityLogTail, getMaxMirrorSeq } from '../../db/activityLog';
import { listEmployees } from '../../db/repositories/employees';
import { listPrereqs } from '../../db/repositories/prereqs';
import { getAllSettings } from '../../db/repositories/settings';
import { redactDeep, redactText } from '../../secrets/redactor';
import { ipcOk } from '../../../shared/ipc/envelope';
import { System as SystemSchemas } from '../../../shared/ipc/schemas/system';
import { stub, type Handler, type HandlerContext } from './types';

/** How much of each log/transcript a bundle keeps — enough to diagnose a
 * real problem, capped so a bundle for a long-running install stays a
 * reasonable size to attach to a support request. */
const SUPPORT_BUNDLE_ACTIVITY_TAIL_ENTRIES = 500;
const SUPPORT_BUNDLE_TRANSCRIPT_TAIL_CHARS = 20_000;

function buildHealthResult() {
  return {
    ok: true as const,
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: 'win32' as const,
  };
}

export const systemHandlers: Record<string, Handler> = {
  health: () => ipcOk({ item: buildHealthResult() }),
  openPath: async (input) => {
    const { path: target } = SystemSchemas.openPath.input.parse(input);
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return ipcOk({ ok: true as const });
  },
  openExternal: async (input) => {
    const { url } = SystemSchemas.openExternal.input.parse(input);
    // §4.2: external links only via shell.openExternal after validating
    // the URL scheme — z.string().url() (schemas/system.ts) already
    // rejects anything that isn't a well-formed URL; restrict further to
    // http(s) so this can never be used to launch an arbitrary protocol
    // handler.
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Refusing to open a non-http(s) URL: ${parsed.protocol}`);
    }
    await shell.openExternal(url);
    return ipcOk({ ok: true as const });
  },
  restart: () => {
    app.relaunch();
    app.exit(0);
    return ipcOk({ ok: true as const });
  },
  backupDb: async (_input, ctx) => {
    const backupPath = await createBackup(ctx.db, ctx.dbPaths.backupsDir);
    return ipcOk({ path: backupPath });
  },
  compactDb: (_input, ctx) => {
    ctx.db.exec('VACUUM');
    // §5.1, a MUST: "Compact database MUST run
    // `INSERT INTO memory_fts(memory_fts) VALUES('rebuild')` after any
    // VACUUM." Missing until audit M0–M2 #6 — and invisible, because the
    // test named for the rebuild ran both statements inline on its own
    // connection and never called this handler at all (standing rule 1).
    // `ftsVacuum.test.ts` now goes through here, so deleting this line
    // fails it.
    ctx.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
    return ipcOk({ ok: true as const });
  },
  openDataFolder: async (_input, ctx) => {
    const dataDir = path.dirname(ctx.dbPaths.dbPath);
    const err = await shell.openPath(dataDir);
    if (err) throw new Error(err);
    return ipcOk({ ok: true as const });
  },
  // M6 session 3: the redactor (§11) exists now, so this is real — every
  // included string passes through `redactDeep`/`redactText` immediately
  // before being written, choke point 6/6 (§11.4). Scoped to one redacted
  // JSON file rather than a zip archive: no archive dependency exists in
  // this repo, and adding one for a single-file feature is a real
  // new-dependency decision left for whoever actually needs a multi-file
  // bundle (a zip's own directory listing has nothing this one JSON file
  // doesn't already carry). Matches the existing IPC contract exactly
  // (`output: z.object({ path: z.string() })` — no schema change).
  supportBundle: async (_input, ctx) => {
    const bundlePath = await buildSupportBundle(ctx);
    return ipcOk({ path: bundlePath });
  },
  checkUpdate: stub('M15'),
  scanFolder: stub('M13'),
};

/**
 * Split out of the handler above for the same reason `secretStore.ts`'s
 * functions take an injectable `safeStorage` — `app.getVersion()` only
 * resolves inside a real, running Electron process (confirmed by this
 * repo's own convention: `resourcePaths.test.ts` exercises `app.isPackaged`
 * -gated code only through a real packaged exe, never plain vitest).
 * Everything else here is plain Node + `ctx.db`, genuinely unit-testable —
 * gating that on a real Electron app too would leave the whole function
 * untested outside a packaged-app smoketest for no reason connected to
 * what it actually does. Real callers never pass `appVersion`.
 */
export async function buildSupportBundle(
  ctx: HandlerContext,
  appVersion: string = app.getVersion(),
): Promise<string> {
  const baseDir = path.dirname(ctx.dbPaths.dbPath);
  const bundleDir = path.join(baseDir, 'support-bundles');
  await fs.mkdir(bundleDir, { recursive: true });

  const activityAfterSeq = Math.max(
    0,
    getMaxMirrorSeq(ctx.db) - SUPPORT_BUNDLE_ACTIVITY_TAIL_ENTRIES,
  );
  const activityTail = existsSync(ctx.dbPaths.activityLogPath)
    ? readActivityLogTail(ctx.dbPaths.activityLogPath, activityAfterSeq)
    : [];

  // `includeArchived` on purpose (M7 session 2, when firing started
  // archiving rather than deleting): a support bundle exists to explain
  // what went wrong, and "the employee who was fired an hour ago" is often
  // exactly the transcript that matters. This is the one caller that wants
  // the whole history rather than the current roster.
  const employees = listEmployees(ctx.db, { includeArchived: true });
  const transcripts: Record<string, string> = {};
  for (const employee of employees) {
    const transcriptPath = path.join(getEmployeeStateDir(baseDir, employee.id), 'transcript.log');
    if (!existsSync(transcriptPath)) continue; // no real hiring flow spawns one yet (M7+) — most employees won't have one
    const raw = await fs.readFile(transcriptPath, 'utf8');
    const tail =
      raw.length > SUPPORT_BUNDLE_TRANSCRIPT_TAIL_CHARS
        ? raw.slice(-SUPPORT_BUNDLE_TRANSCRIPT_TAIL_CHARS)
        : raw;
    // Defense-in-depth, not the only redaction this text ever gets:
    // Supervisor's own RedactionStream already redacted it once before it
    // was ever written to disk (§11.4 choke point 1/6) — this second pass
    // costs nothing and also covers a transcript file written by an older
    // build, before that wiring existed.
    transcripts[employee.id] = redactText(tail);
  }

  const bundle = {
    generatedAt: new Date().toISOString(),
    app: {
      version: appVersion,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: 'win32' as const,
    },
    prereqs: listPrereqs(ctx.db),
    // §11.4: settings never hold a secret VALUE (secretStore.ts stores
    // ciphertext in secrets_meta, never in the settings table) — this is
    // redacted anyway, uniformly with everything else in the bundle,
    // rather than trusting that invariant to hold forever unaudited.
    settings: redactDeep(getAllSettings(ctx.db)),
    activityTail: redactDeep(activityTail),
    employeeTranscriptTails: transcripts,
  };

  const bundlePath = path.join(bundleDir, `bundle-${Date.now()}.json`);
  await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
  return bundlePath;
}
