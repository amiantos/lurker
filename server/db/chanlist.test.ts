// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-chanlist-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let mod: typeof import('./chanlist.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  mod = await import('./chanlist.js');
  user = createUser('cl-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('upsertChannels / countChannels', () => {
  it('inserts rows on first run', () => {
    mod.upsertChannels(net!.id, [
      { channel: '#a', topic: 'about a', num_users: 12 },
      { channel: '#b', topic: 'about b', num_users: 3 },
      { channel: '#empty', topic: null, num_users: 0 },
    ]);
    expect(mod.countChannels(net!.id)).toBe(3);
  });

  it('updates topic/user count in place on re-upsert', () => {
    mod.upsertChannels(net!.id, [{ channel: '#a', topic: 'updated', num_users: 100 }]);
    expect(mod.countChannels(net!.id)).toBe(3);
    const { rows } = mod.searchChannels(net!.id, { query: '#a' });
    expect(rows.find((r) => r.channel === '#a')!.num_users).toBe(100);
  });

  it('skips rows missing the channel name', () => {
    // The source implementation guards against null entries at runtime
    mod.upsertChannels(net!.id, [{ topic: 'no name' }, null as unknown as import('./chanlist.js').ChannelInput]);
    expect(mod.countChannels(net!.id)).toBe(3);
  });
});

describe('searchChannels', () => {
  it('returns rows sorted by user count DESC by default', () => {
    const { rows, total } = mod.searchChannels(net!.id);
    expect(total).toBe(3);
    expect(rows[0].channel).toBe('#a'); // 100 users now
  });

  it('filters by query against name + topic (case-insensitive)', () => {
    const { rows } = mod.searchChannels(net!.id, { query: 'updated' });
    expect(rows.map((r) => r.channel)).toEqual(['#a']);
  });

  it('respects sortBy=name asc', () => {
    const { rows } = mod.searchChannels(net!.id, { sortBy: 'name', sortDir: 'asc' });
    expect(rows.map((r) => r.channel)).toEqual(['#a', '#b', '#empty']);
  });

  it('honors limit + offset', () => {
    const { rows } = mod.searchChannels(net!.id, { sortBy: 'name', sortDir: 'asc', limit: 1, offset: 1 });
    expect(rows.map((r) => r.channel)).toEqual(['#b']);
  });
});

describe('clearChannels', () => {
  it('wipes everything for the network', () => {
    mod.clearChannels(net!.id);
    expect(mod.countChannels(net!.id)).toBe(0);
  });
});

describe('meta', () => {
  it('returns the empty default when no row exists', () => {
    expect(mod.getMeta(net!.id)).toEqual({ fetchedAt: null, inProgress: false, totalCount: 0 });
  });

  it('setMeta upserts the full row', () => {
    mod.setMeta(net!.id, { inProgress: true, totalCount: 9, fetchedAt: '2026-05-17T00:00:00Z' });
    expect(mod.getMeta(net!.id)).toEqual({ inProgress: true, totalCount: 9, fetchedAt: '2026-05-17T00:00:00Z' });
  });

  it('setMeta is a partial patch — unset fields preserved', () => {
    mod.setMeta(net!.id, { inProgress: false });
    const m = mod.getMeta(net!.id);
    expect(m.inProgress).toBe(false);
    expect(m.totalCount).toBe(9);
    expect(m.fetchedAt).toBe('2026-05-17T00:00:00Z');
  });
});
