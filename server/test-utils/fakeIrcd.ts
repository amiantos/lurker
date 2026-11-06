// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// A small IRC server for tests that need a real socket on the far side —
// enough of the protocol for a client to register, join, talk, and be watched.
// Exists because the engine holds a TCP socket and nothing in-process can stand
// in for that, and CI has no ircd. Deliberately not a faithful ircd: every reply
// is the simplest form a real server sends, and anything unimplemented answers
// 421 so a test that wanders off the map fails loudly.
//
// The things it gets deliberately right, because tests lean on them:
//   - `registrations` records every completed registration, so a test can
//     assert the server saw exactly one across an app restart.
//   - server-time: when a client asks for it, every relayed line carries a
//     leading `@time=` tag — the ergo behaviour that broke an early probe.
//   - 317 (signon time) is reported only to the user asking about themself,
//     as ergo does.
//   - PING from the server is a method call, so tests decide when it happens.

import net from 'node:net';
import { REDACTION_CAP } from '../../shared/redaction.js';
import tls from 'node:tls';
import { EventEmitter, once } from 'node:events';
import { generate as generateSelfSigned } from 'selfsigned';
import { ircLineParser } from 'irc-framework';
import { CHANNEL_PREFIX_CHARS, isChannelTarget } from '../../shared/channels.js';
import { stripFormatting } from '../../shared/textMatch.js';

export interface FakeIrcdOptions {
  tls?: boolean;
  // Strip mIRC formatting codes from every PRIVMSG/NOTICE relayed, whoever sent
  // it — a client's own, and a peer's through say() — the way a channel in
  // UnrealIRCd's +S or InspIRCd's stripcolor does. The sender's own echo comes
  // back stripped too, which is what breaks a byte-exact echo match (#612).
  stripFormatting?: boolean;
  // Advertise these in CAP LS (and ACK them when requested).
  caps?: string[];
  // Message redaction (#1013): let a client delete ANY line, as a channel op
  // may on ergo. Without it a client may delete only its own.
  redactAny?: boolean;
  // false → 422 instead of a MOTD.
  motd?: boolean;
  // Pad the MOTD with this many extra numbered 372 lines. Their lengths vary
  // (every tenth is short), so a consumer that caps the MOTD by testing each
  // line against its remaining headroom keeps the short ones after skipping a
  // long one — which is how a truncated-with-holes bug shows itself.
  motdPadLines?: number;
  // Rename every client to this DURING registration (between 005 and the MOTD),
  // the way nick enforcement or a SANICK would.
  burstNickTo?: string;
  // Raw lines injected in the same place, for the rest of what a server or a
  // service can do to a client mid-registration (an auto-join, a rename of the
  // channel it just put you in). Called per client so a line can carry the
  // client's own hostmask. Deliberately raw: they go straight out and touch
  // none of the fake's own bookkeeping, so an injected JOIN does NOT make the
  // client a member — a later PART of it answers 442, and NAMES answers empty.
  // Inject the replies you want too, or join for real.
  burstLines?: (c: FakeClient) => string[];
  serverName?: string;
  // The host in every client's hostmask (default `fake.host`) — a long one for
  // the line-budget tests (#1043).
  clientHost?: string;
  network?: string;
  // Ask every TLS client for a certificate and record what it presents, the way
  // an ircd doing CertFP does — it hashes what you show it rather than
  // verifying a chain, so anything is accepted. Meaningless without `tls`.
  requestClientCert?: boolean;
  // Offer SASL: advertises `sasl=<mechanisms>` in CAP LS and answers
  // AUTHENTICATE. Defaults to PLAIN + EXTERNAL when passed `true`.
  sasl?: boolean | { mechanisms: string[] };
  // Caps that are advertised but NAKed when requested — a cap behind a
  // privilege, or one the server lists and then declines. A REQ is
  // all-or-nothing, so a batch containing one of these is NAKed whole.
  refuse?: string[];
  // Answer WHO for real: advertise WHOX, and send a 352 for each member of the
  // channel (or a 354, for `WHO <mask> %<fields>[,<token>]`) before the 315.
  whox?: boolean;
  // Follow a channel's 324 with its 329 (RPL_CREATIONTIME), as most ircds do.
  creationTime?: boolean;
  // Extra ISUPPORT tokens for the 005 (e.g. `CLIENTTAGDENY=*`).
  isupport?: string[];
  // Speak draft/metadata-2 the way ergo does: live changes as 761/766 to
  // subscribed clients sharing a channel, a SUB answered with a 770 and a
  // `774 * *ALL` asking for a SYNC, lists and syncs as `metadata` batches.
  metadata?: boolean;
  // The metadata cap's value, in place of the default limits: soju's
  // `before-connect,max-keys=0,max-value-bytes=1`, say.
  metadataCapValue?: string;
  // Keep history and serve `draft/chathistory` (#1283): BETWEEN, AFTER, LATEST
  // and TARGETS over every PRIVMSG, NOTICE and TAGMSG relayed, bounds
  // exclusive as on every real server, the `CHATHISTORY=<limit>` ISUPPORT
  // token (over-limit requests refused, as soju does). `end` puts
  // `draft/chathistory-end` on a last page, as ergo does and soju doesn't;
  // `fail` answers every request with that FAIL code; `autoreplay` pushes a
  // channel's last N lines at JOIN unasked, to a client that did not take
  // the cap, as ergo does; `advertise: false` keeps the cap out of CAP LS, so
  // a client that would take it is left with the unasked replay instead.
  chathistory?:
    | boolean
    | { limit?: number; end?: boolean; fail?: string; autoreplay?: number; advertise?: boolean };
}

// A relayed line as history keeps it: the bare line, its tags apart.
export interface HistoryLine {
  time: string;
  msgid: string;
  line: string;
  clientTags: string[];
  // A DM's two parties, so a TARGETS names the other one.
  peers?: [string, string];
}

export interface FakeClient {
  socket: net.Socket;
  nick: string | null;
  user: string | null;
  registered: boolean;
  signon: number;
  caps: Set<string>;
  capNegotiating: boolean;
  channels: Set<string>;
  // The SHA-256 of the certificate this client presented, bare lowercase hex —
  // the form services want it registered in. null when it presented none (or
  // the listener isn't asking).
  certfp: string | null;
  // The SASL mechanism in flight, between AUTHENTICATE <mech> and the outcome.
  saslMech: string | null;
  // The account this client authenticated as, once SASL has succeeded.
  account: string | null;
  // Metadata keys this client subscribed to (METADATA * SUB).
  metadataSubs: Set<string>;
  // Every line this client sent, in order.
  sent: string[];
}

const METADATA_KEY_RE = /^[a-z0-9_./-]+$/;

export const DEFAULT_CAPS = [
  'server-time',
  'message-tags',
  'batch',
  'multi-prefix',
  'away-notify',
  'account-notify',
  'extended-join',
  'chghost',
  'cap-notify',
  'userhost-in-names',
  'echo-message',
];

// The end of each list-mode query the fake answers, by mode letter. Its lists
// are always empty.
const LIST_ENDS: Record<string, string | undefined> = { b: '368', e: '349', I: '347' };

// A CHATHISTORY bound: `*` (null, LATEST only), `timestamp=<iso>` (the
// time), anything else undefined.
function chathistoryBound(s: string | undefined): string | null | undefined {
  if (s === '*') return null;
  if (!s || !s.startsWith('timestamp=')) return undefined;
  return s.slice('timestamp='.length);
}

// `sasl=PLAIN,EXTERNAL` → `sasl`.
function capName(cap: string): string {
  return cap.split('=')[0];
}

// The SHA-256 of a peer's certificate as services want it registered: bare
// lowercase hex. Null for a plain socket, or a TLS one that presented nothing.
function peerCertFingerprint(socket: net.Socket): string | null {
  if (!(socket instanceof tls.TLSSocket)) return null;
  const peer = socket.getPeerCertificate();
  if (!peer || !peer.fingerprint256) return null;
  return peer.fingerprint256.replace(/:/g, '').toLowerCase();
}

export class FakeIrcd extends EventEmitter {
  readonly clients: FakeClient[] = [];
  readonly registrations: Array<{ nick: string; at: number }> = [];
  readonly topics = new Map<string, string>();
  // What CHATHISTORY serves (opts.chathistory): a channel's lines under its
  // lowercase name, a DM's under the folded pair (dmKey), oldest first.
  readonly history = new Map<string, HistoryLine[]>();
  // Fingerprint → account, i.e. what `/msg NickServ CERT ADD` leaves behind.
  // SASL EXTERNAL succeeds for a client whose presented certfp is in here and
  // fails for one whose isn't, which is the whole of CertFP as a client sees it.
  readonly certfpAccounts = new Map<string, string>();
  // account → password, for SASL PLAIN.
  readonly saslAccounts = new Map<string, string>();
  // Metadata per target (lowercase nick or channel): key → value.
  readonly metadata = new Map<string, Map<string, string>>();
  // ergo's own-nick SET throttle, scripted: the next N SETs on yourself are
  // refused `FAIL METADATA RATE_LIMITED <target> <key> <retry-after>`.
  metadataSetsToThrottle = 0;
  metadataRetryAfter = '1';
  // Test hook: return true to swallow a client command — no reply of any kind —
  // for a test of what the client does when a reply never comes.
  hold: ((cmd: string, params: string[], c: FakeClient) => boolean) | null = null;
  private msgidCounter = 0;
  // Who sent each line the fake minted a msgid for, by msgid — what a REDACT
  // is judged against (#1013). A deleted line's entry goes, so a second REDACT
  // for it answers UNKNOWN_MSGID as ergo does once its history row is gone.
  private readonly msgidOwner = new Map<string, string>();
  private server!: net.Server;
  port = 0;
  private readonly caps: string[];
  private readonly serverName: string;
  private readonly network: string;

  private constructor(private readonly opts: FakeIrcdOptions) {
    super();
    this.caps = [...(opts.caps ?? DEFAULT_CAPS)];
    if (opts.sasl) {
      const mechanisms =
        typeof opts.sasl === 'object' ? opts.sasl.mechanisms : ['PLAIN', 'EXTERNAL'];
      // Advertised with its value, as SASL 3.2 does: irc-framework reads the
      // mechanism list off the cap and refuses to try one that isn't there.
      this.caps.push(`sasl=${mechanisms.join(',')}`);
    }
    if (opts.metadata)
      this.caps.push(
        `draft/metadata-2=${opts.metadataCapValue ?? 'max-subs=10,max-keys=10,max-value-bytes=512'}`,
      );
    if (
      opts.chathistory &&
      (typeof opts.chathistory !== 'object' || opts.chathistory.advertise !== false)
    ) {
      this.caps.push('draft/chathistory');
    }
    this.serverName = opts.serverName ?? 'fake.test';
    this.network = opts.network ?? 'FakeNet';
  }

  private chathistoryOpts(): {
    limit: number;
    end: boolean;
    fail?: string;
    autoreplay: number;
  } | null {
    const o = this.opts.chathistory;
    if (!o) return null;
    const given = typeof o === 'object' ? o : {};
    return {
      limit: given.limit ?? 100,
      end: !!given.end,
      fail: given.fail,
      autoreplay: given.autoreplay ?? 0,
    };
  }

  static async start(opts: FakeIrcdOptions = {}): Promise<FakeIrcd> {
    const ircd = new FakeIrcd(opts);
    if (opts.tls) {
      const pems = await generateSelfSigned([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
          {
            name: 'subjectAltName',
            altNames: [
              { type: 2, value: 'localhost' },
              { type: 7, ip: '127.0.0.1' },
            ],
          },
        ],
      });
      ircd.server = tls.createServer(
        {
          key: pems.private,
          cert: pems.cert,
          requestCert: !!opts.requestClientCert,
          // A CertFP client cert is self-signed by definition; verifying it
          // would reject every one of them.
          rejectUnauthorized: false,
        },
        (s) => ircd.accept(s),
      );
    } else {
      ircd.server = net.createServer((s) => ircd.accept(s));
    }
    await new Promise<void>((resolve) => ircd.server.listen(0, '127.0.0.1', resolve));
    ircd.port = (ircd.server.address() as net.AddressInfo).port;
    return ircd;
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.socket.destroy();
    this.server.close();
  }

  client(nick: string): FakeClient | undefined {
    const lower = nick.toLowerCase();
    return this.clients.find((c) => c.nick?.toLowerCase() === lower && !c.socket.destroyed);
  }

  // Wait until a client with this nick has registered.
  async waitForRegistration(nick: string, timeoutMs = 5000): Promise<FakeClient> {
    const existing = this.client(nick);
    if (existing?.registered) return existing;
    return this.waitFor(() => {
      const c = this.client(nick);
      return c?.registered ? c : undefined;
    }, timeoutMs);
  }

  // Wait until some client has sent a line matching `pred`.
  async waitForLine(
    pred: (line: string, client: FakeClient) => boolean,
    timeoutMs = 5000,
  ): Promise<string> {
    return this.waitFor(() => {
      for (const c of this.clients) {
        const hit = c.sent.find((l) => pred(l, c));
        if (hit) return hit;
      }
      return undefined;
    }, timeoutMs);
  }

  private waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        const v = probe();
        if (v !== undefined) return resolve(v);
        if (Date.now() > deadline) return reject(new Error('fakeIrcd: timed out waiting'));
        setTimeout(tick, 10);
      };
      tick();
    });
  }

  // --- server-initiated traffic -------------------------------------------

  ping(nick: string, token = 'fake'): void {
    const c = this.client(nick);
    if (c) this.raw(c, `PING :${token}`);
  }

  // A TAGMSG from a synthetic peer, carrying `clientTags` as written (already
  // escaped, `+`-prefixed), to every message-tags client on the target.
  tagmsg(from: string, target: string, clientTags: string[]): string {
    const msgid = `m${++this.msgidCounter}`;
    this.msgidOwner.set(msgid, from);
    const line = `:${from}!~${from}@peer.fake TAGMSG ${target}`;
    const time = new Date().toISOString();
    this.record(target, from, { time, msgid, line, clientTags });
    const recipients = isChannelTarget(target)
      ? this.members(target)
      : [this.client(target)].filter((c): c is FakeClient => !!c);
    for (const c of recipients) {
      if (c.caps.has('message-tags')) this.tagged(c, line, msgid, clientTags, time);
    }
    return msgid;
  }

  // Deliver a line from a synthetic peer to a nick or a channel. `clientTags`
  // (escaped, `+`-prefixed) ride along to message-tags clients, as on TAGMSG.
  say(from: string, target: string, text: string, clientTags: string[] = []): string {
    const msgid = `m${++this.msgidCounter}`;
    this.msgidOwner.set(msgid, from);
    const body = this.opts.stripFormatting ? stripFormatting(text) : text;
    const line = `:${from}!~${from}@peer.fake PRIVMSG ${target} :${body}`;
    const time = new Date().toISOString();
    this.record(target, from, { time, msgid, line, clientTags });
    if (isChannelTarget(target)) {
      for (const c of this.members(target)) this.tagged(c, line, msgid, clientTags, time);
    } else {
      const c = this.client(target);
      if (c) this.tagged(c, line, msgid, clientTags, time);
    }
    return msgid;
  }

  // --- history (opts.chathistory) --------------------------------------------

  private static dmKey(a: string, b: string): string {
    return 'dm:' + [a.toLowerCase(), b.toLowerCase()].toSorted().join('|');
  }

  // Keep a relayed line, whether or not anyone was there to receive it: a
  // peer talking in a channel the client has dropped out of is the gap.
  private record(target: string, from: string, entry: HistoryLine): void {
    if (!this.chathistoryOpts()) return;
    const key = isChannelTarget(target) ? target.toLowerCase() : FakeIrcd.dmKey(from, target);
    const lines = this.history.get(key) ?? [];
    if (!isChannelTarget(target)) entry.peers = [from, target];
    lines.push(entry);
    this.history.set(key, lines);
  }

  // ZNC core's playback at attach (Chan.cpp): the buffer inside a
  // `znc.in/playback` batch, each line with its original `@time` and, as on
  // ZNC, no msgid. `lines` are history entries, or bare lines stamped now.
  zncPlayback(
    nick: string,
    target: string,
    lines: Array<Pick<HistoryLine, 'time' | 'line'> | string>,
  ): void {
    const c = this.client(nick);
    if (!c) return;
    const ref = `znc${++this.msgidCounter}`;
    this.raw(c, `:znc.in BATCH +${ref} znc.in/playback ${target}`);
    for (const l of lines) {
      const entry = typeof l === 'string' ? { time: new Date().toISOString(), line: l } : l;
      this.raw(c, `@batch=${ref};time=${entry.time} ${entry.line}`);
    }
    this.raw(c, `:znc.in BATCH -${ref}`);
  }

  // A `chathistory` batch of `lines` for `target`, written to `c` whether it
  // asked or not (ergo's autoreplay at JOIN is the unasked form).
  private historyBatch(c: FakeClient, target: string, lines: HistoryLine[], last: boolean): void {
    const opts = this.chathistoryOpts()!;
    const ref = `h${++this.msgidCounter}`;
    const endTag = last && opts.end ? '@draft/chathistory-end ' : '';
    this.raw(c, `${endTag}:${this.serverName} BATCH +${ref} chathistory ${target}`);
    for (const l of lines) {
      const tags = [`batch=${ref}`, `time=${l.time}`, `msgid=${l.msgid}`, ...l.clientTags];
      this.raw(c, `@${tags.join(';')} ${l.line}`);
    }
    this.raw(c, `:${this.serverName} BATCH -${ref}`);
  }

  private chathistoryFail(c: FakeClient, code: string, sub: string, rest: string[]): void {
    const tail = rest.length ? ' ' + rest.join(' ') : '';
    this.raw(
      c,
      `:${this.serverName} FAIL CHATHISTORY ${code} ${sub || '*'}${tail} :Messages could not be retrieved`,
    );
  }

  // CHATHISTORY <sub> …, the subset the spec's reconnect recipe needs. Bounds
  // are `timestamp=<iso>` and exclusive; a batch is always oldest-first.
  private onChathistory(c: FakeClient, p: string[]): void {
    const opts = this.chathistoryOpts();
    if (!opts) return this.num(c, '421', 'CHATHISTORY', 'Unknown command');
    const sub = (p[0] ?? '').toUpperCase();
    if (opts.fail)
      return this.chathistoryFail(c, opts.fail, sub, sub === 'TARGETS' ? [] : [p[1] ?? '*']);
    const bound = chathistoryBound;
    const limitOf = (s: string | undefined): number | undefined => {
      const n = Number(s);
      return Number.isInteger(n) && n > 0 && n <= opts.limit ? n : undefined;
    };
    if (sub === 'TARGETS') {
      const from = bound(p[1]);
      const to = bound(p[2]);
      const limit = limitOf(p[3]);
      if (!from || !to || !limit) return this.chathistoryFail(c, 'INVALID_PARAMS', sub, []);
      const [lo, hi] = from < to ? [from, to] : [to, from];
      const found: Array<{ target: string; time: string }> = [];
      for (const [key, lines] of this.history) {
        const newest = lines[lines.length - 1];
        if (!newest || !(newest.time > lo && newest.time < hi)) continue;
        if (key.startsWith('dm:')) {
          const peers = newest.peers ?? ['', ''];
          const mine = (c.nick ?? '').toLowerCase();
          const other = peers.find((n) => n.toLowerCase() !== mine);
          if (!peers.some((n) => n.toLowerCase() === mine) || !other) continue;
          found.push({ target: other, time: newest.time });
        } else {
          if (!c.channels.has(key)) continue;
          found.push({ target: key, time: newest.time });
        }
      }
      found.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
      const page = found.slice(0, limit);
      const ref = `t${++this.msgidCounter}`;
      this.raw(c, `:${this.serverName} BATCH +${ref} draft/chathistory-targets`);
      for (const f of page) {
        this.raw(c, `@batch=${ref} :${this.serverName} CHATHISTORY TARGETS ${f.target} ${f.time}`);
      }
      this.raw(c, `:${this.serverName} BATCH -${ref}`);
      return;
    }
    const target = p[1] ?? '';
    if (!target) return this.chathistoryFail(c, 'INVALID_PARAMS', sub, []);
    const key = isChannelTarget(target)
      ? target.toLowerCase()
      : FakeIrcd.dmKey(c.nick ?? '', target);
    if (isChannelTarget(target) && !c.channels.has(key)) {
      return this.chathistoryFail(c, 'INVALID_TARGET', sub, [target]);
    }
    const all = this.history.get(key) ?? [];
    let page: HistoryLine[];
    let last: boolean;
    if (sub === 'BETWEEN') {
      const a = bound(p[2]);
      const b = bound(p[3]);
      const limit = limitOf(p[4]);
      if (!a || !b || !limit) return this.chathistoryFail(c, 'INVALID_PARAMS', sub, [target]);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const within = all.filter((l) => l.time > lo && l.time < hi);
      // Forward from the first bound, or backward from it: the page is the
      // first N or the last N, oldest-first either way (as Lurker serves it).
      page = a < b ? within.slice(0, limit) : within.slice(-limit);
      last = within.length <= limit;
    } else if (sub === 'AFTER') {
      const a = bound(p[2]);
      const limit = limitOf(p[3]);
      if (!a || !limit) return this.chathistoryFail(c, 'INVALID_PARAMS', sub, [target]);
      const after = all.filter((l) => l.time > a);
      page = after.slice(0, limit);
      last = after.length <= limit;
    } else if (sub === 'LATEST') {
      const a = bound(p[2]);
      const limit = limitOf(p[3]);
      if (a === undefined || !limit)
        return this.chathistoryFail(c, 'INVALID_PARAMS', sub, [target]);
      const before = a === null ? all : all.filter((l) => l.time > a);
      page = before.slice(-limit);
      last = before.length <= limit;
    } else {
      return this.chathistoryFail(c, 'INVALID_PARAMS', sub, [target]);
    }
    this.historyBatch(c, target, page, last);
  }

  // A REDACT from a synthetic peer (#1013): `from` deleted the line `msgid` in
  // `target` — its own, or as an op. Delivered to every cap client there; a
  // DM REDACT reaches the client named as its target.
  redact(from: string, target: string, msgid: string, reason?: string): void {
    this.msgidOwner.delete(msgid);
    for (const lines of this.history.values()) {
      const i = lines.findIndex((l) => l.msgid === msgid);
      if (i !== -1) lines.splice(i, 1);
    }
    this.relayRedact(`${from}!~${from}@peer.fake`, target, msgid, reason, null);
  }

  private relayRedact(
    prefix: string,
    target: string,
    msgid: string,
    reason: string | undefined,
    sender: FakeClient | null,
  ): void {
    const line = `:${prefix} REDACT ${target} ${msgid}` + (reason ? ` :${reason}` : '');
    const recipients = isChannelTarget(target)
      ? this.members(target)
      : [this.client(target), sender].filter((c): c is FakeClient => !!c);
    const seen = new Set<FakeClient>();
    for (const c of recipients) {
      if (seen.has(c) || !c.caps.has(REDACTION_CAP)) continue;
      seen.add(c);
      this.tagged(c, line, `m${++this.msgidCounter}`);
    }
  }

  setTopic(from: string, channel: string, topic: string): void {
    this.topics.set(channel.toLowerCase(), topic);
    for (const c of this.members(channel)) {
      this.tagged(c, `:${from}!~${from}@peer.fake TOPIC ${channel} :${topic}`);
    }
  }

  // Force-change a client's nick from the server side (a SANICK).
  forceNick(nick: string, newNick: string): void {
    const c = this.client(nick);
    if (c) this.changeNick(c, newNick);
  }

  kick(channel: string, nick: string, by = 'oper'): void {
    const victim = this.client(nick);
    if (!victim) return;
    for (const c of this.members(channel)) {
      this.tagged(c, `:${by}!~${by}@peer.fake KICK ${channel} ${victim.nick} :out`);
    }
    victim.channels.delete(channel.toLowerCase());
  }

  // Inject an arbitrary server-side line to a client (CHGHOST, numerics, …).
  sendRaw(nick: string, line: string): void {
    const c = this.client(nick);
    if (c) this.raw(c, line);
  }

  // Close a client's socket from the server side, optionally after ERROR.
  drop(nick: string, withError = true): void {
    const c = this.client(nick);
    if (!c) return;
    if (withError) this.raw(c, 'ERROR :Closing Link: dropped by test');
    c.socket.end();
  }

  // --- internals -----------------------------------------------------------

  private accept(socket: net.Socket): void {
    const client: FakeClient = {
      socket,
      nick: null,
      user: null,
      registered: false,
      signon: 0,
      caps: new Set(),
      metadataSubs: new Set(),
      capNegotiating: false,
      channels: new Set(),
      certfp: peerCertFingerprint(socket),
      saslMech: null,
      account: null,
      sent: [],
    };
    this.clients.push(client);
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) this.onLine(client, line);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const ch of client.channels) this.partAll(client, ch);
      client.channels.clear();
    });
  }

  private hostmask(c: FakeClient): string {
    return `${c.nick}!~${c.user ?? 'u'}@${this.opts.clientHost ?? 'fake.host'}`;
  }

  private members(channel: string): FakeClient[] {
    const lower = channel.toLowerCase();
    return this.clients.filter((c) => c.channels.has(lower) && !c.socket.destroyed);
  }

  // Every line this server actually writes is also emitted as 'sent' (line,
  // client), so a test can log both directions of a conversation in causal
  // order. Only on a real write — a line dropped to a destroyed socket never
  // went on the wire and must not show up in a wire log.
  private raw(c: FakeClient, line: string): void {
    if (c.socket.destroyed) return;
    c.socket.write(line + '\r\n');
    this.emit('sent', line, c);
  }

  private num(c: FakeClient, code: string, ...params: string[]): void {
    const nick = c.nick ?? '*';
    const last = params.pop();
    const head = params.length ? ' ' + params.join(' ') : '';
    this.raw(
      c,
      `:${this.serverName} ${code} ${nick}${head}${last !== undefined ? ' :' + last : ''}`,
    );
  }

  // Prefix a relayed line with tags the client negotiated. `clientTags` are the
  // sender's `+`-prefixed tags, exactly as it wrote them (escaping included),
  // relayed only to a client that negotiated message-tags — as a real server does.
  private tagged(
    c: FakeClient,
    line: string,
    msgid?: string,
    clientTags: string[] = [],
    time = new Date().toISOString(),
  ): void {
    const tags: string[] = [];
    if (c.caps.has('server-time')) tags.push(`time=${time}`);
    if (c.caps.has('message-tags') && msgid) tags.push(`msgid=${msgid}`);
    if (c.caps.has('message-tags')) tags.push(...clientTags);
    this.raw(c, tags.length ? `@${tags.join(';')} ${line}` : line);
  }

  // The client-only (`+`) tags on a line as sent, still escaped.
  private static clientTagsOf(line: string): string[] {
    if (!line.startsWith('@')) return [];
    const end = line.indexOf(' ');
    return line
      .slice(1, end < 0 ? undefined : end)
      .split(';')
      .filter((t) => t.startsWith('+'));
  }

  private onLine(c: FakeClient, line: string): void {
    c.sent.push(line);
    this.emit('line', line, c);
    const msg = ircLineParser(line);
    if (!msg) return;
    const cmd = String(msg.command || '').toUpperCase();
    const p = msg.params;
    if (this.hold?.(cmd, p, c)) return;
    switch (cmd) {
      case 'CAP':
        return this.onCap(c, p);
      case 'NICK': {
        if (!p[0]) return this.num(c, '431', 'No nickname given');
        if (c.registered) return this.changeNick(c, p[0]);
        c.nick = p[0];
        return this.maybeRegister(c);
      }
      case 'USER':
        c.user = p[0] ?? null;
        return this.maybeRegister(c);
      case 'PASS':
        return;
      case 'AUTHENTICATE':
        return this.onAuthenticate(c, p[0] ?? '');
      case 'PING':
        return this.raw(c, `:${this.serverName} PONG ${this.serverName} :${p[p.length - 1] ?? ''}`);
      case 'PONG':
        return;
      case 'QUIT': {
        const reason = p[0] ? `Quit: ${p[0]}` : 'Quit';
        for (const ch of c.channels) {
          for (const m of this.members(ch)) {
            if (m !== c) this.tagged(m, `:${this.hostmask(c)} QUIT :${reason}`);
          }
        }
        c.channels.clear();
        this.raw(c, 'ERROR :Closing Link (Quit)');
        c.socket.end();
        return;
      }
    }
    if (!c.registered) return this.num(c, '451', 'You have not registered');
    switch (cmd) {
      case 'JOIN': {
        for (const chan of (p[0] ?? '').split(',').filter(Boolean)) {
          const lower = chan.toLowerCase();
          if (c.channels.has(lower)) continue;
          c.channels.add(lower);
          const joinLine = c.caps.has('extended-join')
            ? `:${this.hostmask(c)} JOIN ${chan} * :${c.user ?? ''}`
            : `:${this.hostmask(c)} JOIN ${chan}`;
          for (const m of this.members(chan)) this.tagged(m, joinLine);
          const topic = this.topics.get(lower);
          if (topic) this.num(c, '332', chan, topic);
          this.names(c, chan);
          // ergo's autoreplay-on-join: the last N lines, after the NAMES, to
          // a client without the cap (channel.go, HasHistoryCaps).
          const replay = this.chathistoryOpts()?.autoreplay ?? 0;
          if (replay > 0 && !c.caps.has('draft/chathistory')) {
            this.historyBatch(c, chan, (this.history.get(lower) ?? []).slice(-replay), true);
          }
        }
        return;
      }
      case 'PART': {
        const chan = p[0] ?? '';
        if (!c.channels.has(chan.toLowerCase()))
          return this.num(c, '442', chan, "You're not on that channel");
        for (const m of this.members(chan))
          this.tagged(m, `:${this.hostmask(c)} PART ${chan}${p[1] ? ' :' + p[1] : ''}`);
        c.channels.delete(chan.toLowerCase());
        return;
      }
      case 'NAMES':
        return this.names(c, p[0] ?? '');
      case 'PRIVMSG':
      case 'NOTICE': {
        const target = p[0] ?? '';
        const raw = p[1] ?? '';
        const text = this.opts.stripFormatting ? stripFormatting(raw) : raw;
        const msgid = `m${++this.msgidCounter}`;
        this.msgidOwner.set(msgid, c.nick ?? '');
        const out = `:${this.hostmask(c)} ${cmd} ${target} :${text}`;
        // Client-only tags (a reply's +reply) are relayed as a real ircd does:
        // only a message-tags sender's, and tagged() only hands them on to
        // message-tags recipients.
        const clientTags = c.caps.has('message-tags') ? FakeIrcd.clientTagsOf(line) : [];
        const time = new Date().toISOString();
        this.record(target, c.nick ?? '', { time, msgid, line: out, clientTags });
        if (isChannelTarget(target)) {
          for (const m of this.members(target)) {
            if (m !== c || c.caps.has('echo-message')) this.tagged(m, out, msgid, clientTags, time);
          }
        } else {
          const m = this.client(target);
          if (!m) return this.num(c, '401', target, 'No such nick/channel');
          this.tagged(m, out, msgid, clientTags, time);
          if (c.caps.has('echo-message')) this.tagged(c, out, msgid, clientTags, time);
        }
        return;
      }
      // Client-tag-only messages (+typing, +draft/react, …). Only a client that
      // negotiated message-tags may send one, and only such clients receive it.
      case 'TAGMSG': {
        if (!c.caps.has('message-tags')) return this.num(c, '421', 'TAGMSG', 'Unknown command');
        const target = p[0] ?? '';
        const msgid = `m${++this.msgidCounter}`;
        this.msgidOwner.set(msgid, c.nick ?? '');
        const clientTags = FakeIrcd.clientTagsOf(line);
        const out = `:${this.hostmask(c)} TAGMSG ${target}`;
        const time = new Date().toISOString();
        this.record(target, c.nick ?? '', { time, msgid, line: out, clientTags });
        const deliver = (m: FakeClient) => {
          if (m.caps.has('message-tags')) this.tagged(m, out, msgid, clientTags, time);
        };
        if (isChannelTarget(target)) {
          for (const m of this.members(target)) {
            if (m !== c || c.caps.has('echo-message')) deliver(m);
          }
        } else {
          const m = this.client(target);
          if (!m) return this.num(c, '401', target, 'No such nick/channel');
          deliver(m);
          if (c.caps.has('echo-message')) deliver(c);
        }
        return;
      }
      case 'TOPIC': {
        const chan = p[0] ?? '';
        if (p.length < 2) {
          const t = this.topics.get(chan.toLowerCase());
          return t ? this.num(c, '332', chan, t) : this.num(c, '331', chan, 'No topic is set');
        }
        this.topics.set(chan.toLowerCase(), p[1]);
        for (const m of this.members(chan))
          this.tagged(m, `:${this.hostmask(c)} TOPIC ${chan} :${p[1]}`);
        return;
      }
      case 'WHOIS': {
        const target = this.client(p[p.length - 1] ?? '');
        if (!target) return this.num(c, '401', p[0] ?? '', 'No such nick/channel');
        this.num(c, '311', target.nick!, `~${target.user}`, 'fake.host', '*', target.user ?? '');
        if (target === c) {
          this.num(c, '317', target.nick!, '0', String(target.signon), 'seconds idle, signon time');
        }
        this.num(c, '318', target.nick!, 'End of /WHOIS list');
        return;
      }
      case 'MODE': {
        if (isChannelTarget(p[0]) && p.length === 1) {
          this.num(c, '324', p[0], '+nt');
          if (this.opts.creationTime) this.num(c, '329', p[0], '1700000000');
          return;
        }
        // A list query: `MODE #chan b`, or `+b` with no mask.
        const listEnd =
          isChannelTarget(p[0]) && p.length === 2 ? LIST_ENDS[p[1].replace(/^\+/, '')] : undefined;
        if (listEnd) return this.num(c, listEnd, p[0], 'End of list');
        return;
      }
      case 'WHO':
        return this.who(c, p[0] ?? '*', p[1]);
      case 'LIST': {
        this.num(c, '321', 'Channel', 'Users  Name');
        for (const chan of this.channelNames()) {
          this.num(c, '322', chan, String(this.members(chan).length), this.topics.get(chan) ?? '');
        }
        return this.num(c, '323', 'End of /LIST');
      }
      case 'AWAY':
        return p[0]
          ? this.num(c, '306', 'You have been marked as being away')
          : this.num(c, '305', 'You are no longer marked as being away');
      case 'MONITOR':
        return;
      case 'METADATA':
        return this.onMetadata(c, p);
      case 'KICK': {
        const chan = p[0] ?? '';
        const victim = this.client(p[1] ?? '');
        if (!victim || !victim.channels.has(chan.toLowerCase())) return;
        for (const m of this.members(chan))
          this.tagged(m, `:${this.hostmask(c)} KICK ${chan} ${victim.nick} :${p[2] ?? 'kicked'}`);
        victim.channels.delete(chan.toLowerCase());
        return;
      }
      case 'MOTD':
        return this.sendMotd(c);
      // Message redaction (draft/message-redaction, #1013), with ergo's rules:
      // a client may delete its own lines, someone else's only as an op
      // (`redactAny`), and a msgid the fake never minted — or already deleted —
      // doesn't exist. The REDACT goes to every member (both DM parties) that
      // negotiated the cap, the sender included: ergo sends it back to the
      // deleting session, and that echo is what a client acts on.
      case 'REDACT': {
        if (!c.caps.has(REDACTION_CAP)) return this.num(c, '421', 'REDACT', 'Unknown command');
        const target = p[0] ?? '';
        const msgid = p[1] ?? '';
        const owner = this.msgidOwner.get(msgid);
        if (owner === undefined) {
          return this.raw(
            c,
            `:${this.serverName} FAIL REDACT UNKNOWN_MSGID ${target} ${msgid} :This message does not exist or is too old`,
          );
        }
        if (owner.toLowerCase() !== (c.nick ?? '').toLowerCase() && !this.opts.redactAny) {
          return this.raw(
            c,
            `:${this.serverName} FAIL REDACT REDACT_FORBIDDEN ${target} ${msgid} :You are not authorized to delete this message`,
          );
        }
        this.msgidOwner.delete(msgid);
        this.relayRedact(this.hostmask(c), target, msgid, p[2], c);
        return;
      }
      // A client's draft/multiline batch (`BATCH +ref draft/multiline <target>`
      // … `BATCH -ref`): taken, nothing sent for it. The tagged PRIVMSGs inside
      // relay one by one above, as a member without the cap would see them.
      case 'BATCH':
        if (!c.caps.has('draft/multiline')) return this.num(c, '421', cmd, 'Unknown command');
        return;
      case 'CHATHISTORY':
        return this.onChathistory(c, p);
      default:
        return this.num(c, '421', cmd, 'Unknown command');
    }
  }

  private onCap(c: FakeClient, p: string[]): void {
    const sub = (p[0] ?? '').toUpperCase();
    if (sub === 'LS') {
      c.capNegotiating = true;
      // Two lines when asked for 302, to exercise multi-line LS handling.
      if (p[1] === '302' && this.caps.length > 2) {
        const half = Math.ceil(this.caps.length / 2);
        this.raw(c, `:${this.serverName} CAP * LS * :${this.caps.slice(0, half).join(' ')}`);
        this.raw(c, `:${this.serverName} CAP * LS :${this.caps.slice(half).join(' ')}`);
      } else {
        this.raw(c, `:${this.serverName} CAP * LS :${this.caps.join(' ')}`);
      }
    } else if (sub === 'REQ') {
      const wanted = (p[1] ?? '').split(' ').filter(Boolean);
      // Match on the cap NAME: an advertised cap may carry a value (`sasl=PLAIN`),
      // and a client REQs the bare name.
      const offered = new Set(this.caps.map(capName));
      const refused = new Set(this.opts.refuse ?? []);
      const ok = wanted.every((w) => {
        const name = capName(w.replace(/^-/, ''));
        return offered.has(name) && !refused.has(name);
      });
      if (ok) {
        for (const w of wanted) {
          if (w.startsWith('-')) c.caps.delete(w.slice(1));
          else c.caps.add(w);
        }
        this.raw(c, `:${this.serverName} CAP ${c.nick ?? '*'} ACK :${wanted.join(' ')}`);
      } else {
        this.raw(c, `:${this.serverName} CAP ${c.nick ?? '*'} NAK :${wanted.join(' ')}`);
      }
    } else if (sub === 'END') {
      c.capNegotiating = false;
      this.maybeRegister(c);
    }
  }

  // SASL, as much of it as a client can tell apart: the mechanism is offered or
  // it isn't, the credential is right or it isn't. EXTERNAL is the one that
  // matters here — it carries no credential at all, so the answer turns entirely
  // on the certificate presented back at the handshake.
  private onAuthenticate(c: FakeClient, arg: string): void {
    const mechanisms = this.saslMechanisms();
    if (!mechanisms.length) return this.num(c, '904', 'SASL authentication failed');
    if (!c.saslMech) {
      const mech = arg.toUpperCase();
      if (!mechanisms.includes(mech)) {
        return this.num(c, '904', 'SASL authentication failed');
      }
      c.saslMech = mech;
      // '+' means "go ahead": the client answers with its payload, or with a
      // bare '+' for EXTERNAL, which has none.
      return this.raw(c, 'AUTHENTICATE +');
    }
    const mech = c.saslMech;
    c.saslMech = null;
    if (mech === 'EXTERNAL') {
      const account = c.certfp ? this.certfpAccounts.get(c.certfp) : undefined;
      if (!account) {
        // What an ircd says to a certificate nobody registered — and, just as
        // importantly, to a client that presented none at all.
        return this.num(c, '904', 'SASL authentication failed');
      }
      return this.saslSucceeded(c, account);
    }
    // PLAIN: authzid\0authcid\0password
    const [, authcid, password] = Buffer.from(arg === '+' ? '' : arg, 'base64')
      .toString('utf8')
      .split('\u0000');
    if (!authcid || this.saslAccounts.get(authcid) !== password) {
      return this.num(c, '904', 'SASL authentication failed');
    }
    return this.saslSucceeded(c, authcid);
  }

  private saslSucceeded(c: FakeClient, account: string): void {
    c.account = account;
    this.num(
      c,
      '900',
      `${c.nick ?? '*'}!${c.user ?? 'u'}@127.0.0.1`,
      account,
      `You are now logged in as ${account}`,
    );
    this.num(c, '903', 'SASL authentication successful');
  }

  private saslMechanisms(): string[] {
    const advertised = this.caps.find((cap) => capName(cap) === 'sasl');
    if (!advertised) return [];
    return (advertised.split('=')[1] ?? '').split(',').filter(Boolean);
  }

  private maybeRegister(c: FakeClient): void {
    if (c.registered || !c.nick || !c.user || c.capNegotiating) return;
    c.registered = true;
    c.signon = Math.floor(Date.now() / 1000);
    this.registrations.push({ nick: c.nick, at: Date.now() });
    const n = c.nick;
    this.num(c, '001', `Welcome to the ${this.network} IRC Network ${n}`);
    this.num(c, '002', `Your host is ${this.serverName}, running version fake-1.0`);
    this.num(c, '003', 'This server was created just now');
    this.num(c, '004', this.serverName, 'fake-1.0', 'iow', 'ntk', 'k');
    this.num(
      c,
      '005',
      'CASEMAPPING=ascii',
      `CHANTYPES=${CHANNEL_PREFIX_CHARS}`,
      `NETWORK=${this.network}`,
      'NICKLEN=32',
      'PREFIX=(ov)@+',
      'MONITOR=100',
      ...(this.opts.whox ? ['WHOX'] : []),
      ...(this.chathistoryOpts()
        ? [`CHATHISTORY=${this.chathistoryOpts()!.limit}`, 'MSGREFTYPES=timestamp']
        : []),
      ...(this.opts.isupport ?? []),
      'are supported by this server',
    );
    if (this.opts.burstNickTo) {
      const to = this.opts.burstNickTo;
      this.raw(c, `:${this.hostmask(c)} NICK :${to}`);
      c.nick = to;
    }
    for (const line of this.opts.burstLines?.(c) ?? []) this.raw(c, line);
    this.num(c, '251', 'There are 1 users on 1 servers');
    this.sendMotd(c);
    this.emit('registered', c);
  }

  // The MOTD (or its absence), at registration and for a MOTD command.
  private sendMotd(c: FakeClient): void {
    if (this.opts.motd === false) {
      this.num(c, '422', 'MOTD File is missing');
      return;
    }
    this.num(c, '375', `- ${this.serverName} Message of the day -`);
    this.num(c, '372', '- welcome to the fake');
    for (let i = 0; i < (this.opts.motdPadLines ?? 0); i++) {
      this.num(
        c,
        '372',
        `- ${String(i).padStart(4, '0')} ${'pad '.repeat(i % 10 === 9 ? 8 : 255)}`,
      );
    }
    this.num(c, '376', 'End of /MOTD command.');
  }

  // WHO for a channel's members, or for one nick. A `%<fields>[,<token>]` second
  // argument asks for WHOX: a 354 with the fields in the spec's fixed order.
  // Without the `whox` option, just the 315.
  private who(c: FakeClient, mask: string, options: string | undefined): void {
    if (this.opts.whox) {
      const onChannel = isChannelTarget(mask);
      const found = onChannel ? this.members(mask) : [this.client(mask)];
      const whox = options?.startsWith('%') ? options.slice(1).split(',') : null;
      for (const m of found) {
        if (!m) continue;
        const user = `~${m.user ?? 'u'}`;
        const realname = m.user ?? '';
        if (!whox) {
          this.num(
            c,
            '352',
            onChannel ? mask : '*',
            user,
            'fake.host',
            this.serverName,
            m.nick!,
            'H',
            `0 ${realname}`,
          );
          continue;
        }
        const [fields = '', token = ''] = whox;
        const value: Record<string, string> = {
          t: token,
          c: onChannel ? mask : '*',
          u: user,
          i: '255.255.255.255',
          h: 'fake.host',
          s: this.serverName,
          n: m.nick!,
          f: 'H',
          d: '0',
          l: '0',
          a: m.account ?? '0',
          o: 'n/a',
          r: realname,
        };
        const params = [...'tcuihsnfdlaor'].filter((f) => fields.includes(f)).map((f) => value[f]);
        this.num(c, '354', ...params);
      }
    }
    this.num(c, '315', mask, 'End of WHO list');
  }

  // Every channel someone is in, folded.
  private channelNames(): string[] {
    const names = new Set<string>();
    for (const c of this.clients) {
      if (c.socket.destroyed) continue;
      for (const chan of c.channels) names.add(chan);
    }
    return [...names];
  }

  private names(c: FakeClient, chan: string): void {
    const nicks = this.members(chan).map((m) => m.nick!);
    this.num(c, '353', '=', chan, nicks.join(' '));
    this.num(c, '366', chan, 'End of /NAMES list.');
  }

  private changeNick(c: FakeClient, newNick: string): void {
    if (this.client(newNick)) return this.num(c, '433', newNick, 'Nickname is already in use');
    const line = `:${this.hostmask(c)} NICK :${newNick}`;
    const seen = new Set<FakeClient>([c]);
    for (const ch of c.channels) for (const m of this.members(ch)) seen.add(m);
    for (const m of seen) this.tagged(m, line);
    const meta = this.metadata.get(c.nick!.toLowerCase());
    if (meta) {
      this.metadata.delete(c.nick!.toLowerCase());
      this.metadata.set(newNick.toLowerCase(), meta);
    }
    c.nick = newNick;
  }

  // --- draft/metadata-2 ----------------------------------------------------

  // Set (or, with null, unset) a key on a nick or channel from the server
  // side — what another client's SET or services would do — and tell every
  // subscribed client in the audience.
  setMetadata(target: string, key: string, value: string | null): void {
    const store = this.metadata.get(target.toLowerCase()) ?? new Map<string, string>();
    if (value === null) store.delete(key);
    else store.set(key, value);
    this.metadata.set(target.toLowerCase(), store);
    for (const m of this.metadataAudience(target)) this.notifyMetadata(m, target, key, value);
  }

  // A raw server line to one client, for the mid-session lines a test wants
  // to see handled (a CAP NEW, a FAIL).
  inject(nick: string, line: string): void {
    const c = this.client(nick);
    if (c) this.raw(c, line);
  }

  // A line as if the client had sent it: the one a `hold` swallowed, once the
  // test is ready for the server to act on it.
  feed(nick: string, line: string): void {
    const c = this.client(nick);
    if (c) this.onLine(c, line);
  }

  // Who hears a change on `target`: a channel's members, or every client that
  // shares a channel with the nick (and the nick itself).
  private metadataAudience(target: string): FakeClient[] {
    if (isChannelTarget(target)) return this.members(target);
    const subject = this.client(target);
    if (!subject) return [];
    const out = new Set<FakeClient>([subject]);
    for (const ch of subject.channels) for (const m of this.members(ch)) out.add(m);
    return [...out];
  }

  private notifyMetadata(c: FakeClient, target: string, key: string, value: string | null): void {
    if (!c.caps.has('draft/metadata-2') || !c.metadataSubs.has(key)) return;
    if (value === null) this.raw(c, `:${this.serverName} 766 * ${target} ${key} :Key deleted`);
    else this.raw(c, `:${this.serverName} 761 * ${target} ${key} * :${value}`);
  }

  // A `metadata` batch of 761s for `targets` (channel + members for a channel,
  // one nick, or everything the client can see for `*ALL`).
  private metadataBatch(c: FakeClient, label: string, targets: string[]): void {
    const ref = `mb${++this.msgidCounter}`;
    this.raw(c, `:${this.serverName} BATCH +${ref} metadata ${label}`);
    for (const target of targets) {
      const store = this.metadata.get(target.toLowerCase());
      if (!store) continue;
      for (const [key, value] of store) {
        if (!c.metadataSubs.has(key)) continue;
        this.raw(c, `@batch=${ref} :${this.serverName} 761 ${c.nick} ${target} ${key} * :${value}`);
      }
    }
    this.raw(c, `:${this.serverName} BATCH -${ref}`);
  }

  private onMetadata(c: FakeClient, p: string[]): void {
    if (!c.caps.has('draft/metadata-2')) return this.num(c, '421', 'METADATA', 'Unknown command');
    const rawTarget = p[0] ?? '';
    const sub = (p[1] ?? '').toUpperCase();
    const target = rawTarget === '*' ? c.nick! : rawTarget;
    const fail = (code: string, ...rest: string[]) =>
      this.raw(c, `:${this.serverName} FAIL METADATA ${code} ${rest.join(' ')}`);
    switch (sub) {
      case 'SUB': {
        const keys = p.slice(2);
        let added = 0;
        for (const key of keys) {
          if (!METADATA_KEY_RE.test(key)) return fail('INVALID_KEY', key, ':Invalid key name');
          if (!c.metadataSubs.has(key)) added++;
          c.metadataSubs.add(key);
        }
        if (keys.length) this.num(c, '770', ...keys);
        // ergo: the current values come by a SYNC the client asks for — and
        // only when the SUB added a key. A repeated SUB draws nothing more.
        if (added > 0) this.raw(c, `:${this.serverName} 774 * *ALL 0 :Try again later`);
        return;
      }
      case 'UNSUB': {
        const keys = p.slice(2);
        for (const key of keys) c.metadataSubs.delete(key);
        if (keys.length) this.num(c, '771', ...keys);
        return;
      }
      case 'SUBS': {
        const ref = `mb${++this.msgidCounter}`;
        this.raw(c, `:${this.serverName} BATCH +${ref} metadata-subs`);
        const subs = [...c.metadataSubs];
        if (subs.length)
          this.raw(c, `@batch=${ref} :${this.serverName} 772 ${c.nick} ${subs.join(' ')}`);
        this.raw(c, `:${this.serverName} BATCH -${ref}`);
        return;
      }
      case 'SET': {
        const key = p[2] ?? '';
        if (!METADATA_KEY_RE.test(key)) return fail('INVALID_KEY', key, ':Invalid key name');
        if (!isChannelTarget(target) && target.toLowerCase() !== c.nick!.toLowerCase()) {
          return fail('KEY_NO_PERMISSION', target, key, ':You do not have permission');
        }
        if (!isChannelTarget(target) && this.metadataSetsToThrottle > 0) {
          this.metadataSetsToThrottle--;
          return fail('RATE_LIMITED', rawTarget, key, this.metadataRetryAfter, ':Please wait');
        }
        const value = p.length >= 4 ? (p[3] ?? '') : null;
        // The setter's own reply, then the audience (which excludes the setter).
        if (value === null)
          this.raw(c, `:${this.serverName} 766 ${c.nick} ${target} ${key} :Key deleted`);
        else this.raw(c, `:${this.serverName} 761 ${c.nick} ${target} ${key} * :${value}`);
        const store = this.metadata.get(target.toLowerCase()) ?? new Map<string, string>();
        if (value === null) store.delete(key);
        else store.set(key, value);
        this.metadata.set(target.toLowerCase(), store);
        for (const m of this.metadataAudience(target)) {
          if (m !== c) this.notifyMetadata(m, target, key, value);
        }
        return;
      }
      case 'GET': {
        const ref = `mb${++this.msgidCounter}`;
        this.raw(c, `:${this.serverName} BATCH +${ref} metadata ${target}`);
        const store = this.metadata.get(target.toLowerCase());
        for (const key of p.slice(2)) {
          const value = store?.get(key);
          if (value === undefined) {
            this.raw(
              c,
              `@batch=${ref} :${this.serverName} 766 ${c.nick} ${target} ${key} :key not set`,
            );
          } else {
            this.raw(
              c,
              `@batch=${ref} :${this.serverName} 761 ${c.nick} ${target} ${key} * :${value}`,
            );
          }
        }
        this.raw(c, `:${this.serverName} BATCH -${ref}`);
        return;
      }
      case 'LIST': {
        const ref = `mb${++this.msgidCounter}`;
        this.raw(c, `:${this.serverName} BATCH +${ref} metadata ${target}`);
        for (const [key, value] of this.metadata.get(target.toLowerCase()) ?? []) {
          this.raw(
            c,
            `@batch=${ref} :${this.serverName} 761 ${c.nick} ${target} ${key} * :${value}`,
          );
        }
        this.raw(c, `:${this.serverName} BATCH -${ref}`);
        return;
      }
      case 'SYNC': {
        if (rawTarget === '*ALL') {
          const targets = new Set<string>([c.nick!]);
          for (const ch of c.channels) {
            targets.add(ch);
            for (const m of this.members(ch)) targets.add(m.nick!);
          }
          return this.metadataBatch(c, '*ALL', [...targets]);
        }
        if (isChannelTarget(target)) {
          return this.metadataBatch(c, target, [
            target,
            ...this.members(target).map((m) => m.nick!),
          ]);
        }
        return this.metadataBatch(c, target, [target]);
      }
      default:
        return fail('SUBCOMMAND_INVALID', sub, ':Invalid subcommand');
    }
  }

  private partAll(c: FakeClient, lower: string): void {
    for (const m of this.members(lower)) {
      if (m !== c) this.tagged(m, `:${this.hostmask(c)} QUIT :Connection closed`);
    }
  }
}

// Convenience for tests: a raw client socket that speaks enough IRC to register
// and observe, without irc-framework in the loop.
export async function rawClient(
  port: number,
  nick: string,
): Promise<{
  socket: net.Socket;
  lines: string[];
  send: (l: string) => void;
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
}> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  const lines: string[] = [];
  let buf = '';
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl).replace(/\r$/, ''));
      buf = buf.slice(nl + 1);
    }
  });
  const send = (l: string) => socket.write(l + '\r\n');
  const waitFor = (re: RegExp, ms = 5000): Promise<string> =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + ms;
      const tick = () => {
        const hit = lines.find((l) => re.test(l));
        if (hit) return resolve(hit);
        if (Date.now() > deadline) return reject(new Error(`rawClient: no line matching ${re}`));
        setTimeout(tick, 10);
      };
      tick();
    });
  send(`NICK ${nick}`);
  send(`USER ${nick} 0 * :${nick}`);
  await waitFor(/ 001 /);
  return { socket, lines, send, waitFor };
}
