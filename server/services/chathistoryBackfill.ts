// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Filling a gap from the network's history (IRCv3 draft/chathistory, #1283).
//
// A gap is what a buffer missed while Lurker was off the network: a restart
// without the engine, a crash, a drop long enough for lines to go by. A network
// that keeps history (ergo, soju, a Lurker bouncer) has those lines, and this
// asks for exactly them: `CHATHISTORY BETWEEN <target>` from the newest line
// the buffer holds to the moment we were back in the channel. Both bounds are
// what let a request END: everything after the rejoin arrives live, and asking
// AFTER the anchor with no upper bound would walk through all of it (gamja
// does; goguma bounds it, and this is goguma's shape).
//
// Channels are asked for one by one at our own JOIN, once the NAMES is in
// (ergo writes its own join-time replay before it reads anything after the
// JOIN, so by then any unsolicited batch has gone by). DMs come from one
// `CHATHISTORY TARGETS` per registration: which conversations had a line in
// the gap, each then asked for the same way. A buffer with nothing stored is
// not asked about: there is no gap to fill, and a first join is not an outage
// (halloy asks LATEST there and gets a page of strangers' history).
//
// The anchors — the newest line each buffer held — are read by the connection
// BEFORE the socket can deliver anything new (at the JOIN itself, at
// registration) and handed in, never read when the reply comes: a live line
// that lands meanwhile would move the anchor past the whole outage.
//
// One request on the wire at a time, in the send queue's low lane, so the
// walk paces itself behind chat; the reply router owns the request (its batch
// is the reply, replyRouter.ts), so a bouncer client attached through Lurker
// never sees the lines twice. A page is followed by the next while pages come
// back full: the server's `draft/chathistory-end`, a short page, or a cursor
// that cannot move ends a walk. No cap of Lurker's own on how far back: the
// gap is the gap, and the retention sweeper keeps the newest lines of what
// is stored, which is the right end to keep.
//
// The lines themselves come back inside `chathistory` batches and are stored
// by the ordinary message path with `replay` set: deduped against what the
// buffer already holds (ircConnection.alreadyPersisted), kept at their
// original time, counted as unread, never pushed (wsHub.decorateMessage).
//
// This class holds the walk; it never touches a socket or a row. The
// connection feeds it what the server says and sends what it asks.

import type { QueryEnd } from './replyRouter.js';
import { isChannelTarget } from '../../shared/channels.js';

/** What the walk needs from its connection. */
export interface BackfillHost {
  /** Put a CHATHISTORY line on the wire as Lurker's own query; `onEnd` is the
   *  reply router's verdict once its batch has closed (or never came). */
  send(line: string, onEnd: (how: QueryEnd) => void): void;
  /** The network's per-request cap: the ISUPPORT `CHATHISTORY` token, or 0
   *  when it names no limit. */
  limit(): number;
  /** The network's case fold (foldTargetFor), for the target a batch names. */
  fold(name: string): string;
  log(text: string, level?: 'info' | 'warn'): void;
}

/** The newest conversation line each buffer holds, by folded target. */
export type Anchors = ReadonlyMap<string, string>;

// What soju serves at most, advertises, and refuses more than (downstream.go:
// INVALID_PARAMS over the token). Lurker's own bouncer says the same. ergo's
// default is 1000 too; a smaller token is honoured.
export const BACKFILL_LIMIT_CAP = 1000;
// Both bounds of a window are exclusive on every server (soju's are strict
// `>`/`<`, ergo's and Lurker's the same), and a line's stored time can be a
// millisecond off the server's copy. A second each way; the dedupe pays for
// the overlap, a lost line would not be paid for by anything.
export const BOUND_FUZZ_MS = 1000;
// How many answered batches are remembered as ours (isOurs).
const ASKED_REMEMBERED = 1000;
// Requests in a row that drew nothing, not even a FAIL, before the network is
// taken not to honour the cap it offered. One is a lagging server; the walk
// it was for is dropped, the next goes.
const UNANSWERED_STRIKES = 2;

type Between = {
  kind: 'between';
  target: string;
  from: string;
  to: string;
  fetched: number;
  pages: number;
};
// `origin`: the window's lower bound as first asked, for a conversation named
// on a later page (the cursor has moved by then). `anchors`: where each
// conversation's own window starts, read before the socket could add to it.
// `seen`: conversations already given a window — a page's newest target is
// named again by the next page, whose cursor sits a millisecond under it.
type Targets = {
  kind: 'targets';
  from: string;
  origin: string;
  to: string;
  pages: number;
  anchors: Anchors;
  seen: Set<string>;
};
type Walk = Between | Targets;

interface Active {
  walk: Walk;
  /** The reply batch's reference once its BATCH + has come. */
  ref: string | null;
  /** Lines in the page so far (what the server counts toward its limit),
   *  how many of them are conversation (for the log), and the newest time
   *  among them. */
  lines: number;
  messages: number;
  newest: string | null;
  /** The server said this page is the last (`draft/chathistory-end`). */
  last: boolean;
  /** TARGETS: each target named, with its newest line's time. */
  found: Map<string, string>;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function shifted(time: string, ms: number): string {
  const t = Date.parse(time);
  return Number.isFinite(t) ? iso(t + ms) : time;
}

function newestOf(anchors: Anchors): string | null {
  let newest: string | null = null;
  for (const time of anchors.values()) if (newest === null || time > newest) newest = time;
  return newest;
}

export class ChathistoryBackfill {
  private queue: Walk[] = [];
  private active: Active | null = null;
  // The references of the batches that answered us on this socket. A batch's
  // lines reach their handlers only when it ends, by which time the router
  // has closed the request, so "did we ask for this?" is answered here, not
  // by what is on the wire. Bounded: a socket that lives for weeks asks for
  // thousands of pages, and the question is only ever asked about the last.
  private asked = new Set<string>();
  // False once requests went unanswered: the network offered the cap and
  // honours none of it (a bouncer whose store is off answers nothing at all).
  // Back to true with the next socket.
  private available = true;
  private unanswered = 0;

  constructor(private readonly host: BackfillHost) {}

  /** The socket is gone, and every walk with it. */
  reset(): void {
    this.queue = [];
    this.active = null;
    this.asked.clear();
    this.available = true;
    this.unanswered = 0;
  }

  /**
   * Our link to the engine dropped; the socket lives on there. The request
   * on the wire died with the router's reset, so its page is asked again
   * when the link is back (resume); the rest of the queue waits. A page that
   * was arriving comes back too, from the engine (#1286), and what the two
   * share is stored once (ircConnection.alreadyPersisted).
   */
  suspend(): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.queue.unshift(active.walk);
  }

  /** The link is back: whatever waited goes on. */
  resume(): void {
    this.next();
  }

  /** Whether `ref` is a batch that answered one of our requests. */
  isOurs(ref: string | undefined): boolean {
    return !!ref && this.asked.has(ref);
  }

  // --- triggers --------------------------------------------------------------

  /** We are back in a channel (our JOIN, its NAMES in) as of `joinedAtMs`;
   *  `anchor` is the newest line the buffer held when the JOIN arrived. */
  channelJoined(target: string, joinedAtMs: number, anchor: string | null): void {
    this.window(target, anchor, joinedAtMs);
  }

  /** Registered, with the newest line every buffer held at that moment:
   *  which conversations had a line since the newest of them. */
  registered(nowMs: number, anchors: Anchors): void {
    this.targets(anchors, nowMs);
  }

  /**
   * The engine dropped the oldest lines of the backlog it handed over. The
   * hole sits between the last row stored before this attach (`anchors`,
   * read among the rows up to the attach's maxMessageId) and the first line
   * the backlog kept, which `endMs` is: the window overlaps nothing the
   * backlog stored. Every channel we are in, and the DMs a TARGETS names.
   */
  gap(channels: string[], endMs: number, anchors: Anchors): void {
    for (const target of channels) {
      this.window(target, anchors.get(this.host.fold(target)) ?? null, endMs);
    }
    this.targets(anchors, endMs);
  }

  private window(target: string, anchor: string | null, toMs: number): void {
    if (!anchor) return;
    this.enqueue({
      kind: 'between',
      target,
      from: shifted(anchor, -BOUND_FUZZ_MS),
      to: iso(toMs + BOUND_FUZZ_MS),
      fetched: 0,
      pages: 0,
    });
  }

  private targets(anchors: Anchors, toMs: number): void {
    const newest = newestOf(anchors);
    if (!newest) return;
    const from = shifted(newest, -BOUND_FUZZ_MS);
    this.enqueue({
      kind: 'targets',
      from,
      origin: from,
      to: iso(toMs + BOUND_FUZZ_MS),
      pages: 0,
      anchors,
      seen: new Set(),
    });
  }

  // --- what the server says, fed by the connection's raw listener ------------

  onBatchStart(ref: string, type: string, target: string | undefined, last: boolean): void {
    const active = this.active;
    if (!active || active.ref) return;
    const walk = active.walk;
    const mine =
      walk.kind === 'targets'
        ? type === 'draft/chathistory-targets'
        : type === 'chathistory' &&
          !!target &&
          this.host.fold(target) === this.host.fold(walk.target);
    if (!mine) return;
    active.ref = ref;
    active.last = last;
    this.unanswered = 0;
    if (this.asked.size >= ASKED_REMEMBERED) this.asked.clear();
    this.asked.add(ref);
  }

  /** A line inside our batch, with its `@time` if it has one; `message`
   *  when it is conversation (a PRIVMSG or NOTICE, or a multiline message's
   *  start) rather than a reaction or a TARGETS entry. */
  onBatchLine(ref: string, time: string | undefined, message: boolean): void {
    const active = this.active;
    if (!active || active.ref !== ref) return;
    active.lines++;
    if (message) active.messages++;
    this.noteTime(active, time);
  }

  /** `CHATHISTORY TARGETS <target> <time>` inside our TARGETS batch. The time
   *  is a parameter, not a tag: it is the page's cursor as much as a line's. */
  onTargetsLine(ref: string, target: string, time: string): void {
    const active = this.active;
    if (!active || active.ref !== ref || !target) return;
    active.found.set(target, time);
    this.noteTime(active, time);
  }

  private noteTime(active: Active, time: string | undefined): void {
    if (time && (active.newest === null || time > active.newest)) active.newest = time;
  }

  // --- the walk ----------------------------------------------------------------

  private enqueue(walk: Walk): void {
    if (!this.available) return;
    this.queue.push(walk);
    this.next();
  }

  private next(): void {
    if (this.active || !this.available) return;
    const walk = this.queue.shift();
    if (!walk) return;
    const limit = this.limit();
    const line =
      walk.kind === 'targets'
        ? `CHATHISTORY TARGETS timestamp=${walk.from} timestamp=${walk.to} ${limit}`
        : `CHATHISTORY BETWEEN ${walk.target} timestamp=${walk.from} timestamp=${walk.to} ${limit}`;
    const active: Active = {
      walk,
      ref: null,
      lines: 0,
      messages: 0,
      newest: null,
      last: false,
      found: new Map(),
    };
    this.active = active;
    this.host.send(line, (how) => {
      if (this.active !== active) return;
      this.active = null;
      this.ended(active, how, limit);
      this.next();
    });
  }

  private limit(): number {
    const token = this.host.limit();
    return token > 0 ? Math.min(token, BACKFILL_LIMIT_CAP) : BACKFILL_LIMIT_CAP;
  }

  // Where the next page starts: a millisecond under the newest line of this
  // one, so a second line in that millisecond is not skipped. When that is
  // where this page already started (every line of a full page in the one
  // millisecond), the newest line itself: the rest of that millisecond is
  // given up rather than asked for forever. Null when nothing moves.
  private nextFrom(from: string, newest: string): string | null {
    let next = shifted(newest, -1);
    if (next <= from) next = newest;
    return next > from ? next : null;
  }

  private ended(active: Active, how: QueryEnd, limit: number): void {
    const { walk } = active;
    if (how === 'timeout') {
      if (active.ref) {
        // The batch opened and never closed. Its lines are held by
        // irc-framework until the close that never came, so none of them is
        // stored: the page is not had, and the walk stops here rather than
        // step past it.
        const what = walk.kind === 'targets' ? 'TARGETS' : walk.target;
        this.host.log(`History backfill: ${what}: the page never closed; giving up`, 'warn');
        return;
      }
      // Nothing came, not even a FAIL. Once is a lagging server, and this
      // walk is lost; twice running, the cap is a promise this network
      // doesn't keep, and asking stops (kiwi's chathistory_available).
      if (++this.unanswered < UNANSWERED_STRIKES) return;
      this.available = false;
      this.queue = [];
      this.host.log(
        'History backfill: the network answered no CHATHISTORY; not asking again',
        'warn',
      );
      return;
    }
    if (how === 'error' || how === 'postponed') {
      // The FAIL itself was logged where it was read (the raw listener).
      return;
    }
    if (walk.kind === 'targets') {
      this.endedTargets(active, walk, limit);
      return;
    }
    walk.fetched += active.messages;
    walk.pages++;
    const full = active.lines >= limit;
    const next =
      full && !active.last && active.newest !== null
        ? this.nextFrom(walk.from, active.newest)
        : null;
    if (next === null) {
      if (walk.fetched > 0) {
        this.host.log(
          `History backfill: ${walk.target} caught up ${walk.fetched} line${walk.fetched === 1 ? '' : 's'}` +
            (walk.pages > 1 ? ` in ${walk.pages} pages` : ''),
        );
      }
      return;
    }
    walk.from = next;
    this.queue.unshift(walk);
  }

  private endedTargets(active: Active, walk: Targets, limit: number): void {
    walk.pages++;
    // Every DM named gets its own window: from the newest line we held with
    // them when the walk began, or from the walk's own start for a
    // conversation that began in the gap, to the end of the gap. Channels are
    // the JOIN's business.
    const windows: Between[] = [];
    for (const target of active.found.keys()) {
      if (isChannelTarget(target)) continue;
      const key = this.host.fold(target);
      if (walk.seen.has(key)) continue;
      walk.seen.add(key);
      const anchor = walk.anchors.get(key);
      windows.push({
        kind: 'between',
        target,
        from: anchor ? shifted(anchor, -BOUND_FUZZ_MS) : walk.origin,
        to: walk.to,
        fetched: 0,
        pages: 0,
      });
    }
    this.queue.push(...windows);
    const full = active.lines >= limit;
    const next =
      full && !active.last && active.newest !== null
        ? this.nextFrom(walk.from, active.newest)
        : null;
    if (next !== null) {
      walk.from = next;
      this.queue.unshift(walk);
    }
  }
}
