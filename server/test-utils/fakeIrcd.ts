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
import tls from 'node:tls';
import { EventEmitter, once } from 'node:events';
import { generate as generateSelfSigned } from 'selfsigned';
import { ircLineParser } from 'irc-framework';
import { CHANNEL_PREFIX_CHARS, isChannelTarget } from '../../shared/channels.js';

export interface FakeIrcdOptions {
  tls?: boolean;
  // Advertise these in CAP LS (and ACK them when requested).
  caps?: string[];
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
  serverName?: string;
  network?: string;
  // Ask every TLS client for a certificate and record what it presents, the way
  // an ircd doing CertFP does — it hashes what you show it rather than
  // verifying a chain, so anything is accepted. Meaningless without `tls`.
  requestClientCert?: boolean;
  // Offer SASL: advertises `sasl=<mechanisms>` in CAP LS and answers
  // AUTHENTICATE. Defaults to PLAIN + EXTERNAL when passed `true`.
  sasl?: boolean | { mechanisms: string[] };
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
  // Every line this client sent, in order.
  sent: string[];
}

const DEFAULT_CAPS = [
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
  // Fingerprint → account, i.e. what `/msg NickServ CERT ADD` leaves behind.
  // SASL EXTERNAL succeeds for a client whose presented certfp is in here and
  // fails for one whose isn't, which is the whole of CertFP as a client sees it.
  readonly certfpAccounts = new Map<string, string>();
  // account → password, for SASL PLAIN.
  readonly saslAccounts = new Map<string, string>();
  // Test hook: return true to swallow a client command — no reply of any kind —
  // for a test of what the client does when a reply never comes.
  hold: ((cmd: string, params: string[], c: FakeClient) => boolean) | null = null;
  private msgidCounter = 0;
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
    this.serverName = opts.serverName ?? 'fake.test';
    this.network = opts.network ?? 'FakeNet';
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

  // Deliver a line from a synthetic peer to a nick or a channel.
  say(from: string, target: string, text: string): string {
    const msgid = `m${++this.msgidCounter}`;
    const line = `:${from}!~${from}@peer.fake PRIVMSG ${target} :${text}`;
    if (isChannelTarget(target)) {
      for (const c of this.members(target)) this.tagged(c, line, msgid);
    } else {
      const c = this.client(target);
      if (c) this.tagged(c, line, msgid);
    }
    return msgid;
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
    return `${c.nick}!~${c.user ?? 'u'}@fake.host`;
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

  // Prefix a relayed line with tags the client negotiated.
  private tagged(c: FakeClient, line: string, msgid?: string): void {
    const tags: string[] = [];
    if (c.caps.has('server-time')) tags.push(`time=${new Date().toISOString()}`);
    if (c.caps.has('message-tags') && msgid) tags.push(`msgid=${msgid}`);
    this.raw(c, tags.length ? `@${tags.join(';')} ${line}` : line);
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
        const text = p[1] ?? '';
        const msgid = `m${++this.msgidCounter}`;
        const out = `:${this.hostmask(c)} ${cmd} ${target} :${text}`;
        if (isChannelTarget(target)) {
          for (const m of this.members(target)) {
            if (m !== c || c.caps.has('echo-message')) this.tagged(m, out, msgid);
          }
        } else {
          const m = this.client(target);
          if (!m) return this.num(c, '401', target, 'No such nick/channel');
          this.tagged(m, out, msgid);
          if (c.caps.has('echo-message')) this.tagged(c, out, msgid);
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
        if (isChannelTarget(p[0]) && p.length === 1) return this.num(c, '324', p[0], '+nt');
        return;
      }
      case 'WHO':
        return this.num(c, '315', p[0] ?? '*', 'End of WHO list');
      case 'AWAY':
        return p[0]
          ? this.num(c, '306', 'You have been marked as being away')
          : this.num(c, '305', 'You are no longer marked as being away');
      case 'MONITOR':
        return;
      case 'KICK': {
        const chan = p[0] ?? '';
        const victim = this.client(p[1] ?? '');
        if (!victim || !victim.channels.has(chan.toLowerCase())) return;
        for (const m of this.members(chan))
          this.tagged(m, `:${this.hostmask(c)} KICK ${chan} ${victim.nick} :${p[2] ?? 'kicked'}`);
        victim.channels.delete(chan.toLowerCase());
        return;
      }
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
      const ok = wanted.every((w) => offered.has(capName(w.replace(/^-/, ''))));
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
      'are supported by this server',
    );
    if (this.opts.burstNickTo) {
      const to = this.opts.burstNickTo;
      this.raw(c, `:${this.hostmask(c)} NICK :${to}`);
      c.nick = to;
    }
    this.num(c, '251', 'There are 1 users on 1 servers');
    if (this.opts.motd === false) {
      this.num(c, '422', 'MOTD File is missing');
    } else {
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
    this.emit('registered', c);
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
    c.nick = newNick;
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
