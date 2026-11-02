// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Who each reply on a network connection is for. Three kinds of asker share the
// connection: Lurker itself (the MODE and WHO it sends when it joins a channel,
// a restore's NAMES, TOPIC and MODE, the AWAY carrying the network's away state),
// the user (the web and iOS apps, MCP, connect commands), and each IRC client
// attached through the bouncer. A server's replies don't say who asked, so each
// one used to reach all of them:
// a client got the answers to Lurker's queries and to other clients', and the
// web app showed a client's WHO as if the user had typed it (#931).
//
// Every query goes out through send(), and noteServerLine() says who each line
// from the server is for. A server answers one connection's commands in order,
// so a reply belongs to the oldest query on the wire it can answer: the one
// naming the same channel or nick, where the reply names one. Replies that name
// nothing to match by (WHO's, LIST's, ISON's, USERHOST's) can't be told apart
// that way, so a query of those kinds waits until the last one is answered, as
// soju queues WHO and LIST (enqueueCommand, upstream.go) and ZNC's route_replies
// holds its requests. LIST has to wait anyway: solanum ignores a second LIST
// while one runs, and UnrealIRCd cancels the first. Everything else goes out at
// once, so a query a server never answers doesn't hold up the ones after it.
//
// ⚠ A query that reaches the network any other way (a bare client.raw) isn't
// tracked, and its replies are taken for another query's.

import { ircLineParser } from 'irc-framework';
import { isChannelTarget } from '../../shared/channels.js';
import { envInt } from '../utils/envInt.js';

/** An IRC client attached through the bouncer, as one of the askers. */
export interface ReplyClient {
  /** Lines the network sent earlier that answer this client's query (a MODE #chan). */
  replyFromCache(lines: string[]): void;
  /** This client's query ended without its reply: its end numeric, before the text. */
  replyAborted(numeric: string, params: string[]): void;
  /**
   * Each server line that is this client's, as it arrives. For an in-process
   * asker (modeList.ts), which has no socket to relay the line to. A bouncer
   * client leaves it out and relays through its own raw listener instead.
   */
  onReply?(command: string, params: string[]): void;
}

/** Who asked: Lurker's own automation, the user, or an attached IRC client. */
export type Asker = 'lurker' | 'user' | ReplyClient;

/**
 * Who a server line is for: an asker; `unasked` for a line that answers no
 * query (a PRIVMSG, the NAMES a JOIN brings); `nobody` for a reply to a query
 * nobody here is waiting on (a previous process's, a detached client's).
 */
export type ReplyOwner = Asker | 'unasked' | 'nobody';

// How a query ended, for its `onEnd`: its reply came whole, the server put it
// off (a 774 for a SYNC), an error ended it, or nothing came in time.
export type QueryEnd = 'replied' | 'postponed' | 'error' | 'timeout';

import type { SendHandle, SendPriority } from './sendPacer.js';

/** A line handed to the connection's queue, which can be taken back before it goes. */
export type Written = SendHandle;

export interface ReplyRouterOptions {
  /**
   * Put a line on the wire: now, or in its turn behind what waits (#1149). A
   * function makes the line when it goes. `onSent` runs once it has gone.
   */
  write(
    line: string | (() => string),
    onSent?: (at: number) => void,
    onDropped?: () => void,
    priority?: SendPriority,
    unpaced?: boolean,
  ): Written | void;
  /** Whether a query can go out now. One that can't ends at once. */
  canSend(): boolean;
  /** The network's case fold, for channel names and nicks. */
  fold(name: string): string;
  isJoined(channel: string): boolean;
  ownNick(): string;
  /** The network's list modes (CHANMODES A) and prefix modes (PREFIX). */
  listModes(): Set<string>;
  prefixModes(): Set<string>;
  /** For tests; otherwise QUERY_TIMEOUT_MS (LURKER_REPLY_TIMEOUT_MS) and SETTLE_MS. */
  timeoutMs?: number;
  settleMs?: number;
}

// A query that hears nothing for this long ends, and a client waiting on it is
// sent its end numeric. Silence, not age: a LIST of every channel on Libera runs
// for minutes, all of it progress. soju gives up on a query after 30 s too.
const QUERY_TIMEOUT_MS = 30_000;
// How long a query that has ended keeps its claim on the line right after it:
// the 329 after a 324, the 318 after a 401. A server writes the pair together,
// so the second line normally arrives with the first; this only bounds the wait
// on a quiet connection.
const SETTLE_MS = 1_000;

// Replies to other commands that name a nick where a WHOIS line does. Any other
// 3xx naming the nick asked about is part of its WHOIS: each ircd adds lines of
// its own (UnrealIRCd's 310, InspIRCd's 343 and 344, solanum's 337), and a list
// of them leaks whatever it misses.
const NOT_WHOIS = new Set([
  '302',
  '303',
  '305',
  '306',
  '314',
  '315',
  '321',
  '322',
  '323',
  '324',
  '329',
  '331',
  '332',
  '333',
  '341',
  '346',
  '347',
  '348',
  '349',
  '352',
  '353',
  '354',
  '366',
  '367',
  '368',
  '369',
]);
// WHOIS lines outside 3xx: certfp, TLS, metadata.
const WHOIS_OTHER_REPLIES = new Set(['276', '671', '760']);

function isWhoisReply(command: string): boolean {
  return (/^3\d\d$/.test(command) && !NOT_WHOIS.has(command)) || WHOIS_OTHER_REPLIES.has(command);
}
// WHOWAS reply lines, each naming the nick.
const WHOWAS_REPLIES = new Set(['312', '314', '330', '338']);
// A list-mode query's entries and its end, by mode letter.
const LIST_MODE_NUMERICS: Record<string, { item: string; end: string } | undefined> = {
  b: { item: '367', end: '368' },
  e: { item: '348', end: '349' },
  I: { item: '346', end: '347' },
  q: { item: '728', end: '729' },
};

/** A list mode's entry and end numerics, or null for a list this router can't track. */
export function listModeNumerics(letter: string): { item: string; end: string } | null {
  return Object.hasOwn(LIST_MODE_NUMERICS, letter) ? (LIST_MODE_NUMERICS[letter] ?? null) : null;
}
// Errors that name the command they refuse, and errors that name its target.
const COMMAND_ERRORS = new Set(['263', '400', '421', '461']);
const TARGET_ERRORS = new Set(['401', '402', '403', '407', '442', '476', '479', '482']);
// Lines that only ever answer a query. With none of their kind on the wire,
// nobody here asked. Every other line can come unasked: the NAMES and topic a
// JOIN brings, a 324 some servers volunteer, a 301 for a PRIVMSG to someone away.
// A WHOIS on the wire takes any 3xx naming its nick, but that can't decide a line
// with no query, since MOTD, 328 and 396 come unasked. So the WHOIS lines some
// ircds add are listed here by number.
const QUERY_ONLY = new Set([
  '276',
  '302',
  '303',
  '305',
  '306',
  '307',
  '310',
  '311',
  '312',
  '313',
  '314',
  '315',
  '317',
  '318',
  '319',
  '320',
  '321',
  '322',
  '323',
  '330',
  '335',
  '337',
  '338',
  '343',
  '344',
  '346',
  '347',
  '348',
  '349',
  '352',
  '354',
  '367',
  '368',
  '369',
  '378',
  '379',
  '406',
  '416',
  '671',
  '728',
  '729',
]);

type Form =
  | 'who'
  | 'whois'
  | 'whowas'
  | 'list'
  | 'names'
  | 'mode'
  | 'modelist'
  | 'umode'
  | 'topic'
  | 'ison'
  | 'userhost'
  | 'away'
  | 'accept'
  // METADATA (draft/metadata-2): SUB/UNSUB answer with a 770/771, SUBS with a
  // `metadata-subs` batch, and GET/LIST/SYNC/CLEAR/SET with a `metadata` batch
  // (a SET's single 761 comes bare on ergo). The batch's own BATCH lines carry
  // the query; a 774 ends a SYNC the server postpones.
  | 'metadata';

// The kinds whose replies name nothing to match them by. One of these waits for
// the last of its kind to be answered. A 221 names nothing either: without its
// turn, a restore's unanswered MODE <nick> would take a client's reply.
const WAITS = new Set<Form>(['who', 'list', 'ison', 'userhost', 'umode', 'accept']);

// The end numeric a server may send right after an error ends a query: 401 then
// 318, 263 then 315. A list-mode query's is by letter.
const END_AFTER_ERROR: Partial<Record<Form, string>> = {
  who: '315',
  whois: '318',
  whowas: '369',
  list: '323',
  names: '366',
};

interface Spec {
  form: Form;
  // The command as the network sees it: what a 461 or a 421 names.
  command: string;
  // Folded names the query's replies and errors carry: the channel, the nicks.
  targets: Set<string>;
  // For WHOIS, the folded names a 318 ends it on: the last nick, or the list.
  ends: Set<string>;
  channel: string;
  letter: string;
  // A NAMES with no channel: every 353 is its.
  anyChannel: boolean;
  // What a client is sent if the query ends without its end numeric.
  abort: { numeric: string; params: string[] } | null;
  // The reference of the batch a metadata query's replies arrive in, once its
  // BATCH + line has come; the matching BATCH - ends the query.
  batchRef: string;
  // A METADATA query's subcommand: what ends it differs by one.
  sub: string;
}

interface Query extends Spec {
  // Null once a client detached.
  asker: Asker | null;
  build: () => string;
  heardAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Whether any of its reply has come. A 301 counts for a WHOIS only after that.
  started: boolean;
  // Whether the line has gone. Until then no reply can be its, its timeout
  // isn't running, and `written` takes it back out of the queue.
  sent: boolean;
  written: Written | null;
  onSent: ((at: number) => void) | undefined;
  onDropped: (() => void) | undefined;
  priority: SendPriority | undefined;
  onEnd: ((how: QueryEnd) => void) | undefined;
  /** Past the send queue's clock (sendPacer.ts): the replies pace this one. */
  unpaced: boolean | undefined;
}

interface Settle {
  query: Query;
  wants: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// The `batch=<ref>` tag on a line, or undefined.
function batchTagOf(line: string): string | undefined {
  if (!line.startsWith('@')) return undefined;
  const end = line.indexOf(' ');
  const tags = line.slice(1, end < 0 ? undefined : end).split(';');
  for (const tag of tags) {
    if (tag.startsWith('batch=')) return tag.slice('batch='.length) || undefined;
  }
  return undefined;
}

function spec(form: Form, command: string, fields: Partial<Spec> = {}): Spec {
  return {
    form,
    command,
    targets: new Set(),
    ends: new Set(),
    channel: '',
    letter: '',
    anyChannel: false,
    abort: null,
    batchRef: '',
    sub: '',
    ...fields,
  };
}

function isClient(asker: Asker | null): asker is ReplyClient {
  return asker !== null && typeof asker === 'object';
}

export class ReplyRouter {
  private readonly opts: ReplyRouterOptions;
  // The queries on the wire, oldest first. A line goes to the oldest it
  // answers: a restore's TOPIC and MODE for one channel go out together, and
  // the server answers them in that order.
  private wire: Query[] = [];
  // Queries waiting their turn, oldest first (see mustWait).
  private waiting: Query[] = [];
  // The query that ended on the last line, owed the line right after it. One
  // line ends at most one query, so there's never more than one.
  private settle: Settle | null = null;
  // Folded channel → the last 324 and 329 lines the network sent for it, until
  // a mode change or our own JOIN makes them stale.
  private readonly modes = new Map<string, { mode: string; created: string | null }>();
  // The `batch=` tag of the line being noted (see noteServerLine).
  private lineBatch: string | undefined;

  constructor(opts: ReplyRouterOptions) {
    this.opts = opts;
  }

  /**
   * Send a line for `asker`. A query may wait its turn, and `build`, if given,
   * makes the line when it goes out; anything else is written at once.
   * `onSent` runs when the line has gone (#1149): a timer that waits on the
   * reply starts there. Lurker's own queries wait in the queue's `low` lane,
   * behind what the user says, unless `priority` says otherwise. `onEnd` runs
   * once the query is over, told how — its reply ended, the server postponed
   * it, an error ended it, or it timed out — and never when its socket went
   * first.
   */
  send(
    asker: Asker,
    line: string,
    build?: () => string,
    onSent?: (at: number) => void,
    onDropped?: () => void,
    priority?: SendPriority,
    onEnd?: (how: QueryEnd) => void,
    unpaced?: boolean,
  ): void {
    const lane = priority ?? (asker === 'lurker' ? 'low' : undefined);
    const found = this.classify(line);
    if (!found) {
      this.opts.write(line, onSent, onDropped, lane, unpaced);
      return;
    }
    this.dispatch({
      ...found,
      asker,
      build: build ?? (() => line),
      heardAt: 0,
      timer: null,
      started: false,
      sent: false,
      written: null,
      onSent,
      onDropped,
      priority: lane,
      onEnd,
      unpaced,
    });
  }

  /** Who a line from the server is for. Call for every line, in order. */
  noteServerLine(line: string, command: string, params: string[], source?: string): ReplyOwner {
    this.noteModes(line, command, params, source);
    // The batch this line is inside, if any: a metadata query's replies are
    // the lines tagged with ITS batch, not whatever arrives while it's open.
    this.lineBatch = batchTagOf(line);
    let owner: ReplyOwner | undefined;
    // This is the line the last query's end was waiting on, or the wait is over.
    const settle = this.settle;
    if (settle) {
      if (settle.timer) clearTimeout(settle.timer);
      this.settle = null;
      if (this.settles(settle, command, params)) owner = settle.query.asker ?? 'nobody';
    }
    owner ??= this.claim(command, params);
    if (typeof owner === 'object') owner.onReply?.(command, params);
    // Only now, so a query sent here can't take the line it was sent after.
    if (settle) this.releaseWaiting();
    if (owner !== undefined) return owner;
    return QUERY_ONLY.has(command) ? 'nobody' : 'unasked';
  }

  /**
   * The socket is gone, and every query with it. A client still waiting gets
   * its end numeric.
   */
  reset(): void {
    // The query waiting on the line after its error counts too: that 318 or 315
    // never came.
    const ended = [...(this.settle ? [this.settle.query] : []), ...this.wire, ...this.waiting];
    for (const query of this.wire) {
      if (query.timer) clearTimeout(query.timer);
      // Still in the queue: it must not go out on the next socket, where its
      // reply would be nobody's. Its sender is told, as of any line dropped
      // with its socket (a user's /whois behind a paste: "not sent").
      if (query.written?.cancel()) query.onDropped?.();
      query.written = null;
    }
    if (this.settle?.timer) clearTimeout(this.settle.timer);
    this.wire = [];
    this.waiting = [];
    this.settle = null;
    this.modes.clear();
    for (const query of ended) this.abort(query);
  }

  /** A client detached. Its waiting queries go, one still in the queue goes
   *  with them, and replies to one on the wire go nowhere. */
  dropClient(client: ReplyClient): void {
    this.waiting = this.waiting.filter((query) => query.asker !== client);
    let released = false;
    const queries = this.wire.slice();
    for (const query of queries) {
      if (query.asker !== client) continue;
      if (!query.sent) {
        query.written?.cancel();
        query.written = null;
        this.takeOffWire(query);
        released = true;
      } else {
        query.asker = null;
      }
    }
    if (this.settle?.query.asker === client) this.settle.query.asker = null;
    if (released) this.releaseWaiting();
  }

  private dispatch(query: Query): void {
    if (query.asker === null) return;
    if (this.answerFromCache(query)) return;
    // Lurker's own query of the kind this one would wait for, still in the
    // queue (the low lane, #1149): it steps aside, so a client's WHO after a
    // join goes ahead of the away-sync WHO waiting behind a paste, and Lurker's
    // waits behind the client's instead. Only one still in the queue: one on
    // the wire is being answered.
    const aside =
      query.asker === 'lurker'
        ? []
        : this.wire.filter(
            (other) => !other.sent && other.asker === 'lurker' && this.blocks(other, query),
          );
    for (const other of aside) {
      other.written?.cancel();
      other.written = null;
      this.takeOffWire(other);
    }
    this.dispatchNow(query);
    for (const other of aside) this.dispatch(other);
  }

  private dispatchNow(query: Query): void {
    if (this.mustWait(query)) {
      this.waiting.push(query);
      return;
    }
    if (!this.opts.canSend()) {
      this.abort(query);
      return;
    }
    // On the wire from here, so what follows it waits its turn; its timeout
    // runs from when it has actually gone, which behind a backlog is later.
    this.wire.push(query);
    const written = this.opts.write(
      query.build,
      (at) => {
        query.sent = true;
        query.written = null;
        query.heardAt = Date.now();
        // To the back: the wire is in the order lines went, which, with the
        // queue's lanes, is not the order they were handed to it. A reply
        // goes to the oldest SENT query it can answer (claim).
        const index = this.wire.indexOf(query);
        if (index !== -1) {
          this.wire.splice(index, 1);
          this.wire.push(query);
          this.armTimeout(query, this.timeoutMs());
        }
        query.onSent?.(at);
      },
      query.onDropped,
      query.priority,
      query.unpaced,
    );
    // A line with nothing ahead of it has gone by now.
    if (!query.sent) query.written = written ?? null;
  }

  // Whether a query waits for one already out, or for the line that may still
  // follow that one's end. A kind whose replies name nothing waits for the last
  // of its kind. A client's MODE #chan waits for one already asking about that
  // channel, whose reply then answers it from cache.
  private mustWait(query: Query): boolean {
    const ahead = this.settle ? [...this.wire, this.settle.query] : this.wire;
    return ahead.some((other) => this.blocks(other, query));
  }

  // Whether `query` waits for `other`: its kind, or a client's MODE #chan
  // behind one asking about that channel.
  private blocks(other: Query, query: Query): boolean {
    if (WAITS.has(query.form)) return other.form === query.form;
    if (query.form === 'mode' && isClient(query.asker)) {
      return (
        other.form === 'mode' && this.opts.fold(other.channel) === this.opts.fold(query.channel)
      );
    }
    return false;
  }

  // Every waiting query goes out, or waits again, in order.
  private releaseWaiting(): void {
    if (this.waiting.length === 0) return;
    const waiting = this.waiting;
    this.waiting = [];
    for (const query of waiting) this.dispatch(query);
  }

  // A client's MODE #chan, answered with the network's last 324 and 329, as
  // soju and ZNC do. One sent right after our JOIN waits for Lurker's own MODE
  // and is answered by its reply. The user's isn't: the web app shows the
  // network's own reply.
  private answerFromCache(query: Query): boolean {
    if (query.form !== 'mode' || !isClient(query.asker)) return false;
    if (!this.opts.isJoined(query.channel)) return false;
    const cached = this.modes.get(this.opts.fold(query.channel));
    if (!cached) return false;
    query.asker.replyFromCache(cached.created ? [cached.mode, cached.created] : [cached.mode]);
    return true;
  }

  private armTimeout(query: Query, delay: number): void {
    query.timer = setTimeout(() => {
      query.timer = null;
      // After whatever the loop has read: a stall can run this timer before the
      // lines that arrived during it, and those may be the reply.
      setImmediate(() => {
        if (!this.wire.includes(query)) return;
        const quiet = Date.now() - query.heardAt;
        const limit = this.timeoutMs();
        if (quiet < limit) {
          this.armTimeout(query, limit - quiet);
          return;
        }
        this.takeOffWire(query);
        this.abort(query);
        query.onEnd?.('timeout');
        this.releaseWaiting();
      });
    }, delay);
    query.timer.unref?.();
  }

  private takeOffWire(query: Query): void {
    const index = this.wire.indexOf(query);
    if (index !== -1) this.wire.splice(index, 1);
    if (query.timer) clearTimeout(query.timer);
    query.timer = null;
  }

  private claim(command: string, params: string[]): ReplyOwner | undefined {
    if (this.wire.length === 0) return undefined;
    for (const query of this.wire) {
      // A reply to a line that hasn't gone yet can't be.
      if (!query.sent) continue;
      const role = this.roleOf(query, command, params);
      if (!role) continue;
      query.heardAt = Date.now();
      query.started = true;
      if (role === 'end') {
        this.finish(
          query,
          this.trailerOf(query, command),
          command === '774' ? 'postponed' : 'replied',
        );
      }
      return query.asker ?? 'nobody';
    }
    for (const query of this.wire) {
      if (!query.sent) continue;
      if (!this.isErrorFor(query, command, params)) continue;
      this.finish(query, this.endAfterError(query), 'error');
      return query.asker ?? 'nobody';
    }
    return undefined;
  }

  // Take the query off the wire. If a line may still follow its end, it keeps a
  // claim on the next line, and what waits for it keeps waiting until then.
  private finish(query: Query, wants: string | null, how: QueryEnd): void {
    this.takeOffWire(query);
    query.onEnd?.(how);
    if (!wants) {
      this.releaseWaiting();
      return;
    }
    const settle: Settle = { query, wants, timer: null };
    settle.timer = setTimeout(() => {
      settle.timer = null;
      // After whatever the loop has read, as in armTimeout.
      setImmediate(() => {
        if (this.settle !== settle) return;
        this.settle = null;
        this.releaseWaiting();
      });
    }, this.opts.settleMs ?? SETTLE_MS);
    settle.timer.unref?.();
    this.settle = settle;
  }

  private settles(settle: Settle, command: string, params: string[]): boolean {
    if (command !== settle.wants) return false;
    const { query } = settle;
    // A WHO's 315 can name `*` or a collapsed mask, and a 323 names nothing.
    if (query.form === 'who' || query.form === 'list') return true;
    const name = params[1] ?? '';
    if (name === '*') return true;
    const folded = this.opts.fold(name);
    return query.targets.has(folded) || query.ends.has(folded);
  }

  private trailerOf(query: Query, command: string): string | null {
    if (query.form === 'mode') return '329';
    if (query.form === 'topic' && command === '332') return '333';
    return null;
  }

  private endAfterError(query: Query): string | null {
    if (query.form === 'modelist') return LIST_MODE_NUMERICS[query.letter]?.end ?? null;
    return END_AFTER_ERROR[query.form] ?? null;
  }

  private roleOf(query: Query, command: string, params: string[]): 'body' | 'end' | null {
    const names = (i: number) => query.targets.has(this.opts.fold(params[i] ?? ''));
    switch (query.form) {
      case 'who':
        if (command === '352' || command === '354' || command === '416') return 'body';
        return command === '315' ? 'end' : null;
      case 'whois':
        if (command === '318') {
          if (query.ends.has(this.opts.fold(params[1] ?? ''))) return 'end';
          // InspIRCd ends each nick of `WHOIS a,b` with its own 318.
          return names(1) ? 'body' : null;
        }
        if (!isWhoisReply(command) || !names(1)) return null;
        // A PRIVMSG to someone away draws a 301 too. A server writes a WHOIS's
        // lines together, starting with its 311, so a 301 before any of them
        // isn't the WHOIS's.
        return command !== '301' || query.started ? 'body' : null;
      case 'whowas':
        if (command === '369') return names(1) ? 'end' : null;
        return WHOWAS_REPLIES.has(command) && names(1) ? 'body' : null;
      case 'list':
        if (command === '321' || command === '322') return 'body';
        return command === '323' ? 'end' : null;
      case 'names':
        if (command === '353') return query.anyChannel || names(2) ? 'body' : null;
        return command === '366' && names(1) ? 'end' : null;
      case 'mode':
        return command === '324' && names(1) ? 'end' : null;
      case 'modelist': {
        const numerics = LIST_MODE_NUMERICS[query.letter];
        if (!numerics || !names(1)) return null;
        if (command === numerics.item) return 'body';
        return command === numerics.end ? 'end' : null;
      }
      case 'umode':
        return command === '221' ? 'end' : null;
      case 'topic':
        return (command === '331' || command === '332') && names(1) ? 'end' : null;
      case 'ison':
        return command === '303' ? 'end' : null;
      case 'userhost':
        return command === '302' ? 'end' : null;
      case 'away':
        return command === '305' || command === '306' ? 'end' : null;
      case 'accept':
        if (command === '281') return 'body';
        return command === '282' ? 'end' : null;
      case 'metadata': {
        // Several METADATA queries can be on the wire at once — the user's
        // LIST, Lurker's SUB, a bouncer client's SYNC — so every reply is
        // matched on what it names, by subcommand, as the other forms are.
        if (command === 'BATCH') {
          const ref = params[0] ?? '';
          const type = params[1] ?? '';
          if (ref.startsWith('+')) {
            if (query.batchRef) return null;
            const mine =
              (type === 'metadata-subs' && query.sub === 'SUBS') ||
              (type === 'metadata' &&
                (query.sub === 'GET' ||
                  query.sub === 'LIST' ||
                  query.sub === 'SYNC' ||
                  query.sub === 'CLEAR') &&
                names(2));
            if (!mine) return null;
            query.batchRef = ref.slice(1);
            return 'body';
          }
          return ref.startsWith('-') && query.batchRef === ref.slice(1) ? 'end' : null;
        }
        if (query.batchRef) {
          // Inside the query's batch — tagged with its reference — its,
          // whatever shape the server chose. A bare line while the batch is
          // open is someone else's.
          if (this.lineBatch !== query.batchRef) return null;
          return command === '761' ||
            command === '766' ||
            command === '772' ||
            command === 'METADATA'
            ? 'body'
            : null;
        }
        // A bare 761/766 naming the target is a SET's whole reply.
        if ((command === '761' || command === '766') && query.sub === 'SET') {
          return names(1) ? 'end' : null;
        }
        if (command === '770') return query.sub === 'SUB' ? 'end' : null;
        if (command === '771') return query.sub === 'UNSUB' ? 'end' : null;
        // RPL_METADATASYNCLATER for a SYNC's target: the sync is postponed.
        if (command === '774') return query.sub === 'SYNC' && names(1) ? 'end' : null;
        return null;
      }
    }
  }

  private isErrorFor(query: Query, command: string, params: string[]): boolean {
    if (COMMAND_ERRORS.has(command)) return (params[1] ?? '').toUpperCase() === query.command;
    if (command === 'FAIL') return (params[0] ?? '').toUpperCase() === query.command;
    if (TARGET_ERRORS.has(command)) return query.targets.has(this.opts.fold(params[1] ?? ''));
    if (command === '431') return query.form === 'whois' || query.form === 'whowas';
    // WHOWAS's own error. A WHOIS for the same nick mustn't take it.
    if (command === '406') {
      return query.form === 'whowas' && query.targets.has(this.opts.fold(params[1] ?? ''));
    }
    return false;
  }

  private timeoutMs(): number {
    return this.opts.timeoutMs ?? envInt('LURKER_REPLY_TIMEOUT_MS', QUERY_TIMEOUT_MS);
  }

  private abort(query: Query): void {
    if (!isClient(query.asker) || !query.abort) return;
    query.asker.replyAborted(query.abort.numeric, query.abort.params);
  }

  // The cached 324 and 329 answer a client's MODE #chan until they're stale: a
  // change to a mode a 324 shows, or our own JOIN (a channel we left and
  // rejoined may have been recreated).
  private noteModes(line: string, command: string, params: string[], source?: string): void {
    switch (command) {
      case '324': {
        const key = this.opts.fold(params[1] ?? '');
        if (key) this.modes.set(key, { mode: line, created: this.modes.get(key)?.created ?? null });
        return;
      }
      case '329': {
        const cached = this.modes.get(this.opts.fold(params[1] ?? ''));
        if (cached) cached.created = line;
        return;
      }
      case 'MODE': {
        const target = params[0] ?? '';
        if (isChannelTarget(target) && this.changesShownModes(params[1] ?? '')) {
          this.modes.delete(this.opts.fold(target));
        }
        return;
      }
      case 'JOIN':
        if (source && this.opts.fold(source) === this.opts.fold(this.opts.ownNick())) {
          for (const channel of (params[0] ?? '').split(',')) {
            this.modes.delete(this.opts.fold(channel));
          }
        }
        return;
    }
  }

  // Whether a mode change touches a mode a 324 shows. Prefix modes (+o) land on
  // a member and list modes (+b) on a list, and neither is in a 324.
  private changesShownModes(modes: string): boolean {
    const prefix = this.opts.prefixModes();
    const list = this.opts.listModes();
    for (const letter of modes) {
      if (letter === '+' || letter === '-') continue;
      if (!prefix.has(letter) && !list.has(letter)) return true;
    }
    return false;
  }

  private classify(line: string): Spec | null {
    let msg;
    try {
      msg = ircLineParser(line);
    } catch (_) {
      return null;
    }
    if (!msg) return null;
    const command = String(msg.command || '').toUpperCase();
    const params: string[] = Array.isArray(msg.params) ? msg.params : [];
    const fold = (names: string[]) =>
      new Set(names.filter(Boolean).map((name) => this.opts.fold(name)));
    switch (command) {
      case 'WHO':
        // A 403 or 401 naming the mask ends it, as in ZNC's route_replies.
        return spec('who', command, {
          targets: fold(params[0] ? [params[0]] : []),
          abort: { numeric: '315', params: [params[0] || '*'] },
        });
      case 'WHOIS': {
        // WHOIS [server] <nick>[,<nick>…]. A 402 names the server.
        const list = params[params.length - 1] ?? '';
        const nicks = list.split(',');
        return spec('whois', command, {
          targets: fold([...nicks, list, ...(params.length > 1 ? [params[0]] : [])]),
          ends: fold([list, nicks[nicks.length - 1]]),
          abort: { numeric: '318', params: [list || '*'] },
        });
      }
      case 'WHOWAS': {
        const list = params[0] ?? '';
        return spec('whowas', command, {
          targets: fold([...list.split(','), list]),
          abort: { numeric: '369', params: [list || '*'] },
        });
      }
      case 'LIST':
        // A LIST naming a channel that doesn't exist gets a 401 for it (solanum).
        return spec('list', command, {
          targets: fold((params[0] ?? '').split(',')),
          abort: { numeric: '323', params: [] },
        });
      case 'NAMES': {
        const list = params[0] ?? '';
        return spec('names', command, {
          targets: fold(list ? [...list.split(','), list] : ['*']),
          anyChannel: !list,
          abort: { numeric: '366', params: [list || '*'] },
        });
      }
      case 'MODE': {
        const target = params[0] ?? '';
        if (target && isChannelTarget(target)) {
          if (params.length === 1) {
            return spec('mode', command, { targets: fold([target]), channel: target });
          }
          // A list query: `MODE #chan b`, or `+b` with no mask.
          const letter = params.length === 2 ? /^\+?([A-Za-z])$/.exec(params[1])?.[1] : undefined;
          const numerics = letter ? LIST_MODE_NUMERICS[letter] : undefined;
          if (!letter || !numerics) return null;
          // q is a quiet list on solanum and an owner prefix elsewhere.
          if (letter === 'q' && !this.opts.listModes().has('q')) return null;
          return spec('modelist', command, {
            targets: fold([target]),
            channel: target,
            letter,
            abort: { numeric: numerics.end, params: [target] },
          });
        }
        // Our own user modes. A MODE with no target at all draws a 461 naming
        // MODE, so it's tracked with the rest.
        if (params.length === 0) return spec('umode', command);
        if (params.length === 1 && this.opts.fold(target) === this.opts.fold(this.opts.ownNick())) {
          return spec('umode', command);
        }
        return null;
      }
      case 'TOPIC':
        if (params.length === 0) return spec('topic', command);
        if (params.length === 1 && isChannelTarget(params[0])) {
          return spec('topic', command, { targets: fold([params[0]]), channel: params[0] });
        }
        return null;
      case 'ISON':
        return spec('ison', command);
      case 'USERHOST':
        return spec('userhost', command);
      case 'AWAY':
        // A 305 or 306 names nothing, but only an AWAY draws one, so the oldest
        // AWAY on the wire takes it and no AWAY waits.
        return spec('away', command);
      case 'ACCEPT':
        // Only `ACCEPT *` is a query: adding or removing a nick answers
        // nothing unless it fails (#206).
        return params[0] === '*'
          ? spec('accept', command, { abort: { numeric: '282', params: [] } })
          : null;
      case 'METADATA': {
        // METADATA <target> <sub> …: every subcommand answers something, so
        // each is a query. A SET's reply is a bare 761 naming the target
        // (`*` for ourselves, which the server answers with our nick).
        const target = params[0] ?? '';
        const sub = (params[1] ?? '').toUpperCase();
        if (!target || !sub) return null;
        // `*` is us (the server answers with our nick); `*ALL` is ergo's
        // sync-everything target, answered with a batch labelled the same.
        const own = target === '*' ? [this.opts.ownNick()] : [];
        return spec('metadata', command, { targets: fold([target, ...own]), sub });
      }
      default:
        return null;
    }
  }
}
