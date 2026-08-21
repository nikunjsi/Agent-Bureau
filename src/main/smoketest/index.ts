import { app } from 'electron';
import { runNativeModulesSmoketest } from './nativeModules';
import { runJobObjectSmoketest } from './jobObject';

type SmoketestMode = 'native' | 'jobobject';

function parseMode(value: string | undefined): SmoketestMode | undefined {
  if (value === 'native' || value === 'jobobject') return value;
  return undefined;
}

/**
 * If `BUREAU_SMOKETEST` is set, runs the matching CI-only behavioural check
 * (see §28 M0 gates 3 and 4) and returns `true` — the caller must not
 * proceed to normal startup in that case. Returns `false` when unset, which
 * is the case for every real user launch.
 */
export async function maybeRunSmoketest(): Promise<boolean> {
  const raw = process.env['BUREAU_SMOKETEST'];
  if (raw === undefined) return false;

  const mode = parseMode(raw);
  if (mode === undefined) {
    console.error(`Unknown BUREAU_SMOKETEST value: ${raw} (expected "native" or "jobobject")`);
    app.exit(1);
    return true;
  }

  await app.whenReady();

  if (mode === 'native') {
    await runNativeModulesSmoketest();
  } else {
    await runJobObjectSmoketest();
  }

  return true;
}
