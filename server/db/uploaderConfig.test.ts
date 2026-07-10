// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploader-config-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let mod: typeof import('./uploaderConfig.js');
let createUser: typeof import('./users.js').createUser;
let resetKeyRegistryForTests: typeof import('../utils/secretCrypto.js').resetKeyRegistryForTests;
let userId: number;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  mod = await import('./uploaderConfig.js');
  ({ createUser } = await import('./users.js'));
  ({ resetKeyRegistryForTests } = await import('../utils/secretCrypto.js'));
  userId = createUser('uploader-cfg-alice').id;
});

afterAll(() => {
  delete process.env.LURKER_SECRET_KEY;
  resetKeyRegistryForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM uploader_config').run();
  delete process.env.LURKER_SECRET_KEY;
  resetKeyRegistryForTests();
});

describe('uploaderConfig', () => {
  it('splits config by schema: secrets never land in config_json', () => {
    const id = mod.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'hoarder',
      values: { url: 'https://u.example', api_key: 'sekret' },
    });
    const row = mod.getUploaderConfig(id)!;
    // url is a non-secret field → config_json; api_key is secret → secrets_enc.
    expect(JSON.parse(row.config_json)).toEqual({ url: 'https://u.example' });
    expect(row.config_json).not.toContain('sekret');
    expect(mod.resolvedConfig(row)).toEqual({ url: 'https://u.example', api_key: 'sekret' });
  });

  it('roundtrips secrets as plaintext on self-host (no key configured)', () => {
    const id = mod.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'catbox',
      values: { userhash: 'abc123' },
    });
    const row = mod.getUploaderConfig(id)!;
    // Without a key, secretCrypto is a plaintext no-op — the value is stored as-is.
    expect(row.secrets_enc).toContain('abc123');
    expect(mod.resolvedConfig(row)).toEqual({ userhash: 'abc123' });
  });

  it('encrypts secrets at rest when LURKER_SECRET_KEY is configured', () => {
    process.env.LURKER_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
    resetKeyRegistryForTests();
    const id = mod.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'catbox',
      values: { userhash: 'topsecret' },
    });
    const row = mod.getUploaderConfig(id)!;
    expect(row.secrets_enc).toMatch(/^lk1\./); // secretCrypto envelope
    expect(row.secrets_enc).not.toContain('topsecret');
    // Decrypts back on read.
    expect(mod.resolvedConfig(row)).toEqual({ userhash: 'topsecret' });
  });

  it('client projection carries only { id, driver, label } — no secrets', () => {
    const id = mod.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'catbox',
      label: 'My Catbox',
      values: { userhash: 'abc' },
    });
    const row = mod.getUploaderConfig(id)!;
    expect(mod.toSummary(row)).toEqual({ id, driver: 'catbox', label: 'My Catbox' });
  });

  it('enforces at most one instance default', () => {
    mod.createUploaderConfig({ scope: 'instance', driver: 'x0', isDefault: true });
    expect(() =>
      mod.createUploaderConfig({ scope: 'instance', driver: 'catbox', isDefault: true }),
    ).toThrow(/UNIQUE constraint/);
  });

  it('lists and finds instance vs user uploaders', () => {
    const instId = mod.createUploaderConfig({ scope: 'instance', driver: 'x0', isDefault: true });
    const userRow = mod.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'catbox',
      values: { userhash: 'x' },
    });
    expect(mod.listInstanceUploaders().map((r) => r.id)).toEqual([instId]);
    expect(mod.listUserUploaders(userId).map((r) => r.id)).toEqual([userRow]);
    expect(mod.getInstanceDefault()?.id).toBe(instId);
  });

  it('rejects an unknown driver', () => {
    expect(() => mod.createUploaderConfig({ scope: 'instance', driver: 'nope' })).toThrow(
      /unknown upload driver/,
    );
  });
});
