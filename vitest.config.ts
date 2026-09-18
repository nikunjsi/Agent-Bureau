import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 5_000,
    /**
     * `npm run test:coverage` (AUDIT M3–M6 #24, done at pre-M11 §C).
     *
     * **A measurement, not a gate.** No thresholds: a number that fails a
     * build teaches people to write tests that move the number, and the
     * audit this came from found the opposite problem — three tests that
     * ran without reaching their production path at all. What this answers
     * is "which branches of the evaluator, the commit path, the redactor or
     * the breaker are never hit", which until now could only be answered by
     * reading code.
     *
     * **It covers the unit suite only, and that is the honest scope.** The
     * integration and contract suites drive the same `src/` through real
     * databases and real HTTP, so their coverage is real too — but merging
     * three runs' reports needs a merge step nobody has written yet, and a
     * single-suite number labelled as the whole is worse than one labelled
     * as itself. `docs/NEXT-VERSION.md` §E.1 records that.
     */
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // Nothing generated, nothing that is only a type, and not the
      // entry point — `src/main/index.ts` is wiring that only a packaged
      // app executes, so counting it would report a large permanent gap
      // that no unit test should be trying to close.
      exclude: ['src/main/index.ts', 'src/**/*.d.ts', 'src/preload/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'docs/artifacts/coverage',
    },
  },
});
