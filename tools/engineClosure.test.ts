// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// tools/engine-closure.mjs decides, for the release workflow, whether the
// engine changed. Run through its real CLI, the way docker-publish.yml calls
// it: against this repo, and against small fixture repos for the scan's edges.

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repo = path.join(import.meta.dirname, '..');
const script = path.join(repo, 'tools', 'engine-closure.mjs');

function run(args: string[], stdin?: string) {
  const r = spawnSync(process.execPath, [script, ...args], {
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

function lock(
  packages: Record<string, { version: string; dependencies?: Record<string, string> }>,
) {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });
}

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
        'Dockerfile',
        'tsconfig*.json',
      ]),
    );
    expect(lines.filter((l) => /\.(test|spec)\.ts$/.test(l))).toEqual([]);
    for (const file of lines.filter((l) => !l.includes('*'))) {
      expect(fs.existsSync(path.join(repo, file)), `${file} exists`).toBe(true);
    }
  });

  it("lists the engine's packages and what they pull in, but not a lazy import it never runs", () => {
    const { status, lines } = run(
      ['deps'],
      fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'),
    );
    expect(status).toBe(0);
    const names = lines.map((l) => l.slice(0, l.lastIndexOf('@')));
    expect(names).toEqual(
      expect.arrayContaining([
        'node_modules/irc-framework',
        'node_modules/socks',
        // socks' own dependency: a lockfile-only bump of it changes the engine.
        'node_modules/smart-buffer',
        'node_modules/dotenv',
      ]),
    );
    // clientCert.ts imports it inside generateClientCert, which only the app calls.
    expect(names).not.toContain('node_modules/selfsigned');
  });
});

describe('engine-closure import scan', () => {
  it('follows every import form, and skips type-only imports and builtins', () => {
    const root = fixture({
      'server/engine.ts': [
        "import 'dotenv/config';",
        "import net from 'node:net';",
        "import os from 'os';",
        'import {',
        '  a,',
        '  b,',
        "} from './engine/multi.js';",
        "import type { T } from './engine/typesOnly.js';",
        "export { c } from './engine/reexport.js';",
        "export * from './engine/star.js';",
        "import './engine/sideEffect.js';",
        "import { type U, d } from './engine/mixed.js';",
      ].join('\n'),
      'server/engine/multi.ts': "import { x } from '@scope/pkg/sub';\nexport const a = 1, b = 2;\n",
      'server/engine/typesOnly.ts': "import 'never-loaded';\n",
      'server/engine/reexport.ts': 'export const c = 1;\n',
      'server/engine/star.ts': 'export const s = 1;\n',
      'server/engine/sideEffect.ts': '',
      'server/engine/mixed.ts': 'export const d = 1;\n',
    });
    expect(run(['files', '--root', root]).lines).toEqual([
      'server/engine.ts',
      'server/engine/mixed.ts',
      'server/engine/multi.ts',
      'server/engine/reexport.ts',
      'server/engine/sideEffect.ts',
      'server/engine/star.ts',
      'Dockerfile',
      'tsconfig*.json',
    ]);
    const deps = run(
      ['deps', '--root', root],
      lock({
        'node_modules/dotenv': { version: '1.0.0' },
        'node_modules/@scope/pkg': { version: '2.0.0' },
      }),
    );
    expect(deps.lines).toEqual(['node_modules/@scope/pkg@2.0.0', 'node_modules/dotenv@1.0.0']);
  });

  it('refuses an import it cannot resolve', () => {
    const root = fixture({ 'server/engine.ts': "import { x } from './engine/gone.js';\n" });
    const r = run(['files', '--root', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot resolve import './engine/gone.js'");
    expect(r.lines).toEqual([]);
  });

  it('refuses a dynamic import nobody said the engine never runs', () => {
    for (const call of ["await import('./engine/late.js');", 'await import(name);']) {
      const root = fixture({ 'server/engine.ts': call, 'server/engine/late.ts': '' });
      const r = run(['files', '--root', root]);
      expect(r.status, `status for ${call}`).toBe(1);
      expect(r.stderr, `stderr for ${call}`).toContain('LAZY_IMPORTS');
    }
  });
});

describe('engine-closure lockfile walk', () => {
  const root = () => fixture({ 'server/engine.ts': "import 'a';\n" });

  it('follows nested resolution, so the copy a package actually loads is the one compared', () => {
    const r = run(
      ['deps', '--root', root()],
      lock({
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^2' } },
        'node_modules/a/node_modules/b': { version: '2.1.0', dependencies: { c: '*' } },
        'node_modules/b': { version: '1.0.0' },
        'node_modules/c': { version: '3.0.0' },
        'node_modules/unrelated': { version: '9.9.9' },
      }),
    );
    expect(r.lines).toEqual([
      'node_modules/a/node_modules/b@2.1.0',
      'node_modules/a@1.0.0',
      'node_modules/c@3.0.0',
    ]);
  });

  it('reports a package an older lockfile lacks instead of failing', () => {
    const r = run(['deps', '--root', root()], lock({}));
    expect(r.status).toBe(0);
    expect(r.lines).toEqual(['node_modules/a@(absent)']);
  });
});
