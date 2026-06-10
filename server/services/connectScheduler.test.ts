// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi } from 'vitest';
import { ConnectScheduler } from './connectScheduler.js';

// A deterministic virtual clock + timer harness. The scheduler is purely
// timing-driven, so we inject `now`/`setTimer`/`clearTimer` and drive time by
// hand rather than leaning on real timers (flaky) or vitest fake timers (which
// the rest of this codebase doesn't use).
function makeHarness() {
  interface Pending {
    fireAt: number;
    fn: () => void;
    cancelled: boolean;
  }
  let clock = 0;
  const timers: Pending[] = [];

  const now = () => clock;
  const setTimer = (fn: () => void, ms: number) => {
    const p: Pending = { fireAt: clock + Math.max(0, ms), fn, cancelled: false };
    timers.push(p);
    return p as unknown as ReturnType<typeof setTimeout>;
  };
  const clearTimer = (h: ReturnType<typeof setTimeout>) => {
    (h as unknown as Pending).cancelled = true;
  };
  // Advance virtual time by `ms`, firing every due (non-cancelled) timer in
  // chronological order. Re-reads the list each step because firing a timer can
  // synchronously schedule the next one.
  const advance = (ms: number) => {
    const target = clock + ms;
    for (let guard = 0; guard < 100000; guard++) {
      const due = timers.filter((t) => !t.cancelled).toSorted((a, b) => a.fireAt - b.fireAt)[0];
      if (!due || due.fireAt > target) break;
      clock = Math.max(clock, due.fireAt);
      due.cancelled = true;
      due.fn();
    }
    clock = target;
  };

  return { now, setTimer, clearTimer, advance };
}

describe('ConnectScheduler', () => {
  it('launches the first connect to a host at once, then spaces same-host connects by perHostMs', () => {
    const h = makeHarness();
    const launches: number[] = [];
    const s = new ConnectScheduler({
      perHostMs: 2000,
      jitterMs: 0,
      globalMs: 0,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    for (let i = 0; i < 3; i++) s.schedule('irc.libera.chat', () => launches.push(h.now()));

    h.advance(0);
    expect(launches).toEqual([0]);
    h.advance(2000);
    expect(launches).toEqual([0, 2000]);
    h.advance(2000);
    expect(launches).toEqual([0, 2000, 4000]);
    expect(s.pendingCount()).toBe(0);
  });

  it('adds jitter on top of the per-host base so a synchronised herd de-syncs', () => {
    const h = makeHarness();
    const launches: number[] = [];
    // random pinned at 0.5 → jitter = floor(0.5 * 2000) = 1000 → spacing 3000.
    const s = new ConnectScheduler({
      perHostMs: 2000,
      jitterMs: 2000,
      globalMs: 0,
      random: () => 0.5,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    for (let i = 0; i < 3; i++) s.schedule('irc.example.org', () => launches.push(h.now()));

    h.advance(0);
    h.advance(3000);
    h.advance(3000);
    expect(launches).toEqual([0, 3000, 6000]);
  });

  it('lets distinct hosts connect right away — only the global floor spaces them, not the per-host gate', () => {
    const h = makeHarness();
    const log: Array<[string, number]> = [];
    const s = new ConnectScheduler({
      perHostMs: 2000,
      jitterMs: 0,
      globalMs: 150,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    s.schedule('host-a', () => log.push(['A1', h.now()]));
    s.schedule('host-b', () => log.push(['B1', h.now()]));
    s.schedule('host-a', () => log.push(['A2', h.now()]));

    h.advance(0); // A1
    h.advance(150); // B1 — held only by the 150ms global floor, NOT host-a's 2s gate
    h.advance(2000); // A2 — held by host-a's per-host gate

    expect(log).toEqual([
      ['A1', 0],
      ['B1', 150],
      ['A2', 2000],
    ]);
  });

  it('drains same-host connects in FIFO arrival order', () => {
    const h = makeHarness();
    const order: string[] = [];
    const s = new ConnectScheduler({
      perHostMs: 1000,
      jitterMs: 0,
      globalMs: 0,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    s.schedule('x', () => order.push('first'));
    s.schedule('x', () => order.push('second'));
    s.schedule('x', () => order.push('third'));

    h.advance(0);
    h.advance(1000);
    h.advance(1000);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('keys on the host case-insensitively (same remote, different casing = one bucket)', () => {
    const h = makeHarness();
    const launches: number[] = [];
    const s = new ConnectScheduler({
      perHostMs: 2000,
      jitterMs: 0,
      globalMs: 0,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    s.schedule('IRC.Libera.Chat', () => launches.push(h.now()));
    s.schedule('irc.libera.chat', () => launches.push(h.now()));

    h.advance(0);
    expect(launches).toEqual([0]); // second is throttled behind the first
    h.advance(2000);
    expect(launches).toEqual([0, 2000]);
  });

  it('runs inline and synchronously when disabled', () => {
    const h = makeHarness();
    let ran = false;
    const s = new ConnectScheduler({
      perHostMs: 9999,
      disabled: true,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    s.schedule('x', () => {
      ran = true;
    });

    expect(ran).toBe(true); // no advance needed
    expect(s.pendingCount()).toBe(0);
  });

  it('reset() drops queued launches and cancels the pending timer', () => {
    const h = makeHarness();
    const launches: number[] = [];
    const s = new ConnectScheduler({
      perHostMs: 2000,
      jitterMs: 0,
      globalMs: 0,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    s.schedule('x', () => launches.push(h.now()));
    s.schedule('x', () => launches.push(h.now()));
    h.advance(0);
    expect(launches.length).toBe(1);
    expect(s.pendingCount()).toBe(1);

    s.reset();
    expect(s.pendingCount()).toBe(0);
    h.advance(100000);
    expect(launches.length).toBe(1); // the queued second launch never fired
  });

  it('does not strand a fresh-host connect behind another host’s far-future gate', () => {
    const h = makeHarness();
    const log: Array<[string, number]> = [];
    const s = new ConnectScheduler({
      perHostMs: 100000,
      jitterMs: 0,
      globalMs: 0,
      now: h.now,
      setTimer: h.setTimer,
      clearTimer: h.clearTimer,
    });

    // host-a's second connect gets pushed ~100s out after the first launches.
    s.schedule('host-a', () => log.push(['A1', h.now()]));
    s.schedule('host-a', () => log.push(['A2', h.now()]));
    h.advance(0);
    expect(log).toEqual([['A1', 0]]);

    // A connect to a brand-new host arrives while host-a's gate is far away. It
    // must launch promptly (its own host is unthrottled) — not wait for the
    // pending far-future timer.
    s.schedule('host-b', () => log.push(['B1', h.now()]));
    h.advance(0);
    expect(log).toEqual([
      ['A1', 0],
      ['B1', 0],
    ]);
  });

  it('logs a staggering line once a host is contended (operator visibility)', () => {
    const h = makeHarness();
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a) => {
      logs.push(a.map(String).join(' '));
    });
    try {
      const s = new ConnectScheduler({
        perHostMs: 2000,
        jitterMs: 0,
        globalMs: 0,
        now: h.now,
        setTimer: h.setTimer,
        clearTimer: h.clearTimer,
      });
      s.schedule('irc.libera.chat', () => {});
      s.schedule('irc.libera.chat', () => {});
      expect(logs.some((l) => l.includes('staggering') && l.includes('irc.libera.chat'))).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
