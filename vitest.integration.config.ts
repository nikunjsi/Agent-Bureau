import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These spawn a real packaged Electron process and hard-kill it — one
    // at a time avoids two tests racing to force-kill each other's process.
    fileParallelism: false,
  },
});
