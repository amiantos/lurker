// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-pinned-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let pinned: typeof import('./pinnedBuffers.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  pinned = await import('./pinnedBuffers.js');
  user = createUser('pin-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('pinBuffer / listPinnedForUserNetwork', () => {
  it('appends in pin order', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    pinned.pinBuffer(user.id, net!.id, '#b');
    pinned.pinBuffer(user.id, net!.id, '#c');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });

  it('is idempotent — pinning twice does not duplicate or move the entry', () => {
    pinned.pinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#b', '#c']);
  });
});

describe('unpinBuffer', () => {
  it('densely renumbers remaining rows so positions stay 0..n-1', () => {
    pinned.unpinBuffer(user.id, net!.id, '#b');
    // Re-listing returns the new order; reorderPins relies on dense positions.
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#a', '#c']);
    // Pinning a fourth then unpinning the head exercises a non-trivial renumber.
    pinned.pinBuffer(user.id, net!.id, '#d');
    pinned.unpinBuffer(user.id, net!.id, '#a');
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#c', '#d']);
  });
});

describe('reorderPins', () => {
  it('rewrites order on a matching set', () => {
    const next = pinned.reorderPins(user.id, net!.id, ['#d', '#c']);
    expect(next).toEqual(['#d', '#c']);
    expect(pinned.listPinnedForUserNetwork(user.id, net!.id)).toEqual(['#d', '#c']);
  });

  it('returns null on a mismatched set', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d'])).toBeNull();
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#c', '#missing'])).toBeNull();
  });
});

describe('listPinnedForUser', () => {
  it('groups by network id', () => {
    pinned.pinBuffer(user.id, net2!.id, '#meta');
    const grouped = pinned.listPinnedForUser(user.id);
    expect(grouped.get(net!.id)).toEqual(['#d', '#c']);
    expect(grouped.get(net2!.id)).toEqual(['#meta']);
  });
});
