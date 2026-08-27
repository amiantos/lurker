// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The gate on its own: FIFO grant, synchronous start under the cap, release
// from either side of the cap, round-robin re-queueing, and the things that
// would wedge it for the life of the process — a step that throws, and a step
// that hands its turn straight back. The wire-level behaviour (what a
// re-attached connection sends and when) is engineRestoreConcurrency.test.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestoreGate } from './restoreGate.js';
import type { RestoreSlot } from './restoreGate.js';

// Reserve a step and ask for its turn; `started` records the order steps ran.
function step(
  g: RestoreGate,
  label: string,
  started: string[],
  body?: (slot: RestoreSlot) => void,
): RestoreSlot {
  const slot = g.reserve(() => label);
  slot.start(() => {
    started.push(label);
    body?.(slot);
  });
  return slot;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RestoreGate', () => {
  it('starts at once, inside start(), while under the cap', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    const started: string[] = [];
    step(g, 'A', started);
    expect(started).toEqual(['A']);
    step(g, 'B', started);
    expect(started).toEqual(['A', 'B']);
    expect(g.activeCount()).toBe(2);
    expect(g.waitingCount()).toBe(0);
  });

  it('queues past the cap, FIFO, and grants as turns come back', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    const started: string[] = [];
    const a = step(g, 'A', started);
    const b = step(g, 'B', started);
    step(g, 'C', started);
    step(g, 'D', started);
    expect(started).toEqual(['A', 'B']);
    expect(g.waitingCount()).toBe(2);

    a.release();
    expect(started).toEqual(['A', 'B', 'C']);
    expect(g.activeCount()).toBe(2);
    expect(g.waitingCount()).toBe(1);

    b.release();
    expect(started).toEqual(['A', 'B', 'C', 'D']);
    expect(g.activeCount()).toBe(2);
    expect(g.waitingCount()).toBe(0);
  });

  it('a queued step that is released leaves the queue and never runs', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = step(g, 'A', started);
    const b = step(g, 'B', started);
    step(g, 'C', started);
    b.release();
    expect(g.waitingCount()).toBe(1);
    a.release();
    expect(started).toEqual(['A', 'C']);
  });

  it('a slot released before start() never starts, and start() is once-only', () => {
    const g = new RestoreGate({ concurrency: () => 0 });
    const started: string[] = [];
    const early = g.reserve(() => 'early');
    early.release();
    early.start(() => started.push('early'));
    expect(started).toEqual([]);
    expect(g.activeCount()).toBe(0);

    const twice = g.reserve(() => 'twice');
    twice.start(() => started.push('twice'));
    twice.start(() => started.push('twice again'));
    expect(started).toEqual(['twice']);
    expect(g.activeCount()).toBe(1);
  });

  it('release is idempotent — a second release frees nobody else', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = step(g, 'A', started);
    step(g, 'B', started);
    step(g, 'C', started);
    a.release();
    a.release();
    expect(started).toEqual(['A', 'B']);
    expect(g.activeCount()).toBe(1);
    expect(g.waitingCount()).toBe(1);
  });

  it('a step that throws holds nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    g.reserve(() => 'A').start(() => {
      throw new Error('boom');
    });
    expect(g.activeCount()).toBe(0);
    step(g, 'B', started);
    expect(started).toEqual(['B']);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('a step that gives its turn straight back hands it on', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = step(g, 'A', started);
    // B has nothing to ask after all (its channel was left while it queued):
    // it releases inside its own run. C must not be stranded behind that.
    step(g, 'B', started, (s) => s.release());
    step(g, 'C', started);
    a.release();
    expect(started).toEqual(['A', 'B', 'C']);
    expect(g.activeCount()).toBe(1);
    expect(g.waitingCount()).toBe(0);
  });

  it("a connection's next step re-queues behind everyone waiting (round-robin)", () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a1 = step(g, 'A1', started);
    const b1 = step(g, 'B1', started);
    const c1 = step(g, 'C1', started);
    // A's step ends and A reserves its next one — a new reservation, behind
    // B and C, the way drainRestoreQueue does — so B and C go first.
    a1.release();
    step(g, 'A2', started);
    expect(started).toEqual(['A1', 'B1']);
    b1.release();
    expect(started).toEqual(['A1', 'B1', 'C1']);
    c1.release();
    expect(started).toEqual(['A1', 'B1', 'C1', 'A2']);
  });

  it('a cap of 0 is no cap', () => {
    const g = new RestoreGate({ concurrency: () => 0 });
    const started: string[] = [];
    for (const label of ['A', 'B', 'C', 'D', 'E']) step(g, label, started);
    expect(started).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(g.waitingCount()).toBe(0);
  });

  it('reads the cap live', () => {
    let cap = 1;
    const g = new RestoreGate({ concurrency: () => cap });
    const started: string[] = [];
    step(g, 'A', started);
    step(g, 'B', started);
    step(g, 'C', started);
    expect(started).toEqual(['A']);
    cap = 3;
    step(g, 'D', started);
    expect(started).toEqual(['A', 'B', 'C']);
    expect(g.waitingCount()).toBe(1);
  });

  it('describes what is in flight, and nothing when idle', () => {
    const g = new RestoreGate({ concurrency: () => 2 });
    expect(g.describeInFlight()).toBeNull();
    const started: string[] = [];
    const a = step(g, 'net 1 #a', started);
    step(g, 'net 2 #b', started);
    step(g, 'net 3 #c', started);
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refresh steps in flight: 2 (net 1 #a, net 2 #b); 1 waiting',
    );
    a.release();
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refresh steps in flight: 2 (net 2 #b, net 3 #c)',
    );
  });

  it('names at most six holders and survives a describe that throws', () => {
    const g = new RestoreGate({ concurrency: () => 0 });
    for (let i = 1; i <= 8; i++) {
      g.reserve(() => {
        if (i === 2) throw new Error('no label');
        return `net ${i}`;
      }).start(() => {});
    }
    expect(g.describeInFlight()).toBe(
      're-attach channel-state refresh steps in flight: 8 (net 1, ?, net 3, net 4, net 5, net 6, +2 more)',
    );
  });

  it('reset drops everything and runs nothing; handles from before it are no-ops', () => {
    const g = new RestoreGate({ concurrency: () => 1 });
    const started: string[] = [];
    const a = step(g, 'A', started);
    step(g, 'B', started);
    g.reset();
    expect(g.activeCount()).toBe(0);
    expect(g.waitingCount()).toBe(0);
    a.release();
    expect(started).toEqual(['A']);
    step(g, 'C', started);
    expect(started).toEqual(['A', 'C']);
  });

  it('logs once when the cap is first hit and once when the burst drains, counting the steps that waited', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    let now = 1_000;
    const g = new RestoreGate({ concurrency: () => 1, now: () => now });
    const started: string[] = [];
    const a = step(g, 'A', started);
    expect(log).not.toHaveBeenCalled();
    const b = step(g, 'B', started);
    const c = step(g, 'C', started);
    const d = step(g, 'D', started);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe(
      '[restore-gate] 1 channel-state refresh step in flight after re-attach; the rest take turns (LURKER_RESTORE_CONCURRENCY=1)',
    );
    // C leaves the queue without ever running: not a step that waited for
    // a turn, so not in the count.
    c.release();
    now += 2_500;
    a.release();
    b.release();
    expect(log).toHaveBeenCalledTimes(1);
    d.release();
    expect(started).toEqual(['A', 'B', 'D']);
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[1][0])).toBe(
      '[restore-gate] re-attach refreshes drained: 2 steps waited for a turn, 2.5s since the cap was first hit',
    );
    // The next burst logs afresh.
    step(g, 'E', started);
    step(g, 'F', started);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
