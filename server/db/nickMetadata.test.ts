// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-nickmeta-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let deleteNetwork: typeof import('./networks.js').deleteNetwork;
let mod: typeof import('./nickMetadata.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let other: ReturnType<typeof import('./users.js').createUser>;
let net: NonNullable<ReturnType<typeof import('./networks.js').createNetwork>>;
let net2: NonNullable<ReturnType<typeof import('./networks.js').createNetwork>>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork, deleteNetwork } = await import('./networks.js'));
  mod = await import('./nickMetadata.js');
  user = createUser('nm-alice');
  other = createUser('nm-carol');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' })!;
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' })!;
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('metadata set on a nick', () => {
  it('keeps a value, a hidden key and nothing as three different things', () => {
    const at = { userId: user.id, networkId: net.id, nick: 'bob' };
    expect(mod.getNickMetadata(at)).toEqual({});
    expect(mod.setNickMetadata({ ...at, key: 'timezone', value: 'Europe/Berlin' })).toEqual({
      timezone: 'Europe/Berlin',
    });
    expect(mod.setNickMetadata({ ...at, key: 'display-name', value: null })).toEqual({
      timezone: 'Europe/Berlin',
      'display-name': null,
    });
    expect(mod.setNickMetadata({ ...at, key: 'display-name', value: 'Robert' })).toEqual({
      timezone: 'Europe/Berlin',
      'display-name': 'Robert',
    });
    expect(mod.resetNickMetadata({ ...at, key: 'display-name' })).toEqual({
      timezone: 'Europe/Berlin',
    });
  });

  it('is one record whatever the case of the nick', () => {
    const at = { userId: user.id, networkId: net.id };
    mod.setNickMetadata({ ...at, nick: 'Dave', key: 'color', value: '3' });
    mod.setNickMetadata({ ...at, nick: 'dave', key: 'color', value: '5' });
    expect(mod.getNickMetadata({ ...at, nick: 'DAVE' })).toEqual({ color: '5' });
    mod.resetNickMetadata({ ...at, nick: 'DAVE', key: 'color' });
    expect(mod.getNickMetadata({ ...at, nick: 'dave' })).toEqual({});
  });

  it('is per network and per user', () => {
    mod.setNickMetadata({
      userId: user.id,
      networkId: net2.id,
      nick: 'bob',
      key: 'color',
      value: '1',
    });
    expect(mod.getNickMetadata({ userId: user.id, networkId: net2.id, nick: 'bob' })).toEqual({
      color: '1',
    });
    expect(mod.getNickMetadata({ userId: other.id, networkId: net.id, nick: 'bob' })).toEqual({});
    expect(mod.listNickMetadataGrouped(other.id).size).toBe(0);
  });

  it('groups by network for the snapshot, one entry a nick', () => {
    const at = { userId: user.id, networkId: net.id };
    mod.setNickMetadata({ ...at, nick: 'Erin', key: 'color', value: '2' });
    mod.setNickMetadata({ ...at, nick: 'erin', key: 'avatar', value: null });
    const grouped = mod.listNickMetadataGrouped(user.id);
    const onNet = grouped.get(net.id)!;
    // Either spelling may name the entry; clients key it by the lower-cased nick.
    const erin = onNet.filter((e) => e.nick.toLowerCase() === 'erin');
    expect(erin.map((e) => e.values)).toEqual([{ color: '2', avatar: null }]);
    expect(onNet.find((e) => e.nick === 'bob')!.values).toEqual({
      timezone: 'Europe/Berlin',
    });
    expect(grouped.get(net2.id)).toEqual([{ nick: 'bob', values: { color: '1' } }]);
  });

  it('goes with its network', () => {
    deleteNetwork(net2.id, user.id);
    expect(mod.listNickMetadataGrouped(user.id).has(net2.id)).toBe(false);
  });
});
