// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-closedbufs-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let closedBuffers: typeof import('./closedBuffers.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  closedBuffers = await import('./closedBuffers.js');
  user = createUser('cb-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('closeBuffer / isClosed / reopenBuffer', () => {
  it('close → isClosed → reopen round-trips', () => {
    expect(closedBuffers.isClosed(user.id, net!.id, '#x')).toBe(false);
    closedBuffers.closeBuffer(user.id, net!.id, '#x');
    expect(closedBuffers.isClosed(user.id, net!.id, '#x')).toBe(true);
    expect(closedBuffers.reopenBuffer(user.id, net!.id, '#x')).toBe(true);
    expect(closedBuffers.isClosed(user.id, net!.id, '#x')).toBe(false);
  });

  it('reopenBuffer returns false when nothing was closed', () => {
    expect(closedBuffers.reopenBuffer(user.id, net!.id, '#nope')).toBe(false);
  });

  it('closeBuffer is idempotent (upsert refreshes closed_at)', () => {
    closedBuffers.closeBuffer(user.id, net!.id, '#dupe');
    expect(() => closedBuffers.closeBuffer(user.id, net!.id, '#dupe')).not.toThrow();
    expect(closedBuffers.isClosed(user.id, net!.id, '#dupe')).toBe(true);
  });
});

describe('closedKeySetForUser', () => {
  it('returns network::target keys for each closed entry', () => {
    closedBuffers.closeBuffer(user.id, net!.id, '#a');
    closedBuffers.closeBuffer(user.id, net!.id, '#b');
    const set = closedBuffers.closedKeySetForUser(user.id);
    expect(set.has(`${net!.id}::#a`)).toBe(true);
    expect(set.has(`${net!.id}::#b`)).toBe(true);
  });
});
