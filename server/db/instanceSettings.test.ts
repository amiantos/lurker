// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-instance-settings-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let db: typeof import('./index.js').default;
let mod: typeof import('./instanceSettings.js');

beforeAll(async () => {
  db = (await import('./index.js')).default;
  mod = await import('./instanceSettings.js');
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  db.prepare('DELETE FROM instance_settings').run();
});

describe('instanceSettings', () => {
  it('returns null for an unset key', () => {
    expect(mod.getInstanceSetting('nope')).toBeNull();
  });

  it('set then get roundtrips', () => {
    mod.setInstanceSetting('k', 'v');
    expect(mod.getInstanceSetting('k')).toBe('v');
    // upsert overwrites
    mod.setInstanceSetting('k', 'v2');
    expect(mod.getInstanceSetting('k')).toBe('v2');
  });

  it('allowUserDefinedUploaders defaults to true on self-host when unset', () => {
    // The seed cleared by beforeEach; no LURKER_EDITION in this process → self-host.
    expect(mod.allowUserDefinedUploaders()).toBe(true);
  });

  it('setAllowUserDefinedUploaders flips the flag', () => {
    mod.setAllowUserDefinedUploaders(false);
    expect(mod.allowUserDefinedUploaders()).toBe(false);
    mod.setAllowUserDefinedUploaders(true);
    expect(mod.allowUserDefinedUploaders()).toBe(true);
  });
});
