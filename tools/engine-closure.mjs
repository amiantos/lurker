// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What the IRC engine is made of, for the release workflow's "did the engine
// change?" check (docker-publish.yml). `engine-<major>` moves only when a
// release changes the engine, so this has to name everything the engine
// process loads — a file it misses is a fix that never reaches anyone running
// the engine image, with a release log saying the engine didn't change.
//
// It used to be a list written into the workflow, and it fell behind: the
// CertFP and proxy work gave the engine four more files and the `socks`
// package, and the list never heard about them. So the list is now the
// engine's module graph, as esbuild resolves it from server/engine.ts. esbuild
// is what tsx transpiles and resolves the engine with at runtime, so its
// answer is the engine's: type-only imports dropped under this repo's
// tsconfig, Node's builtins left out, and a package's browser-only files never
// reached.
//
// A package counts only if some of its code survives esbuild's tree shaking,
// i.e. the engine can actually run it. clientCert.ts imports selfsigned inside
// generateClientCert, which only the app calls, so selfsigned and its
// dependencies don't count — and if the engine ever calls it, they will,
// without anyone having to remember to say so.
//
// Deliberately NOT included: tsx and esbuild themselves, the loader the engine
// runs under (docker-compose.engine.yml). Dependabot bumps them routinely, a
// bump rarely changes what the engine does, and every move of the engine tag
// drops self-hosters' IRC connections. Node itself IS covered, through the
// Dockerfile's pinned base image.
//
// Usage (from the repo root, after `npm ci`):
//   node tools/engine-closure.mjs files
//       the pathspecs to `git diff` between two releases, one per line
//   git show v2.3.1:package-lock.json | node tools/engine-closure.mjs deps
//       every package the engine loads, as `name@version integrity` lines
//
// `deps` takes the packages, and which package loads which, from THIS
// checkout's node_modules, then looks each one up in whichever lockfile it's
// fed — so the two sides of a release compare the same packages, and a
// package that moved in node_modules (a dedupe) without changing reads the
// same. Integrity is compared as well as version: a git or fork dependency
// can change without its version string changing.
//
// An import that doesn't resolve, or a dynamic import or require of a
// computed specifier in the engine's own files, stops the release. Code the
// engine loads without an import esbuild can see (createRequire, a Worker, a
// child process) is not caught; the diff of the whole server/engine directory
// is the backstop there. A package that declares `"sideEffects": false` is
// taken at its word.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// tsx's own copy of esbuild, not whichever one npm hoisted: esbuild isn't a
// dependency of ours in its own right, and a second copy could come in under
// some other package.
const { build } = createRequire(path.join(repo, 'node_modules/tsx/package.json'))('esbuild');

const ENTRY = 'server/engine.ts';

// Inputs the engine depends on that no import names: the whole engine
// directory (anything it reads at runtime rather than imports), the image it
// runs in, and the tsconfig it's transpiled with.
const STATIC_INPUTS = [
  'server/engine',
  ':(exclude)server/engine/*.test.ts',
  ':(exclude)server/engine/*.spec.ts',
  'Dockerfile',
  'tsconfig*.json',
];

class ClosureError extends Error {}

/** `node_modules/a/node_modules/@s/b/lib/x.js` → `node_modules/a/node_modules/@s/b`,
 *  the package's lockfile key; null for a file of our own. */
function packageKey(file) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file);
  return m ? m[1] : null;
}

function packageName(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** The engine's own files; which package each file or package loads
 *  (`edges.get(from)` maps the package names `from` imports to where they sit
 *  in this checkout, where `from` is a lockfile key, or '' for the engine's
 *  own files); and which packages have code in the engine (`used`). */
export async function scanEngine(root) {
  let result;
  try {
    result = await build({
      entryPoints: [ENTRY],
      absWorkingDir: path.resolve(root),
      bundle: true,
      platform: 'node',
      format: 'esm',
      // Resolve as Node does, not as a bundler would: tsx loads the engine
      // with Node's resolver and uses esbuild only to transpile. No `module`
      // condition, no `module` main field.
      conditions: [],
      mainFields: ['main'],
      write: false,
      outfile: 'engine.js',
      metafile: true,
      logLevel: 'silent',
      logOverride: {
        'unsupported-dynamic-import': 'warning',
        'unsupported-require-call': 'warning',
      },
    });
  } catch (err) {
    const first = err.errors?.[0];
    if (!first) throw err;
    const where = first.location ? `${first.location.file}:${first.location.line}: ` : '';
    throw new ClosureError(`${where}${first.text}`, { cause: err });
  }
  // A package's own computed require is the package's business: its contents
  // are covered by its version and integrity. One in the engine's files could
  // load anything.
  for (const w of result.warnings) {
    const file = w.location?.file ?? '';
    if (w.id.startsWith('unsupported-') && !packageKey(file)) {
      throw new ClosureError(`${file}:${w.location?.line}: ${w.text}`);
    }
  }
  const files = [];
  const edges = new Map();
  for (const [file, input] of Object.entries(result.metafile.inputs)) {
    const from = packageKey(file) ?? '';
    if (!from) files.push(file);
    for (const imp of input.imports) {
      const to = imp.external ? null : packageKey(imp.path);
      if (!to || to === from) continue;
      if (!edges.has(from)) edges.set(from, new Map());
      edges.get(from).set(packageName(to), to);
    }
  }
  const used = new Set();
  for (const output of Object.values(result.metafile.outputs)) {
    for (const [file, { bytesInOutput }] of Object.entries(output.inputs)) {
      const key = packageKey(file);
      if (key && bytesInOutput > 0) used.add(key);
    }
  }
  return { files: files.sort(), edges, used };
}

/** Each package with code in the engine, looked up in `lock` by npm's
 *  resolution from whatever loads it there, as `name@version integrity`. The
 *  walk still passes through a package with none (a re-export shim) to reach
 *  the ones it loads. */
export function lockClosure(lock, edges, used) {
  const entries = lock.packages ?? {};
  const find = (from, name) => {
    let dir = from;
    for (;;) {
      const key = `${dir ? `${dir}/` : ''}node_modules/${name}`;
      if (entries[key]) return key;
      if (!dir) return null;
      const i = dir.lastIndexOf('/node_modules/');
      dir = i < 0 ? '' : dir.slice(0, i);
    }
  };
  const lines = new Set();
  const seen = new Set();
  // `here` walks this checkout's graph; `there` is the same package's key in
  // `lock`, which may sit at a different depth.
  const walk = (here, there) => {
    for (const [name, child] of edges.get(here) ?? []) {
      const found = there === null ? null : find(there, name);
      const visit = `${child}\0${found}`;
      if (seen.has(visit)) continue;
      seen.add(visit);
      if (used.has(child)) {
        // A package this checkout's engine loads can be missing from an OLDER
        // lockfile (the release that added it). That's a difference, not an
        // error.
        const e = found === null ? null : entries[found];
        lines.add(
          e
            ? `${name}@${e.version ?? ''} ${e.integrity ?? e.resolved ?? ''}`.trim()
            : `${name}@(absent)`,
        );
      }
      walk(child, found);
    }
  };
  walk('', '');
  return [...lines].sort();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const rootFlag = rest.indexOf('--root');
  const root = rootFlag >= 0 ? rest[rootFlag + 1] : repo;
  if (cmd === 'files') {
    const { files } = await scanEngine(root);
    process.stdout.write([...files, ...STATIC_INPUTS].join('\n') + '\n');
  } else if (cmd === 'deps') {
    const { edges, used } = await scanEngine(root);
    const lock = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(lockClosure(lock, edges, used).join('\n') + '\n');
  } else {
    process.stderr.write('usage: node tools/engine-closure.mjs files|deps [--root DIR]\n');
    process.exit(2);
  }
}

// Node realpaths import.meta.url, so argv[1] must be too: through a symlinked
// checkout the two would differ, main() would never run, and the step would
// read empty output as an answer.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    if (!(err instanceof ClosureError)) throw err;
    process.stderr.write(`engine-closure: ${err.message}\n`);
    process.exit(1);
  });
}
