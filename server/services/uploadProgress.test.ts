// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fanOutToUser = vi.fn<(userId: number, payload: unknown) => void>();
vi.mock('./wsHub.js', () => ({
  fanOutToUser: (userId: number, payload: unknown) => fanOutToUser(userId, payload),
}));

const { makeUploadProgress } = await import('./uploadProgress.js');

interface Frame {
  kind: string;
  token: string;
  phase: string;
  destination: string;
  percent: number | null;
}

const framesFor = (userId: number): Frame[] =>
  fanOutToUser.mock.calls.filter((c) => c[0] === userId).map((c) => c[1] as Frame);

beforeEach(() => {
  fanOutToUser.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('makeUploadProgress', () => {
  it('announces the phases the browser cannot see', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.processing();
    p.sending();

    expect(framesFor(7)).toEqual([
      {
        kind: 'upload-progress',
        token: 'tok-1',
        phase: 'processing',
        destination: 'Catbox',
        percent: null,
      },
      {
        kind: 'upload-progress',
        token: 'tok-1',
        phase: 'sending',
        destination: 'Catbox',
        // Indeterminate, NOT 0. `local` never reports a byte (it renames the temp
        // file), so a 0 here would freeze at "Sending to Local disk… 0%" for the
        // entire send — a number we cannot back is worse than no number.
        percent: null,
      },
    ]);
  });

  // The escape hatch that keeps progress a courtesy: a client that doesn't ask (or an
  // older one that doesn't know to) must cost nothing and break nothing.
  it('emits nothing at all without a token', () => {
    const p = makeUploadProgress(7, null, 'Catbox');
    p.processing();
    p.sending();
    p.onBytes(500, 1000);
    expect(fanOutToUser).not.toHaveBeenCalled();
  });

  it('throttles the byte stream instead of spraying a frame per chunk', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.sending();
    fanOutToUser.mockClear();

    // 50 chunks arriving back-to-back, as they would off a fast local socket.
    for (let i = 1; i <= 50; i++) p.onBytes(i * 1000, 100_000);

    // All inside one throttle window → at most one frame, not fifty.
    expect(framesFor(7).length).toBeLessThanOrEqual(1);
  });

  it('lets progress through once the throttle window passes', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    // sending() emits its own 0% frame and primes the throttle clock, so a byte frame
    // landing in the same instant is (correctly) suppressed — advance past it first.
    p.sending();
    fanOutToUser.mockClear();

    vi.advanceTimersByTime(200);
    p.onBytes(10_000, 100_000);
    vi.advanceTimersByTime(200);
    p.onBytes(20_000, 100_000);
    vi.advanceTimersByTime(200);
    p.onBytes(30_000, 100_000);

    expect(framesFor(7).map((f) => f.percent)).toEqual([10, 20, 30]);
  });

  // The frame that ends the phase. Dropping it because it landed inside the throttle
  // window would strand the bar just short of done — the same class of lie as
  // "Uploading: 100%", which is the entire point of #545.
  it('always emits 100% even when it lands inside the throttle window', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.sending();
    fanOutToUser.mockClear();

    // Two chunks back-to-back with no time between them: the first is throttled, the
    // last completes the upload and must NOT be.
    p.onBytes(99_000, 100_000);
    p.onBytes(100_000, 100_000);

    expect(framesFor(7).at(-1)!.percent).toBe(100);
  });

  // A 200 MB file yields thousands of chunks, and a run of them all round to the same
  // percent. Without this guard the throttle alone would still let one through every
  // 150ms, repainting the same number forever.
  it('never repeats a percent it has already sent', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.sending();
    fanOutToUser.mockClear();

    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(200); // throttle is wide open every time
      p.onBytes(50_000 + i, 100_000); // ...but every one of these is still 50%
    }

    expect(framesFor(7).map((f) => f.percent)).toEqual([50]);
  });

  // ⚠ The bug this module exists to kill, sneaking back in one layer down.
  // Math.round(0.996 * 100) is 100 — so with most of a megabyte of a 200 MB file
  // still on the wire, the client would read "Sending… 100%". And it would STAY
  // there: lastPercent would already be 100, so the real 100% arriving with the final
  // chunk gets dropped as a duplicate. A false 100 that then goes quiet is precisely
  // "Uploading: 100%" wearing a different hat.
  it('never says 100% until the last byte is actually gone', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.sending();
    fanOutToUser.mockClear();

    vi.advanceTimersByTime(200);
    p.onBytes(99_600, 100_000); // 99.6% — rounds to 100, floors to 99
    expect(framesFor(7).at(-1)!.percent).toBe(99);

    // And the genuine 100 still gets through afterwards; it was not eaten as a dupe.
    p.onBytes(100_000, 100_000);
    expect(framesFor(7).at(-1)!.percent).toBe(100);
  });

  it('never flatters the number on the way up', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Catbox');
    p.sending();
    fanOutToUser.mockClear();

    vi.advanceTimersByTime(200);
    p.onBytes(1990, 10_000); // 19.9% — round() would call this 20
    expect(framesFor(7).at(-1)!.percent).toBe(19);
  });

  it('reports a finite percent for an empty body', () => {
    const p = makeUploadProgress(7, 'tok-1', 'Local disk');
    p.sending();
    fanOutToUser.mockClear();
    vi.advanceTimersByTime(200);
    // 0/0 would be NaN, which renders as "Sending… NaN%". Nothing to send is sent.
    p.onBytes(0, 0);
    expect(framesFor(7).at(-1)!.percent).toBe(100);
  });

  it('scopes frames to the uploading user', () => {
    makeUploadProgress(42, 'tok-a', 'Catbox').processing();
    expect(framesFor(42).length).toBe(1);
    expect(framesFor(7).length).toBe(0);
  });
});
