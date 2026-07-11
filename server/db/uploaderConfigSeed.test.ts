// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-uploader-seed-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let seedUploaderConfig: typeof import('./uploaderConfigSeed.js').seedUploaderConfig;
let createUser: typeof import('./users.js').createUser;
let setUserSetting: typeof import('./settings.js').setUserSetting;
let getUserSettings: typeof import('./settings.js').getUserSettings;

interface Row {
  id: number;
  driver: string;
  is_default: number;
  offered_to_users: number;
  secrets_enc: string | null;
  config_json: string;
}

const instanceRows = (): Row[] =>
  db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'instance' ORDER BY driver`)
    .all() as Row[];
const userRows = (uid: number): Row[] =>
  db
    .prepare(`SELECT * FROM uploader_config WHERE scope = 'user' AND owner_user_id = ?`)
    .all(uid) as Row[];
const allowUserDefined = (): string | undefined =>
  (
    db
      .prepare(`SELECT value FROM instance_settings WHERE key = 'uploads.allow_user_defined'`)
      .get() as { value: string } | undefined
  )?.value;

beforeAll(async () => {
  db = (await import('./index.js')).default;
  ({ seedUploaderConfig } = await import('./uploaderConfigSeed.js'));
  ({ createUser } = await import('./users.js'));
  ({ setUserSetting, getUserSettings } = await import('./settings.js'));
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  // Clear everything the seed touches (users cascade to their uploader_config +
  // user_settings) for a deterministic starting point.
  db.prepare('DELETE FROM uploader_config').run();
  db.prepare('DELETE FROM instance_settings').run();
  db.prepare('DELETE FROM user_settings').run();
  db.prepare('DELETE FROM users').run();
});

describe('seedUploaderConfig (self-host)', () => {
  it('seeds instance x0 (default) + catbox, allow_user_defined=1', () => {
    seedUploaderConfig(db);
    const inst = instanceRows();
    expect(inst.map((r) => r.driver)).toEqual(['catbox', 'x0']);
    const x0 = inst.find((r) => r.driver === 'x0')!;
    const catbox = inst.find((r) => r.driver === 'catbox')!;
    expect(x0.is_default).toBe(1);
    expect(x0.offered_to_users).toBe(1);
    expect(catbox.is_default).toBe(0);
    expect(catbox.offered_to_users).toBe(1);
    expect(allowUserDefined()).toBe('1');
  });

  it('converts a configured catbox user into a user row + uploader_id', () => {
    const u = createUser('seed-catbox');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'hash1');
    seedUploaderConfig(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('catbox');
    expect(rows[0].secrets_enc).toContain('hash1'); // secret carried across
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(rows[0].id);
  });

  it('converts a configured self-host hoarder user (url public, key secret)', () => {
    const u = createUser('seed-hoarder');
    setUserSetting(u.id, 'uploads.provider', 'hoarder');
    setUserSetting(u.id, 'uploads.hoarder.url', 'https://u.example');
    setUserSetting(u.id, 'uploads.hoarder.api_key', 'k-secret');
    seedUploaderConfig(db);

    const rows = userRows(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].driver).toBe('hoarder');
    expect(JSON.parse(rows[0].config_json)).toEqual({ url: 'https://u.example' });
    expect(rows[0].secrets_enc).toContain('k-secret');
    expect(rows[0].config_json).not.toContain('k-secret');
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(rows[0].id);
  });

  it('points an x0 / unconfigured user at the instance x0 row, no user row', () => {
    const u = createUser('seed-x0'); // no settings at all
    seedUploaderConfig(db);
    expect(userRows(u.id)).toHaveLength(0);
    const x0 = instanceRows().find((r) => r.driver === 'x0')!;
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(x0.id);
  });

  it('is idempotent — a second run adds no rows and does not clobber', () => {
    const u = createUser('seed-idem');
    setUserSetting(u.id, 'uploads.provider', 'catbox');
    setUserSetting(u.id, 'uploads.catbox.userhash', 'hh');
    seedUploaderConfig(db);
    const firstUserRowId = userRows(u.id)[0].id;
    const firstUploaderId = getUserSettings(u.id)['uploads.uploader_id'];

    seedUploaderConfig(db);
    expect(instanceRows()).toHaveLength(2); // still just x0 + catbox
    expect(userRows(u.id)).toHaveLength(1);
    expect(userRows(u.id)[0].id).toBe(firstUserRowId);
    expect(getUserSettings(u.id)['uploads.uploader_id']).toBe(firstUploaderId);
  });
});
