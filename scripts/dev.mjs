// Minimal dev loop: build main+preload once, start the Vite dev server, then
// launch Electron against it. No hot-reload for main/preload yet (re-run
// this script after changing them) — not required for any M0 gate, and
// deliberately kept simple until a later milestone needs faster iteration.

import { createServer } from 'vite';
import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import electronPath from 'electron';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(rootDir, 'dist');

const NATIVE_EXTERNALS = ['better-sqlite3', 'node-pty', '@bureau/job-object'];

async function buildMainAndPreload() {
  await Promise.all([
    esbuild.build({
      entryPoints: [path.join(rootDir, 'src', 'main', 'index.ts')],
      outfile: path.join(distDir, 'main', 'index.js'),
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      sourcemap: true,
      external: ['electron', ...NATIVE_EXTERNALS],
    }),
    esbuild.build({
      entryPoints: [path.join(rootDir, 'src', 'preload', 'index.ts')],
      outfile: path.join(distDir, 'preload', 'index.js'),
      bundle: true,
      platform: 'browser',
      target: 'chrome120',
      format: 'cjs',
      sourcemap: true,
      external: ['electron'],
    }),
  ]);
}

async function main() {
  await buildMainAndPreload();

  const viteServer = await createServer({
    root: path.join(rootDir, 'src', 'renderer'),
    configFile: path.join(rootDir, 'src', 'renderer', 'vite.config.ts'),
  });
  await viteServer.listen();
  viteServer.printUrls();

  const electron = spawn(String(electronPath), [rootDir], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
  });

  electron.on('exit', async (code) => {
    await viteServer.close();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
