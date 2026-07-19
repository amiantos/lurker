// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lurker-test-buffers-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

let createUser: typeof import('./users.js').createUser;
let createNetwork: typeof import('./networks.js').createNetwork;
let buffers: typeof import('./buffers.js');
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  buffers = await import('./buffers.js');
  user = createUser('buf-alice');
  net = createNetwork(user.id, { name: 'libera', host: 'h', port: 6697, tls: true, nick: 'a' });
});

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('kindForTarget', () => {
  it('classifies every channel prefix as channel, everything else as dm', () => {
    for (const t of ['#chan', '&local', '+modeless', '!secure']) {
      expect(buffers.kindForTarget(t)).toBe('channel');
    }
    expect(buffers.kindForTarget('Bob')).toBe('dm');
    expect(buffers.kindForTarget('')).toBe('dm');
  });
});

describe('ensureOpen', () => {
  it('creates an open row with the caller casing and reports created', () => {
    const r = buffers.ensureOpen(user.id, net!.id, '#Fresh');
    expect(r.created).toBe(true);
    expect(r.reopened).toBe(false);
    expect(r.record.target).toBe('#Fresh');
    expect(r.record.kind).toBe('channel');
    expect(r.record.state).toBe('open');
    expect(r.record.autojoin).toBe(false);
  });

  it('is a folded no-op on an existing open row and keeps the stored casing', () => {
    const r = buffers.ensureOpen(user.id, net!.id, '#FRESH');
    expect(r.created).toBe(false);
    expect(r.reopened).toBe(false);
    expect(r.record.target).toBe('#Fresh');
  });

  it('reopens a closed row and clears closed_at', () => {
    buffers.close(user.id, net!.id, '#fresh');
    expect(buffers.isClosed(user.id, net!.id, '#Fresh')).toBe(true);
    const r = buffers.ensureOpen(user.id, net!.id, '#fresh');
    expect(r.reopened).toBe(true);
    expect(r.record.state).toBe('open');
    expect(r.record.closedAt).toBeNull();
  });

  it('sets autojoin/key only when passed (join-echo semantics)', () => {
    const r1 = buffers.ensureOpen(user.id, net!.id, '#keyed', { autojoin: true, key: 'hunter2' });
    expect(r1.record.autojoin).toBe(true);
    expect(r1.record.key).toBe('hunter2');
    // Omitting both leaves them untouched…
    const r2 = buffers.ensureOpen(user.id, net!.id, '#keyed');
    expect(r2.record.autojoin).toBe(true);
    expect(r2.record.key).toBe('hunter2');
    // …and an explicit null clears the key.
    const r3 = buffers.ensureOpen(user.id, net!.id, '#keyed', { key: null });
    expect(r3.record.key).toBeNull();
  });
});

describe('ensureExists (the NOTICE path)', () => {
  it('creates an open row for a first-contact nick', () => {
    const r = buffers.ensureExists(user.id, net!.id, 'NickServ');
    expect(r.created).toBe(true);
    expect(r.record.kind).toBe('dm');
    expect(r.record.state).toBe('open');
  });

  it('NEVER reopens a closed row', () => {
    buffers.close(user.id, net!.id, 'NickServ');
    const r = buffers.ensureExists(user.id, net!.id, 'nickserv');
    expect(r.created).toBe(false);
    expect(r.record.state).toBe('closed');
  });
});

describe('close / reopen / isClosed', () => {
  it('folds case on every path', () => {
    buffers.ensureOpen(user.id, net!.id, '#Mixed');
    expect(buffers.close(user.id, net!.id, '#MIXED')).toBe(true);
    expect(buffers.isClosed(user.id, net!.id, '#mixed')).toBe(true);
    expect(buffers.reopen(user.id, net!.id, '#mIxEd')).toBe(true);
    expect(buffers.isClosed(user.id, net!.id, '#Mixed')).toBe(false);
  });

  it('close is update-only: closing a nonexistent buffer conjures nothing', () => {
    expect(buffers.close(user.id, net!.id, '#never-existed')).toBe(false);
    expect(buffers.getBuffer(user.id, net!.id, '#never-existed')).toBeUndefined();
  });

  it('double-close and double-reopen are no-ops that report false', () => {
    buffers.ensureOpen(user.id, net!.id, '#idem');
    expect(buffers.close(user.id, net!.id, '#idem')).toBe(true);
    expect(buffers.close(user.id, net!.id, '#idem')).toBe(false);
    expect(buffers.reopen(user.id, net!.id, '#idem')).toBe(true);
    expect(buffers.reopen(user.id, net!.id, '#idem')).toBe(false);
  });
});

describe('setAutojoin / setChannelKey', () => {
  it('are update-only: an absent row stays absent', () => {
    buffers.setAutojoin(user.id, net!.id, '#ghost', true);
    buffers.setChannelKey(user.id, net!.id, '#ghost', 'k');
    expect(buffers.getBuffer(user.id, net!.id, '#ghost')).toBeUndefined();
  });

  it('lower autojoin without touching state (the part path)', () => {
    buffers.ensureOpen(user.id, net!.id, '#parted', { autojoin: true });
    buffers.setAutojoin(user.id, net!.id, '#PARTED', false);
    const row = buffers.getBuffer(user.id, net!.id, '#parted')!;
    expect(row.autojoin).toBe(false);
    expect(row.state).toBe('open');
  });
});

describe('deleteBuffer', () => {
  it('drops the row, folded', () => {
    buffers.ensureOpen(user.id, net!.id, '#Doomed');
    expect(buffers.deleteBuffer(user.id, net!.id, '#doomed')).toBe(true);
    expect(buffers.getBuffer(user.id, net!.id, '#Doomed')).toBeUndefined();
    expect(buffers.deleteBuffer(user.id, net!.id, '#doomed')).toBe(false);
  });
});

describe('list helpers', () => {
  it('listAutojoinChannels returns only autojoin channels, keys decrypted', () => {
    buffers.ensureOpen(user.id, net!.id, '#aj1', { autojoin: true, key: 'sekrit' });
    buffers.ensureOpen(user.id, net!.id, '#aj0', { autojoin: false });
    buffers.ensureOpen(user.id, net!.id, 'ajnick');
    const names = buffers.listAutojoinChannels(net!.id).map((b) => b.target);
    expect(names).toContain('#aj1');
    expect(names).not.toContain('#aj0');
    expect(names).not.toContain('ajnick');
    const aj1 = buffers.listAutojoinChannels(net!.id).find((b) => b.target === '#aj1')!;
    expect(aj1.key).toBe('sekrit');
  });

  it('listOpenDms excludes closed DMs and channels', () => {
    buffers.ensureOpen(user.id, net!.id, 'OpenPal');
    buffers.ensureOpen(user.id, net!.id, 'ClosedPal');
    buffers.close(user.id, net!.id, 'closedpal');
    const dms = buffers.listOpenDms(net!.id).map((b) => b.target);
    expect(dms).toContain('OpenPal');
    expect(dms).not.toContain('ClosedPal');
    expect(dms.every((t) => !t.startsWith('#'))).toBe(true);
  });
});

describe('importRow closed_at merging', () => {
  it('a tombstone timestamp lands on an already-closed never-surfaced row', () => {
    // The legacy-conversion order: a channels-seed row imports as closed with
    // NULL closed_at ("never surfaced"), then a closed_buffers tombstone for
    // the same target carries the user's real close timestamp. Closed wins and
    // carries its timestamp — matching the schema-16 migration's unconditional
    // closed_at overwrite — even though the row was already closed.
    buffers.importRow({
      userId: user.id,
      networkId: net!.id,
      target: '#seed-then-tomb',
      kind: 'channel',
      state: 'closed',
      autojoin: true,
    });
    expect(buffers.getBuffer(user.id, net!.id, '#seed-then-tomb')!.closedAt).toBeNull();
    buffers.importRow({
      userId: user.id,
      networkId: net!.id,
      target: '#Seed-Then-Tomb',
      state: 'closed',
      closedAt: '2026-03-01T00:00:00Z',
    });
    const row = buffers.getBuffer(user.id, net!.id, '#seed-then-tomb')!;
    expect(row.closedAt).toBe('2026-03-01T00:00:00Z');
    expect(row.autojoin).toBe(true); // merge kept the seed's autojoin
  });
});

describe('app-scoped rows (NULL network_id)', () => {
  it('dedupe via the coalesced unique index', () => {
    const a = buffers.ensureOpen(user.id, null, ':system:', { kind: 'system' });
    const b = buffers.ensureOpen(user.id, null, ':system:', { kind: 'system' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(a.record.id).toBe(b.record.id);
  });
});

describe('uniqueness', () => {
  it('one row per (user, network, folded target) — a case variant cannot fork', () => {
    buffers.ensureOpen(user.id, net!.id, '#NoFork');
    buffers.ensureOpen(user.id, net!.id, '#nofork');
    buffers.ensureOpen(user.id, net!.id, '#NOFORK');
    const rows = buffers
      .listForNetwork(net!.id)
      .filter((b) => buffers.foldTarget(b.target) === '#nofork');
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe('#NoFork');
  });
});
