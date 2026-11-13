// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// The outbound queue of one IRC connection (#1149). Every line Lurker writes
// to the server goes through here, in order, and waits when the server would
// otherwise stop reading us.
//
// What a server charges: ircu and IRCnet's ircd advance a per-client clock by
// a couple of seconds plus a second per hundred-odd bytes for every line, read
// the client while that clock is less than ten seconds ahead of real time, and
// kill it ("Excess Flood") once what it sent meanwhile overflows a small input
// buffer. Lurker keeps the same clock (`since`): a line costs 2 s + 1 s per
// 100 bytes (irssi's constants, the pessimistic side of ircu's len/120, so an
// estimate that drifts drifts safe), goes at once while its charge still fits
// under 10 s, and waits for the charge to decay otherwise. HexChat paces every
// line the same way (server.c, tcp_send_queue); irssi sends five at once and
// then one per 2.2 s, WeeChat one per 2 s. Five short lines go at once, then
// one every 2 s; a REKEY burst or a long paste is spread out instead of killed.
//
// Not paced: anything written before registration (the registration burst,
// which an engine re-attach's transport swallows and a server gives grace),
// uncharged; PING, PONG and QUIT, which waiting would only make wrong,
// charged since the server charges them; and an item sent `unpaced`, which
// is not made to wait on the clock for itself — it goes when its turn in its
// lane comes, still behind whatever waits ahead of it in the lanes. That is the
// re-attach's channel walk (NAMES/TOPIC/MODE per channel, and the WHO each
// NAMES reply draws): the server's own replies pace it already, one channel
// at a time, the next not asked until the last is answered (#840) — and a
// server that has stopped processing us answers nothing, so the walk stops
// with it. Making those lines wait here as well stacked one throttle on the
// other: each step waited 6 s for a clock the replies had already proven
// wrong, and held its turn at the process-wide cap (#842) the whole time, so
// a 42-connection cell took 221 s to learn its topics and member lists again.
// Charged, though, since the server charges them, but never counted past the
// budget: a line the server has answered is a line it has processed, and it
// processes only while its clock is under the budget — so what the user types
// behind the walk waits the one budget, not the walk's whole length, and goes
// into a server that can take it.
//
// An item is a line, a thunk that makes its line(s) when its turn comes (a
// REKEY to a nick resolved at send time, an E2E message encrypted at send
// time), or a unit of lines that go back to back (a draft/multiline batch). A
// thunk may make further thunks, each run at its own turn. Every item can say
// what to do when it is sent (`onSent`: every timer that waits on a reply
// starts there, not at write), when it goes with its socket (`onDropped`: a
// user line reported as sent is reported again as not sent), and whether it
// is still wanted when its turn comes (`live`: a withdrawn DCC offer sends
// nothing).
//
// A batch is charged as the servers that take one bill it (#1318), since the
// per-line price is ircu's and ircu has no draft/multiline. UnrealIRCd bills
// each line by length as it would outside a batch, but stops at 15 s for the
// batch (multiline.c, calculate_multiline_fakelag), its two BATCH lines a
// second each on top; it reads a client under the same ten seconds and kills
// one whose unread input outgrows its class's recvq, so its bill is the one
// not to fall short of. Ergo suspends its fakelag for the batch and bills
// max(bytes/512 + 1, lines*60/512) messages when it ends (client.go,
// EndMultilineBatch), and only sleeps. So a batch costs its lines' own price,
// no more than UnrealIRCd's 17 s, and no less than Ergo's bill at a short line
// a message (which passes 17 s only for a great many short lines). Priced by
// the line alone, a paste of four 460-byte lines was 28 s and held everything
// typed after it for 20; it holds it 9 now. WeeChat sends a batch past its
// anti-flood queue altogether; Halloy rate-limits each line of one.
//
// Three lanes, and order is absolute within each: `high` goes before `normal`
// before `low` whenever a line waits at all. What the user wrote goes in the
// order they wrote it (`normal`, the default: chat, CTCP, DCC, their own
// commands, and every E2E line, since a REKEY is a NOTICE and the message
// that needs it a PRIVMSG, and the one must reach the wire before the other).
// What chat may not overtake goes first (`high`: the connect commands, the
// autojoin, a nick change), so a message typed into a channel never overtakes
// the JOIN that puts us there, nor the IDENTIFY before it. Lurker's own
// questions and bookkeeping go last (`low`: the MODE and WHO after a join, the
// restore walk's NAMES/TOPIC/MODE, MONITOR, AWAY), so a paste or a reply isn't
// stuck behind a minute of refreshing names, nor behind the presence list a
// re-attach rebuilds. Only what must precede chat is `high`: eight MONITOR and
// AWAY lines there held a re-attach's chat 16 s.
// HexChat sends WHO and MODE queries after everything else and PRIVMSG/NOTICE
// after the rest; WeeChat and irssi send their polls (ISON, channel sync)
// last; Halloy sends what the user typed first. With nothing waiting, which
// is the usual state, the lanes never show.

import { IRC_LINE_BYTES } from '../../shared/wireBudget.js';

const BASE_COST_MS = 2000;
const COST_PER_100_BYTES_MS = 1000;
/** How far ahead of real time the server's clock may run before a line waits. */
export const BURST_BUDGET_MS = 10_000;
/** The most keyed items (handshake replies) allowed to wait at once. */
const DEFAULT_MAX_KEYED = 20;
/** Past the lanes altogether, and charged in full: see the header. */
const IMMEDIATE = /^(?:@\S+ )?(?:PING|PONG|QUIT)\b/i;
/** How long the queue stays empty before it is reported empty: the connect
 *  walk and a restore send one line at a time, each waiting its 2 s alone, and
 *  "1 waiting" blinking once per line reads as a fault. A rise is reported at
 *  once. */
export const EMPTY_HOLD_MS = 2000;

/** Which lane an item waits in; see the header. */
export type SendPriority = 'high' | 'normal' | 'low';
const LANES: readonly SendPriority[] = ['high', 'normal', 'low'];

/** What one line of `bytes` (CRLF included) advances the server's clock by.
 *  `LURKER_SEND_PACING=0` makes every line free: a test seam, for tests that
 *  send many lines through a real connection and would otherwise wait them
 *  out. */
export function lineCostMs(bytes: number): number {
  if (process.env.LURKER_SEND_PACING === '0') return 0;
  return BASE_COST_MS + Math.floor(bytes / 100) * COST_PER_100_BYTES_MS;
}

function costOf(line: string): number {
  return lineCostMs(Buffer.byteLength(line) + 2);
}

/** The most UnrealIRCd bills a batch: its 15 s cap, and a second for each of
 *  the two BATCH lines. */
const BATCH_COST_CAP_MS = 17_000;
/** What Ergo reckons a line of a batch at, of the line length it bills a
 *  message per. */
const BATCH_BILL_LINE_BYTES = 60;

/** What a draft/multiline batch (`lines`, its BATCH lines included) advances
 *  the server's clock by: see the header. Free where a line is
 *  (`LURKER_SEND_PACING=0`). */
export function batchCostMs(lines: readonly string[]): number {
  let bytes = 0;
  let byLine = 0;
  for (const line of lines) {
    bytes += Buffer.byteLength(line) + 2;
    byLine += costOf(line);
  }
  const bill = Math.max(
    Math.floor(bytes / IRC_LINE_BYTES) + 1,
    Math.floor((lines.length * BATCH_BILL_LINE_BYTES) / IRC_LINE_BYTES),
  );
  // The opening BATCH, which Ergo bills as the line it is, and its bill.
  const ergo = (1 + bill) * lineCostMs(0);
  return Math.max(Math.min(byLine, BATCH_COST_CAP_MS), ergo);
}

/** One line to send, with what to do once it has gone, or if it never does.
 *  `text` may be made when the line goes (a REKEY to the nick its peer has
 *  then); null then sends nothing. */
export interface Line {
  text: string | (() => string | null);
  onSent?: (at: number) => void;
  onDropped?: (why?: string) => void;
}

/** What a thunk makes when its turn comes: lines, further thunks, or nothing. */
export type Built = string | Line | (() => Built) | Array<string | Line | (() => Built)> | null;

export interface WriteOptions {
  /** The lane the item waits in; `normal` unless said. */
  priority?: SendPriority;
  /** A keyed item replaces a queued item with the same key where it stands,
   *  and at most `maxKeyed` keyed items wait: a handshake reply to a peer. */
  key?: string;
  /** Asked when the line's turn comes; false sends nothing. */
  live?: () => boolean;
  /** Called right after the item's last line hits the socket. */
  onSent?: (at: number) => void;
  /** Called when the item is dropped with its socket, or over the keyed cap,
   *  or taken back by withdraw(), which says why. */
  onDropped?: (why?: string) => void;
  /** The conversation a message of the user's is for. Only an item that
   *  names one can be taken back (withdraw): Lurker's own lines never are. */
  target?: string;
  /** Not made to wait on the clock for itself (still behind what waits ahead
   *  of it in the lanes); charged, but never counted past the budget: a line
   *  the server's replies pace already (the header's third exception). Not
   *  the PING/PONG/QUIT bypass, which skips the lanes and is charged in full. */
  unpaced?: boolean;
}

export interface SendHandle {
  /** Take the item, and whatever it expanded to, out before it goes. True if
   *  any of it was still waiting. */
  cancel(): boolean;
}

export interface SendPacerOptions {
  /** Write one line to the socket now. `false` means the socket would not
   *  take it (a QUIT is on its way out): the item is told dropped, not sent,
   *  and nothing is charged for it. Anything else means it went. */
  send: (line: string) => boolean | void;
  /** Whether the connection is registered and can take a line. */
  ready: () => boolean;
  /** Whether the next line must keep waiting although the connection is
   *  ready: a NICK during an engine restore, whose transport would swallow it
   *  as registration. Asked with the line (undefined for a thunk, which is
   *  never one) on every drain, not only on resume(), since any write drains;
   *  what waits behind it waits too. */
  holding?: (line: string | undefined) => boolean;
  /** How many items wait, whenever that changes (coalesced per tick; an
   *  empty queue is reported once it has stayed empty EMPTY_HOLD_MS). */
  onDepth?: (waiting: number) => void;
  /** Whether this connection is paced at all (#1193). Asked for every line
   *  as its turn comes, so a flip applies to what already waits: off, a line
   *  costs nothing and goes at once, in the same order. A network whose
   *  server exempts the user (an oper, a bouncer that paces upstream itself)
   *  turns it off. Absent means paced. */
  paced?: () => boolean;
  /** Monotonic ms; injectable for tests. */
  now?: () => number;
  maxKeyed?: number;
}

interface Entry {
  priority: SendPriority;
  /** Arrival order, across lanes: the keyed cap drops the oldest. */
  seq?: number;
  text?: string;
  build?: () => Built;
  unit?: string[];
  key?: string;
  live?: () => boolean;
  onSent?: (at: number) => void;
  onDropped?: (why?: string) => void;
  target?: string;
  /** A line of this item, or of what it expanded to, has gone (withdraw). */
  began?: boolean;
  /** The item this one expanded from, for cancel(). */
  origin?: Entry;
  unpaced?: boolean;
}

// A line whose text is made when it goes, as a thunk making that line.
function lazyLine(line: Line): () => Built {
  const make = line.text as () => string | null;
  return () => {
    const text = make();
    return text === null ? null : { text, onSent: line.onSent };
  };
}

export class SendPacer {
  private readonly lanes: Record<SendPriority, Entry[]> = { high: [], normal: [], low: [] };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private draining = false;
  private disposed = false;
  /** The server's clock for us, as far as we can tell: it reads us while this
   *  is less than BURST_BUDGET_MS ahead of now(). */
  private since = 0;
  private reportedDepth = 0;
  private depthReport: ReturnType<typeof setImmediate> | null = null;
  private emptyHold: ReturnType<typeof setTimeout> | null = null;
  /** Set by drop(): the next empty report goes without the hold. */
  private emptyAtOnce = false;
  private seq = 0;
  /** Items told dropped by a refusal since the last drop() — see `refuse`. */
  private toldAtRefusal = new Set<Entry>();
  private readonly now: () => number;
  private readonly maxKeyed: number;

  constructor(private readonly opts: SendPacerOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.maxKeyed = opts.maxKeyed ?? DEFAULT_MAX_KEYED;
  }

  /**
   * Send `item` now, or queue it behind what is waiting. A string is the line;
   * a function makes the line(s) when the item's turn comes, and may return
   * `null` to send nothing after all.
   */
  write(item: string | (() => Built), opts: WriteOptions = {}): SendHandle {
    if (this.disposed) {
      if (opts.onDropped) this.guarded('an onDropped hook', opts.onDropped);
      return { cancel: () => false };
    }
    const entry: Entry = {
      priority: opts.priority ?? 'normal',
      seq: this.seq++,
      ...(typeof item === 'string' ? { text: item } : { build: item }),
      key: opts.key,
      live: opts.live,
      onSent: opts.onSent,
      onDropped: opts.onDropped,
      unpaced: opts.unpaced,
      target: opts.target,
    };
    // Before registration, straight out and uncharged. The held lines, if any,
    // were written to a registered connection and wait for it to come back;
    // this is the registration burst, which must reach the transport now (an
    // engine re-attach swallows it), or a line the framework drops for want
    // of a socket, as it did before there was a queue.
    if (!this.opts.ready()) {
      this.sendAtOnce(entry);
      return { cancel: () => false };
    }
    // PING, PONG and QUIT too, since waiting would only make them late; the
    // server charges them, so they are charged.
    if (entry.text !== undefined && IMMEDIATE.test(entry.text)) {
      this.sendNow(entry, true);
      return { cancel: () => false };
    }
    if (entry.key !== undefined) {
      for (const lane of LANES) {
        const at = this.lanes[lane].findIndex((q) => q.key === entry.key);
        if (at === -1) continue;
        // Where its predecessor stood, as old as it was.
        entry.priority = lane;
        entry.seq = this.lanes[lane][at].seq;
        this.lanes[lane][at] = entry;
        return this.handle(entry);
      }
      // The oldest keyed item goes to make room. Its onDropped may write
      // again, so the room is checked again, until there is some.
      let keyed = this.keyed();
      while (keyed.length >= this.maxKeyed && !this.disposed) {
        this.remove(keyed[0], true);
        keyed = this.keyed();
      }
      if (this.disposed) {
        if (opts.onDropped) this.guarded('an onDropped hook', opts.onDropped);
        return { cancel: () => false };
      }
    }
    this.lanes[entry.priority].push(entry);
    this.noteDepth();
    this.redrain();
    return this.handle(entry);
  }

  /** Send `lines` back to back, as one unit, and charge for it after. A unit
   *  is a draft/multiline batch and is charged as one (batchCostMs): lines
   *  that are not a batch are written one by one. */
  unit(
    lines: string[],
    opts: Pick<WriteOptions, 'priority' | 'onSent' | 'onDropped' | 'target'> = {},
  ): SendHandle {
    if (this.disposed || lines.length === 0) {
      if (opts.onDropped) this.guarded('an onDropped hook', opts.onDropped);
      return { cancel: () => false };
    }
    const entry: Entry = {
      priority: opts.priority ?? 'normal',
      unit: lines,
      onSent: opts.onSent,
      onDropped: opts.onDropped,
      target: opts.target,
    };
    if (!this.opts.ready()) {
      this.sendAtOnce(entry);
      return { cancel: () => false };
    }
    this.lanes[entry.priority].push(entry);
    this.noteDepth();
    this.redrain();
    return this.handle(entry);
  }

  // A new item may be the head now (a higher lane), and a wait scheduled for
  // the old head (a long MONITOR line: 6 s) is not its wait: pick again.
  /** Reconsider a scheduled wait now rather than when its timer fires: a new
   *  item may belong ahead of the slow head it was scheduled for, or the
   *  pacing rule changed (`paced` flipped). */
  redrain(): void {
    if (!this.draining) this.clearTimer();
    this.drain();
  }

  /** Items waiting. */
  get pending(): number {
    return this.lanes.high.length + this.lanes.normal.length + this.lanes.low.length;
  }

  // The next item to go: the first of the first lane with any.
  private head(): Entry | undefined {
    for (const lane of LANES) {
      if (this.lanes[lane].length) return this.lanes[lane][0];
    }
    return undefined;
  }

  // The keyed items waiting, oldest first.
  private keyed(): Entry[] {
    return LANES.flatMap((lane) => this.lanes[lane].filter((q) => q.key !== undefined)).sort(
      (a, b) => a.seq! - b.seq!,
    );
  }

  /** Try again: the connection came (back) up. */
  resume(): void {
    this.drain();
  }

  /** A new socket: what waited was meant for the old one, and the server
   *  charges the new one from nothing. Every dropped item is told. */
  drop(): void {
    const dropped = LANES.flatMap((lane) => this.lanes[lane].splice(0));
    this.since = 0;
    this.clearTimer();
    this.emptyAtOnce = true;
    this.noteDepth();
    // Seeded with what a refusal already told (see `refuse`), then forgotten:
    // the next socket's items are new.
    const told = this.toldAtRefusal;
    this.toldAtRefusal = new Set();
    for (const entry of dropped) this.tellDropped(entry, told);
  }

  /** The connection is gone for good. Set before the items are told, so a
   *  write from an onDropped is dropped too, not sent. The depth is reported
   *  empty here and now, if it was not: there is no later tick for it, and a
   *  status bar left at "12 waiting" through a reconnect would stay there. */
  dispose(): void {
    this.disposed = true;
    this.drop();
    if (this.depthReport) clearImmediate(this.depthReport);
    this.depthReport = null;
    if (this.emptyHold) clearTimeout(this.emptyHold);
    this.emptyHold = null;
    if (this.reportedDepth !== 0 && this.opts.onDepth) {
      this.reportedDepth = 0;
      this.guarded('the depth report', () => this.opts.onDepth!(0));
    }
  }

  /**
   * Take back the user's messages still waiting for a conversation `match`
   * accepts (#1322): the queue cleared by hand, or a channel we are no longer
   * in. Each is told dropped, with `why`. Only items written with a `target`,
   * and only whole: a message that has begun (a line of it has gone) is left
   * to finish, since part of it is on the wire and "not sent" would not be
   * true of it. One that was made into its lines and still waits whole is
   * taken, lines and all. Nor one a refusal has told already: the close's
   * drop() has the rest of it. Returns how many messages were taken.
   */
  withdraw(match: (target: string) => boolean, why: string): number {
    const roots = new Set<Entry>();
    const taken: Entry[] = [];
    for (const lane of LANES) {
      const queue = this.lanes[lane];
      for (let i = 0; i < queue.length;) {
        const root = this.rootOf(queue[i]);
        if (
          !root.began &&
          !this.toldAtRefusal.has(root) &&
          root.target !== undefined &&
          match(root.target)
        ) {
          roots.add(root);
          taken.push(...queue.splice(i, 1));
        } else i++;
      }
    }
    if (taken.length === 0) return 0;
    // Gone, not sent: an emptied queue is reported empty now, as drop()'s is.
    this.emptyAtOnce = true;
    this.noteDepth();
    const told = new Set<Entry>();
    for (const q of taken) this.tellDropped(q, told, why);
    // The head may be another item now, with another wait.
    this.redrain();
    return roots.size;
  }

  private handle(entry: Entry): SendHandle {
    return { cancel: () => this.remove(entry, false) };
  }

  // The item and everything it expanded to.
  private remove(entry: Entry, dropped: boolean): boolean {
    const taken: Entry[] = [];
    for (const lane of LANES) {
      const queue = this.lanes[lane];
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (q === entry || this.rootOf(q) === entry) taken.unshift(...queue.splice(i, 1));
      }
    }
    if (taken.length === 0) return false;
    this.noteDepth();
    if (dropped) {
      const told = new Set<Entry>();
      for (const q of taken) this.tellDropped(q, told);
    }
    return true;
  }

  private rootOf(entry: Entry): Entry {
    let root = entry;
    while (root.origin) root = root.origin;
    return root;
  }

  // A line's own onDropped, and the item it came from's, once each. Guarded:
  // one hook that throws (a DB write) must not leave the rest untold.
  private tellDropped(entry: Entry, told: Set<Entry>, why?: string): void {
    if (!told.has(entry)) {
      told.add(entry);
      if (entry.onDropped) this.guarded('an onDropped hook', () => entry.onDropped!(why));
    }
    for (let o = entry.origin; o; o = o.origin) {
      if (told.has(o)) continue;
      told.add(o);
      const hook = o.onDropped;
      if (hook) this.guarded('an onDropped hook', () => hook(why));
    }
  }

  private drain(): void {
    if (this.timer || this.draining) return;
    this.draining = true;
    try {
      for (let head = this.head(); head; head = this.head()) {
        // Held until the connection is back; resume() picks it up.
        if (!this.opts.ready()) return;
        if (this.opts.holding?.(head.text ?? head.unit?.[0])) return;
        // The line goes when its own charge still fits under the budget: the
        // server's clock never runs more than BURST_BUDGET_MS ahead of real
        // time by our count. A thunk is run once the shortest line would fit,
        // so what it builds is as fresh as it can be; a unit is admitted on
        // its first line and goes whole. Unpaced, nothing waits: not even for
        // what a unit charged past the budget before the switch was flipped.
        if (this.paced() && !head.unpaced) {
          const ahead = this.since - this.now();
          const cost = head.build ? BASE_COST_MS : costOf(head.unit ? head.unit[0] : head.text!);
          const over = ahead + cost - BURST_BUDGET_MS;
          if (over > 0) {
            this.schedule(over);
            return;
          }
        }
        this.lanes[head.priority].shift();
        // Not wanted any more: nothing goes, and a thunk isn't even built.
        if (head.live && !this.wanted(head)) {
          this.noteDepth();
          continue;
        }
        if (head.build) {
          this.expand(head);
          continue;
        }
        this.noteDepth();
        // A refusal means the socket is on its way out: the refused item has
        // been told, and what still waits is left for drop() at the close,
        // which tells each item once. Pressing on would refuse them one by
        // one here, and tell a thunk's origin once per line.
        const went = head.unit ? this.sendUnit(head) : this.sendNow(head, true);
        if (!went) return;
      }
    } finally {
      this.draining = false;
    }
  }

  // A thunk's items take its place at the head of its lane, each paced on its
  // item's own onSent follows its last line; its onDropped fires once if any
  // of them is dropped (tellDropped); cancel() takes them all (remove).
  private expand(entry: Entry): void {
    let built: Built;
    try {
      built = entry.build!();
    } catch (err) {
      // Told as dropped: the sender hears "not sent" rather than nothing, and
      // a router query doesn't sit on the wire unsent for good.
      console.warn('[irc] send: an item failed to build and was dropped:', err);
      this.noteDepth();
      this.tellDropped(entry, new Set());
      return;
    }
    const items = built === null ? [] : Array.isArray(built) ? built : [built];
    if (items.length === 0) {
      this.noteDepth();
      return;
    }
    const last = items.length - 1;
    const expanded: Entry[] = items.map((item, i) => {
      const own = this.entryFor(item, entry);
      // Asked again at each line's own turn.
      own.live = entry.live;
      own.unpaced = entry.unpaced;
      if (i === last && entry.onSent) {
        const sent = own.onSent;
        own.onSent = (at) => {
          sent?.(at);
          entry.onSent!(at);
        };
      }
      return own;
    });
    this.lanes[entry.priority].unshift(...expanded);
    this.noteDepth();
  }

  // Past the queue, uncharged: a line written before registration. True if
  // everything went; false once the socket refused a line (the item has been
  // told dropped) or a thunk failed to build.
  private sendAtOnce(entry: Entry): boolean {
    if (entry.unit) {
      for (const line of entry.unit) if (!this.push(line)) return this.refuse(entry);
      if (entry.onSent) this.guarded('an onSent hook', () => entry.onSent!(this.now()));
      return true;
    }
    if (!entry.build) return this.sendNow(entry, false);
    let built: Built;
    try {
      built = entry.build();
    } catch (err) {
      console.warn('[irc] send: an item failed to build and was dropped:', err);
      return this.refuse(entry);
    }
    const items = built === null ? [] : Array.isArray(built) ? built : [built];
    // Each line is the item's (`origin`), so a refusal tells the item once,
    // through sendNow, and the item's own onSent follows only if all of it went.
    for (const item of items) {
      const own = this.entryFor(item, entry);
      const went = own.build ? this.sendAtOnce(own) : this.sendNow(own, false);
      if (!went) return false;
    }
    if (items.length && entry.onSent)
      this.guarded('an onSent hook', () => entry.onSent!(this.now()));
    return true;
  }

  // One item of what a thunk built, as the entry that goes in its place: the
  // thunk is its `origin`, so a drop tells the thunk too. One mapping for the
  // queued path (expand) and the pre-registration one (sendAtOnce), so a field
  // a Line carries reaches both.
  private entryFor(item: string | Line | (() => Built), origin: Entry): Entry {
    const priority = origin.priority;
    if (typeof item === 'function') return { priority, build: item, origin };
    if (typeof item === 'string') return { priority, text: item, origin };
    if (typeof item.text === 'function')
      return { priority, build: lazyLine(item), onDropped: item.onDropped, origin };
    return { priority, text: item.text, onSent: item.onSent, onDropped: item.onDropped, origin };
  }

  // The socket refused `entry`'s line, or it failed to build: told dropped,
  // once. ⚠ What was told here is remembered until the next drop(): a refusal
  // stops the drain with the item's siblings still queued, and the close's
  // drop() walks each of them to the same origin — which must not hear it
  // again. Always false, so a caller can `return this.refuse(entry)`.
  private refuse(entry: Entry): false {
    this.tellDropped(entry, this.toldAtRefusal);
    return false;
  }

  // One line to the socket. False when the socket refused it (see
  // SendPacerOptions.send); a `send` that throws is warned about and counts as
  // gone, as it always has — the hook contract is about the socket's answer.
  private push(line: string): boolean {
    let went = true;
    this.guarded('send', () => {
      went = this.opts.send(line) !== false;
    });
    return went;
  }

  // True if the line went; false if the socket refused it, in which case the
  // entry (and what it expanded from) has been told dropped and nothing charged.
  private sendNow(entry: Entry, charge: boolean): boolean {
    const text = entry.text!;
    if (!this.push(text)) return this.refuse(entry);
    const at = this.now();
    this.rootOf(entry).began = true;
    if (charge) this.charge(this.costOf(text), at, entry.unpaced === true);
    if (entry.onSent) this.guarded('an onSent hook', () => entry.onSent!(at));
    return true;
  }

  private sendUnit(entry: Entry): boolean {
    let cost = 0;
    for (const line of entry.unit!) {
      // What went before the refusal is charged, by the line: the server
      // read it, and bills as a batch only one that was closed.
      if (!this.push(line)) {
        if (cost) this.charge(cost, this.now());
        return this.refuse(entry);
      }
      cost += this.costOf(line);
    }
    const at = this.now();
    this.charge(this.paced() ? batchCostMs(entry.unit!) : 0, at);
    if (entry.onSent) this.guarded('an onSent hook', () => entry.onSent!(at));
    return true;
  }

  private wanted(entry: Entry): boolean {
    try {
      return entry.live!();
    } catch (err) {
      console.warn('[irc] send: a live() check threw; the item was skipped:', err);
      return false;
    }
  }

  // A drain runs from a timer with no caller to catch for it: a hook that
  // throws (a DB write) must not take the queue, or the process, with it.
  private guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.warn(`[irc] send: ${what} threw:`, err);
    }
  }

  // Paced unless the connection says otherwise.
  private paced(): boolean {
    return this.opts.paced ? this.opts.paced() : true;
  }

  // What a line is charged: nothing while unpaced. What was charged before a
  // flip stands and decays as it would have: the server may have counted it,
  // and an estimate that drifts drifts safe.
  private costOf(line: string): number {
    return this.paced() ? costOf(line) : 0;
  }

  // `capped`: an unpaced line's charge counts only up to the budget (the
  // header's third exception) — and never lowers what a unit already charged
  // past it.
  private charge(cost: number, at: number, capped = false): void {
    const charged = Math.max(this.since, at) + cost;
    this.since = capped ? Math.min(charged, Math.max(this.since, at + BURST_BUDGET_MS)) : charged;
  }

  private schedule(wait: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drain();
    }, wait);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // Depth changes with every line; report once per tick, and only a change.
  // Empty is reported once it has held EMPTY_HOLD_MS (a rise in between is
  // reported instead), except that drop() reports it at once: what waited is
  // gone, not sent.
  private noteDepth(): void {
    if (!this.opts.onDepth || this.depthReport) return;
    this.depthReport = setImmediate(() => {
      this.depthReport = null;
      const depth = this.pending;
      const atOnce = this.emptyAtOnce;
      this.emptyAtOnce = false;
      if ((depth > 0 || atOnce) && this.emptyHold) {
        clearTimeout(this.emptyHold);
        this.emptyHold = null;
      }
      if (depth === this.reportedDepth) return;
      if (depth === 0 && !atOnce) {
        this.emptyHold ??= setTimeout(() => {
          this.emptyHold = null;
          if (this.pending > 0 || this.reportedDepth === 0) return;
          this.reportedDepth = 0;
          this.opts.onDepth?.(0);
        }, EMPTY_HOLD_MS);
        return;
      }
      this.reportedDepth = depth;
      this.opts.onDepth?.(depth);
    });
  }
}
