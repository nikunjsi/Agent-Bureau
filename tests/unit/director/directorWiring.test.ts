import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The production half of M11 row S1-8, checked at the source because
 * `main()` only runs inside Electron. `startDirector.test.ts` proves what
 * `startDirector` does; this proves the shipped app calls it, and builds
 * every engine adapter that spawns work the one way that carries the
 * user's settings (pre-M11 §F, S-1).
 */
const SRC = path.resolve(__dirname, '..', '..', '..', 'src');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the shipped app starts the Director, on the settings' adapter", () => {
  it('main() calls startDirector, without swapping its adapter', () => {
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    const call = /startDirector\(\{[\s\S]*?\}\)/.exec(main)?.[0];

    expect(call).toBeDefined();
    // The test seam must not be used in production: without it,
    // startDirector builds through createClaudeCodeAdapterFromSettings.
    expect(call).not.toMatch(/createAdapter/);
    // M11 row S1-9: and gives it the real Job Object containment.
    // The imported function itself, not a stand-in with the same name.
    expect(call).toMatch(/^\s*containProcess,\s*$/m);
    expect(main).toMatch(/import \{[^}]*\bcontainProcess\b[^}]*\} from '\.\/process\/jobObject'/);
    // M11 row S1-13: and the chat's one stream registry, so the Director's
    // prose reaches the chat. Without it, startDirector attaches no producer.
    expect(call).toMatch(/^\s*chatStreams,\s*$/m);
    expect(main).toMatch(/const chatStreams = new ChatStreamRegistry\(/);
  });

  it("the restart report is built from reconcile's own result and offered to the queue", () => {
    // M11 row S1-20: the summary must read what reconcile() actually
    // repaired, not a second derivation, and reach the one Director queue.
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    expect(main).toMatch(/const reconciled = await reconcile\(/);
    expect(main).toMatch(/buildRestartSummary\([\s\S]*?reconcile: reconciled/);
    expect(main).toMatch(/offerRestartReport\(directorTriggers, restartSummary, appStartedAtMs\)/);
  });

  it("the trigger queue is given what it needs to write the Director's context", () => {
    // M11 context assembly (§8.0.1): without both, no context file is
    // written and the Director would run on its bare prompt.
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    const call = /createDirectorTriggers\(\{[\s\S]*?\}\)/.exec(main)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/baseDir: app\.getPath\('userData'\)/);
    expect(call).toMatch(/^\s*bundledPacksDir,\s*$/m);
  });

  it('the checkpoint surfacer hands settled batches to the Director’s queue', () => {
    // M11 S2-6, §9.3: without it, every batch gets the Core's plain grouped
    // card and the Director never groups anything.
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    const call = /new CheckpointSurfacer\(db, \{[\s\S]*?\}\)/.exec(main)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/^\s*director: directorTriggers,\s*$/m);
  });

  it('the assignment loop runs in the shipped app, on the production adapter, and stops on quit', () => {
    // M11 S3-2b, §26.2: without it no task is ever assigned. The adapter
    // seam must not be used: the loop then builds each employee through
    // createEmployeeAdapter, with the Job Object's containment.
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    const call = /createAssignmentLoop\(\{[\s\S]*?\}\);/.exec(main)?.[0];
    expect(call).toBeDefined();
    expect(call).not.toMatch(/createAdapter/);
    expect(call).toMatch(/^\s*containProcess,\s*$/m);
    // M11 S3-3: ready work nobody can take reaches the Director.
    expect(call).toMatch(/^\s*director: directorTriggers,\s*$/m);
    expect(main).toMatch(/^\s*assignmentLoop\.kick\(\);/m);
    expect(main).toMatch(/^\s*assignmentLoop\.stop\(\);/m);
  });

  it('finished tasks are committed, checked and handed to the Director in the shipped app', () => {
    // M11 S3-4a, §8.5.1: without it a reported task sits in review forever.
    const main = readFileSync(path.join(SRC, 'main', 'index.ts'), 'utf8');
    expect(main).toMatch(
      /^\s*const taskCompletion = createTaskCompletion\(\{ db, activityLog, director: directorTriggers \}\);/m,
    );
    expect(main).toMatch(/^\s*taskCompletion\.stop\(\);/m);
    // M11 S3-5a: and a finished phase goes to review.
    expect(main).toMatch(
      /^\s*const phaseWatcher = createPhaseWatcher\(\{ db, activityLog, director: directorTriggers \}\);/m,
    );
    expect(main).toMatch(/^\s*phaseWatcher\.stop\(\);/m);
    // M11 S3-6b: and a stalled task reaches the Director.
    expect(main).toMatch(
      /^\s*const stallWatcher = createStallWatcher\(\{ db, activityLog, director: directorTriggers \}\);/m,
    );
    expect(main).toMatch(/^\s*stallWatcher\.stop\(\);/m);
  });

  it("startDirector's production adapter is the settings factory, with containment", () => {
    const source = readFileSync(path.join(SRC, 'main', 'director', 'startDirector.ts'), 'utf8');
    expect(source).toMatch(
      /createClaudeCodeAdapterFromSettings\(db, \{ containProcess: deps\.containProcess \}\)/,
    );
  });

  it('a bare ClaudeCodeAdapter is built only by the two probe sites and the factory itself', () => {
    const sites = tsFilesUnder(SRC)
      .filter((file) => /new ClaudeCodeAdapter\(/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))
      .sort();

    expect(sites).toEqual([
      'main/cost/zeroCostMode.ts', // probe only: can zero-cost mode be enabled
      'main/engine/claudeCodeAdapter.ts', // the factory, createClaudeCodeAdapterFromSettings
      'main/index.ts', // probe only: each pack's required engines (§6.3)
    ]);
  });
});
