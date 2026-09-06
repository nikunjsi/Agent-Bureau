import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { ZodError } from 'zod';
import {
  PackManifestSchema,
  DepartmentYamlSchema,
  RoleYamlSchema,
  type ParsedPack,
  type DepartmentYaml,
  type RoleYaml,
} from '../../shared/models/pack';

/**
 * §6.2 — reads a pack directory into memory. Parse and Zod only: no DB, no
 * cross-file checks, no filesystem checks beyond the files it must read.
 * Everything semantic is `validatePack.ts`'s job, so the two can be
 * exercised independently.
 *
 * Follows `src/main/cost/pricingYaml.ts`'s convention (`{ parse }` from
 * `yaml`, `readFileSync`, annotate `unknown`, `Schema.parse`), with one
 * deliberate difference at the pack boundary: a pack is user-authorable
 * content, and §6.7 requires a *readable error*. So failures are collected
 * into `errors[]` rather than thrown as a raw `ZodError` — `packs.validate`
 * returns `{ valid, errors[] }` to the renderer, and a stringified Zod
 * issue tree is not something a pack author can act on.
 */

export interface PackLoadResult {
  /** Present only when `errors` is empty. */
  readonly pack: ParsedPack | null;
  readonly errors: string[];
}

const PACK_YAML = 'pack.yaml';
const DEPARTMENTS_DIR = 'departments';
const ROLES_DIR = 'roles';

/** Zod's issue tree is precise and unreadable. This is the readable half. */
function formatZodError(file: string, error: ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${file}: ${location} — ${issue.message}`;
  });
}

function readYamlFile(rootDir: string, relPath: string): { value: unknown } | { error: string } {
  const absolute = path.join(rootDir, relPath);
  let raw: string;
  try {
    raw = readFileSync(absolute, 'utf8');
  } catch {
    return { error: `${relPath}: cannot be read` };
  }
  try {
    return { value: parse(raw) as unknown };
  } catch (err) {
    return { error: `${relPath}: is not valid YAML — ${(err as Error).message}` };
  }
}

function listYamlFiles(rootDir: string, subdir: string): string[] {
  const absolute = path.join(rootDir, subdir);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return [];
  return readdirSync(absolute)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => path.posix.join(subdir, name));
}

export function loadPack(rootDir: string): PackLoadResult {
  const errors: string[] = [];

  const manifestRead = readYamlFile(rootDir, PACK_YAML);
  if ('error' in manifestRead) {
    // Without a manifest there is no pack — reporting the missing roles too
    // would bury the one error that matters.
    return { pack: null, errors: [manifestRead.error] };
  }
  const manifestParse = PackManifestSchema.safeParse(manifestRead.value);
  if (!manifestParse.success) {
    return { pack: null, errors: formatZodError(PACK_YAML, manifestParse.error) };
  }

  const departments: DepartmentYaml[] = [];
  for (const relPath of listYamlFiles(rootDir, DEPARTMENTS_DIR)) {
    const read = readYamlFile(rootDir, relPath);
    if ('error' in read) {
      errors.push(read.error);
      continue;
    }
    const parsed = DepartmentYamlSchema.safeParse(read.value);
    if (!parsed.success) {
      errors.push(...formatZodError(relPath, parsed.error));
      continue;
    }
    departments.push(parsed.data);
  }

  const roles: RoleYaml[] = [];
  for (const relPath of listYamlFiles(rootDir, ROLES_DIR)) {
    const read = readYamlFile(rootDir, relPath);
    if ('error' in read) {
      errors.push(read.error);
      continue;
    }
    const parsed = RoleYamlSchema.safeParse(read.value);
    if (!parsed.success) {
      errors.push(...formatZodError(relPath, parsed.error));
      continue;
    }
    roles.push(parsed.data);
  }

  if (departments.length === 0) {
    errors.push(`${DEPARTMENTS_DIR}/: contains no department definitions`);
  }
  if (roles.length === 0) {
    errors.push(`${ROLES_DIR}/: contains no role definitions`);
  }

  if (errors.length > 0) return { pack: null, errors };
  return {
    pack: { rootDir, manifest: manifestParse.data, departments, roles },
    errors: [],
  };
}
