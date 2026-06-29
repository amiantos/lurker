// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { createUser } from './users.js';
import {
  CAPABILITY_DCC,
  listUserCapabilities,
  setUserCapability,
  userHasCapability,
} from './userCapabilities.js';

let userId: number;
beforeAll(() => {
  userId = createUser('cap-alice').id;
});

describe('userCapabilities', () => {
  it('defaults to off (an absent row means not granted)', () => {
    expect(userHasCapability(userId, CAPABILITY_DCC)).toBe(false);
  });

  it('grants and revokes a capability', () => {
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(userHasCapability(userId, CAPABILITY_DCC)).toBe(true);
    setUserCapability(userId, CAPABILITY_DCC, false);
    expect(userHasCapability(userId, CAPABILITY_DCC)).toBe(false);
  });

  it('upserts rather than duplicating on repeated grants', () => {
    setUserCapability(userId, CAPABILITY_DCC, true);
    setUserCapability(userId, CAPABILITY_DCC, true);
    const rows = listUserCapabilities(userId).filter((r) => r.capability === CAPABILITY_DCC);
    expect(rows).toHaveLength(1);
    expect(rows[0].enabled).toBe(1);
  });

  it('scopes capabilities per user', () => {
    const other = createUser('cap-bob').id;
    setUserCapability(userId, CAPABILITY_DCC, true);
    expect(userHasCapability(other, CAPABILITY_DCC)).toBe(false);
  });
});
