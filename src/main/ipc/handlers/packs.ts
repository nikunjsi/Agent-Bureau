import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ipcOk, ipcError } from '../../../shared/ipc/envelope';
import { Packs as PacksSchemas } from '../../../shared/ipc/schemas/packs';
import { listPacks, getPackByKey, setPackEnabled } from '../../db/repositories/packs';
import { getPacksDir } from '../../db/paths';
import { loadPack } from '../../packs/loadPack';
import { validatePack } from '../../packs/validatePack';
import { installPack } from '../../packs/installPack';
import { scaffoldPack, PackAlreadyExistsError } from '../../packs/scaffoldPack';
import type { Handler, HandlerContext } from './types';

/**
 * §6's five pack methods, all real as of M7.
 *
 * `list` reports what the DB knows about INSTALLED packs, plus the bundled
 * ones sitting in `resourcesPath/packs` that have not been installed yet —
 * a user needs to see a pack in order to install it, and the DB only
 * learns about one after they have.
 */

/** Bundled pack directories on disk, whether or not they are installed. */
function bundledPackKeys(ctx: HandlerContext): string[] {
  if (!existsSync(ctx.bundledPacksDir)) return [];
  return readdirSync(ctx.bundledPacksDir).filter((entry) =>
    statSync(path.join(ctx.bundledPacksDir, entry)).isDirectory(),
  );
}

const list: Handler = (_input, ctx) => {
  const installed = listPacks(ctx.db);
  const installedKeys = new Set(installed.map((row) => row.key));

  const items = installed.map((row) => {
    const dir =
      row.origin === 'bundled'
        ? path.join(ctx.bundledPacksDir, row.key)
        : path.join(getPacksDir(ctx.baseDir), row.key);
    const loaded = loadPack(dir);
    return {
      key: row.key,
      name: row.name,
      version: row.version,
      description: loaded.pack?.manifest.description ?? '',
      // The user's intent AND the validation outcome, together. §6.7's
      // "disabled with a readable error" is an unavailable pack with a
      // reason, not a flipped setting — so a pack the user left on that
      // failed validation reports `enabled: false` HERE, at the read
      // boundary, while its stored intent stays true.
      enabled: row.enabled && row.last_validation_status === 'ok',
      departments: loaded.pack?.manifest.departments ?? [],
    };
  });

  // Bundled packs the user has not installed. Without these, a fresh
  // install shows an empty Packs screen and no way to get anywhere.
  for (const key of bundledPackKeys(ctx)) {
    if (installedKeys.has(key)) continue;
    const loaded = loadPack(path.join(ctx.bundledPacksDir, key));
    if (loaded.pack === null) continue;
    items.push({
      key,
      name: loaded.pack.manifest.name,
      version: loaded.pack.manifest.version,
      description: loaded.pack.manifest.description,
      enabled: false,
      departments: loaded.pack.manifest.departments,
    });
  }

  return ipcOk(
    PacksSchemas.list.output.parse({ items: items.sort((a, b) => a.key.localeCompare(b.key)) }),
  );
};

/**
 * `source` is either a bundled pack's key or an absolute directory path.
 * Resolved here rather than by the caller so the renderer never has to
 * know where `resourcesPath` is — it has no Node access and could not
 * construct that path anyway (CLAUDE.md invariant #11).
 */
function resolveSource(
  ctx: HandlerContext,
  source: string,
): { dir: string; origin: 'bundled' | 'user' } | null {
  const bundled = path.join(ctx.bundledPacksDir, source);
  if (!path.isAbsolute(source) && existsSync(bundled)) return { dir: bundled, origin: 'bundled' };
  if (path.isAbsolute(source) && existsSync(source)) return { dir: source, origin: 'user' };
  return null;
}

const validate: Handler = (input, ctx) => {
  const { source } = PacksSchemas.validate.input.parse(input);
  const resolved = resolveSource(ctx, source);
  if (!resolved) {
    return ipcOk(
      PacksSchemas.validate.output.parse({
        valid: false,
        errors: [`No pack found at "${source}".`],
      }),
    );
  }

  const loaded = loadPack(resolved.dir);
  if (loaded.pack === null) {
    return ipcOk(PacksSchemas.validate.output.parse({ valid: false, errors: loaded.errors }));
  }

  const result = validatePack(loaded.pack, { appVersion: ctx.appVersion });
  return ipcOk(
    PacksSchemas.validate.output.parse({
      valid: result.errors.length === 0,
      // Warnings are surfaced alongside errors rather than dropped —
      // `valid` already says which is which, and a warning the user never
      // sees is a check that did not happen as far as they are concerned.
      errors: [...result.errors, ...result.warnings.map((w) => `warning: ${w}`)],
    }),
  );
};

const install: Handler = (input, ctx) => {
  const { source } = PacksSchemas.install.input.parse(input);
  const resolved = resolveSource(ctx, source);
  if (!resolved) {
    return ipcError('NOT_FOUND', `No pack found at "${source}". Check the folder and try again.`, {
      type: 'retry',
    });
  }

  const result = installPack({
    db: ctx.db,
    activityLog: ctx.activityLog,
    baseDir: ctx.baseDir,
    sourceDir: resolved.dir,
    origin: resolved.origin,
    appVersion: ctx.appVersion,
  });

  if (!result.installed) {
    // §14.6: plain language, then the detail. The errors are already
    // written for a pack author to act on — `validatePack` names the file
    // and the field in every one.
    return ipcError(
      'VALIDATION_FAILED',
      `That pack could not be installed:\n${result.errors.join('\n')}`,
      { type: 'retry' },
    );
  }

  return ipcOk(PacksSchemas.install.output.parse({ ok: true }));
};

const scaffold: Handler = (input, ctx) => {
  const { name } = PacksSchemas.scaffold.input.parse(input);
  try {
    scaffoldPack({ baseDir: ctx.baseDir, key: name, appVersion: ctx.appVersion });
    return ipcOk(PacksSchemas.scaffold.output.parse({ ok: true }));
  } catch (err) {
    if (err instanceof PackAlreadyExistsError) {
      // `VALIDATION_FAILED` rather than a new `CONFLICT` code: §17's error
      // set is deliberately closed ("not invented per handler"), and the
      // name genuinely is invalid — it is taken. Widening the set for one
      // case is a bigger change than it is worth.
      return ipcError(
        'VALIDATION_FAILED',
        `A pack called "${name}" already exists. Pick a different name.`,
        {
          type: 'retry',
        },
      );
    }
    return ipcError('VALIDATION_FAILED', (err as Error).message, { type: 'retry' });
  }
};

const setEnabled: Handler = (input, ctx) => {
  const { key, enabled } = PacksSchemas.setEnabled.input.parse(input);
  if (!getPackByKey(ctx.db, key)) {
    return ipcError('NOT_FOUND', `No pack called "${key}" is installed.`);
  }
  setPackEnabled(ctx.db, key, enabled);
  return ipcOk(PacksSchemas.setEnabled.output.parse({ ok: true }));
};

export const packsHandlers: Record<string, Handler> = {
  list,
  install,
  validate,
  scaffold,
  setEnabled,
};
