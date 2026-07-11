// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createUser } from '../db/users.js';
import { CAPABILITY_DCC, setUserCapability } from '../db/userCapabilities.js';
import {
  dccAllowPrivateHosts,
  dccEnabledForUser,
  dccMasterEnabled,
  dccMaxFileBytes,
  parseDccEnabled,
  dccShouldAutoAccept,
  dccEffectiveAcceptCap,
  dccPreferPassive,
} from './dccConfig.js';
import { setUserSetting } from '../db/settings.js';

describe('parseDccEnabled', () => {
  it('treats the conventional truthy values as on (trimmed, case-insensitive)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
      expect(parseDccEnabled(v)).toBe(true);
    }
  });

  it('is off for unset / empty / anything else (opt-in only)', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
      expect(parseDccEnabled(v)).toBe(false);
    }
  });
});

describe('dcc gate', () => {
  let userId: number;
  beforeAll(() => {
    userId = createUser('gate-alice').id;
  });
  afterEach(() => {
    delete process.env.LURKER_DCC_ENABLED;
    delete process.env.LURKER_DCC_MAX_FILE_MB;
    delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS;
  });

  it('reads the master switch live from LURKER_DCC_ENABLED', () => {
    delete process.env.LURKER_DCC_ENABLED;
    expect(dccMasterEnabled()).toBe(false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccMasterEnabled()).toBe(true);
  });

  it('requires BOTH the master switch and a per-user grant', () => {
    // neither
    expect(dccEnabledForUser(userId)).toBe(false);
    // grant only
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(false);
    // master only
    setUserCapability(userId, CAPABILITY_DCC, false);
    process.env.LURKER_DCC_ENABLED = '1';
    expect(dccEnabledForUser(userId)).toBe(false);
    // both
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(dccEnabledForUser(userId)).toBe(true);
  });
});

describe('dccMaxFileBytes', () => {
  afterEach(() => delete process.env.LURKER_DCC_MAX_FILE_MB);

  it('is 0 (no cap) when unset / non-positive / unparseable', () => {
    expect(dccMaxFileBytes()).toBe(0);
    for (const v of ['0', '-5', 'abc', '']) {
      process.env.LURKER_DCC_MAX_FILE_MB = v;
      expect(dccMaxFileBytes()).toBe(0);
    }
  });

  it('converts MB to bytes', () => {
    process.env.LURKER_DCC_MAX_FILE_MB = '100';
    expect(dccMaxFileBytes()).toBe(100 * 1024 * 1024);
  });
});

describe('dccAllowPrivateHosts', () => {
  afterEach(() => delete process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS);

  it('defaults to off and honors the truthy set', () => {
    expect(dccAllowPrivateHosts()).toBe(false);
    process.env.LURKER_DCC_ALLOW_PRIVATE_HOSTS = '1';
    expect(dccAllowPrivateHosts()).toBe(true);
  });
});

describe('per-user DCC preferences', () => {
  let uid: number;
  beforeAll(() => {
    uid = createUser('prefs-bob').id;
  });
  afterEach(() => delete process.env.LURKER_DCC_MAX_FILE_MB);

  it('prefer-passive + auto-accept default off', () => {
    expect(dccPreferPassive(uid)).toBe(false);
    expect(dccShouldAutoAccept(uid, 'friend', 'friend!u@host')).toBe(false);
  });

  it('auto-accept only fires when ON and the sender matches the allowlist', () => {
    setUserSetting(uid, 'dcc.auto_accept', true);
    // enabled but empty allowlist → never matches
    expect(dccShouldAutoAccept(uid, 'friend', 'friend!u@host')).toBe(false);
    setUserSetting(uid, 'dcc.auto_accept_from', ['friend', '*!*@*.trusted.net']);
    expect(dccShouldAutoAccept(uid, 'friend', 'friend!u@anywhere')).toBe(true);
    expect(dccShouldAutoAccept(uid, 'stranger', 'stranger!u@box.trusted.net')).toBe(true);
    expect(dccShouldAutoAccept(uid, 'stranger', 'stranger!u@box.evil.net')).toBe(false);
    // toggle off → inert even with a matching list
    setUserSetting(uid, 'dcc.auto_accept', false);
    expect(dccShouldAutoAccept(uid, 'friend', 'friend!u@anywhere')).toBe(false);
  });

  it('effective accept cap is the tighter of env + per-user (0 = uncapped)', () => {
    // neither set → uncapped
    expect(dccEffectiveAcceptCap(uid)).toBe(0);
    // user cap only
    setUserSetting(uid, 'dcc.max_accept_mb', 50);
    expect(dccEffectiveAcceptCap(uid)).toBe(50 * 1024 * 1024);
    // env cap tighter → env wins
    process.env.LURKER_DCC_MAX_FILE_MB = '20';
    expect(dccEffectiveAcceptCap(uid)).toBe(20 * 1024 * 1024);
    // env cap looser → user wins
    process.env.LURKER_DCC_MAX_FILE_MB = '500';
    expect(dccEffectiveAcceptCap(uid)).toBe(50 * 1024 * 1024);
  });
});
