// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import { ByteBudget, LineBuffer, keepRanges } from './lineBuffer.js';

const seqs = (b: LineBuffer) => b.pending().map((l) => l.seq);

describe('LineBuffer', () => {
  it('numbers lines from 1 and keeps them until acked', () => {
    const b = new LineBuffer(1024 * 1024, new ByteBudget(1024 * 1024));
    expect(b.push('a')).toBe(1);
    expect(b.push('b')).toBe(2);
    expect(b.push('c')).toBe(3);
    expect(seqs(b)).toEqual([1, 2, 3]);
    b.ack(2);
    expect(seqs(b)).toEqual([3]);
    // An ack below what is already gone is a no-op, not an error.
    b.ack(1);
    expect(seqs(b)).toEqual([3]);
    b.ack(3);
    expect(b.length).toBe(0);
    expect(b.lastSeq).toBe(3);
    expect(b.takeGap()).toBeNull();
  });

  it('drops the OLDEST lines past its byte cap and records one gap', () => {
    // Each line is 10 bytes + CRLF = 12; cap fits four.
    const b = new LineBuffer(48, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 6; i++) b.push('x'.repeat(10));
    expect(seqs(b)).toEqual([3, 4, 5, 6]);
    expect(b.bytes).toBe(48);
    const gap = b.takeGap();
    expect(gap).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 2 });
    // Reported once.
    expect(b.takeGap()).toBeNull();
  });

  it('never drops the newest line, even when it alone exceeds the cap', () => {
    const b = new LineBuffer(16, new ByteBudget(1024 * 1024));
    b.push('short');
    b.push('a'.repeat(100));
    expect(seqs(b)).toEqual([2]);
  });

  it('sheds from the LARGEST buffer when the process-wide budget is full', () => {
    const budget = new ByteBudget(60);
    const hoarder = new LineBuffer(1024, budget);
    const quiet = new LineBuffer(1024, budget);
    for (let i = 0; i < 4; i++) hoarder.push('x'.repeat(10)); // 48 bytes
    quiet.push('y'.repeat(10)); // 60: exactly full
    quiet.push('y'.repeat(10)); // 72: over — the hoarder pays, not the pusher
    expect(quiet.length).toBe(2);
    expect(hoarder.length).toBe(3);
    expect(hoarder.takeGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 1 });
    expect(quiet.takeGap()).toBeNull();
    expect(budget.used).toBe(60);
    hoarder.dispose();
    expect(budget.used).toBe(24);
    // A disposed buffer is out of the running.
    for (let i = 0; i < 4; i++) quiet.push('z'.repeat(10));
    expect(quiet.length).toBe(5);
    expect(budget.used).toBe(60);
  });

  it('shrinks a recorded gap as acks land inside it', () => {
    const b = new LineBuffer(48, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 8; i++) b.push('x'.repeat(10)); // keeps 5..8, dropped 1..4
    expect(b.peekGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 4 });
    b.ack(2); // the app had 1..2 after all
    expect(b.peekGap()).toMatchObject({ firstDroppedSeq: 3, lastDroppedSeq: 4 });
    b.ack(4); // and the rest
    expect(b.peekGap()).toBeNull();
    expect(b.length).toBe(4);
  });

  it('keeps the lines an ack names, until an ack stops naming them (#1286)', () => {
    const budget = new ByteBudget(1024 * 1024);
    const b = new LineBuffer(1024 * 1024, budget);
    for (let i = 1; i <= 8; i++) b.push(`line ${i}`);
    const each = b.bytes / 8;
    b.ack(6, [
      [2, 3],
      [5, 5],
    ]);
    expect(seqs(b)).toEqual([2, 3, 5, 7, 8]);
    expect(b.bytes).toBe(each * 5);
    expect(budget.used).toBe(each * 5);
    // The same ack again changes nothing; a range past the ack's seq, or over
    // lines long gone, is not an instruction about anything.
    b.ack(6, [
      [1, 3],
      [5, 5],
      [7, 9],
    ]);
    expect(seqs(b)).toEqual([2, 3, 5, 7, 8]);
    // Each ack states the whole set: 2 and 3 are no longer in it.
    b.ack(7, [[5, 5]]);
    expect(seqs(b)).toEqual([5, 8]);
    // An ack BELOW a kept line says nothing about it.
    b.ack(4);
    expect(seqs(b)).toEqual([5, 8]);
    b.ack(8);
    expect(b.length).toBe(0);
    expect(b.bytes).toBe(0);
    expect(budget.used).toBe(0);
  });

  it('a kept line shed under pressure is not a hole; an unacked one still is (#1286)', () => {
    // Each line is 12 bytes; the cap fits four.
    const b = new LineBuffer(48, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 3; i++) b.push('x'.repeat(10));
    b.ack(3, [[2, 2]]);
    expect(seqs(b)).toEqual([2]);
    expect(b.wasKept(b.pending()[0])).toBe(true);
    // Pressure sheds the oldest line, kept or not: the app had that one.
    for (let i = 4; i <= 7; i++) b.push('x'.repeat(10));
    expect(seqs(b)).toEqual([4, 5, 6, 7]);
    expect(b.pending().some((l) => b.wasKept(l))).toBe(false);
    expect(b.peekGap()).toBeNull();
    // The next one to go was never acked, and the hole is exactly it.
    b.push('x'.repeat(10));
    expect(b.peekGap()).toMatchObject({ firstDroppedSeq: 4, lastDroppedSeq: 4 });
  });

  it('reads a `keep` off the wire: ranges in order, and nothing else', () => {
    expect(keepRanges(undefined)).toEqual([]);
    expect(keepRanges('1-2')).toEqual([]);
    expect(
      keepRanges([[5, 6], [1, 2], [4, 3], [1.5, 2], ['1', 2], [7], [8, 9, 10], null, [3, 3]]),
    ).toEqual([
      [1, 2],
      [3, 3],
      [5, 6],
    ]);
  });

  it('extends an open gap rather than opening a second one', () => {
    const b = new LineBuffer(24, new ByteBudget(1024 * 1024));
    for (let i = 1; i <= 4; i++) b.push('x'.repeat(10));
    expect(b.takeGap()).toMatchObject({ firstDroppedSeq: 1, lastDroppedSeq: 2 });
    b.push('x'.repeat(10));
    b.push('x'.repeat(10));
    expect(b.takeGap()).toMatchObject({ firstDroppedSeq: 3, lastDroppedSeq: 4 });
  });
});
