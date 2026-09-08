import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { listChangedFiles } from './gitWorktree';
import { scanFilesForSecrets } from './secretScan';

export interface ValidatorResult {
  readonly name: string;
  readonly passed: boolean;
  readonly output: string;
}

export interface Validator {
  readonly name: string;
  run(repoPath: string, worktreePath: string): Promise<ValidatorResult>;
}

export const SECRET_SCAN_VALIDATOR_NAME = 'secret-scan';

/** §10.4: "cannot be disabled — not by config, not by a pack, not by a
 * project setting" (M5 part 2 kickoff). Thrown by `runValidators` itself
 * — see that function's own doc comment for why enforcement lives there
 * and not in `detectValidators` (M5 part 2 plan review, D5). */
export class MissingSecretScanValidatorError extends Error {
  constructor() {
    super(
      '§10.4: the secret-scan validator cannot be omitted. runValidators refuses to run against any validator list that does not include it, regardless of how that list was built.',
    );
    this.name = 'MissingSecretScanValidatorError';
  }
}

function execFileAsync(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      // Resolve either way — a validator's job is to report pass/fail as
      // data, not to throw; only genuinely unexpected errors (a missing
      // secret-scan validator, D5) should ever throw out of this module.
      resolve({ stdout, stderr, failed: error !== null });
    });
  });
}

function makeSecretScanValidator(): Validator {
  return {
    name: SECRET_SCAN_VALIDATOR_NAME,
    async run(repoPath, worktreePath) {
      const changedFiles = await listChangedFiles(repoPath, worktreePath);
      const findings = scanFilesForSecrets(worktreePath, changedFiles);
      if (findings.length === 0) {
        return { name: SECRET_SCAN_VALIDATOR_NAME, passed: true, output: 'no secrets detected' };
      }
      // Deliberately omits the matched text itself (SecretFinding.match)
      // — this output becomes part of a durable record (task.status_reason,
      // a git.validator_failed event payload), and echoing the actual
      // leaked credential into Bureau's own log would defeat the point of
      // catching it. File + pattern name is enough for an employee (or a
      // human) to find and remove it.
      const summary = findings.map((f) => `${f.file}: matched ${f.pattern}`).join('\n');
      return {
        name: SECRET_SCAN_VALIDATOR_NAME,
        passed: false,
        output: `secret scan found ${findings.length} finding(s):\n${summary}`,
      };
    },
  };
}

function makeNpmScriptValidator(name: string, script: string): Validator {
  return {
    name,
    async run(_repoPath, worktreePath) {
      const { stdout, stderr, failed } = await execFileAsync('npm', ['run', script], worktreePath);
      return { name, passed: !failed, output: `${stdout}${stderr}`.trim() };
    },
  };
}

export interface ValidatorOverrides {
  /** Skips lint detection even if package.json has a `lint` script — a
   * legitimate future per-project setting. No equivalent key exists for
   * secret-scan; there is nothing here that could disable it. */
  readonly lint?: boolean;
  readonly test?: boolean;
}

/**
 * §10.4/§28 M5 item 5: "detected from the repo, not assumed" — secret-
 * scan is always first, unconditionally; `lint`/`test` are detected only
 * if `package.json` actually has that script (§10.4's own example),
 * each individually skippable via `overrides`. A project with no
 * `package.json` at all (§10.2's non-code projects) still gets the
 * secret scan — it's the only validator that doesn't depend on the repo
 * being a Node project.
 */
export function detectValidators(
  projectPath: string,
  overrides: ValidatorOverrides = {},
): Validator[] {
  const validators: Validator[] = [makeSecretScanValidator()];

  const packageJsonPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      const scripts = packageJson.scripts ?? {};
      if (typeof scripts['lint'] === 'string' && overrides.lint !== false) {
        validators.push(makeNpmScriptValidator('lint', 'lint'));
      }
      if (typeof scripts['test'] === 'string' && overrides.test !== false) {
        validators.push(makeNpmScriptValidator('test', 'test'));
      }
    } catch {
      // Malformed package.json — not this function's job to fix; simply
      // don't detect lint/test from it. Secret-scan still runs regardless.
    }
  }

  return validators;
}

export interface ValidatorRunReport {
  readonly allPassed: boolean;
  readonly results: readonly ValidatorResult[];
}

/**
 * §10.4/invariant #13: the actual enforcement point for "cannot be
 * disabled." `detectValidators` always includes secret-scan, but nothing
 * stops a caller from building its own validator list by hand and
 * calling this function directly — so this is where it's actually
 * guarded, the one choke point every validator run passes through this
 * session (there is no other call path). Runs every validator
 * sequentially (not stop-at-first-failure, and not parallel — lint/test
 * running concurrently against the same worktree is an avoidable risk
 * for no real benefit at this scale) and collects every result, so an
 * employee sees everything that failed at once, not one thing per retry.
 */
export async function runValidators(
  repoPath: string,
  worktreePath: string,
  validators: readonly Validator[],
): Promise<ValidatorRunReport> {
  if (!validators.some((v) => v.name === SECRET_SCAN_VALIDATOR_NAME)) {
    throw new MissingSecretScanValidatorError();
  }

  const results: ValidatorResult[] = [];
  for (const validator of validators) {
    results.push(await validator.run(repoPath, worktreePath));
  }
  return { allPassed: results.every((r) => r.passed), results };
}
