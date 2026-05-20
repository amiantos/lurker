// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-ignored-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let mod: typeof import('./ignoredMasks.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net1: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./ignoredMasks.js');
  user = createUser('ig-alice');
  net1 = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('addMask / removeMask / listMasks', () => {
  it('add → list round-trips, idempotent (case-insensitive uniqueness)', () => {
    expect(mod.addMask({ userId: user.id, networkId: net1!.id, mask: 'bozo' })).toBe(true);
    // Case-insensitive uniqueness — second add is a no-op.
    expect(mod.addMask({ userId: user.id, networkId: net1!.id, mask: 'Bozo' })).toBe(false);
    const list = mod.listMasks({ userId: user.id, networkId: net1!.id });
    expect(list.map((r) => r.mask)).toEqual(['bozo']);
  });

  it('removeMask is case-insensitive too', () => {
    expect(mod.removeMask({ userId: user.id, networkId: net1!.id, mask: 'BOZO' })).toBe(true);
    expect(mod.listMasks({ userId: user.id, networkId: net1!.id })).toEqual([]);
  });

  it('removeMask returns false when nothing matched', () => {
    expect(mod.removeMask({ userId: user.id, networkId: net1!.id, mask: 'ghost' })).toBe(false);
  });
});

describe('listAllForUser', () => {
  it('returns masks across networks for one user', () => {
    mod.addMask({ userId: user.id, networkId: net1!.id, mask: '*!*@spam.example' });
    mod.addMask({ userId: user.id, networkId: net2!.id, mask: 'trolla' });
    const all = mod.listAllForUser(user.id);
    expect(all.map((r) => r.mask).sort()).toEqual(['*!*@spam.example', 'trolla']);
  });
});
