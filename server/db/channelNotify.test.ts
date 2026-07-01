// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let getChannelNotifyAlways: typeof import('./channelNotify.js').getChannelNotifyAlways;
let listChannelNotifyForUser: typeof import('./channelNotify.js').listChannelNotifyForUser;
let setChannelNotifyAlways: typeof import('./channelNotify.js').setChannelNotifyAlways;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  ({ getChannelNotifyAlways, listChannelNotifyForUser, setChannelNotifyAlways } =
    await import('./channelNotify.js'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNetwork(userId: number, name: string) {
  return createNetwork(userId, {
    name,
    host: 'irc.libera.chat',
    port: 6697,
    tls: true,
    nick: name,
  });
}

describe('channelNotify', () => {
  it('records and reads back a per-channel notify_always flag', () => {
    const u = createUser('cn-alice');
    const net = mkNetwork(u.id, 'libera');
    setChannelNotifyAlways(u.id, net!.id, '#lurker', true);
    expect(getChannelNotifyAlways(u.id, net!.id, '#lurker')).toBe(true);
  });

  it('defaults to false when no row exists', () => {
    const u = createUser('cn-bob');
    const net = mkNetwork(u.id, 'libera');
    expect(getChannelNotifyAlways(u.id, net!.id, '#unset')).toBe(false);
  });

  it('clears the row when set to false (no stale defaults sitting around)', () => {
    const u = createUser('cn-carol');
    const net = mkNetwork(u.id, 'libera');
    setChannelNotifyAlways(u.id, net!.id, '#chan', true);
    setChannelNotifyAlways(u.id, net!.id, '#chan', false);
    expect(getChannelNotifyAlways(u.id, net!.id, '#chan')).toBe(false);
    expect(listChannelNotifyForUser(u.id).size).toBe(0);
  });

  it('groups notify_always settings by network for the whole user', () => {
    const u = createUser('cn-dave');
    const a = mkNetwork(u.id, 'liberaA');
    const b = mkNetwork(u.id, 'liberaB');
    setChannelNotifyAlways(u.id, a!.id, '#one', true);
    setChannelNotifyAlways(u.id, b!.id, '#two', true);
    const byNetwork = listChannelNotifyForUser(u.id);
    expect(byNetwork.get(a!.id)).toEqual({ '#one': { notifyAlways: true } });
    expect(byNetwork.get(b!.id)).toEqual({ '#two': { notifyAlways: true } });
  });
});
