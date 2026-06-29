// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useDccStore, percentReceived, type DccTransfer, type DccState } from './dcc.js';

// Minimal row factory — only the fields the store logic reads.
function row(id: number, state: DccState, over: Partial<DccTransfer> = {}): DccTransfer {
  return {
    id,
    network_id: 1,
    peer_nick: 'bot',
    filename: `f${id}.bin`,
    advertised_size: 1000,
    received_bytes: 0,
    state,
    crc_status: null,
    error: null,
    created_at: '2026-06-28 00:00:00',
    updated_at: '2026-06-28 00:00:00',
    completed_at: null,
    ...over,
  };
}

describe('dcc store applyTransfer', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('inserts new rows keeping id-DESC order', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row(2, 'receiving'));
    dcc.applyTransfer(row(5, 'pending_approval'));
    dcc.applyTransfer(row(3, 'receiving'));
    expect(dcc.transfers.map((t) => t.id)).toEqual([5, 3, 2]);
  });

  it('replaces an existing row in place', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row(1, 'receiving', { received_bytes: 100 }));
    dcc.applyTransfer(row(1, 'receiving', { received_bytes: 500 }));
    expect(dcc.transfers).toHaveLength(1);
    expect(dcc.transfers[0].received_bytes).toBe(500);
  });

  it('does not let a terminal row regress to an active state (stale snapshot)', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row(1, 'completed', { received_bytes: 1000 }));
    // A late POST-response snapshot carrying the pre-completion 'receiving' state.
    dcc.applyTransfer(row(1, 'receiving', { received_bytes: 300 }));
    expect(dcc.transfers[0].state).toBe('completed');
    expect(dcc.transfers[0].received_bytes).toBe(1000);
  });

  it('still applies a terminal state over an active one', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row(1, 'receiving'));
    dcc.applyTransfer(row(1, 'cancelled'));
    expect(dcc.transfers[0].state).toBe('cancelled');
  });

  it('ignores a malformed frame', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(undefined as unknown as DccTransfer);
    dcc.applyTransfer({ id: 'x' } as unknown as DccTransfer);
    expect(dcc.transfers).toHaveLength(0);
  });
});

describe('dcc store getters', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('pendingCount counts only pending_approval offers', () => {
    const dcc = useDccStore();
    dcc.applyTransfer(row(1, 'pending_approval'));
    dcc.applyTransfer(row(2, 'pending_approval'));
    dcc.applyTransfer(row(3, 'receiving'));
    dcc.applyTransfer(row(4, 'completed'));
    expect(dcc.pendingCount).toBe(2);
    expect(dcc.hasAny).toBe(true);
  });
});

describe('percentReceived', () => {
  it('is a clamped 0–100 integer', () => {
    expect(percentReceived(row(1, 'receiving', { received_bytes: 0, advertised_size: 1000 }))).toBe(
      0,
    );
    expect(
      percentReceived(row(1, 'receiving', { received_bytes: 500, advertised_size: 1000 })),
    ).toBe(50);
    expect(
      percentReceived(row(1, 'completed', { received_bytes: 1000, advertised_size: 1000 })),
    ).toBe(100);
    // A bot that over-sends can't push the bar past 100%.
    expect(
      percentReceived(row(1, 'receiving', { received_bytes: 1500, advertised_size: 1000 })),
    ).toBe(100);
    // No advertised size → 0 (avoid divide-by-zero).
    expect(percentReceived(row(1, 'receiving', { received_bytes: 500, advertised_size: 0 }))).toBe(
      0,
    );
  });
});
