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
// package, and the list never heard about them. So the list is now derived by
// following the engine's imports from server/engine.ts, and checked against
// the lockfile for the packages those imports reach.
//
// Usage (from the repo root, plain Node — the release job has no npm install):
//   node tools/engine-closure.mjs files
//       the pathspecs to `git diff` between two releases, one per line
//   git show v2.3.1:package-lock.json | node tools/engine-closure.mjs deps
//       every package the engine loads, transitively, as key@version lines
//
// `deps` takes its package list from THIS checkout's imports and reads
// versions from whichever lockfile it's fed, so the two sides of a release
// compare the same packages.
//
// The import scan is a regex, not a parser, and it fails loudly rather than
// guess: an import it can't resolve, or a dynamic import it wasn't told about,
// exits non-zero, which stops the release before anything is published.

import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';

const ENTRY = 'server/engine.ts';

// Inputs the engine depends on that no import names: the image it runs in,
// and the tsconfig tsx transpiles it with.
const STATIC_INPUTS = ['Dockerfile', 'tsconfig*.json'];

// A dynamic import is loaded when its code runs, not when the engine starts,
// so it is only part of the engine if the engine calls it. Each one in the
// engine's files must be listed here with the reason the engine never runs it;
// an unlisted one stops the release, since the scan can't tell.
const LAZY_IMPORTS = {
  // generateClientCert mints certs for the app's CertFP form. The engine
  // imports clientCert.ts only for isDialableCertPair.
  'server/utils/clientCert.ts': ['selfsigned'],
};

// `import … from '…'`, `export … from '…'` and a bare `import '…'`. The span
// before `from` may cross lines (a long import list) but not a semicolon, a
// quote, or the start of another import/export statement.
const STATIC_RE =
  /^[ \t]*(import|export)(\s+type\b(?!\s*,))?(?:(?!^[ \t]*(?:import|export)\b)[^;'"])*?\bfrom\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*(?:(['"])([^'"]+)\1)?/g;

class ClosureError extends Error {}

function resolveLocal(root, fromFile, spec) {
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  const candidates = base.endsWith('.js')
    ? [base.slice(0, -3) + '.ts', base]
    : [base, base + '.ts', base + '/index.ts'];
  const hit = candidates.find((c) =>
    fs.statSync(path.join(root, c), { throwIfNoEntry: false })?.isFile(),
  );
  if (!hit) throw new ClosureError(`${fromFile}: cannot resolve import '${spec}'`);
  return hit;
}

function packageName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The repo-relative files the engine loads, and the packages they import. */
export function scanEngine(root) {
  const files = new Set();
  const packages = new Set();
  const visit = (file) => {
    if (files.has(file)) return;
    files.add(file);
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    for (const m of src.matchAll(STATIC_RE)) {
      if (m[2]) continue; // `import type` / `export type`: erased, loads nothing
      const spec = m[3] ?? m[4];
      if (spec.startsWith('.')) visit(resolveLocal(root, file, spec));
      else if (!isBuiltin(spec)) packages.add(packageName(spec));
    }
    for (const m of src.matchAll(DYNAMIC_RE)) {
      const spec = m[2];
      if (!spec || !(LAZY_IMPORTS[file] ?? []).includes(spec)) {
        throw new ClosureError(
          `${file}: dynamic import ${spec ? `'${spec}'` : '(computed)'} — list it in LAZY_IMPORTS if the engine never runs it, or make it static`,
        );
      }
    }
  };
  visit(ENTRY);
  return { files: [...files].sort(), packages: [...packages].sort() };
}

/** Every lockfile entry `roots` load, following npm's nested resolution. */
export function lockClosure(lock, roots) {
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
  const seen = new Map();
  const walk = (key) => {
    if (seen.has(key)) return;
    const entry = entries[key];
    seen.set(key, entry.version ?? entry.resolved ?? '');
    const deps = {
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    };
    for (const name of Object.keys(deps)) {
      const dep = find(key, name);
      if (dep) walk(dep);
    }
  };
  for (const name of roots) {
    // A package this checkout's engine imports can be missing from an OLDER
    // lockfile (the release that added it). That's a difference, not an error.
    const key = find('', name);
    if (key) walk(key);
    else seen.set(`node_modules/${name}`, '(absent)');
  }
  return [...seen].map(([key, version]) => `${key}@${version}`).sort();
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const rootFlag = rest.indexOf('--root');
  const root =
    rootFlag >= 0
      ? rest[rootFlag + 1]
      : path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (cmd === 'files') {
    const { files } = scanEngine(root);
    process.stdout.write([...files, ...STATIC_INPUTS].join('\n') + '\n');
  } else if (cmd === 'deps') {
    const { packages } = scanEngine(root);
    const lock = JSON.parse(fs.readFileSync(0, 'utf8'));
    process.stdout.write(lockClosure(lock, packages).join('\n') + '\n');
  } else {
    process.stderr.write('usage: node tools/engine-closure.mjs files|deps [--root DIR]\n');
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    if (!(err instanceof ClosureError)) throw err;
    process.stderr.write(`engine-closure: ${err.message}\n`);
    process.exit(1);
  }
}
