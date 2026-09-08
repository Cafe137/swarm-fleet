/**
 * What the deployed agent is allowed to depend on.
 *
 * `deploy` ships `dist/`, `node_modules/zod` and nothing else — half a megabyte
 * instead of the 11 MB the Swarm SDK adds — so `cli.js` must be able to reach
 * `agent --stdio` without statically importing anything else. The publisher
 * (bee-js) and the live view (cli-table3) are both loaded with `await import()`
 * for exactly that reason: neither runs on an agent.
 *
 * Get this wrong and the failure appears only on remote machines, as
 * `ERR_MODULE_NOT_FOUND` inside an ssh pipe, several seconds into a fleet
 * launch. So it is a test rather than a comment.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** Bare specifiers the archive can actually resolve on the far side. */
const SHIPPED = new Set(['zod']);

test('the agent bundle needs nothing the deploy does not ship', async () => {
  const external = await staticExternals(path.join(SRC, 'cli.ts'));
  const missing = [...external].filter(
    (specifier) => !specifier.startsWith('node:') && !SHIPPED.has(rootPackage(specifier)),
  );
  assert.deepEqual(
    missing,
    [],
    `statically reachable from cli.ts but not in the agent archive: ${missing.join(', ')}. ` +
      'Import it with `await import()` from the command that needs it, or add it to the tar ' +
      'in buildAgentArchive.',
  );
});

test('the publisher is reachable, but only dynamically', async () => {
  // The guard above passes trivially if nothing imports the publisher at all,
  // so check that the dynamic import is really there and really the only one.
  const cli = await readFile(path.join(SRC, 'cli.ts'), 'utf8');
  assert.match(cli, /await import\('\.\/publisher\/control\.js'\)/);
  const valueImports = cli
    .split('\n')
    .filter((line) => /from '\.\/publisher\/control/.test(line))
    .filter((line) => !/^\s*(?:import|export)\s+type\b/.test(line));
  assert.deepEqual(
    valueImports,
    [],
    'cli.ts must not import publisher/control.js for its values: that pulls in bee-js. A ' +
      '`import type` is fine — it is erased — but the call has to be `await import()`.',
  );

  // The config module is imported statically on purpose — the scenario schema
  // needs it — so it must stay free of the SDK.
  const config = await readFile(path.join(SRC, 'publisher', 'config.ts'), 'utf8');
  assert.doesNotMatch(config, /@ethersphere/);
});

/** Bare specifiers reachable from `entry` through static imports only. */
async function staticExternals(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = await readFile(file, 'utf8').catch(() => undefined);
    if (source === undefined) {
      continue;
    }
    for (const specifier of staticSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        external.add(specifier);
        continue;
      }
      // Emitted JS imports `./x.js`; the source of it is `./x.ts`.
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
      queue.push(resolved);
    }
  }
  return external;
}

/**
 * `import ... from 'x'` and `export ... from 'x'`, but never `await import('x')`
 * and never `import type`, which the compiler erases.
 *
 * Deliberately a regex rather than a parser: the distinction being tested is
 * exactly the one a regex can see, and taking on a parser dependency to check
 * the dependency list would be ironic. An import whose bindings are all types
 * but written inline is counted anyway — conservative in the safe direction.
 */
function staticSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^\n;]*?from\s*'([^']+)'/g,
  )) {
    out.push(match[1] as string);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*'([^']+)'/g)) {
    out.push(match[1] as string);
  }
  return out;
}

function rootPackage(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}
