// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-db-settings-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let mod;
let user;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  mod = await import('./settings.js');
  user = createUser('s-alice');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('setUserSetting / getUserSettings / deleteUserSetting', () => {
  it('JSON-encodes values transparently for round-trip', () => {
    mod.setUserSetting(user.id, 'foo.bar', 42);
    mod.setUserSetting(user.id, 'a.b.c', ['x', 'y']);
    mod.setUserSetting(user.id, 'flag', true);
    const values = mod.getUserSettings(user.id);
    expect(values['foo.bar']).toBe(42);
    expect(values['a.b.c']).toEqual(['x', 'y']);
    expect(values.flag).toBe(true);
  });

  it('upsert replaces an existing value', () => {
    mod.setUserSetting(user.id, 'foo.bar', 99);
    expect(mod.getUserSettings(user.id)['foo.bar']).toBe(99);
  });

  it('deleteUserSetting drops the override', () => {
    mod.deleteUserSetting(user.id, 'foo.bar');
    expect(mod.getUserSettings(user.id)['foo.bar']).toBeUndefined();
  });

  it('malformed rows are skipped silently', async () => {
    const db = (await import('./index.js')).default;
    db.prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      user.id, 'bad.json', 'not-json!!',
    );
    const values = mod.getUserSettings(user.id);
    expect(values['bad.json']).toBeUndefined();
  });
});
