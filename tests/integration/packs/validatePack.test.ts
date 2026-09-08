import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadPack } from '../../../src/main/packs/loadPack';
import { validatePack, MAX_PROMPT_BYTES } from '../../../src/main/packs/validatePack';
import { writePack, validRoleYaml, APP_VERSION_FOR_TESTS } from '../../helpers/packFixture';

/**
 * §6.7's eight checks, each driven through the real `loadPack` over a real
 * pack directory. Check 5 (widening) has its own file — it is S3.
 */
describe('§6.7 pack validation', () => {
  let tmpDir: string;
  let seq = 0;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'bureau-validate-pack-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function dir(): string {
    seq += 1;
    return path.join(tmpDir, `pack${seq}`);
  }

  function check(sourceDir: string, appVersion = APP_VERSION_FOR_TESTS) {
    const loaded = loadPack(sourceDir);
    if (loaded.pack === null) return { errors: loaded.errors, warnings: [] as string[] };
    return validatePack(loaded.pack, { appVersion });
  }

  it('accepts a pack modelled on §6.5’s own reference role', () => {
    const result = check(writePack(dir()));
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  // --- check 1 ----------------------------------------------------------

  it('rejects a pack requiring a newer Bureau than this one', () => {
    const source = writePack(dir(), { manifest: { bureau_min_version: '2.0.0' } });
    expect(check(source).errors[0]).toContain('requires Bureau 2.0.0 or later');
  });

  it('rejects a version that is not exactly major.minor.patch', () => {
    // Rejected at PARSE time by the schema, before the comparator ever
    // sees it — see semver.ts for why that is the strict choice.
    const source = writePack(dir(), { manifest: { bureau_min_version: '1.0.0-beta' } });
    expect(check(source).errors.join('\n')).toContain(
      'prerelease and build metadata are not supported',
    );
  });

  // --- check 2 ----------------------------------------------------------

  it('rejects a role pointing at a department that does not exist', () => {
    const source = writePack(dir(), { roles: [validRoleYaml({ department: 'marketing' })] });
    expect(check(source).errors.join('\n')).toContain('department "marketing" does not exist');
  });

  it('rejects a department listing a role that does not exist', () => {
    const source = writePack(dir(), {
      departments: [
        {
          key: 'engineering',
          name: 'Engineering',
          description: 'x',
          roles: ['developer', 'ghost'],
          room: { preferred_size: { w: 12, h: 8 } },
          default_hires: [],
        },
      ],
    });
    expect(check(source).errors.join('\n')).toContain('lists role "ghost"');
  });

  it('rejects a missing prompt file', () => {
    const source = writePack(dir(), { omitPrompts: ['prompts/developer.md'] });
    expect(check(source).errors.join('\n')).toContain(
      'prompt file "prompts/developer.md" does not exist',
    );
  });

  it('rejects a prompt path that escapes the pack', () => {
    // CLAUDE.md invariant #5's boundary, at install time rather than run
    // time: a pack may not read what the Core can read.
    const source = writePack(dir(), {
      roles: [validRoleYaml({ system_prompt_path: '../../../etc/passwd', shared_prompts: [] })],
    });
    expect(check(source).errors.join('\n')).toContain('may not escape it');
  });

  // --- check 3 ----------------------------------------------------------

  it('rejects an empty prompt file', () => {
    const source = writePack(dir(), { omitPrompts: ['prompts/developer.md'] });
    mkdirSync(path.join(source, 'prompts'), { recursive: true });
    writeFileSync(path.join(source, 'prompts', 'developer.md'), '', 'utf8');
    expect(check(source).errors.join('\n')).toContain('is empty');
  });

  it('rejects a whitespace-only prompt file, which passes the size check', () => {
    const source = writePack(dir(), { omitPrompts: ['prompts/developer.md'] });
    writeFileSync(path.join(source, 'prompts', 'developer.md'), '\n\n   \t\n', 'utf8');
    const joined = check(source).errors.join('\n');
    expect(joined).toContain('only whitespace');
    expect(joined).not.toContain('is empty'); // it has bytes; it has no content
  });

  it('rejects a prompt file over the 32 KB cap', () => {
    const source = writePack(dir(), { omitPrompts: ['prompts/developer.md'] });
    writeFileSync(
      path.join(source, 'prompts', 'developer.md'),
      'x'.repeat(MAX_PROMPT_BYTES + 1),
      'utf8',
    );
    expect(check(source).errors.join('\n')).toContain(`over the ${MAX_PROMPT_BYTES}-byte cap`);
  });

  // --- check 4 ----------------------------------------------------------

  it('rejects a malformed tool pattern that parseToolPattern would accept silently', () => {
    const source = writePack(dir(), { roles: [validRoleYaml({ tools_deny: ['Bash(rm -rf *'] })] });
    expect(check(source).errors.join('\n')).toContain('unbalanced parentheses');
  });

  // --- check 4a ---------------------------------------------------------

  it('rejects a network tool granted with no network_allow (an ERROR)', () => {
    const source = writePack(dir(), {
      roles: [validRoleYaml({ tools_allow: ['Read(**)', 'WebFetch(**)'], network_allow: [] })],
    });
    expect(check(source).errors.join('\n')).toContain('network_allow is empty');
  });

  it('warns — but does not reject — a network_allow with no network tool', () => {
    // Deliberately asymmetric. A granted tool with no destination list is
    // a hole; a destination list with no tool is dead configuration.
    const source = writePack(dir(), {
      roles: [validRoleYaml({ tools_allow: ['Read(**)'], network_allow: ['*.npmjs.org'] })],
    });
    const result = check(source);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('granted no network tool');
  });

  it('accepts a network tool paired with a real destination list', () => {
    const source = writePack(dir(), {
      roles: [
        validRoleYaml({
          tools_allow: ['Read(**)', 'WebFetch(**)'],
          network_allow: ['*.npmjs.org'],
        }),
      ],
    });
    expect(check(source).errors).toEqual([]);
  });

  // --- check 6 ----------------------------------------------------------

  it('rejects a role_options key the pack’s own schema does not declare', () => {
    const source = writePack(dir(), {
      manifest: { role_options_schema: { review_depth: 'string' } },
      roles: [validRoleYaml({ role_options: { review_depth: 'deep', unknown_knob: 1 } })],
    });
    expect(check(source).errors.join('\n')).toContain('unknown_knob is not declared');
  });

  it('rejects a role_options value of the wrong type', () => {
    const source = writePack(dir(), {
      manifest: { role_options_schema: { max_files: 'number' } },
      roles: [validRoleYaml({ role_options: { max_files: 'lots' } })],
    });
    expect(check(source).errors.join('\n')).toContain('should be number, got string');
  });

  it('leaves role_options alone when the pack declares no schema', () => {
    const source = writePack(dir(), {
      roles: [validRoleYaml({ role_options: { anything: 'goes' } })],
    });
    expect(check(source).errors).toEqual([]);
  });

  // --- check 7 ----------------------------------------------------------

  it('warns on an unknown sprite key and names the fallback', () => {
    const source = writePack(dir(), { roles: [validRoleYaml({ sprite_key: 'wizard' })] });
    const result = check(source);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join('\n')).toContain('falling back to "generic"');
  });

  // --- check 8 ----------------------------------------------------------

  it('rejects a room size given in pixels rather than tiles', () => {
    const source = writePack(dir(), {
      departments: [
        {
          key: 'engineering',
          name: 'Engineering',
          description: 'x',
          roles: ['developer'],
          room: { preferred_size: { w: 1200, h: 800 } },
          default_hires: [],
        },
      ],
    });
    expect(check(source).errors.join('\n')).toContain('are in TILES, not pixels');
  });

  // --- readable errors --------------------------------------------------

  it('reports every problem at once, not just the first', () => {
    // "Disabled with a readable error" means all of them — fixing a pack
    // one error per validation run is not a usable authoring loop.
    const source = writePack(dir(), {
      roles: [
        validRoleYaml({
          department: 'nowhere',
          tools_deny: ['Bash(rm -rf *'],
          sprite_key: 'wizard',
        }),
      ],
    });
    const result = check(source);
    expect(result.errors.length).toBeGreaterThan(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('turns a Zod failure into a message naming the file and the field', () => {
    const source = writePack(dir(), { roles: [validRoleYaml({ autonomy_default: 'yolo' })] });
    const message = check(source).errors.join('\n');
    expect(message).toContain('roles/developer.yaml');
    expect(message).toContain('autonomy_default');
  });

  it('reports a missing pack.yaml on its own, without burying it', () => {
    const empty = path.join(tmpDir, 'empty');
    mkdirSync(empty, { recursive: true });
    const result = check(empty);
    expect(result.errors).toEqual(['pack.yaml: cannot be read']);
  });

  it('rejects an unknown key in role.yaml rather than ignoring it', () => {
    // The reason the schemas are `.strict()`: a silently-dropped
    // `tools_deny` typo is exactly the failure §6.7 exists to prevent.
    const source = writePack(dir(), { roles: [validRoleYaml({ tools_denny: ['Bash(git *)'] })] });
    expect(check(source).errors.join('\n')).toContain('tools_denny');
  });
});
