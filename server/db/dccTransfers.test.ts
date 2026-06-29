// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// MUST be first — redirect DATABASE_PATH before the static imports below open
// the real data/lurker.db.
import '../test-utils/isolateDb.js';
import { beforeAll, describe, expect, it } from 'vitest';

import db from './index.js';
import { createNetwork } from './networks.js';
import { createUser } from './users.js';
import {
  findArmedRequest,
  getDccTransfer,
  insertDccTransfer,
  listDccTransfers,
  updateDccTransferState,
} from './dccTransfers.js';

let userId: number;
let networkId: number;
beforeAll(() => {
  userId = createUser('dcc-alice').id;
  networkId = createNetwork(userId, {
    name: 'rizon',
    host: 'irc.rizon.net',
    port: 6697,
    tls: true,
    nick: 'alice',
  })!.id;
});

describe('dccTransfers', () => {
  it('inserts a pending_approval offer and reads it back exactly', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: '[EWG]MArchive',
      filename: 'scene.mkv',
      advertised_size: 5_368_709_120, // > 4 GiB — must stay exact (64-bit INTEGER)
      state: 'pending_approval',
    });
    const row = getDccTransfer(userId, id)!;
    expect(row.state).toBe('pending_approval');
    expect(row.advertised_size).toBe(5_368_709_120);
    expect(row.received_bytes).toBe(0);
    expect(row.passive).toBe(0);
    expect(row.peer_nick).toBe('[EWG]MArchive');
    expect(row.direction).toBe('recv');
  });

  it('records passive offers with their token', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'bot',
      filename: 'f.bin',
      advertised_size: 10,
      state: 'requested',
      passive: true,
      token: 42,
    });
    const row = getDccTransfer(userId, id)!;
    expect(row.passive).toBe(1);
    expect(row.token).toBe(42);
  });

  it('collates peer_nick NOCASE so an offer matches the trigger regardless of casing', () => {
    insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'BotName',
      filename: 'f',
      advertised_size: 1,
      state: 'requested',
    });
    const found = db.prepare('SELECT id FROM dcc_transfers WHERE peer_nick = ?').get('botname');
    expect(found).toBeTruthy();
  });

  it('transitions state with an error and lists newest-first', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'last.mkv',
      advertised_size: 1,
      state: 'pending_approval',
    });
    updateDccTransferState(id, 'cancelled', 'user cancelled');
    const row = getDccTransfer(userId, id)!;
    expect(row.state).toBe('cancelled');
    expect(row.error).toBe('user cancelled');

    const list = listDccTransfers(userId);
    expect(list.map((r) => r.id)).toContain(id);
    // newest-first ordering
    expect(list.toSorted((a, b) => b.id - a.id).map((r) => r.id)).toEqual(list.map((r) => r.id));
  });

  it('scopes reads to the owning user', () => {
    const other = createUser('dcc-bob').id;
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'b',
      filename: 'p.mkv',
      advertised_size: 1,
      state: 'pending_approval',
    });
    expect(getDccTransfer(other, id)).toBeUndefined();
  });

  it('findArmedRequest matches a recent request (NOCASE) but not an expired one', () => {
    const id = insertDccTransfer(userId, {
      network_id: networkId,
      peer_nick: 'QueueBot',
      filename: 'XDCC #1',
      advertised_size: 0,
      state: 'requested',
    });
    // Fresh + case-insensitive nick → matched.
    expect(findArmedRequest(userId, networkId, 'queuebot')?.id).toBe(id);
    // Aged past the arm TTL (120 min) → no longer matched, so a later unsolicited
    // offer from that nick can't auto-accept.
    db.prepare("UPDATE dcc_transfers SET created_at = datetime('now','-3 hours') WHERE id = ?").run(
      id,
    );
    expect(findArmedRequest(userId, networkId, 'QueueBot')).toBeUndefined();
  });
});
