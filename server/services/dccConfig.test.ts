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
} from './dccConfig.js';

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
