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
// The unit of a turn is one STEP (one channel's three requests), not a
// connection's whole walk: each step is its own reservation at the back of the
// FIFO, so with more connections than slots the steps round-robin — every
// session's first member list comes back early, and a connection whose server
// answers slowly (or not at all: the step deadline) holds a slot for one step
// at a time, never for all of its channels.
//
// Model: a counting semaphore with a FIFO wait queue. Not connectScheduler (a
// rate limiter: a connect may never register, so it can't await one; a step
// has a definite end — its replies or the deadline — and definite abort
// points, all of which release the slot). Not utils/slotPool either: that one
// grants asynchronously, so a step could never go out synchronously under the
// cap (the "small instance sees no change" property), and a queued waiter
// cannot be dropped, which every abort path here needs.
//
// What this bounds, and what it does not. A turn covers the NAMES/TOPIC/MODE
// requests and ends with their replies. The WHO that the NAMES reply triggers
// is outside it, on purpose: irc-framework serialises WHOs behind their 315
// and never recovers from one that does not come, so a turn held for it would
// turn one lost reply into a deadline wait per remaining channel. Its
// 352-per-member reply is trimmed by the size gate (RESTORE_WHO_MAX_MEMBERS)
// and held to one in flight per connection by that queue, but across
// connections it is as parallel as before. And this bounds ONE producer of the
// post-restart burst: a re-attach's refresh of channels the socket is already
// in. A socket the engine registered unattended has none to refresh — its
// autojoin JOINs at `live` — and a non-engine restart's fresh connects (spaced
// only by connectScheduler) each bring their own volunteered 353/366 + WHO per
// channel, ungated here.

import { envInt } from '../utils/envInt.js';

const DEFAULT_CONCURRENCY = 4;
// How many holders describeInFlight() names before it says "+N more".
const DESCRIBE_MAX = 6;

export interface RestoreSlot {
  // Ask for the turn. `run` fires when a slot is free — synchronously, inside
  // start(), while the gate is under its cap. Once only; a slot released
  // before it came up never starts.
  start(run: () => void): void;
  // Give the turn back, or leave the queue if it never came up. Idempotent.
  release(): void;
}

export interface RestoreGateOptions {
  // How many steps may be in flight at once; 0 (or non-finite) = no cap. Read
  // on every decision, like the other restore knobs, so a test — or an
  // operator — does not have to restart the process for it to take.
  concurrency?: () => number;
  now?: () => number;
}

interface Entry {
  id: number;
  describe: () => string;
  run: (() => void) | null;
  released: boolean;
  // Still queued when a grant pass ended — what the drained log counts.
  waited: boolean;
}

export class RestoreGate {
  private readonly cap: () => number;
  private readonly now: () => number;
  private readonly waiting: Entry[] = [];
  private readonly active = new Map<number, Entry>();
  private nextId = 1;
  private pumping = false;
  // Set from the first step that has to wait until every step is done — one
  // log line at each end of the burst, never one per queued step.
  private burst: { since: number; queued: number } | null = null;

  constructor(opts: RestoreGateOptions = {}) {
    this.cap =
      opts.concurrency ?? (() => envInt('LURKER_RESTORE_CONCURRENCY', DEFAULT_CONCURRENCY));
    this.now = opts.now ?? (() => Date.now());
  }

  // A slot handle for one step. Two-phase so the caller holds the handle
  // BEFORE anything can run: start() may grant synchronously, and the step it
  // runs may give the slot straight back (nothing to ask after all) — with a
  // one-call API the caller would have nothing to release yet. `describe`
  // labels the step for the event-loop monitor (describeInFlight).
  reserve(describe: () => string): RestoreSlot {
    const entry: Entry = {
      id: this.nextId++,
      describe,
      run: null,
      released: false,
      waited: false,
    };
    return {
      start: (run) => {
        if (entry.released || entry.run) return;
        entry.run = run;
        this.waiting.push(entry);
        this.pump();
      },
      release: () => this.release(entry),
    };
  }

  activeCount(): number {
    return this.active.size;
  }

  waitingCount(): number {
    return this.waiting.length;
  }

  // What the gate is doing right now, for the [event-loop] stall line, or null
  // when idle. Sampled by the monitor at its poll, which runs after the stall
  // it reports — so this names the steps in flight just after, which for a
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
    return `re-attach channel-state refresh steps in flight: ${this.active.size}${list}${waiting}`;
  }

  // Drop everything, running nothing. For shutdown ONLY, and before the
  // connections are detached: a detach's synchronous 'close' releases its slot,
  // which would otherwise grant the next queued step to a connection that is
  // itself about to detach — three requests whose replies land in the engine
  // backlog and replay to the next process as if it had asked. Any other
  // caller strands whatever was queued (its channels never get refreshed) and
  // lifts the cap for the steps still running. A handle from before the reset
  // releases as a no-op.
  reset(): void {
    this.waiting.length = 0;
    this.active.clear();
    this.burst = null;
  }

  private limit(): number {
    const n = this.cap();
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  }

  private release(entry: Entry): void {
    entry.released = true;
    const w = this.waiting.indexOf(entry);
    if (w >= 0) this.waiting.splice(w, 1);
    else if (!this.active.delete(entry.id)) return;
    this.pump();
  }

  // Grant slots to waiters, FIFO, while there is room. Re-entrant calls (a
  // run() that reserves or releases synchronously — a connection re-queues its
  // next step from inside the release of its last) return at once; the outer
  // loop re-reads the counts each pass and picks the change up. Only the
  // outer pass does the burst bookkeeping, once it is over: a step enqueued
  // mid-pass and granted by the same pass never waited.
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length > 0 && this.active.size < this.limit()) {
        const entry = this.waiting.shift()!;
        this.active.set(entry.id, entry);
        if (entry.waited && this.burst) this.burst.queued++;
        try {
          entry.run!();
        } catch (err) {
          // A start that threw holds nothing; keeping its slot would wedge
          // every step behind it for the life of the process.
          console.error('[restore-gate] refresh step threw', err);
          this.active.delete(entry.id);
        }
      }
    } finally {
      this.pumping = false;
    }
    for (const entry of this.waiting) {
      if (entry.waited) continue;
      entry.waited = true;
      if (this.burst) continue;
      this.burst = { since: this.now(), queued: 0 };
      const n = this.active.size;
      console.log(
        `[restore-gate] ${n} channel-state refresh step${n === 1 ? '' : 's'} in flight after re-attach; ` +
          `the rest take turns (LURKER_RESTORE_CONCURRENCY=${this.limit()})`,
      );
    }
    this.noteIdle();
  }

  private noteIdle(): void {
    if (!this.burst || this.waiting.length > 0 || this.active.size > 0) return;
    const secs = ((this.now() - this.burst.since) / 1000).toFixed(1);
    const n = this.burst.queued;
    console.log(
      `[restore-gate] re-attach refreshes drained: ${n} step${n === 1 ? '' : 's'} waited for a turn, ` +
        `${secs}s since the cap was first hit`,
    );
    this.burst = null;
  }
}

// Process-wide singleton used by IrcConnection. Tests construct their own
// instances with injected config rather than poking this one.
const restoreGate = new RestoreGate();
export default restoreGate;
