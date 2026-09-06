// Build pipeline (BUILD-SPEC.md §18.1), M0 slice: renderer (Vite), main and
// preload (esbuild), and the resources/bin helper scripts (esbuild). The
// final `electron-builder` packaging step lives in `npm run package`, not
// here, so `npm run build` stays fast and CI can typecheck/lint against its
// output without packaging every time.

import { build as viteBuild } from 'vite';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rm, mkdir, readdir, copyFile, cp } from 'node:fs/promises';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(rootDir, 'dist');

const NATIVE_EXTERNALS = ['better-sqlite3', 'node-pty', '@bureau/job-object'];

async function buildRenderer() {
  await viteBuild({
    root: path.join(rootDir, 'src', 'renderer'),
    configFile: path.join(rootDir, 'src', 'renderer', 'vite.config.ts'),
  });
}

async function buildMain() {
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'main', 'index.ts')],
    outfile: path.join(distDir, 'main', 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
    external: ['electron', ...NATIVE_EXTERNALS],
  });
}

async function buildPreload() {
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'preload', 'index.ts')],
    outfile: path.join(distDir, 'preload', 'index.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'cjs',
    sourcemap: true,
    external: ['electron'],
  });
}

async function buildDummyResource() {
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'resources', 'bin', 'bureau-dummy.ts')],
    outfile: path.join(distDir, 'resources', 'bin', 'bureau-dummy.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
  });
}

// §7.10/§18.1: bureau-hook.js/bureau-tools.js run via `process.execPath` +
// `ELECTRON_RUN_AS_NODE=1` — no bundled second Node runtime, but everything
// THEY import (including @modelcontextprotocol/sdk, pure JS, no native
// bindings) must still be bundled in, same as bureau-dummy.ts above:
// node_modules is not reliably reachable relative to
// process.resourcesPath in a packaged app.
async function buildControlChannelResources() {
  await esbuild.build({
    entryPoints: [
      path.join(rootDir, 'resources', 'bin', 'bureau-tools.ts'),
      path.join(rootDir, 'resources', 'bin', 'bureau-hook.ts'),
    ],
    outdir: path.join(distDir, 'resources', 'bin'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: true,
  });
}

// esbuild bundles .ts into dist/main/index.js, but migrations are read
// from disk at runtime (db/migrate.ts), not imported — they have to be
// copied as plain files, sitting next to where the bundle expects them
// (dist/main/db/migrations, mirroring the source layout, since
// __dirname inside the bundle is dist/main/).
async function copyMigrations() {
  const srcDir = path.join(rootDir, 'src', 'main', 'db', 'migrations');
  const outDir = path.join(distDir, 'main', 'db', 'migrations');
  await mkdir(outDir, { recursive: true });
  const files = await readdir(srcDir);
  await Promise.all(
    files.filter((f) => f.endsWith('.sql')).map((f) => copyFile(path.join(srcDir, f), path.join(outDir, f))),
  );
}

// §11.5.1 — pricing.yaml is read from disk at runtime (pricingYaml.ts),
// never imported, same reasoning as copyMigrations() above.
async function copyPricingYaml() {
  const outDir = path.join(distDir, 'resources');
  await mkdir(outDir, { recursive: true });
  await copyFile(path.join(rootDir, 'resources', 'pricing.yaml'), path.join(outDir, 'pricing.yaml'));
}

// §18.1's pipeline diagram already lists "copy packs → dist/packs". M7 is
// the milestone where there are packs to copy: a pack is YAML and markdown
// read from disk at runtime (packs/loadPack.ts), never imported, the same
// reasoning as copyMigrations() and copyPricingYaml() above.
//
// Copied whole rather than file-by-file: a pack's `prompts/`, `skills/`,
// `templates/`, `assets/` and `memory-seed/` trees are all read at runtime
// and an allow-list of extensions here would silently drop whatever a pack
// author adds next.
async function copyPacks() {
  const srcDir = path.join(rootDir, 'packs');
  const outDir = path.join(distDir, 'packs');
  await cp(srcDir, outDir, { recursive: true });
}

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await buildRenderer();
  await Promise.all([
    buildMain(),
    buildPreload(),
    buildDummyResource(),
    buildControlChannelResources(),
    copyMigrations(),
    copyPricingYaml(),
    copyPacks(),
  ]);
  console.log('Build complete:', distDir);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
