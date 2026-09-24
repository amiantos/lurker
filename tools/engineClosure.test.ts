// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// tools/engine-closure.mjs decides, for the release workflow, whether the
// engine changed. Run through its real CLI, the way docker-publish.yml calls
// it: against this repo, and against small fixture repos for the edges.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dirname, '..');
const script = path.join(repo, 'tools', 'engine-closure.mjs');

function run(args: string[], stdin?: string, scriptPath = script) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repo,
    input: stdin,
    encoding: 'utf8',
  });
  return { status: r.status, lines: r.stdout.split('\n').filter(Boolean), stderr: r.stderr };
}

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repo root holding `files`, for `--root`. */
function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-closure-'));
  fixtures.push(dir);
  for (const [name, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), src);
  }
  return dir;
}

/** An installed CommonJS package at `dir` (e.g. `node_modules/a`). */
function pkg(dir: string, src: string): Record<string, string> {
  const name = dir.slice(dir.lastIndexOf('node_modules/') + 'node_modules/'.length);
  return {
    [`${dir}/package.json`]: JSON.stringify({ name, version: '1.0.0', main: 'index.js' }),
    [`${dir}/index.js`]: src,
  };
}

type LockEntry = { version: string; integrity?: string };

function lock(packages: Record<string, LockEntry>) {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
}

const ownFiles = (lines: string[]) => lines.filter((l) => l.endsWith('.ts') && !l.startsWith(':('));

describe('engine-closure against this repo', () => {
  it('lists the files the engine imports, including the ones the old hand list missed', () => {
    const { status, lines } = run(['files']);
    expect(status).toBe(0);
    expect(lines).toEqual(
      expect.arrayContaining([
        'server/engine.ts',
        'server/engine/server.ts',
        'server/engine/upstream.ts',
        'server/services/identd.ts',
        // Reached through upstream.ts and server.ts; not on the old list.
        'server/utils/proxyDial.ts',
        'shared/proxy.ts',
        'server/utils/clientCert.ts',
        'shared/clientCertPem.ts',
        // Whatever the engine reads at runtime rather than imports.
        'server/engine',
        'Dockerfile',
        'tsconfig*.json',
      ]),
    );
    expect(ownFiles(lines).filter((l) => /\.(test|spec)\.ts$/.test(l))).toEqual([]);
    for (const file of lines.filter((l) => !l.includes('*') && !l.startsWith(':('))) {
      expect(fs.existsSync(path.join(repo, file)), `${file} exists`).toBe(true);
    }
  });

  it('lists the packages whose code runs in the engine, and only those', () => {
    const { status, lines } = run(
      ['deps'],
      fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'),
    );
    expect(status).toBe(0);
    const names = lines.map((l) => l.slice(0, l.indexOf('@', 1)));
    expect(names).toEqual(
      expect.arrayContaining([
        'irc-framework',
        'iconv-lite',
        'socks',
        // socks' own dependency: a lockfile-only bump of it changes the engine.
        'smart-buffer',
        'dotenv',
      ]),
    );
    // clientCert.ts imports selfsigned inside generateClientCert, which only
    // the app calls; and irc-framework's browser polyfills never load in Node.
    for (const never of ['selfsigned', 'core-js', 'util', 'buffer', 'stream-browserify']) {
      expect(names, `${never} is not the engine's`).not.toContain(never);
    }
  });
});

describe('engine-closure module graph', () => {
  it("follows the engine's imports the way tsx loads them", () => {
    const root = fixture({
      'server/engine.ts': [
        "import { a } from './engine/a.js';",
        "import type { T } from './engine/typesOnly.js';",
        "// a comment with a quote in it: don't; and import('./engine/gone.js')",
        "const quote = /'/g; const glob = 'image/*';",
        "const words = 'failed to import (proxy)';",
        "const later = `${quote ? `a` : 'b'}`;",
        "await import('./engine/late.js');",
        '/** doc */',
        'console.log(a, quote, glob, words, later);',
      ].join('\n'),
      'server/engine/a.ts': 'export const a = 1;\n',
      'server/engine/typesOnly.ts': "import 'never-installed';\nexport type T = 1;\n",
      'server/engine/late.ts': 'export const l = 1;\n',
    });
    const r = run(['files', '--root', root]);
    expect(r.stderr).toBe('');
    expect(ownFiles(r.lines)).toEqual([
      'server/engine.ts',
      'server/engine/a.ts',
      'server/engine/late.ts',
    ]);
  });

  it('refuses an import it cannot resolve', () => {
    const root = fixture({ 'server/engine.ts': "import { x } from './engine/gone.js';\nx();\n" });
    const r = run(['files', '--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('./engine/gone.js');
    expect(r.lines).toEqual([]);
  });

  it('refuses a computed import or require in the engine, which could load anything', () => {
    for (const call of ['await import(process.env.X);', 'require(process.env.X);']) {
      const root = fixture({ 'server/engine.ts': `${call}\nexport {};\n` });
      const r = run(['files', '--root', root]);
      expect(r.status, `status for ${call}`).toBe(1);
      expect(r.stderr, `stderr for ${call}`).toContain('server/engine.ts');
    }
  });

  it('counts a package only once the engine can run its code', () => {
    const files = (callsIt: boolean) => ({
      'server/engine.ts': [
        "import { used, mint } from './engine/cert.js';",
        `console.log(used${callsIt ? ', await mint()' : ''});`,
      ].join('\n'),
      'server/engine/cert.ts': [
        'export const used = 1;',
        "export async function mint() { return (await import('lazy')).default; }",
      ].join('\n'),
      ...pkg('node_modules/lazy', 'module.exports = 42;\n'),
    });
    const theLock = lock({ 'node_modules/lazy': { version: '1.0.0', integrity: 'sha512-l' } });
    expect(run(['deps', '--root', fixture(files(false))], theLock).lines).toEqual([]);
    expect(run(['deps', '--root', fixture(files(true))], theLock).lines).toEqual([
      'lazy@1.0.0 sha512-l',
    ]);
  });
});

describe('engine-closure lockfile comparison', () => {
  // The engine loads a, which loads b; this checkout has b nested under a.
  const root = () =>
    fixture({
      'server/engine.ts': "import a from 'a';\nconsole.log(a);\n",
      ...pkg('node_modules/a', "module.exports = require('b');\n"),
      ...pkg('node_modules/a/node_modules/b', 'module.exports = 1;\n'),
    });
  const deps = (packages: Record<string, LockEntry>) =>
    run(['deps', '--root', root()], lock(packages));

  it('passes through a package with no code of its own to the ones it re-exports', () => {
    const esm = (name: string, src: string) => ({
      [`node_modules/${name}/package.json`]: JSON.stringify({
        name,
        version: '1.0.0',
        type: 'module',
        main: 'index.js',
        sideEffects: false,
      }),
      [`node_modules/${name}/index.js`]: src,
    });
    const root = fixture({
      'server/engine.ts': "import { v } from 'shim';\nconsole.log(v);\n",
      // Nothing of shim's survives the bundle; real's code does.
      ...esm('shim', "export * from 'real';\n"),
      ...esm('real', 'export const v = 1;\n'),
    });
    const r = run(
      ['deps', '--root', root],
      lock({
        'node_modules/shim': { version: '1.0.0' },
        'node_modules/real': { version: '3.0.0' },
      }),
    );
    expect(r.lines).toEqual(['real@3.0.0']);
  });

  it('reads a package the same wherever npm put it', () => {
    const nested = deps({
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
      'node_modules/a/node_modules/b': { version: '2.0.0', integrity: 'sha512-b' },
      'node_modules/b': { version: '9.0.0', integrity: 'sha512-other' },
    });
    const hoisted = deps({
      'node_modules/a': { version: '1.0.0', integrity: 'sha512-a' },
      'node_modules/b': { version: '2.0.0', integrity: 'sha512-b' },
    });
    expect(nested.lines).toEqual(['a@1.0.0 sha512-a', 'b@2.0.0 sha512-b']);
    expect(hoisted.lines).toEqual(nested.lines);
  });

  it('tells two builds of one version apart by integrity (a git or fork dependency)', () => {
    const withB = (integrity: string) =>
      deps({
        'node_modules/a': { version: '1.0.0' },
        'node_modules/b': { version: '2.0.0', integrity },
      }).lines;
    expect(withB('sha512-old')).not.toEqual(withB('sha512-new'));
  });

  it('reports a package an older lockfile lacks instead of failing', () => {
    const r = deps({ 'node_modules/a': { version: '1.0.0' } });
    expect(r.status).toBe(0);
    expect(r.lines).toEqual(['a@1.0.0', 'b@(absent)']);
  });
});

describe('engine-closure invocation', () => {
  it('runs when invoked through a symlinked path', () => {
    const dir = fixture({});
    const link = path.join(dir, 'linked-tools');
    fs.symlinkSync(path.dirname(script), link);
    const r = run(['files'], undefined, path.join(link, 'engine-closure.mjs'));
    expect(r.status).toBe(0);
    expect(r.lines).toContain('server/engine.ts');
  });
});
