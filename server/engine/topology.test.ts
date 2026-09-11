// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The engine's protocol major is copied into two artefacts that CI and
// self-hosters read: the image tag the compose overlay pins, and the tag the
// publish workflow derives. The workflow reads the constant from source; this
// pins the overlay to it, so a PROTOCOL_MAJOR bump cannot ship a v2 engine to
// people pulling `engine-1`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_MAJOR } from './protocol.js';
import { ENGINE_VERSION } from './version.js';

const root = path.join(import.meta.dirname, '..', '..');

describe('engine topology artefacts', () => {
  it('docker-compose.engine.yml pins the image tag for this PROTOCOL_MAJOR', () => {
    const overlay = fs.readFileSync(path.join(root, 'docker-compose.engine.yml'), 'utf8');
    const m = /image:\s*\$\{LURKER_ENGINE_IMAGE:-ghcr\.io\/amiantos\/lurker:engine-(\d+)\}/.exec(
      overlay,
    );
    expect(m, 'the overlay should pin ghcr.io/amiantos/lurker:engine-<major>').not.toBeNull();
    expect(Number(m![1])).toBe(PROTOCOL_MAJOR);
  });

  it('the publish workflow reads the major from protocol.ts rather than hardcoding it', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(wf).toMatch(/PROTOCOL_MAJOR = \(\[0-9\]\+\);/);
    expect(wf).not.toMatch(/^\s*MAJOR=\d+\s*$/m);
    // And it never trips on the version bump every release makes.
    expect(wf).not.toMatch(/git diff --quiet[^\n]*package\.json/);
  });

  // The engine's version is set by hand (server/engine/version.ts), and the
  // release workflow refuses to move the engine tag unless it names that
  // release. The workflow reads the constant with a sed, so this pins both ends:
  // the pattern still matches the file, and the engine still reports the
  // constant — not package.json's version, which a later checkout would carry.
  it('the publish workflow checks ENGINE_VERSION, and the engine reports it', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/docker-publish.yml'), 'utf8');
    expect(wf).toContain(
      `sed -nE "s/^export const ENGINE_VERSION = '([^']+)';/\\1/p" server/engine/version.ts`,
    );
    const src = fs.readFileSync(path.join(root, 'server/engine/version.ts'), 'utf8');
    expect(/^export const ENGINE_VERSION = '([^']+)';$/m.exec(src)?.[1]).toBe(ENGINE_VERSION);
    const entry = fs.readFileSync(path.join(root, 'server/engine.ts'), 'utf8');
    expect(entry).toMatch(/^\s*version: ENGINE_VERSION,$/m);
  });

  // The engine binds loopback unless told otherwise (server/engine/config.ts),
  // which is the safe default for an engine beside the app on a host — and
  // fatal in a container, where loopback is that container's own namespace and
  // the `lurker` container cannot reach it. The overlay must therefore set the
  // bind, and this pins the coupling from the other end: nothing else would
  // fail if that line were dropped, until every connection did.
  it('the compose overlay gives the engine a reachable bind', () => {
    const overlay = fs.readFileSync(path.join(root, 'docker-compose.engine.yml'), 'utf8');
    const m = /LURKER_ENGINE_LISTEN=\$\{LURKER_ENGINE_LISTEN:-([^}]+)\}/.exec(overlay);
    expect(
      m,
      'the overlay should set LURKER_ENGINE_LISTEN for the engine container',
    ).not.toBeNull();
    expect(m![1]).not.toMatch(/^(127\.|::1|localhost)/);
    // …and it still must not publish the port; the compose network is the boundary.
    expect(overlay).not.toMatch(/^\s*ports:/m);
  });

  // `${{ cond && 0 || 1 }}` always evaluates to 1 in a GitHub Actions
  // expression: 0 is falsy, so the `|| 1` branch wins. In the checkout step
  // that silently turns every release into a shallow clone, `git describe`
  // finds no previous tag, the step falls back to "the engine changed", and
  // `engine-<major>` moves on EVERY release — recreating the engine container,
  // and dropping the IRC connections the whole overlay exists to keep. It
  // fails in the direction that looks like success, and nothing but a
  // self-hoster noticing their connections drop would report it.
  it('the publish workflow cannot land a falsy value in a GitHub Actions ternary', () => {
    const wf = fs.readFileSync(path.join(root, '.github/workflows/docker-publish.yml'), 'utf8');
    const ternaries = [...wf.matchAll(/\$\{\{[^}]*?&&([^}]*?)\|\|[^}]*?\}\}/g)];
    expect(ternaries.length, 'expected at least the fetch-depth ternary').toBeGreaterThan(0);
    for (const t of ternaries) {
      expect(t[1].trim(), `falsy true-branch in ${t[0]}`).not.toMatch(/^(0|false|'')$/);
    }
    // The release path must also refuse to decide from a clone that cannot see
    // history, rather than falling through to "publish".
    expect(wf).toMatch(/is-shallow-repository/);
  });
});
