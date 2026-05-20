// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the DB layer at a throwaway file before importing anything that
// touches it. db/index.js reads DATABASE_PATH at module-load time, so this
// must happen before the dynamic imports below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let listCollapsedForUser: typeof import('./nicklistCollapsed.js').listCollapsedForUser;
let listCollapsedForUserNetwork: typeof import('./nicklistCollapsed.js').listCollapsedForUserNetwork;
let setNicklistCollapsed: typeof import('./nicklistCollapsed.js').setNicklistCollapsed;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({
    listCollapsedForUser,
    listCollapsedForUserNetwork,
    setNicklistCollapsed,
  } = await import('./nicklistCollapsed.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name, host: 'irc.libera.chat', port: 6697, tls: true, nick: name,
  });
}

describe('nicklistCollapsed', () => {
  it('records and reads back a per-channel override', () => {
    const u = createUser('nc-alice');
    const net = mkNetwork(u.id, 'libera');
    setNicklistCollapsed(u.id, net!.id, '#vue', true);
    expect(listCollapsedForUserNetwork(u.id, net!.id)).toEqual({ '#vue': true });
  });

  it('upserts — a second set on the same channel flips the flag in place', () => {
    const u = createUser('nc-bob');
    const net = mkNetwork(u.id, 'libera');
    setNicklistCollapsed(u.id, net!.id, '#chan', true);
    setNicklistCollapsed(u.id, net!.id, '#chan', false);
    expect(listCollapsedForUserNetwork(u.id, net!.id)).toEqual({ '#chan': false });
  });

  it('groups overrides by network for the whole user', () => {
    const u = createUser('nc-carol');
    const a = mkNetwork(u.id, 'liberaA');
    const b = mkNetwork(u.id, 'liberaB');
    setNicklistCollapsed(u.id, a!.id, '#one', true);
    setNicklistCollapsed(u.id, a!.id, '#two', false);
    setNicklistCollapsed(u.id, b!.id, '#three', true);
    const byNetwork = listCollapsedForUser(u.id);
    expect(byNetwork.get(a!.id)).toEqual({ '#one': true, '#two': false });
    expect(byNetwork.get(b!.id)).toEqual({ '#three': true });
  });

  it('returns empty results for a user with no overrides', () => {
    const u = createUser('nc-dave');
    const net = mkNetwork(u.id, 'libera');
    expect(listCollapsedForUserNetwork(u.id, net!.id)).toEqual({});
    expect(listCollapsedForUser(u.id).size).toBe(0);
  });
});
