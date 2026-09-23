import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The M11 S1-21 defect, reproduced on any Windows box — no PowerShell 7
 * needed, and no `process.env` mutated.
 *
 * On the CI runner (and in a VS Code terminal running `pwsh`), the parent
 * is PowerShell 7 and puts its own module folders first on `PSModulePath`.
 * A child Windows PowerShell 5.1 inherits that list, finds a **Core-only**
 * copy of a built-in module ahead of its own, and refuses to load it:
 *
 * ```
 * Get-Acl : The 'Get-Acl' command was found in the module
 * 'Microsoft.PowerShell.Security', but the module could not be loaded.
 *     + FullyQualifiedErrorId : CouldNotAutoloadMatchingModule
 * ```
 *
 * What actually causes the refusal is the manifest, not PowerShell 7: a
 * `.psd1` declaring `CompatiblePSEditions = @('Core')` and a missing
 * binary. So a temp directory holding two such manifests, placed first on
 * a **copy** of the environment, produces the runner's exact failure from
 * a Windows PowerShell parent — which is what makes this reproducible in
 * the suite rather than only on the runner.
 */
export interface ShadowedModules {
  /** An environment whose `PSModulePath` finds the Core-only manifests first. */
  readonly env: NodeJS.ProcessEnv;
  /** Removes the temp directory. Call from `afterEach`. */
  readonly cleanup: () => void;
}

const SHADOWED = [
  {
    module: 'Microsoft.PowerShell.Security',
    cmdlet: 'Get-Acl',
    dll: 'Microsoft.PowerShell.Security.dll',
  },
  {
    module: 'Microsoft.PowerShell.Management',
    cmdlet: 'Get-Process',
    dll: 'Microsoft.PowerShell.Commands.Management.dll',
  },
] as const;

export function shadowPowerShellModules(
  parentEnv: NodeJS.ProcessEnv = process.env,
): ShadowedModules {
  const root = mkdtempSync(path.join(tmpdir(), 'bureau-ps7-modules-'));
  for (const { module, cmdlet, dll } of SHADOWED) {
    const dir = path.join(root, module);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `${module}.psd1`),
      [
        '@{',
        "    ModuleVersion = '7.0.0.0'",
        // A Core-only edition and a 7.0 floor: Windows PowerShell 5.1 finds
        // this manifest first, matches the cmdlet to it, and then cannot
        // load it. The nested DLL is deliberately absent — exactly the
        // shape PS7's own copy has from 5.1's point of view.
        "    CompatiblePSEditions = @('Core')",
        "    PowerShellVersion = '7.0'",
        `    CmdletsToExport = @('${cmdlet}')`,
        `    NestedModules = @('${dll}')`,
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
  }
  return {
    env: withPsModulePath(parentEnv, `${root};${parentEnv.PSModulePath ?? ''}`),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Windows environment variables are case-insensitive; a JS object's keys
 * are not. `{ ...env, PSModulePath: x }` looks like it replaces the
 * variable and does not when the snapshot spells it differently — and
 * Vitest's `process.env` snapshot really does carry `PSMODULEPATH`, so
 * the child kept the old value and this whole fixture was inert. Measured,
 * not guessed: without this the shadowed manifests never applied and every
 * case below passed while reproducing nothing.
 *
 * Deliberately not imported from the module under test: a fixture that
 * builds its poison with the same helper it is testing cannot fail when
 * that helper is wrong.
 */
function withPsModulePath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, v] of Object.entries(env)) {
    if (!/^psmodulepath$/i.test(key)) out[key] = v;
  }
  out.PSModulePath = value;
  return out;
}
