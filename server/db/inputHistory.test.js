// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-input-history-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser;
let createNetwork;
let inputHistory;
let user;
let net;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  inputHistory = await import('./inputHistory.js');
  user = createUser('ih-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('addEntry / listRecent', () => {
  it('returns oldest-first within the requested slice', () => {
    inputHistory.addEntry(user.id, net.id, '#chat', 'one');
    inputHistory.addEntry(user.id, net.id, '#chat', 'two');
    inputHistory.addEntry(user.id, net.id, '#chat', 'three');
    expect(inputHistory.listRecent(user.id, net.id, '#chat', 10)).toEqual(['one', 'two', 'three']);
  });

  it('respects the limit and keeps the most-recent suffix', () => {
    for (let i = 0; i < 10; i += 1) inputHistory.addEntry(user.id, net.id, '#wall', `m${i}`);
    const recent = inputHistory.listRecent(user.id, net.id, '#wall', 3);
    expect(recent).toEqual(['m7', 'm8', 'm9']);
  });

  it('scopes by (user, network, target)', () => {
    inputHistory.addEntry(user.id, net.id, '#a', 'private');
    expect(inputHistory.listRecent(user.id, net.id, '#b', 10)).toEqual([]);
  });
});
