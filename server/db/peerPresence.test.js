// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-peer-presence-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let pp;
let user;
let net;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  pp = await import('./peerPresence.js');
  user = createUser('pp-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('writePeerState / getPeerPresence', () => {
  it('records and replaces a single row per peer', () => {
    pp.writePeerState(net.id, 'bob', 'online', '2026-05-17T10:00:00Z');
    expect(pp.getPeerPresence(net.id, 'bob')).toMatchObject({
      nick: 'bob', state: 'online', awayMessage: null,
    });
    pp.writePeerState(net.id, 'bob', 'away', '2026-05-17T11:00:00Z', 'lunch');
    expect(pp.getPeerPresence(net.id, 'bob')).toMatchObject({
      state: 'away', awayMessage: 'lunch',
    });
  });

  it('nick comparison is case-insensitive', () => {
    pp.writePeerState(net.id, 'Carol', 'online', '2026-05-17T10:00:00Z');
    expect(pp.getPeerPresence(net.id, 'carol')).not.toBeNull();
    expect(pp.getPeerPresence(net.id, 'CAROL')).not.toBeNull();
  });
});

describe('listPeerPresenceForNetwork', () => {
  it('returns every peer for the network', () => {
    const list = pp.listPeerPresenceForNetwork(net.id);
    const nicks = list.map((p) => p.nick).sort();
    expect(nicks).toEqual(expect.arrayContaining(['Carol', 'bob']));
  });
});

describe('deletePeerPresence', () => {
  it('removes the row', () => {
    pp.deletePeerPresence(net.id, 'bob');
    expect(pp.getPeerPresence(net.id, 'bob')).toBeNull();
  });
});
