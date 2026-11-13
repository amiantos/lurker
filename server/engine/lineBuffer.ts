// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The per-connection backlog: every inbound IRC line the app has not yet acked,
// numbered so a re-attaching app can resume exactly where the last one stopped.
//
// Bounded in BYTES, not lines, because one busy channel and one quiet one differ
// by orders of magnitude in line length and what we actually protect is the
// engine's memory. When the cap is hit the OLDEST lines go — the app will learn
// the shape of the hole from the recorded gap and can say so (or backfill from
// CHATHISTORY where the network offers it). Newer lines are kept because they
// are the ones that describe the state the app is about to attach to.
//
// Deliberately in memory only. The app's SQLite is the durable store; this
// buffer exists to bridge a redeploy, not to be a second message log. A
// spill-to-disk implementation would slot in behind the same interface if
// cross-host engines ever need to cover hour-long detaches.

import type { Gap, SeqRange } from './protocol.js';

export interface BufferedLine {
  seq: number;
  line: string;
}

// Shared across every buffer in the process so the total is bounded too. A cell
// with a hundred connections mid-netsplit must not be able to take the engine
// down by each staying under its own cap. Under global pressure it is the
// LARGEST backlog that sheds, not whichever connection happened to receive the
// next line — otherwise one quiet DM would be squeezed to nothing while the
// hoarders kept their full 4 MiB each.
export class ByteBudget {
  used = 0;
  private readonly buffers = new Set<LineBuffer>();
  constructor(readonly max: number) {}

  register(b: LineBuffer): void {
    this.buffers.add(b);
  }

  unregister(b: LineBuffer): void {
    this.buffers.delete(b);
  }

  // Drop oldest lines from the largest buffer until the total fits (a buffer is
  // never emptied below one line, so a single over-long line can't wedge this).
  reclaim(): void {
    while (this.used > this.max) {
      let largest: LineBuffer | null = null;
      for (const b of this.buffers) {
        if (b.length > 1 && (!largest || b.bytes > largest.bytes)) largest = b;
      }
      if (!largest) return;
      largest.dropOldest();
    }
  }
}

const lineBytes = (line: string): number => Buffer.byteLength(line, 'utf8') + 2;

// An ack's `keep` as it came off the wire: whatever in it is a range, in
// ascending order. Anything else is left out, which only ever means a line is
// forgotten as it would have been without the field.
export function keepRanges(raw: unknown): SeqRange[] {
  if (!Array.isArray(raw)) return [];
  const out: SeqRange[] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 2) continue;
    const [from, to] = r as unknown[];
    if (
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      (from as number) <= (to as number)
    )
      out.push([from as number, to as number]);
  }
  return out.toSorted((a, b) => a[0] - b[0]);
}

export class LineBuffer {
  private lines: BufferedLine[] = [];
  private nextSeq = 1;
  private gap: Gap | null = null;
  // The highest seq an ack has named. A line still here at or below it is one
  // an ack asked to keep.
  private acked = 0;
  bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly budget: ByteBudget,
  ) {
    budget.register(this);
  }

  get length(): number {
    return this.lines.length;
  }

  // Latest seq handed out; 0 before the first line.
  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  push(line: string): number {
    const seq = this.nextSeq++;
    const size = lineBytes(line);
    this.lines.push({ seq, line });
    this.bytes += size;
    this.budget.used += size;
    while (this.lines.length > 1 && this.bytes > this.maxBytes) this.dropOldest();
    this.budget.reclaim();
    return seq;
  }

  // Also called by the budget on whichever buffer is largest; not part of the
  // public contract otherwise.
  dropOldest(): void {
    const dropped = this.lines.shift();
    if (!dropped) return;
    const size = lineBytes(dropped.line);
    this.bytes -= size;
    this.budget.used -= size;
    // A kept line is not a hole: the app was given it, and what goes with it
    // is only the copy for the app after that one. (The lines an ack kept are
    // the oldest here, so they are also the first to go.)
    if (dropped.seq <= this.acked) return;
    // Extend a gap that is already open rather than recording a second one:
    // the app only needs the outer bounds of the hole.
    if (this.gap) {
      this.gap.lastDroppedSeq = dropped.seq;
      this.gap.at = Date.now();
    } else {
      this.gap = { firstDroppedSeq: dropped.seq, lastDroppedSeq: dropped.seq, at: Date.now() };
    }
  }

  // Forget everything at or below `seq`, except what `keep` names (ascending
  // ranges, see keepRanges): lines the app was given and has not processed,
  // which the next app to attach is owed again. They stay where they were, so
  // the buffer is in seq order but no longer contiguous.
  ack(seq: number, keep: readonly SeqRange[] = []): void {
    // An ack into the hole says the app had those lines after all (it was
    // attached and simply slow to ack, or the burst replay just delivered
    // them): shrink the reported hole to what is actually unaccounted for.
    if (this.gap) {
      if (seq >= this.gap.lastDroppedSeq) this.gap = null;
      else if (seq >= this.gap.firstDroppedSeq) this.gap.firstDroppedSeq = seq + 1;
    }
    if (seq > this.acked) this.acked = seq;
    let freed = 0;
    let i = 0;
    let kept = 0;
    let k = 0;
    while (i < this.lines.length && this.lines[i].seq <= seq) {
      const line = this.lines[i];
      while (k < keep.length && keep[k][1] < line.seq) k++;
      if (k < keep.length && keep[k][0] <= line.seq) this.lines[kept++] = line;
      else freed += lineBytes(line.line);
      i++;
    }
    if (i === kept) return;
    this.lines.splice(kept, i - kept);
    this.bytes -= freed;
    this.budget.used -= freed;
  }

  // Whether a pending line is one an ack kept, and so has been delivered.
  wasKept(line: BufferedLine): boolean {
    return line.seq <= this.acked;
  }

  pending(): readonly BufferedLine[] {
    return this.lines;
  }

  peekGap(): Gap | null {
    return this.gap;
  }

  // Hand over the recorded hole (if any) and forget it, so it is reported once.
  takeGap(): Gap | null {
    const g = this.gap;
    this.gap = null;
    return g;
  }

  // Release this buffer's share of the budget; called when the connection ends.
  dispose(): void {
    this.budget.used -= this.bytes;
    this.bytes = 0;
    this.lines = [];
    this.budget.unregister(this);
  }
}
