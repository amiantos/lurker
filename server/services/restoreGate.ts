// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Cross-connection cap on the channel-state refresh after an engine re-attach.
// See issue #842.
//
// When the app re-attaches to the connections the engine kept open, each one
// asks the server about every channel it is in — NAMES/TOPIC/MODE, then the
// WHO the NAMES reply triggers. drainRestoreQueue (ircConnection.ts) paces that
// WITHIN a connection: one channel in flight, the next released by the previous
// one's replies. Across N connections nothing paced it: all N started in the
// tick the engine said `restored`, and their 353/366 replies (member rebuild +
// WS fan-out, all synchronous) landed together. Measured on a 30-session cell:
// one ~1.4 s [event-loop] stall a few seconds after attach, linear in the
// session count.
//
// The attach itself is deliberately NOT staggered (ircManager skips
// connectScheduler for it — an attach registers nothing on the ircd) and stays
// immediate: buffered lines are delivered and the session is live the moment it
// re-attaches. Only the refresh waits its turn here, and nothing is at stake on
// the ircd side while it does — the socket is up, the engine answered PINGs
// throughout — it is only "when does this channel's member list come back".
//
// Model: a counting semaphore with a FIFO wait queue, not a rate limiter like
// connectScheduler. A connect may never register, so the scheduler can't await
// one; a refresh has a definite end (its queue drains) and definite abort
// points (the socket closes, the connection re-dials or re-attaches, the
// network is removed), all of which release the slot. A holder that stalls is
// bounded by drainRestoreQueue's per-step deadline: every step ends, so every
// queue drains, so every slot comes back.
//
// Under the cap the refresh starts synchronously inside acquire(), so a
// single-user instance with a handful of networks sees no change at all.

const DEFAULT_CONCURRENCY = 4;
// How many holders describeInFlight() names before it says "+N more".
const DESCRIBE_MAX = 6;

export type RestoreSlotState = 'waiting' | 'active' | 'released';

export interface RestoreSlot {
  // Give the slot back, or leave the queue if it was never granted. Idempotent.
  release(): void;
  state(): RestoreSlotState;
}

export interface RestoreGateOptions {
  // How many refreshes may run at once; 0 (or non-finite) = no cap. Read on
  // every decision, like the other restore knobs, so a test — or an operator —
  // does not have to restart the process for it to take.
  concurrency?: () => number;
  now?: () => number;
}

interface Entry {
  id: number;
  describe: () => string;
  run: (slot: RestoreSlot) => void;
  slot: RestoreSlot;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export class RestoreGate {
  private readonly cap: () => number;
  private readonly now: () => number;
  private readonly waiting: Entry[] = [];
  private readonly active = new Map<number, Entry>();
  private nextId = 1;
  private pumping = false;
  // Set from the first refresh that has to wait until every refresh is done —
  // one log line at each end of the burst, never one per queued session.
  private burst: { since: number; queued: number } | null = null;

  constructor(opts: RestoreGateOptions = {}) {
    this.cap =
      opts.concurrency ?? (() => envInt('LURKER_RESTORE_CONCURRENCY', DEFAULT_CONCURRENCY));
    this.now = opts.now ?? (() => Date.now());
  }

  // Ask for a slot. `run` is called with the slot the moment one is free —
  // synchronously, inside this call, when the gate is under its cap — and the
  // caller keeps the slot until its refresh is done or abandoned. `describe`
  // labels the holder for the event-loop monitor (describeInFlight).
  acquire(describe: () => string, run: (slot: RestoreSlot) => void): RestoreSlot {
    const id = this.nextId++;
    const slot: RestoreSlot = {
      release: () => this.release(id),
      state: () => {
        if (this.active.has(id)) return 'active';
        return this.waiting.some((e) => e.id === id) ? 'waiting' : 'released';
      },
    };
    const entry: Entry = { id, describe, run, slot };
    this.waiting.push(entry);
    this.pump();
    if (this.waiting.includes(entry)) {
      if (!this.burst) {
        this.burst = { since: this.now(), queued: 0 };
        const n = this.active.size;
        console.log(
          `[restore-gate] ${n} connection${n === 1 ? '' : 's'} refreshing channel state after re-attach; ` +
            `queuing the rest (LURKER_RESTORE_CONCURRENCY=${this.limit()})`,
        );
      }
      this.burst.queued++;
    }
    return slot;
  }

  activeCount(): number {
    return this.active.size;
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  // What the gate is doing right now, for the [event-loop] stall line, or null
  // when idle. Sampled by the monitor at its poll, which runs after the stall
  // it reports — so this names the refreshes in flight just after, which for a
  // stall caused by their replies is the same set.
  describeInFlight(): string | null {
    if (this.active.size === 0 && this.waiting.length === 0) return null;
    const names: string[] = [];
    for (const entry of this.active.values()) {
      if (names.length >= DESCRIBE_MAX) break;
      let label: string;
      try {
        label = entry.describe();
      } catch (_) {
        label = '?';
      }
      names.push(label);
    }
    const more = this.active.size - names.length;
    const list = names.length ? ` (${names.join(', ')}${more > 0 ? `, +${more} more` : ''})` : '';
    const waiting = this.waiting.length > 0 ? `; ${this.waiting.length} waiting` : '';
    return `re-attach channel-state refreshes in flight: ${this.active.size}${list}${waiting}`;
  }

  // Drop everything. Called on shutdown (the connections are being detached
  // and nothing should start a refresh) and by tests. A slot handed out before
  // the reset releases as a no-op.
  reset(): void {
    this.waiting.length = 0;
    this.active.clear();
    this.burst = null;
  }

  private limit(): number {
    const n = this.cap();
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  }

  private release(id: number): void {
    const w = this.waiting.findIndex((e) => e.id === id);
    if (w >= 0) {
      this.waiting.splice(w, 1);
      this.noteIdle();
      return;
    }
    if (!this.active.delete(id)) return;
    this.pump();
  }

  // Grant slots to waiters, FIFO, while there is room. Re-entrant calls (a
  // run() that acquires or releases synchronously — a connection with no
  // channels drains its queue inside its own start) return at once; the
  // outer loop re-reads the counts each pass and picks the change up.
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length > 0 && this.active.size < this.limit()) {
        const entry = this.waiting.shift()!;
        this.active.set(entry.id, entry);
        try {
          entry.run(entry.slot);
        } catch (err) {
          // A start that threw holds nothing; keeping its slot would wedge
          // every refresh behind it for the life of the process.
          console.error('[restore-gate] refresh start threw', err);
          this.active.delete(entry.id);
        }
      }
    } finally {
      this.pumping = false;
    }
    this.noteIdle();
  }

  private noteIdle(): void {
    if (!this.burst || this.waiting.length > 0 || this.active.size > 0) return;
    const secs = ((this.now() - this.burst.since) / 1000).toFixed(1);
    console.log(
      `[restore-gate] re-attach refreshes drained: ${this.burst.queued} waited their turn, ` +
        `${secs}s since the cap was first hit`,
    );
    this.burst = null;
  }
}

// Process-wide singleton used by IrcConnection. Tests construct their own
// instances with injected config rather than poking this one.
const restoreGate = new RestoreGate();
export default restoreGate;
