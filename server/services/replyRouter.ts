// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Who each reply on a network connection is for. Three kinds of asker share the
// connection: Lurker itself (the MODE and WHO it sends when it joins a channel,
// a restore's NAMES, TOPIC and MODE, the AWAY carrying the account's away state),
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

export interface ReplyRouterOptions {
  /** Put a line on the wire. */
  write(line: string): void;
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
  | 'away';

// The kinds whose replies name nothing to match them by. One of these waits for
// the last of its kind to be answered. A 221 names nothing either: without its
// turn, a restore's unanswered MODE <nick> would take a client's reply.
const WAITS = new Set<Form>(['who', 'list', 'ison', 'userhost', 'umode']);

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
}

interface Query extends Spec {
  // Null once a client detached.
  asker: Asker | null;
  build: () => string;
  heardAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  // Whether any of its reply has come. A 301 counts for a WHOIS only after that.
  started: boolean;
}

interface Settle {
  query: Query;
  wants: string;
  timer: ReturnType<typeof setTimeout> | null;
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

  constructor(opts: ReplyRouterOptions) {
    this.opts = opts;
  }

  /**
   * Send a line for `asker`. A query may wait its turn, and `build`, if given,
   * makes the line when it goes out; anything else is written at once.
   */
  send(asker: Asker, line: string, build?: () => string): void {
    const found = this.classify(line);
    if (!found) {
      this.opts.write(line);
      return;
    }
    this.dispatch({
      ...found,
      asker,
      build: build ?? (() => line),
      heardAt: 0,
      timer: null,
      started: false,
    });
  }

  /** Who a line from the server is for. Call for every line, in order. */
  noteServerLine(line: string, command: string, params: string[], source?: string): ReplyOwner {
    this.noteModes(line, command, params, source);
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
    for (const query of this.wire) if (query.timer) clearTimeout(query.timer);
    if (this.settle?.timer) clearTimeout(this.settle.timer);
    this.wire = [];
    this.waiting = [];
    this.settle = null;
    this.modes.clear();
    for (const query of ended) this.abort(query);
  }

  /** A client detached. Its waiting queries go, and replies to one on the wire go nowhere. */
  dropClient(client: ReplyClient): void {
    this.waiting = this.waiting.filter((query) => query.asker !== client);
    for (const query of this.wire) if (query.asker === client) query.asker = null;
    if (this.settle?.query.asker === client) this.settle.query.asker = null;
  }

  private dispatch(query: Query): void {
    if (query.asker === null) return;
    if (this.answerFromCache(query)) return;
    if (this.mustWait(query)) {
      this.waiting.push(query);
      return;
    }
    if (!this.opts.canSend()) {
      this.abort(query);
      return;
    }
    query.heardAt = Date.now();
    this.wire.push(query);
    this.armTimeout(query, this.timeoutMs());
    this.opts.write(query.build());
  }

  // Whether a query waits for one already out, or for the line that may still
  // follow that one's end. A kind whose replies name nothing waits for the last
  // of its kind. A client's MODE #chan waits for one already asking about that
  // channel, whose reply then answers it from cache.
  private mustWait(query: Query): boolean {
    const ahead = this.settle ? [...this.wire, this.settle.query] : this.wire;
    if (WAITS.has(query.form)) return ahead.some((other) => other.form === query.form);
    if (query.form === 'mode' && isClient(query.asker)) {
      const channel = this.opts.fold(query.channel);
      return ahead.some(
        (other) => other.form === 'mode' && this.opts.fold(other.channel) === channel,
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
      const role = this.roleOf(query, command, params);
      if (!role) continue;
      query.heardAt = Date.now();
      query.started = true;
      if (role === 'end') this.finish(query, this.trailerOf(query, command));
      return query.asker ?? 'nobody';
    }
    for (const query of this.wire) {
      if (!this.isErrorFor(query, command, params)) continue;
      this.finish(query, this.endAfterError(query));
      return query.asker ?? 'nobody';
    }
    return undefined;
  }

  // Take the query off the wire. If a line may still follow its end, it keeps a
  // claim on the next line, and what waits for it keeps waiting until then.
  private finish(query: Query, wants: string | null): void {
    this.takeOffWire(query);
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
      default:
        return null;
    }
  }
}
