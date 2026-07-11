// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-resolve-uploader-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('../../db/index.js').default;
let resolve: typeof import('./resolve.js');
let cfg: typeof import('../../db/uploaderConfig.js');
let createUser: typeof import('../../db/users.js').createUser;
let setUserSetting: typeof import('../../db/settings.js').setUserSetting;
let userId: number;

beforeAll(async () => {
  db = (await import('../../db/index.js')).default;
  resolve = await import('./resolve.js');
  cfg = await import('../../db/uploaderConfig.js');
  ({ createUser } = await import('../../db/users.js'));
  ({ setUserSetting } = await import('../../db/settings.js'));
  userId = createUser('resolve-alice').id;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM uploader_config').run();
  db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId);
});

describe('resolveUploader', () => {
  it('falls back to the instance default when the user has no choice', () => {
    const id = cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'x0',
      offeredToUsers: true,
      isDefault: true,
    });
    const r = resolve.resolveUploader({ userId });
    expect(r.configId).toBe(id);
    expect(r.driverId).toBe('x0');
  });

  it('prefers the user default (uploads.uploader_id) over the instance default', () => {
    cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'x0',
      offeredToUsers: true,
      isDefault: true,
    });
    const mine = cfg.createUploaderConfig({
      scope: 'user',
      ownerUserId: userId,
      driver: 'catbox',
      values: { userhash: 'h' },
    });
    setUserSetting(userId, 'uploads.uploader_id', mine);
    const r = resolve.resolveUploader({ userId });
    expect(r.configId).toBe(mine);
    expect(r.driverConfig).toEqual({ userhash: 'h' });
  });

  it('throws UploaderUnavailable when nothing resolves', () => {
    expect(() => resolve.resolveUploader({ userId })).toThrow(resolve.UploaderUnavailableError);
  });

  describe('P0 bridge: legacy uploads.provider dropdown', () => {
    it('honors the dropdown, overriding the migration-seeded uploader_id', () => {
      const x0 = cfg.createUploaderConfig({
        scope: 'instance',
        driver: 'x0',
        offeredToUsers: true,
        isDefault: true,
      });
      const catbox = cfg.createUploaderConfig({
        scope: 'instance',
        driver: 'catbox',
        offeredToUsers: true,
      });
      // Migration pointed uploader_id at x0; the user then switched the dropdown.
      setUserSetting(userId, 'uploads.uploader_id', x0);
      setUserSetting(userId, 'uploads.provider', 'catbox');
      expect(resolve.resolveUploader({ userId }).configId).toBe(catbox);
    });

    it('prefers the user’s own configured uploader for that driver (carries secrets)', () => {
      cfg.createUploaderConfig({
        scope: 'instance',
        driver: 'catbox',
        offeredToUsers: true,
        isDefault: true,
      });
      const mine = cfg.createUploaderConfig({
        scope: 'user',
        ownerUserId: userId,
        driver: 'catbox',
        values: { userhash: 'h' },
      });
      setUserSetting(userId, 'uploads.provider', 'catbox');
      const r = resolve.resolveUploader({ userId });
      expect(r.configId).toBe(mine);
      expect(r.driverConfig).toEqual({ userhash: 'h' });
    });

    it('falls through to the instance default when the enum maps to nothing usable', () => {
      const x0 = cfg.createUploaderConfig({
        scope: 'instance',
        driver: 'x0',
        offeredToUsers: true,
        isDefault: true,
      });
      // No hoarder row exists for this user → unmappable → default, not an error.
      setUserSetting(userId, 'uploads.provider', 'hoarder');
      expect(resolve.resolveUploader({ userId }).configId).toBe(x0);
    });
  });

  it('an explicit requested id that is not allowed is an error, not a silent reroute', () => {
    cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'x0',
      offeredToUsers: true,
      isDefault: true,
    });
    const hidden = cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'catbox',
      offeredToUsers: false,
    });
    expect(() => resolve.resolveUploader({ userId, requestedId: hidden })).toThrow(
      resolve.UploaderUnavailableError,
    );
    // ...but an admin may use a non-offered instance row.
    expect(resolve.resolveUploader({ userId, isAdmin: true, requestedId: hidden }).configId).toBe(
      hidden,
    );
  });

  it('surfaces policy metadata separately from driver config', () => {
    // Simulate the hosted locked uploader: driver field + policy.* metadata.
    const id = cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'hoarder',
      isDefault: true,
      locked: true,
      values: { url: 'https://dropper.test' },
    });
    // Bake the policy + secret the way the seed does (raw, bypassing the schema
    // split which would drop the policy.* keys).
    db.prepare('UPDATE uploader_config SET config_json = ? WHERE id = ?').run(
      JSON.stringify({
        url: 'https://dropper.test',
        'policy.hostsThumbnails': '1',
        'policy.rasterOnly': '1',
        'policy.maxMb': '1',
        'policy.maxDim': '512',
        'policy.quality': '40',
      }),
      id,
    );
    db.prepare('UPDATE uploader_config SET secrets_enc = ? WHERE id = ?').run(
      JSON.stringify({ api_key: 'k' }),
      id,
    );
    const r = resolve.resolveUploader({ userId });
    expect(r.driverConfig).toEqual({ url: 'https://dropper.test', api_key: 'k' });
    expect(r.policy).toEqual({
      hostsThumbnails: true,
      rasterOnly: true,
      maxMb: 1,
      maxDim: 512,
      quality: 40,
    });
  });

  it('a locked uploader missing a required field → UploaderNotConfigured (→ 503)', () => {
    cfg.createUploaderConfig({
      scope: 'instance',
      driver: 'hoarder', // url + api_key required
      isDefault: true,
      locked: true,
      // no values → required fields empty
    });
    expect(() => resolve.resolveUploader({ userId })).toThrow(resolve.UploaderNotConfiguredError);
  });
});
