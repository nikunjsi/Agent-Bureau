import { writeFileSync } from 'node:fs';

/**
 * Smoketest handlers report their outcome two ways: to stdout/stderr (so a
 * human can read a CI log) and, if `BUREAU_SMOKETEST_OUT` is set, as JSON to
 * that file (so the outer test harness can assert on structured data
 * instead of scraping console output).
 */
export function writeResult(data: Record<string, unknown>): void {
  const line = JSON.stringify(data);
  console.log(`BUREAU_SMOKETEST_RESULT ${line}`);

  const outPath = process.env['BUREAU_SMOKETEST_OUT'];
  if (outPath) {
    writeFileSync(outPath, line, 'utf8');
  }
}
