// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-nicknotes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let mod;
let user;
let net;
let net2;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./nickNotes.js');
  user = createUser('nn-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
  net2 = createNetwork(user.id, { name: 'oftc', host: 'h2', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('setNote / getNote', () => {
  it('upserts and reads back', () => {
    const out = mod.setNote({ userId: user.id, networkId: net.id, nick: 'bob', note: 'lives in Berlin' });
    expect(out.note).toBe('lives in Berlin');
    expect(mod.getNote({ userId: user.id, networkId: net.id, nick: 'bob' }).note).toBe('lives in Berlin');
  });

  it('case-insensitive lookup', () => {
    expect(mod.getNote({ userId: user.id, networkId: net.id, nick: 'BOB' }).note).toBe('lives in Berlin');
  });

  it('empty/whitespace body deletes the row', () => {
    expect(mod.setNote({ userId: user.id, networkId: net.id, nick: 'bob', note: '   ' })).toBeNull();
    expect(mod.getNote({ userId: user.id, networkId: net.id, nick: 'bob' })).toBeNull();
  });

  it('returns null when no note exists', () => {
    expect(mod.getNote({ userId: user.id, networkId: net.id, nick: 'ghost' })).toBeNull();
  });
});

describe('listForUserGrouped', () => {
  it('returns a Map of networkId → [{ nick, note, updatedAt }]', () => {
    mod.setNote({ userId: user.id, networkId: net.id, nick: 'alpha', note: 'one' });
    mod.setNote({ userId: user.id, networkId: net2.id, nick: 'beta', note: 'two' });
    const grouped = mod.listForUserGrouped(user.id);
    expect(grouped.get(net.id).find((n) => n.nick === 'alpha').note).toBe('one');
    expect(grouped.get(net2.id).find((n) => n.nick === 'beta').note).toBe('two');
  });
});
