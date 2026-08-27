// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The gate on its own: FIFO grant, synchronous start under the cap, release
// from either side of the cap, and the two things that would wedge it for the
// life of the process — a start that throws, and a start that hands its slot
// straight back. The wire-level behaviour (what a re-attached connection sends
// and when) is engineRestoreConcurrency.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestoreGate } from './restoreGate.js';
import type { RestoreSlot } from './restoreGate.js';

interface Asked {
  slot: RestoreSlot;
  // The slot `run` was handed, once it has been.
  granted: RestoreSlot | null;
}

function ask(
  g: RestoreGate,
  label: string,
  started: string[],
  onStart?: (slot: RestoreSlot) => void,
): Asked {
  const asked: Asked = { slot: null as unknown as RestoreSlot, granted: null };
  asked.slot = g.acquire(
    () => label,
    (s) => {
      asked.granted = s;
      started.push(label);
      onStart?.(s);
    },
  );
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RestoreGate', () => {
  it('starts at once, inside acquire, while under the cap', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    expect(started).toEqual(['A']);
    expect(a.granted).toBe(a.slot);
    expect(a.slot.state()).toBe('active');
    ask(g, 'B', started);
    expect(started).toEqual(['A', 'B']);
    expect(g.activeCount()).toBe(2);
    expect(g.waitingCount()).toBe(0);
  });

  it('queues past the cap, FIFO, and grants as slots come back', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    const b = ask(g, 'B', started);
    const c = ask(g, 'C', started);
    const d = ask(g, 'D', started);
    expect(started).toEqual(['A', 'B']);
    expect(c.granted).toBeNull();
    expect(c.slot.state()).toBe('waiting');
    expect(g.waitingCount()).toBe(2);

    a.slot.release();
    expect(started).toEqual(['A', 'B', 'C']);
    expect(a.slot.state()).toBe('released');
    expect(c.slot.state()).toBe('active');
    expect(d.slot.state()).toBe('waiting');
    expect(g.activeCount()).toBe(2);

    b.slot.release();
    expect(started).toEqual(['A', 'B', 'C', 'D']);
    expect(g.activeCount()).toBe(2);
    expect(g.waitingCount()).toBe(0);
  });

  it('a waiter that gives up leaves the queue and is never started', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    const b = ask(g, 'B', started);
    ask(g, 'C', started);
    b.slot.release();
    expect(b.slot.state()).toBe('released');
    expect(g.waitingCount()).toBe(1);
    a.slot.release();
    expect(started).toEqual(['A', 'C']);
  });

  it('release is idempotent — a second release frees nobody else', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    ask(g, 'B', started);
    ask(g, 'C', started);
    a.slot.release();
    a.slot.release();
    expect(started).toEqual(['A', 'B']);
    expect(g.activeCount()).toBe(1);
    expect(g.waitingCount()).toBe(1);
  });

  it('a start that throws holds nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    g.acquire(
      () => 'A',
      () => {
        throw new Error('boom');
      },
    );
    expect(g.activeCount()).toBe(0);
    ask(g, 'B', started);
    expect(started).toEqual(['B']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a start that finishes synchronously hands the slot straight on', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    // B has nothing to refresh: it releases inside its own start, the way a
    // connection with no channels drains its queue before drainRestoreQueue
    // returns. C must not be stranded behind that.
    ask(g, 'B', started, (s) => s.release());
    const c = ask(g, 'C', started);
    a.slot.release();
    expect(started).toEqual(['A', 'B', 'C']);
    expect(c.slot.state()).toBe('active');
    expect(g.activeCount()).toBe(1);
    expect(g.waitingCount()).toBe(0);
  });

  it('a cap of 0 is no cap', () => {
    const g = new RestoreGate({ concurrency: () => 0 });
    const started: string[] = [];
    for (const label of ['A', 'B', 'C', 'D', 'E']) ask(g, label, started);
    expect(started).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(g.waitingCount()).toBe(0);
  });

  it('reads the cap live', () => {
    let cap = 1;
    const g = new RestoreGate({ concurrency: () => cap });
    const started: string[] = [];
    ask(g, 'A', started);
    ask(g, 'B', started);
    ask(g, 'C', started);
    expect(started).toEqual(['A']);
    cap = 3;
    ask(g, 'D', started);
    expect(started).toEqual(['A', 'B', 'C']);
    expect(g.waitingCount()).toBe(1);
  });

  it('describes what is in flight, and nothing when idle', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    expect(g.describeInFlight()).toBeNull();
    const started: string[] = [];
    const a = ask(g, 'net 1 #a', started);
    ask(g, 'net 2 (between steps)', started);
    ask(g, 'net 3 #c', started);
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refreshes in flight: 2 (net 1 #a, net 2 (between steps)); 1 waiting',
    );
    a.slot.release();
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refreshes in flight: 2 (net 2 (between steps), net 3 #c)',
    );
  });

  it('names at most six holders and survives a describe that throws', () => {
    const g = new RestoreGate({ concurrency: () => 0 });
    for (let i = 1; i <= 8; i++) {
      g.acquire(
        () => {
          if (i === 2) throw new Error('no label');
          return `net ${i}`;
        },
        () => {},
      );
    }
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refreshes in flight: 8 (net 1, ?, net 3, net 4, net 5, net 6, +2 more)',
    );
  });

  it('reset drops everything; a slot from before the reset releases as a no-op', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    const b = ask(g, 'B', started);
    g.reset();
    expect(g.activeCount()).toBe(0);
    expect(g.waitingCount()).toBe(0);
    expect(b.slot.state()).toBe('released');
    a.slot.release();
    expect(started).toEqual(['A']);
    ask(g, 'C', started);
    expect(started).toEqual(['A', 'C']);
  });

  it('logs once when the cap is first hit and once when the burst drains', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 1_000;
    const g = new RestoreGate({ concurrency: () => 1, now: () => now });
    const started: string[] = [];
    const a = ask(g, 'A', started);
    expect(log).not.toHaveBeenCalled();
    const b = ask(g, 'B', started);
    const c = ask(g, 'C', started);
    const d = ask(g, 'D', started);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe(
      '[restore-gate] 1 connection refreshing channel state after re-attach; queuing the rest (LURKER_RESTORE_CONCURRENCY=1)',
    );
    now += 2_500;
    a.slot.release();
    b.slot.release();
    c.slot.release();
    expect(log).toHaveBeenCalledTimes(1);
    d.slot.release();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toBe(
      '[restore-gate] re-attach refreshes drained: 3 waited their turn, 2.5s since the cap was first hit',
    );
    // The next burst logs afresh.
    ask(g, 'E', started);
    ask(g, 'F', started);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
