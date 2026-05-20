// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-bufreads-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let bufferReads: typeof import('./bufferReads.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  bufferReads = await import('./bufferReads.js');
  user = createUser('br-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('setReadState / getReadState', () => {
  it('returns 0 when no row exists', () => {
    expect(bufferReads.getReadState(user.id, net!.id, '#empty')).toBe(0);
  });

  it('round-trips and returns the persisted value', () => {
    const out = bufferReads.setReadState(user.id, net!.id, '#x', 42);
    expect(out).toBe(42);
    expect(bufferReads.getReadState(user.id, net!.id, '#x')).toBe(42);
  });

  it('clamps to MAX(existing, requested) so older reads can\'t move the pointer back', () => {
    bufferReads.setReadState(user.id, net!.id, '#mono', 100);
    const out = bufferReads.setReadState(user.id, net!.id, '#mono', 50);
    expect(out).toBe(100);
    expect(bufferReads.getReadState(user.id, net!.id, '#mono')).toBe(100);
  });

  it('treats non-positive or non-finite ids as no-ops', () => {
    bufferReads.setReadState(user.id, net!.id, '#bad', 10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', 0)).toBe(10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', -5)).toBe(10);
    expect(bufferReads.setReadState(user.id, net!.id, '#bad', NaN)).toBe(10);
  });
});

describe('listReadStateForUser', () => {
  it('returns a map keyed by network::target', () => {
    bufferReads.setReadState(user.id, net!.id, '#a', 7);
    bufferReads.setReadState(user.id, net!.id, '#b', 9);
    const map = bufferReads.listReadStateForUser(user.id);
    expect(map[`${net!.id}::#a`]).toBe(7);
    expect(map[`${net!.id}::#b`]).toBe(9);
  });
});
