// Diffs §17.1's `window.bureau = {...}` code block in docs/BUILD-SPEC.md
// against src/shared/ipc/methodList.ts — the single source of truth every
// other IPC-surface consumer (preload, router) reads from. "Extract the
// method list from §17.1 with a script and diff it against what you
// implement. Do not eyeball it" (M2 build prompt).
//
// A small, honest text extraction, not a full TS/markdown parser — enough
// to pull `namespace: { method, method, ... }` pairs out of the fenced
// code block, which is all §17.1's shape actually needs.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const rootDir = path.resolve(import.meta.dirname, '..');

/** Strips a `// ...` line comment from every line (not just the whole
 * string's end) — needed because §17.1's code block comments each `on.*`
 * event on its own line, before the next event's name on the next line. */
function stripLineComments(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function extractSpecSurface() {
  const spec = readFileSync(path.join(rootDir, 'docs', 'BUILD-SPEC.md'), 'utf8');

  const sectionMatch = /### 17\.1 Shape\b[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(spec);
  if (!sectionMatch?.[1]) {
    throw new Error('Could not find the §17.1 "window.bureau = {...}" fenced code block in BUILD-SPEC.md');
  }
  const block = stripLineComments(sectionMatch[1]);

  // Split the block into the request/response half and the `on: {...}` half.
  const onSplit = /\bon:\s*\{([\s\S]*?)\n {2}\},?\s*\n\};/.exec(block);
  const onBlock = onSplit?.[1] ?? '';
  const requestBlock = onSplit ? block.slice(0, onSplit.index) : block;

  const methods = {};
  // `namespace:  { method, method,\n   method },` — namespaces can wrap
  // their method list across lines, so match namespace name then
  // everything up to the matching `}`.
  const nsRegex = /(\w+):\s*\{([^}]*)\}/g;
  let m;
  while ((m = nsRegex.exec(requestBlock)) !== null) {
    const [, ns, body] = m;
    if (ns === undefined || body === undefined) continue;
    const names = body
      .split(',')
      .map((s) => s.replace(/\/\/.*$/, '').trim())
      .filter((s) => s.length > 0);
    methods[ns] = names.sort();
  }

  const events = onBlock
    .split(',')
    .map((s) => s.replace(/\/\/.*$/, '').trim())
    .filter((s) => s.length > 0)
    .sort();

  return { methods, events };
}

async function loadMethodList() {
  const src = readFileSync(path.join(rootDir, 'src', 'shared', 'ipc', 'methodList.ts'), 'utf8');
  const { code } = await esbuild.transform(src, { loader: 'ts', format: 'esm' });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return import(dataUrl);
}

function diffNamespaces(specMethods, codeMethods) {
  const problems = [];
  const allNs = new Set([...Object.keys(specMethods), ...Object.keys(codeMethods)]);
  for (const ns of [...allNs].sort()) {
    const specList = specMethods[ns] ?? [];
    const codeList = codeMethods[ns] ?? [];
    if (specMethods[ns] === undefined) {
      problems.push(`  namespace "${ns}" exists in methodList.ts but not in §17.1`);
      continue;
    }
    if (codeMethods[ns] === undefined) {
      problems.push(`  namespace "${ns}" exists in §17.1 but not in methodList.ts`);
      continue;
    }
    const specSet = new Set(specList);
    const codeSet = new Set(codeList);
    for (const method of specList) {
      if (!codeSet.has(method)) problems.push(`  ${ns}.${method}: in §17.1, missing from methodList.ts`);
    }
    for (const method of codeList) {
      if (!specSet.has(method)) problems.push(`  ${ns}.${method}: in methodList.ts, missing from §17.1`);
    }
  }
  return problems;
}

function diffEvents(specEvents, codeEvents) {
  const problems = [];
  const specSet = new Set(specEvents);
  const codeSet = new Set(codeEvents);
  for (const e of specEvents) if (!codeSet.has(e)) problems.push(`  on.${e}: in §17.1, missing from IPC_EVENTS`);
  for (const e of codeEvents) if (!specSet.has(e)) problems.push(`  on.${e}: in IPC_EVENTS, missing from §17.1`);
  return problems;
}

async function main() {
  const { methods: specMethods, events: specEvents } = extractSpecSurface();
  const { IPC_METHODS, IPC_EVENTS } = await loadMethodList();

  const codeMethods = Object.fromEntries(
    Object.entries(IPC_METHODS).map(([ns, list]) => [ns, [...list].sort()]),
  );
  const codeEvents = [...IPC_EVENTS].sort();

  const problems = [...diffNamespaces(specMethods, codeMethods), ...diffEvents(specEvents, codeEvents)];

  if (problems.length > 0) {
    console.error('IPC surface mismatch between docs/BUILD-SPEC.md §17.1 and src/shared/ipc/methodList.ts:\n');
    console.error(problems.join('\n'));
    process.exitCode = 1;
    return;
  }

  const totalMethods = Object.values(codeMethods).reduce((n, list) => n + list.length, 0);
  console.log(
    `IPC surface matches: ${Object.keys(codeMethods).length} namespaces, ${totalMethods} methods, ${codeEvents.length} events.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
