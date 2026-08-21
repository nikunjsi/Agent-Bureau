// Build pipeline (BUILD-SPEC.md §18.1), M0 slice: renderer (Vite), main and
// preload (esbuild), and the resources/bin helper scripts (esbuild). The
// final `electron-builder` packaging step lives in `npm run package`, not
// here, so `npm run build` stays fast and CI can typecheck/lint against its
// output without packaging every time.

import { build as viteBuild } from 'vite';
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rm } from 'node:fs/promises';

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

async function main() {
  await rm(distDir, { recursive: true, force: true });
  await buildRenderer();
  await Promise.all([buildMain(), buildPreload(), buildDummyResource()]);
  console.log('Build complete:', distDir);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
