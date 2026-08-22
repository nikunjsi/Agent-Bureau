import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Real-engine tests spawn real processes and (when opted in) spend
    // real money — one at a time, matching the integration suite's own
    // reasoning for the same setting.
    fileParallelism: false,
  },
});
