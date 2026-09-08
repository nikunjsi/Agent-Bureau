import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { satisfiesMinVersion } from '../../shared/models/semver';
import { validateToolPatternSyntax } from '../../shared/policy/patternSyntax';
import { assertNoImmutableWidening } from '../../shared/policy/immutableWidening';
import { roleRulesFrom, buildRuleSet } from '../../shared/policy/ruleLoader';
import { isBureauTool } from '../../shared/policy/evaluator';
import { parseToolPattern } from '../../shared/policy/patternGrammar';
import type { Rule } from '../../shared/policy/types';
import { KNOWN_SPRITE_KEYS, FALLBACK_SPRITE_KEY } from '../../shared/floor/sprites';
import { FLOOR_WIDTH_TILES, MAX_ROOM_WIDTH_TILES } from '../../shared/floor/layout';
import type { ParsedPack, RoleYaml } from '../../shared/models/pack';

/**
 * §6.7's eight checks. Returns collected errors and warnings rather than
 * throwing: "a pack that fails validation is disabled with a readable
 * error, never partially loaded", and a readable error means all of them,
 * not the first one.
 */

export interface PackValidationResult {
  readonly errors: string[];
  readonly warnings: string[];
}

/** §6.7 check 3's cap, named rather than inline. */
export const MAX_PROMPT_BYTES = 32 * 1024;

// §6.7 check 7's key list moved to `src/shared/floor/sprites.ts` at M7
// session 2, when hiring became its second consumer — a constant two
// modules depend on does not belong inside one of them. Re-exported here
// so existing importers of this module keep working.
export { KNOWN_SPRITE_KEYS, FALLBACK_SPRITE_KEY } from '../../shared/floor/sprites';

/**
 * §11.2's network tool classes. Kept here rather than imported from an
 * adapter's classification map because check 4a is about what a PACK
 * declares, which is engine-independent — a role granting `WebFetch` needs
 * a `network_allow` whether or not the engine it happens to run under
 * classifies it that way.
 */
const NETWORK_TOOL_NAMES: readonly string[] = ['WebFetch', 'WebSearch', 'Fetch', 'HttpRequest'];

export interface ValidatePackOptions {
  /** The running app's version, for check 1. */
  readonly appVersion: string;
  /** Department keys already installed from OTHER packs, for check 2. */
  readonly installedDepartmentKeys?: readonly string[];
  /** Room rectangles the floor already holds, for check 8's sanity bound. */
  readonly maxRoomTiles?: number;
}

/** A room bigger than this is a pack-authoring mistake, not a floor problem. */
const MAX_ROOM_TILES = 64;

export function validatePack(pack: ParsedPack, options: ValidatePackOptions): PackValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  checkMinVersion(pack, options.appVersion, errors);
  checkReferences(pack, options.installedDepartmentKeys ?? [], errors);
  checkPromptFiles(pack, errors);
  checkToolPatterns(pack, errors, warnings);
  checkWidening(pack, errors);
  checkRoleOptions(pack, errors);
  checkSpriteKeys(pack, warnings);
  checkRoomSizes(pack, options.maxRoomTiles ?? MAX_ROOM_TILES, errors);

  return { errors, warnings };
}

// --- check 1 ------------------------------------------------------------

function checkMinVersion(pack: ParsedPack, appVersion: string, errors: string[]): void {
  if (!satisfiesMinVersion(appVersion, pack.manifest.bureau_min_version)) {
    errors.push(
      `pack.yaml: requires Bureau ${pack.manifest.bureau_min_version} or later, but this is ${appVersion}.`,
    );
  }
}

// --- check 2 ------------------------------------------------------------

function checkReferences(
  pack: ParsedPack,
  installedDepartmentKeys: readonly string[],
  errors: string[],
): void {
  const inPackDepartments = new Set(pack.departments.map((d) => d.key));
  const known = new Set([...inPackDepartments, ...installedDepartmentKeys]);
  const inPackRoles = new Set(pack.roles.map((r) => r.key));

  for (const declared of pack.manifest.departments) {
    if (!inPackDepartments.has(declared)) {
      errors.push(
        `pack.yaml: declares department "${declared}", which has no departments/${declared}.yaml.`,
      );
    }
  }

  for (const role of pack.roles) {
    if (!known.has(role.department)) {
      errors.push(
        `roles/${role.key}.yaml: department "${role.department}" does not exist in this pack or any installed one.`,
      );
    }
  }

  // The reverse direction. A department listing a role that does not exist
  // would otherwise fail much later, as a missing hire.
  for (const department of pack.departments) {
    for (const roleKey of department.roles) {
      if (!inPackRoles.has(roleKey)) {
        errors.push(
          `departments/${department.key}.yaml: lists role "${roleKey}", which has no roles/${roleKey}.yaml.`,
        );
      }
    }
    for (const hire of department.default_hires) {
      if (!inPackRoles.has(hire)) {
        errors.push(
          `departments/${department.key}.yaml: default_hires names "${hire}", which is not a role in this pack.`,
        );
      }
    }
  }
}

// --- checks 2 (prompt files exist) and 3 (non-empty, capped) ------------

function promptPathsOf(role: RoleYaml): string[] {
  return [role.system_prompt_path, ...role.shared_prompts];
}

function checkPromptFiles(pack: ParsedPack, errors: string[]): void {
  for (const role of pack.roles) {
    for (const relPath of promptPathsOf(role)) {
      // A pack-relative path only. `..` would let a pack read whatever the
      // Core can read at install time, which is exactly the boundary
      // CLAUDE.md invariant #5 draws.
      if (path.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) {
        errors.push(
          `roles/${role.key}.yaml: prompt path "${relPath}" must be relative to the pack and may not escape it.`,
        );
        continue;
      }
      const absolute = path.join(pack.rootDir, relPath);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) {
        errors.push(`roles/${role.key}.yaml: prompt file "${relPath}" does not exist.`);
        continue;
      }
      const bytes = statSync(absolute).size;
      if (bytes === 0) {
        errors.push(`roles/${role.key}.yaml: prompt file "${relPath}" is empty.`);
        continue;
      }
      if (bytes > MAX_PROMPT_BYTES) {
        errors.push(
          `roles/${role.key}.yaml: prompt file "${relPath}" is ${bytes} bytes, over the ${MAX_PROMPT_BYTES}-byte cap.`,
        );
        continue;
      }
      // Non-empty by BYTES is not non-empty by content — a file of
      // whitespace passes the size check and produces no prompt at all.
      if (readFileSync(absolute, 'utf8').trim().length === 0) {
        errors.push(`roles/${role.key}.yaml: prompt file "${relPath}" contains only whitespace.`);
      }
    }
  }
}

// --- checks 4 and 4a ----------------------------------------------------

function checkToolPatterns(pack: ParsedPack, errors: string[], warnings: string[]): void {
  for (const role of pack.roles) {
    const label = `roles/${role.key}.yaml`;
    for (const [field, patterns] of [
      ['tools_allow', role.tools_allow],
      ['tools_deny', role.tools_deny],
    ] as const) {
      patterns.forEach((pattern, index) => {
        for (const message of validateToolPatternSyntax(pattern)) {
          errors.push(`${label}: ${field}[${index}] ${message}`);
        }
        // AUDIT #10. §23.2's "Bureau's own tools are always allowed"
        // short-circuit trusts a NAME PREFIX rather than verified
        // provenance, ahead of the whole rule scan. It is safe today only
        // because `--strict-mcp-config` blocks competing MCP servers and
        // packs cannot declare one. The moment a pack can name a tool, that
        // prefix becomes a privilege-escalation path, so a pack may not
        // name one at all. Uses the very function the short-circuit uses,
        // so the two cannot drift apart.
        for (const term of parseToolPattern(pattern)) {
          if (isBureauTool(term.tool)) {
            errors.push(
              `${label}: ${field}[${index}] names "${term.tool}", which is reserved — ` +
                `tool names beginning with "bureau_" or "mcp__bureau__" belong to Bureau's own ` +
                `control channel and are always allowed ahead of rule evaluation (§23.2).`,
            );
          }
        }
      });
    }

    // 4a is deliberately ASYMMETRIC: granting a network tool without a
    // destination list is a hole (the role can reach anything), while a
    // destination list with no network tool is merely dead configuration.
    const grantedNetworkTools = NETWORK_TOOL_NAMES.filter((tool) =>
      role.tools_allow.some((pattern) =>
        parseToolPattern(pattern).some((term) => term.tool === tool),
      ),
    );
    if (grantedNetworkTools.length > 0 && role.network_allow.length === 0) {
      errors.push(
        `${label}: grants ${grantedNetworkTools.join(', ')} but network_allow is empty — ` +
          `a role with a network tool must declare the domains it may reach (§6.7 check 4a).`,
      );
    }
    if (grantedNetworkTools.length === 0 && role.network_allow.length > 0) {
      warnings.push(
        `${label}: declares network_allow but is granted no network tool, so the list has no effect.`,
      );
    }
  }
}

// --- check 5 ------------------------------------------------------------

function checkWidening(pack: ParsedPack, errors: string[]): void {
  for (const role of pack.roles) {
    const rules: Rule[] = roleRulesFrom({
      // `full_key` only ever appears in the rule id and the error text
      // here; the pack is not installed yet, so there is no DB row to read
      // a real one from.
      full_key: `${pack.manifest.key}:${role.key}`,
      tools_allow: role.tools_allow,
      tools_deny: role.tools_deny,
    });

    for (const message of assertNoImmutableWidening(rules)) {
      errors.push(`roles/${role.key}.yaml: ${message}`);
    }

    // The other half of check 5, and not a formality: the rules this role
    // produces must actually LOAD into a valid rule set. `buildRuleSet` is
    // what enforces the id-collision rule and the tier floor, and running
    // it here is what makes "fails validation at load" true of the tier
    // rules too rather than only of the widening patterns.
    //
    // Found by a surviving mutation. Inverting IMMUTABLE_RULE_PRIORITY
    // (0 -> 150) left S3 entirely green, because the install path went
    // roleRulesFrom -> assertNoImmutableWidening and never touched
    // `validateRuleSet` at all. A guard nothing on the real path calls is
    // not a guard.
    try {
      buildRuleSet({ roleRules: rules });
    } catch (err) {
      errors.push(`roles/${role.key}.yaml: ${(err as Error).message}`);
    }
  }
}

// --- check 6 ------------------------------------------------------------

function checkRoleOptions(pack: ParsedPack, errors: string[]): void {
  const schema = pack.manifest.role_options_schema;
  for (const role of pack.roles) {
    const label = `roles/${role.key}.yaml`;
    if (schema === undefined) {
      // Nothing declared — `role_options` is only required to be an object,
      // which the Zod schema already guaranteed. Deliberately permissive:
      // it is "a JSON bag for pack-specific settings, deliberately opaque
      // to the Core" (§5.1) until the pack itself says otherwise.
      continue;
    }
    for (const [key, value] of Object.entries(role.role_options)) {
      const expected = schema[key];
      if (expected === undefined) {
        errors.push(
          `${label}: role_options.${key} is not declared in pack.yaml's role_options_schema.`,
        );
        continue;
      }
      const actual = typeof value;
      if (actual !== expected) {
        errors.push(`${label}: role_options.${key} should be ${expected}, got ${actual}.`);
      }
    }
  }
}

// --- check 7 ------------------------------------------------------------

function checkSpriteKeys(pack: ParsedPack, warnings: string[]): void {
  for (const role of pack.roles) {
    if (!KNOWN_SPRITE_KEYS.includes(role.sprite_key)) {
      warnings.push(
        `roles/${role.key}.yaml: sprite_key "${role.sprite_key}" is not a known sprite — ` +
          `falling back to "${FALLBACK_SPRITE_KEY}".`,
      );
    }
  }
}

// --- check 8 ------------------------------------------------------------

/**
 * §6.7 check 8 — "Department room sizes fit the floor, or the floor is
 * expanded (§13.3)."
 *
 * **This became a real check at M7 session 2.** Session 1 implemented it as
 * a sanity bound and said so explicitly, because the floor generator did
 * not exist to define "fit". It does now, and the generator's own geometry
 * makes the question sharp:
 *
 * §13.3 step 5 expands the floor **downward** and re-packs. Width never
 * grows. So a room taller than the floor is fine — the floor grows to meet
 * it — while a room WIDER than the usable floor can never be placed, no
 * matter how far it expands. That asymmetry is the whole check, and it is
 * asserted against `MAX_ROOM_WIDTH_TILES`, the same constant the generator
 * packs against, so the two cannot drift.
 *
 * The pixels-not-tiles sanity bound stays: it catches a typo'd
 * `preferred_size: {w: 1200, h: 800}` with a message that says what went
 * wrong, rather than the width rule's more mechanical one.
 */
function checkRoomSizes(pack: ParsedPack, maxTiles: number, errors: string[]): void {
  for (const department of pack.departments) {
    const { w, h } = department.room.preferred_size;
    if (w > maxTiles || h > maxTiles) {
      errors.push(
        `departments/${department.key}.yaml: room preferred_size ${w}x${h} exceeds ${maxTiles} tiles per side ` +
          `— sizes are in TILES, not pixels.`,
      );
      continue;
    }
    if (w > MAX_ROOM_WIDTH_TILES) {
      errors.push(
        `departments/${department.key}.yaml: room preferred_size is ${w} tiles wide, but the floor is ` +
          `${FLOOR_WIDTH_TILES} tiles wide and expands downward only (§13.3) — the widest room that can ever ` +
          `be placed is ${MAX_ROOM_WIDTH_TILES}.`,
      );
    }
  }
}
