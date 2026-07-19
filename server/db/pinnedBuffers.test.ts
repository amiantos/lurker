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
let db: typeof import('./index.js').default;
let user: ReturnType<typeof import('./users.js').createUser>;
let net: ReturnType<typeof import('./networks.js').createNetwork>;
let net2: ReturnType<typeof import('./networks.js').createNetwork>;

beforeAll(async () => {
  ({ createUser } = await import('./users.js'));
  ({ createNetwork } = await import('./networks.js'));
  pinned = await import('./pinnedBuffers.js');
  db = (await import('./index.js')).default;
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

  it('returns null when a requested target is not pinned', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#c', '#missing'])).toBeNull();
  });

  it('returns null on a duplicated target', () => {
    expect(pinned.reorderPins(user.id, net!.id, ['#d', '#d'])).toBeNull();
  });

  // The client drops pins it can't render (closed/parted buffers, friend
  // primary DMs), so a drag legitimately reorders only a subset of the pinned
  // set. The reorder must still apply, keeping the unmentioned ("hidden") pins
  // after the visible ones rather than snapping back (issue #405).
  it('accepts a subset, reordering the supplied targets and keeping hidden pins after them', () => {
    // Fresh user/network so the suite-wide ordering above stays intact.
    const carol = createUser('pin-carol');
    const netC = createNetwork(carol.id, {
      name: 'c',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'c',
    });
    pinned.pinBuffer(carol.id, netC!.id, '#visibleA'); // pos 0
    pinned.pinBuffer(carol.id, netC!.id, 'hiddenDM'); // pos 1 (invisible to the client)
    pinned.pinBuffer(carol.id, netC!.id, '#visibleB'); // pos 2

    // Client only sees the two channels and drags B above A.
    const next = pinned.reorderPins(carol.id, netC!.id, ['#visibleB', '#visibleA']);
    expect(next).toEqual(['#visibleB', '#visibleA', 'hiddenDM']);
    expect(pinned.listPinnedForUserNetwork(carol.id, netC!.id)).toEqual([
      '#visibleB',
      '#visibleA',
      'hiddenDM',
    ]);
  });
});

describe('unpinBufferCaseInsensitive', () => {
  it('removes a pin whose stored casing differs from the requested target', () => {
    const dave = createUser('pin-dave');
    const netD = createNetwork(dave.id, {
      name: 'd',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'd',
    });
    pinned.pinBuffer(dave.id, netD!.id, '#Channel'); // stored with a capital C
    pinned.pinBuffer(dave.id, netD!.id, '#other');

    // close-buffer arrives with the server's lowercased casing.
    const next = pinned.unpinBufferCaseInsensitive(dave.id, netD!.id, '#channel');
    expect(next).toEqual(['#other']);
    expect(pinned.listPinnedForUserNetwork(dave.id, netD!.id)).toEqual(['#other']);
  });

  it('removes every case-variant in one pass (PRIMARY KEY is case-sensitive)', () => {
    const frank = createUser('pin-frank');
    const netF = createNetwork(frank.id, {
      name: 'f',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'f',
    });
    // The schema allows both rows since the target column has no NOCASE.
    pinned.pinBuffer(frank.id, netF!.id, '#Channel');
    pinned.pinBuffer(frank.id, netF!.id, '#channel');
    pinned.pinBuffer(frank.id, netF!.id, '#kept');

    const next = pinned.unpinBufferCaseInsensitive(frank.id, netF!.id, '#CHANNEL');
    expect(next).toEqual(['#kept']);
    expect(pinned.listPinnedForUserNetwork(frank.id, netF!.id)).toEqual(['#kept']);
    // Positions stay dense after pulling two rows out of the middle/front.
    const rows = db
      .prepare(`SELECT target, position FROM pinned_buffers WHERE user_id = ? AND network_id = ?`)
      .all(frank.id, netF!.id) as Array<{ target: string; position: number }>;
    expect(rows).toEqual([{ target: '#kept', position: 0 }]);
  });

  it('returns null when nothing matches so the caller can skip the broadcast', () => {
    const erin = createUser('pin-erin');
    const netE = createNetwork(erin.id, {
      name: 'e',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'e',
    });
    pinned.pinBuffer(erin.id, netE!.id, '#kept');
    expect(pinned.unpinBufferCaseInsensitive(erin.id, netE!.id, '#nope')).toBeNull();
    expect(pinned.listPinnedForUserNetwork(erin.id, netE!.id)).toEqual(['#kept']);
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

// Mirrors the schemaVersion < 7 cleanup in db/index.ts. Kept here as a string
// so the test can replay it against orphan rows that the public API can no
// longer create (close-buffer now implies unpin).
// The v7 migration repair ran against the legacy closed_buffers table (the
// registry didn't exist yet), and is now gated on that table existing. Its
// replay here recreates the legacy world: fixture table + fixture close.
function ensureLegacyClosedBuffers(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS closed_buffers (
      user_id INTEGER NOT NULL,
      network_id INTEGER NOT NULL,
      target TEXT NOT NULL,
      closed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, network_id, target)
    )
  `);
}
function closeBuffer(userId: number, networkId: number, target: string): void {
  ensureLegacyClosedBuffers();
  db.prepare(
    `INSERT INTO closed_buffers (user_id, network_id, target) VALUES (?, ?, ?)
     ON CONFLICT(user_id, network_id, target) DO UPDATE SET closed_at = datetime('now')`,
  ).run(userId, networkId, target);
}

const PURGE_ORPHANS_SQL = `
  DELETE FROM pinned_buffers
  WHERE EXISTS (
    SELECT 1 FROM closed_buffers c
    WHERE c.user_id = pinned_buffers.user_id
      AND c.network_id = pinned_buffers.network_id
      AND c.target = pinned_buffers.target
  )
`;
const RENUMBER_PINS_SQL = `
  WITH renum AS (
    SELECT user_id, network_id, target,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, network_id
             ORDER BY position ASC, target ASC
           ) - 1 AS new_pos
    FROM pinned_buffers
  )
  UPDATE pinned_buffers
  SET position = (
    SELECT new_pos FROM renum
    WHERE renum.user_id = pinned_buffers.user_id
      AND renum.network_id = pinned_buffers.network_id
      AND renum.target = pinned_buffers.target
  )
`;

describe('schemaVersion < 7 orphan cleanup (issue #112)', () => {
  it('drops pinned rows whose target is also closed, then renumbers positions per (user, network)', () => {
    // Fresh user/networks so we don't entangle with the suite-wide state above.
    const bob = createUser('pin-bob');
    const netA = createNetwork(bob.id, {
      name: 'a',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'b',
    });
    const netB = createNetwork(bob.id, {
      name: 'b',
      host: 'h',
      port: 6697,
      tls: true,
      nick: 'b',
    });

    pinned.pinBuffer(bob.id, netA!.id, '#x');
    pinned.pinBuffer(bob.id, netA!.id, '#y');
    pinned.pinBuffer(bob.id, netA!.id, '#z');
    pinned.pinBuffer(bob.id, netB!.id, '#solo');

    // Simulate the pre-fix bug: close a pinned buffer without unpinning it,
    // leaving an orphan pinned_buffers row pointing at a closed buffer.
    closeBuffer(bob.id, netA!.id, '#y');
    closeBuffer(bob.id, netB!.id, '#solo');

    db.exec(PURGE_ORPHANS_SQL);
    db.exec(RENUMBER_PINS_SQL);

    expect(pinned.listPinnedForUserNetwork(bob.id, netA!.id)).toEqual(['#x', '#z']);
    expect(pinned.listPinnedForUserNetwork(bob.id, netB!.id)).toEqual([]);

    // Positions must be dense (0..n-1) so a subsequent pin appends at the
    // correct slot — listPinnedForUserNetwork already orders by position,
    // but reorderPins relies on the underlying numbering being gap-free.
    const rows = db
      .prepare(`SELECT target, position FROM pinned_buffers WHERE user_id = ? AND network_id = ?`)
      .all(bob.id, netA!.id) as Array<{ target: string; position: number }>;
    expect(rows.toSorted((a, b) => a.position - b.position)).toEqual([
      { target: '#x', position: 0 },
      { target: '#z', position: 1 },
    ]);

    // Pinning a new buffer after the cleanup lands at position 2, not 3
    // (which is what would happen if renumber missed a gap).
    pinned.pinBuffer(bob.id, netA!.id, '#w');
    expect(pinned.listPinnedForUserNetwork(bob.id, netA!.id)).toEqual(['#x', '#z', '#w']);
  });
});
