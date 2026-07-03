// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Built-in IRC bouncer (ZNC-style). An opt-in TCP/TLS listener that speaks the
// IRC *server* protocol, so any ordinary IRC client (WeeChat, irssi, Textual,
// HexChat, …) can attach to a user's always-on Lurker connection and use it
// like a ZNC network: shared upstream socket, shared nick, history playback on
// attach, and everything the client sends flows through the same ircManager
// paths the web UI uses (so messages persist and fan out to web tabs too).
//
// Attach protocol (ZNC-compatible credential shapes):
//   PASS <username>:<password-or-api-token>            single network
//   PASS <username>/<network>:<password-or-api-token>  pick a network by name/id
//   …or put `username/network` in the USER field and only the secret in PASS.
// The secret may be the account password or an active read-write API token
// (Settings → API tokens) — tokens are recommended since client configs store
// the value in plaintext.
//
// Design notes / v1 limitations, all deliberate:
// - Upstream→client traffic is relayed as the RAW wire lines the network sent
//   (minus registration/PING plumbing), so semantics stay exact. That means
//   Lurker-level ignore rules and RPE2E decryption do NOT apply to live relay:
//   an ignored sender is still visible in an attached client, and E2E channel
//   traffic shows as ciphertext there (your own sends echo as plaintext).
// - Numeric replies to one attached client's query (WHOIS, LIST, …) are
//   broadcast to every client attached to that network — the classic
//   shared-connection bouncer quirk.
// - Detaching (client QUIT / socket drop) never touches the upstream
//   connection; Lurker stays online exactly like ZNC.

import net from 'net';
import tls from 'tls';
import fs from 'fs';
import ircManager from './ircManager.js';
import type { IrcConnection } from './ircConnection.js';
import * as systemLog from './systemLog.js';
import { findUserByUsername, getPasswordHash } from '../db/users.js';
import type { User } from '../db/users.js';
import { verifyPassword } from './password.js';
import { hashToken, findActiveByHash, touchLastUsed } from '../db/apiTokens.js';
import { listNetworksForUser, upsertChannel } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { reopenBuffer, isClosed as isBufferClosed } from '../db/closedBuffers.js';
import { listMessages, listBuffersForNetwork } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { splitSay, splitAction } from './messageSplit.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';

const SERVER_NAME = 'lurker.bouncer';

// Caps we can honestly offer an attaching client. server-time stamps playback
// and relayed lines; message-tags passes upstream tags through verbatim;
// echo-message opts the client into receiving its own sends back (otherwise we
// suppress the echo, since the client already rendered the message locally);
// znc.in/self-message is a marker cap — clients that know it render
// `:you PRIVMSG peer` playback/sync lines as *your* outgoing DMs.
const SUPPORTED_CAPS = ['server-time', 'message-tags', 'echo-message', 'znc.in/self-message'];

// Upstream wire commands never relayed to attached clients: connection
// plumbing that belongs to Lurker's own registration/keepalive (we answer the
// client's PINGs ourselves and replay our own welcome burst at attach), plus
// SASL/STARTTLS numerics from an upstream re-registration that would confuse a
// client that never negotiated them.
const RELAY_DROP = new Set([
  'PING',
  'PONG',
  'CAP',
  'AUTHENTICATE',
  'ERROR',
  '001',
  '002',
  '003',
  '004',
  '005',
  '670',
  '691',
  '900',
  '901',
  '902',
  '903',
  '904',
  '905',
  '906',
  '907',
  '908',
]);

const REGISTRATION_TIMEOUT_MS = 60_000;
// Heartbeat: PING an idle client after this much silence, and reap it when the
// silence outlives the reap threshold (any inbound line counts as activity).
const HEARTBEAT_INTERVAL_MS = 45_000;
const HEARTBEAT_PING_AFTER_MS = 90_000;
const HEARTBEAT_REAP_AFTER_MS = 240_000;
const MAX_INPUT_BUFFER = 64 * 1024;
// Cap DM buffers replayed on attach so a years-old account doesn't spew every
// conversation it ever had; joined channels are always replayed.
const PLAYBACK_MAX_DM_BUFFERS = 20;

// Per-IP failed-auth throttle: after MAX failures inside the window, further
// attempts from that address are refused before touching scrypt.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 10;
const authFailures = new Map<string, { count: number; resetAt: number }>();

function authThrottled(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= AUTH_FAIL_MAX;
}

function noteAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authFailures.get(ip);
  if (!entry || now > entry.resetAt) {
    authFailures.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

// Tests reset between cases; production never calls this.
export function resetAuthThrottle(): void {
  authFailures.clear();
}

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedClientLine {
  command: string;
  params: string[];
}

/** Parse one client→server IRC line: optional @tags and :prefix are ignored. */
export function parseClientLine(raw: string): ParsedClientLine | null {
  // eslint-disable-next-line no-control-regex
  let line = raw.replace(/[\r\n\u0000]/g, '');
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp === -1) return null;
    line = line.slice(sp + 1);
  }
  line = line.replace(/^ +/, '');
  if (line.startsWith(':')) {
    const sp = line.indexOf(' ');
    if (sp === -1) return null;
    line = line.slice(sp + 1).replace(/^ +/, '');
  }
  if (!line) return null;
  let trailing: string | null = null;
  let head = line;
  if (line.startsWith(':')) return null;
  const ti = line.indexOf(' :');
  if (ti !== -1) {
    trailing = line.slice(ti + 2);
    head = line.slice(0, ti);
  }
  const parts = head.split(' ').filter(Boolean);
  if (parts.length === 0) return null;
  const command = parts.shift()!.toUpperCase();
  const params = parts;
  if (trailing !== null) params.push(trailing);
  return { command, params };
}

/** Rebuild a parsed client line for verbatim upstream forwarding. */
export function rebuildLine({ command, params }: ParsedClientLine): string {
  if (params.length === 0) return command;
  const head = params.slice(0, -1);
  const last = params[params.length - 1];
  const needsTrailing = last === '' || last.includes(' ') || last.startsWith(':');
  return [command, ...head, needsTrailing ? `:${last}` : last].join(' ');
}

export interface BouncerCredentials {
  username: string;
  secret: string;
  network: string | null;
}

// PASS carries `user[/network]:secret` (ZNC shape); when PASS is just the
// secret, the login (and optional `/network`) rides the USER field instead. A
// ZNC-style `@clientid` in the login part is accepted and discarded.
export function parseBouncerCredentials(
  pass: string,
  userField: string | null,
): BouncerCredentials | null {
  let loginPart = '';
  let secret = pass;
  const colon = pass.indexOf(':');
  if (colon !== -1) {
    loginPart = pass.slice(0, colon);
    secret = pass.slice(colon + 1);
  }
  if (!loginPart) loginPart = userField || '';
  let network: string | null = null;
  const slash = loginPart.indexOf('/');
  if (slash !== -1) {
    network = loginPart.slice(slash + 1) || null;
    loginPart = loginPart.slice(0, slash);
  }
  // The network selector may also ride the USER field while the login came
  // from PASS (`PASS user:secret` + `USER user/libera …`).
  if (!network && userField) {
    const uSlash = userField.indexOf('/');
    if (uSlash !== -1) network = userField.slice(uSlash + 1) || null;
  }
  const at = loginPart.indexOf('@');
  if (at !== -1) loginPart = loginPart.slice(0, at);
  if (!loginPart || !secret) return null;
  return { username: loginPart, secret, network };
}

// Rewrite the target-nick param of a server numeric (`:prefix NNN nick …`).
// Used to point the replayed registration burst at whatever nick the attaching
// client asked for, ZNC-style, before we NICK it over to the live one.
export function rewriteNumericTarget(line: string, nick: string): string {
  // [\s\S] instead of `.` so a stray trailing CR can't stop the tail group
  // short of `$` and silently skip the rewrite.
  const m = /^(:\S+ \S+ )\S+([\s\S]*)$/.exec(line);
  if (!m) return line;
  return `${m[1]}${nick}${m[2]}`;
}

/**
 * Filter one raw upstream line for an attached client: drop connection
 * plumbing, drop tag-only commands the client can't parse, and strip message
 * tags down to what the client negotiated (everything for message-tags, just
 * `time` for server-time, nothing otherwise). Returns null to drop the line.
 */
export function filterRelayLine(line: string, caps: ReadonlySet<string>): string | null {
  // irc-framework's raw event line keeps its trailing CR — strip it so the
  // relayed copy doesn't carry a stray control char into our own CRLF framing.
  line = line.replace(/[\r\n]+$/, '');
  let tags = '';
  let rest = line;
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    tags = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let afterPrefix = rest;
  if (afterPrefix.startsWith(':')) {
    const sp = afterPrefix.indexOf(' ');
    if (sp === -1) return null;
    afterPrefix = afterPrefix.slice(sp + 1);
  }
  const command = (afterPrefix.split(' ', 1)[0] || '').toUpperCase();
  if (RELAY_DROP.has(command)) return null;
  if ((command === 'TAGMSG' || command === 'BATCH') && !caps.has('message-tags')) return null;
  if (!tags) return line;
  if (caps.has('message-tags')) return line;
  if (caps.has('server-time')) {
    const time = tags.split(';').find((t) => t === 'time' || t.startsWith('time='));
    if (time) return `@${time} ${rest}`;
  }
  return rest;
}

// Default IRC prefix ladder, used when the network's ISUPPORT PREFIX isn't
// available (attached while upstream is still registering).
const DEFAULT_PREFIXES: Array<{ mode: string; symbol: string }> = [
  { mode: 'q', symbol: '~' },
  { mode: 'a', symbol: '&' },
  { mode: 'o', symbol: '@' },
  { mode: 'h', symbol: '%' },
  { mode: 'v', symbol: '+' },
];

export function memberPrefixSymbol(
  memberModes: string[],
  prefixes: Array<{ mode: string; symbol: string }> = DEFAULT_PREFIXES,
): string {
  for (const p of prefixes) {
    if (memberModes.includes(p.mode)) return p.symbol;
  }
  return '';
}

/** Chunk a NAMES membership list into 353 lines under the 512-byte wire cap. */
export function buildNamesLines(nick: string, channel: string, names: string[]): string[] {
  const base = `:${SERVER_NAME} 353 ${nick} = ${channel} :`;
  const budget = Math.max(64, 480 - base.length);
  const lines: string[] = [];
  let chunk: string[] = [];
  let len = 0;
  for (const name of names) {
    const add = chunk.length === 0 ? name.length : name.length + 1;
    if (len + add > budget && chunk.length > 0) {
      lines.push(base + chunk.join(' '));
      chunk = [];
      len = 0;
    }
    chunk.push(name);
    len += chunk.length === 1 ? name.length : add;
  }
  if (chunk.length > 0) lines.push(base + chunk.join(' '));
  lines.push(`:${SERVER_NAME} 366 ${nick} ${channel} :End of /NAMES list.`);
  return lines;
}

function toIrcTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function isChannelName(target: string): boolean {
  return target.startsWith('#') || target.startsWith('&');
}

// Network-services pseudo-users (NickServ/ChanServ/…). Playback replays their
// buffers like any DM, but never the user's OWN lines to them — the self side
// routinely contains credentials (`msg NickServ IDENTIFY <password>` from a
// client's perform/on-connect) that would otherwise land in every attached
// client's logs on every reconnect.
export function isServicesNick(nick: string): boolean {
  const lower = nick.toLowerCase();
  return /^[a-z]+serv$/.test(lower) || lower === 'global' || lower === 'services';
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Set<BouncerSession>();
const registry = new Map<string, Set<BouncerSession>>();

function registryKey(userId: number, networkId: number): string {
  return `${userId}:${networkId}`;
}

function attachToRegistry(session: BouncerSession): void {
  const key = registryKey(session.userId, session.networkId);
  let set = registry.get(key);
  if (!set) {
    set = new Set();
    registry.set(key, set);
  }
  set.add(session);
}

function detachFromRegistry(session: BouncerSession): void {
  const key = registryKey(session.userId, session.networkId);
  const set = registry.get(key);
  if (!set) return;
  set.delete(session);
  if (set.size === 0) registry.delete(key);
}

export function attachedSessionCount(userId?: number, networkId?: number): number {
  if (userId == null) return sessions.size;
  if (networkId == null) {
    let n = 0;
    for (const s of sessions) if (s.userId === userId && s.isRegistered()) n += 1;
    return n;
  }
  return registry.get(registryKey(userId, networkId))?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class BouncerSession {
  readonly caps = new Set<string>();
  userId = 0;
  networkId = 0;
  lastActivityAt = Date.now();

  private readonly socket: net.Socket;
  private readonly remoteIp: string;
  private buf = '';
  private capNegotiating = false;
  private passRaw: string | null = null;
  private clientNick: string | null = null;
  private clientUser: string | null = null;
  private registered = false;
  private closed = false;
  private conn: IrcConnection | null = null;
  private network: Network | null = null;
  // Outbound sends awaiting their self-echo event from ircManager, so a
  // client that didn't negotiate echo-message doesn't get its own message
  // back (it already rendered it locally). Other attached clients and web
  // tabs still receive the echo. Keys are per wire chunk, and entries expire
  // after a short window so an unconsumed key (from the rare chunking-
  // mismatch cases) can't suppress an identical message sent much later.
  private pendingEcho: Array<{ key: string; at: number }> = [];
  private onRawUpstream: ((event: { from_server: boolean; line: string }) => void) | null = null;
  private regTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.remoteIp = socket.remoteAddress || 'unknown';
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this.destroy());
    this.regTimer = setTimeout(() => {
      this.closeWithError('Registration timeout');
    }, REGISTRATION_TIMEOUT_MS);
    this.regTimer.unref?.();
  }

  isRegistered(): boolean {
    return this.registered;
  }

  private write(line: string): void {
    if (this.closed) return;
    try {
      // No generated line legitimately contains CR/LF/NUL; scrub rather than
      // let an embedded newline in interpolated text split into a second
      // injected command. Matching control chars is the point of the regex.
      // eslint-disable-next-line no-control-regex
      this.socket.write(line.replace(/[\r\n\u0000]/g, ' ') + '\r\n');
    } catch {
      this.destroy();
    }
  }

  private numeric(code: string, params: string): void {
    const nick = this.currentNick() || this.clientNick || '*';
    this.write(`:${SERVER_NAME} ${code} ${nick} ${params}`);
  }

  private notice(text: string): void {
    const nick = this.currentNick() || this.clientNick || '*';
    this.write(`:${SERVER_NAME} NOTICE ${nick} :${text}`);
  }

  private currentNick(): string | null {
    return this.conn?.currentNick || null;
  }

  private selfPrefix(): string {
    const nick = this.currentNick() || this.clientNick || '*';
    const user = this.conn?.client.user?.username || 'lurker';
    const host = this.conn?.client.user?.host || SERVER_NAME;
    return `${nick}!${user}@${host}`;
  }

  private onData(chunk: Buffer | string): void {
    this.lastActivityAt = Date.now();
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (this.buf.length > MAX_INPUT_BUFFER) {
      this.closeWithError('Input buffer exceeded');
      return;
    }
    let idx: number;
    while (!this.closed && (idx = this.buf.indexOf('\n')) !== -1) {
      const raw = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      if (!raw) continue;
      try {
        this.onLine(raw);
      } catch (e) {
        console.warn('[bouncer] error handling line:', (e as Error)?.message || e);
      }
    }
  }

  private onLine(raw: string): void {
    const parsed = parseClientLine(raw);
    if (!parsed) return;
    if (!this.registered) this.handlePreRegistration(parsed);
    else this.handleCommand(parsed);
  }

  // --- registration ---------------------------------------------------------

  private handlePreRegistration(msg: ParsedClientLine): void {
    switch (msg.command) {
      case 'CAP':
        this.handleCap(msg);
        break;
      case 'PASS':
        this.passRaw = msg.params[0] ?? '';
        break;
      case 'NICK':
        if (msg.params[0]) this.clientNick = msg.params[0];
        break;
      case 'USER':
        if (msg.params[0]) this.clientUser = msg.params[0];
        break;
      case 'AUTHENTICATE':
        this.write(`:${SERVER_NAME} 904 * :SASL authentication failed (not supported — use PASS)`);
        break;
      case 'QUIT':
        this.destroy();
        return;
      default:
        this.write(`:${SERVER_NAME} 451 * :You have not registered`);
        break;
    }
    this.maybeFinishRegistration();
  }

  private handleCap(msg: ParsedClientLine): void {
    const sub = (msg.params[0] || '').toUpperCase();
    const nick = this.currentNick() || this.clientNick || '*';
    switch (sub) {
      case 'LS':
        if (!this.registered) this.capNegotiating = true;
        this.write(`:${SERVER_NAME} CAP ${nick} LS :${SUPPORTED_CAPS.join(' ')}`);
        break;
      case 'LIST':
        this.write(`:${SERVER_NAME} CAP ${nick} LIST :${[...this.caps].join(' ')}`);
        break;
      case 'REQ': {
        if (!this.registered) this.capNegotiating = true;
        const requested = (msg.params[1] || '')
          .split(' ')
          .map((c) => c.trim())
          .filter(Boolean);
        const supported = requested.every((c) => SUPPORTED_CAPS.includes(c.replace(/^-/, '')));
        if (!supported || requested.length === 0) {
          this.write(`:${SERVER_NAME} CAP ${nick} NAK :${requested.join(' ')}`);
          break;
        }
        for (const cap of requested) {
          if (cap.startsWith('-')) this.caps.delete(cap.slice(1));
          else this.caps.add(cap);
        }
        this.write(`:${SERVER_NAME} CAP ${nick} ACK :${requested.join(' ')}`);
        break;
      }
      case 'END':
        this.capNegotiating = false;
        break;
      default:
        this.write(`:${SERVER_NAME} 410 ${nick} ${sub || '*'} :Invalid CAP command`);
        break;
    }
  }

  private maybeFinishRegistration(): void {
    if (this.registered || this.closed) return;
    if (!this.clientNick || !this.clientUser || this.capNegotiating) return;
    this.authenticate();
  }

  private failRegistration(text: string): void {
    // Console too (not just the wire): a misconfigured client often hides the
    // 464/ERROR lines, so the operator needs a server-side trace of why.
    console.warn(`[bouncer] registration failed from ${this.remoteIp}: ${text}`);
    this.write(`:${SERVER_NAME} 464 ${this.clientNick || '*'} :${text}`);
    this.closeWithError(text);
  }

  private authenticate(): void {
    if (authThrottled(this.remoteIp)) {
      this.closeWithError('Too many failed logins — try again later');
      return;
    }
    if (!this.passRaw) {
      this.failRegistration('Password required: PASS <username>[/<network>]:<password-or-token>');
      return;
    }
    const creds = parseBouncerCredentials(this.passRaw, this.clientUser);
    if (!creds) {
      this.failRegistration('Invalid credentials format: PASS <username>[/<network>]:<secret>');
      return;
    }
    const user = this.verifyUser(creds.username, creds.secret);
    if (!user) {
      noteAuthFailure(this.remoteIp);
      this.failRegistration('Invalid username or password/token');
      return;
    }
    if (user.is_paused) {
      this.failRegistration('Account is paused');
      return;
    }
    const networks = listNetworksForUser(user.id);
    if (networks.length === 0) {
      this.failRegistration('No IRC networks configured — add one in the web UI first');
      return;
    }
    let network: Network | undefined;
    if (creds.network) {
      const sel = creds.network.toLowerCase();
      network = networks.find((n) => n.name.toLowerCase() === sel || String(n.id) === sel);
      if (!network) {
        this.failRegistration(
          `Unknown network '${creds.network}' — available: ${networks.map((n) => n.name).join(', ')}`,
        );
        return;
      }
    } else if (networks.length === 1) {
      network = networks[0];
    } else {
      this.failRegistration(
        `Multiple networks — log in as ${creds.username}/<network>. Available: ${networks
          .map((n) => n.name)
          .join(', ')}`,
      );
      return;
    }
    // Attach to the live upstream connection; attaching to a stopped or dead
    // network (re)connects it, mirroring how ZNC brings a network up when a
    // client attaches. A conn object stuck in 'disconnected' (e.g. its boot-
    // time connect was refused and retries ran out) is restarted — safe here
    // because this session hasn't attached any listeners to it yet.
    let conn = ircManager.getConnection(user.id, network.id);
    if (!conn) {
      conn = ircManager.startNetwork(user.id, network.id);
    } else if (conn.state === 'disconnected') {
      conn = ircManager.restartNetwork(user.id, network.id, 'bouncer client attached');
    }
    if (!conn) {
      this.failRegistration('Network is unavailable');
      return;
    }

    this.userId = user.id;
    this.networkId = network.id;
    this.network = network;
    this.conn = conn;
    this.registered = true;
    if (this.regTimer) {
      clearTimeout(this.regTimer);
      this.regTimer = null;
    }
    attachToRegistry(this);
    this.sendAttachBurst();
    systemLog.log({
      userId: this.userId,
      scope: 'bouncer',
      fields: { networkId: this.networkId },
      text: `IRC client attached from ${this.remoteIp} (${attachedSessionCount(this.userId, this.networkId)} attached to ${network.name})`,
    });
  }

  private verifyUser(username: string, secret: string): User | null {
    const user = findUserByUsername(username) ?? findUserByUsername(username.toLowerCase());
    if (!user) {
      // Burn comparable time so a missing username isn't distinguishable from
      // a wrong password by response latency.
      verifyPassword(secret, null);
      return null;
    }
    if (verifyPassword(secret, getPasswordHash(user.id))) return user;
    const token = findActiveByHash(hashToken(secret));
    if (token && token.userId === user.id && token.scope === 'read-write') {
      touchLastUsed(token.id);
      return user;
    }
    return null;
  }

  // --- attach burst ----------------------------------------------------------

  private sendAttachBurst(): void {
    const conn = this.conn!;
    const requested = this.clientNick || conn.currentNick || 'user';
    const liveNick = conn.currentNick || requested;

    // ZNC's welcome shape: numerics target the nick the client asked for, then
    // an explicit NICK line moves it onto the connection's real nick. Replay
    // the network's own 001–005 when we have them so the client sees the real
    // ISUPPORT tokens (CHANTYPES/PREFIX/NETWORK drive its parsing).
    if (conn.state === 'connected' && conn.registrationLines.length > 0) {
      for (const line of conn.registrationLines) {
        this.write(rewriteNumericTarget(line, requested));
      }
    } else {
      this.write(
        `:${SERVER_NAME} 001 ${requested} :Welcome to the ${APP_NAME} bouncer, ${requested}`,
      );
      this.write(
        `:${SERVER_NAME} 002 ${requested} :Your host is ${SERVER_NAME}, running ${APP_NAME} ${APP_VERSION}`,
      );
      this.write(`:${SERVER_NAME} 003 ${requested} :This server was created for you`);
      this.write(`:${SERVER_NAME} 004 ${requested} ${SERVER_NAME} ${APP_NAME}-${APP_VERSION} o o`);
    }
    if (requested !== liveNick) {
      this.write(
        `:${requested}!${conn.client.user?.username || 'lurker'}@${SERVER_NAME} NICK :${liveNick}`,
      );
    }
    this.write(`:${SERVER_NAME} 422 ${liveNick} :MOTD File is missing`);

    if (conn.state !== 'connected') {
      this.notice(
        `Network '${this.network?.name}' is ${conn.state}; channels will appear once it registers.`,
      );
    } else {
      this.sendJoinBurst();
      this.sendPlayback();
    }

    // Live relay attaches AFTER playback so replayed history and the live
    // stream don't interleave out of order.
    this.onRawUpstream = (event) => {
      if (this.closed || !event?.from_server || typeof event.line !== 'string') return;
      const out = filterRelayLine(event.line, this.caps);
      if (out) this.write(out);
    };
    // irc-framework's Client is an eventemitter3, which has no listener-count
    // cap — several attached clients can listen on one upstream client freely.
    conn.client.on('raw', this.onRawUpstream);
  }

  private isupportPrefixes(): Array<{ mode: string; symbol: string }> {
    const raw = this.conn?.client.network?.options?.PREFIX as unknown;
    if (
      Array.isArray(raw) &&
      raw.length > 0 &&
      raw.every(
        (p) =>
          p &&
          typeof (p as { mode?: unknown }).mode === 'string' &&
          typeof (p as { symbol?: unknown }).symbol === 'string',
      )
    ) {
      return raw as Array<{ mode: string; symbol: string }>;
    }
    return DEFAULT_PREFIXES;
  }

  private sendJoinBurst(): void {
    const conn = this.conn!;
    const nick = this.currentNick() || '*';
    const prefixes = this.isupportPrefixes();
    for (const ch of conn.channels.values()) {
      this.write(`:${this.selfPrefix()} JOIN ${ch.name}`);
      if (ch.topic) this.write(`:${SERVER_NAME} 332 ${nick} ${ch.name} :${ch.topic}`);
      const names = Array.from(ch.members.values()).map(
        (m) => memberPrefixSymbol(m.modes || [], prefixes) + m.nick,
      );
      for (const line of buildNamesLines(nick, ch.name, names)) this.write(line);
    }
  }

  private sendPlayback(): void {
    const limit = playbackLimit();
    if (limit <= 0) return;
    const conn = this.conn!;
    const targets: Array<{ target: string; isChannel: boolean }> = [];
    for (const ch of conn.channels.values()) targets.push({ target: ch.name, isChannel: true });
    const joined = new Set(Array.from(conn.channels.keys()));
    const dms = listBuffersForNetwork(this.networkId)
      .filter((b) => !isChannelName(b.target) && !b.target.startsWith(':server:'))
      .filter((b) => !joined.has(b.target.toLowerCase()))
      .filter((b) => !isBufferClosed(this.userId, this.networkId, b.target))
      .toSorted((a, b) => (a.lastMessageAt < b.lastMessageAt ? 1 : -1))
      .slice(0, PLAYBACK_MAX_DM_BUFFERS);
    for (const b of dms) targets.push({ target: b.target, isChannel: false });

    for (const { target, isChannel } of targets) {
      const rows = listMessages(this.networkId, target, { limit });
      for (const line of this.playbackLines(rows, target, isChannel)) this.write(line);
    }
  }

  private playbackLines(rows: MessageEvent[], bufferTarget: string, isChannel: boolean): string[] {
    const out: string[] = [];
    const selfNick = this.currentNick() || this.clientNick || '*';
    for (const row of rows) {
      if (row.type !== 'message' && row.type !== 'action' && row.type !== 'notice') continue;
      if (row.fromIgnored || row.mirrored || !row.text) continue;
      // A self-message in a DM is `:you PRIVMSG peer` — a shape only clients
      // that negotiated znc.in/self-message (or echo-message) can attribute
      // correctly. Anything else (e.g. mIRC) misreads it as an INCOMING PM
      // "from you", which confuses query windows and trips auto-responders.
      // ZNC gates on the same caps. Channel self-lines are safe for everyone.
      if (row.self && !isChannel && !this.wantsSelfMessages()) continue;
      // Never replay your OWN lines to services (NickServ/ChanServ/…) even to
      // capable clients: that's where credentials live (IDENTIFY from a
      // client's perform), and each reconnect would replay them into that
      // client's logs. The services' replies still play back normally.
      if (row.self && !isChannel && isServicesNick(bufferTarget)) continue;
      const nick = row.nick || 'unknown';
      const prefix =
        row.userhost && row.userhost.includes('!')
          ? row.userhost
          : `${nick}!${nick}@${SERVER_NAME}`;
      // Channel rows keep the channel as the target; DM rows address inbound
      // lines to us and outbound (self) lines to the peer, ZNC-style.
      const target = isChannel ? bufferTarget : row.self ? bufferTarget : selfNick;
      const cmd = row.type === 'notice' ? 'NOTICE' : 'PRIVMSG';
      // Persisted multiline bodies (IRCv3 draft/multiline) become one playback
      // line per row line; ACTION collapses to a single line.
      const bodies =
        row.type === 'action'
          ? [`\u0001ACTION ${row.text.replace(/\n/g, ' ')}\u0001`]
          : row.text.split('\n');
      for (const body of bodies) {
        let line = `:${prefix} ${cmd} ${target} :${body}`;
        if (this.caps.has('server-time')) line = `@time=${toIrcTime(row.time)} ${line}`;
        out.push(line);
      }
    }
    return out;
  }

  // --- post-registration commands --------------------------------------------

  private liveConn(): IrcConnection | null {
    const live = ircManager.getConnection(this.userId, this.networkId);
    if (live && this.conn && live !== this.conn) {
      // The IrcConnection object was replaced (network edit / explicit
      // reconnect). Our relay listeners point at the dead client; drop the
      // session and let the IRC client's auto-reconnect reattach cleanly.
      this.closeWithError('Upstream connection was reset — reconnect to reattach');
      return null;
    }
    return live;
  }

  private handleCommand(msg: ParsedClientLine): void {
    switch (msg.command) {
      case 'PING':
        this.write(`:${SERVER_NAME} PONG ${SERVER_NAME} :${msg.params[0] ?? SERVER_NAME}`);
        return;
      case 'PONG':
        return;
      case 'QUIT':
        // Detach only — the upstream connection stays up. That's the point.
        this.destroy();
        return;
      case 'CAP':
        this.handleCap(msg);
        return;
      case 'USER':
        this.numeric('462', ':You may not reregister');
        return;
    }

    const conn = this.liveConn();
    if (this.closed) return;
    if (!conn) {
      this.notice(`Not connected to '${this.network?.name}' — connect it from the web UI.`);
      return;
    }
    this.conn = conn;

    switch (msg.command) {
      case 'PRIVMSG':
      case 'NOTICE':
        this.handleClientMessage(msg);
        return;
      case 'JOIN': {
        const first = msg.params[0] || '';
        if (!first) return;
        if (first === '0') {
          conn.raw('JOIN 0');
          return;
        }
        const channels = first.split(',').filter(Boolean);
        const keys = (msg.params[1] || '').split(',');
        channels.forEach((channel, i) => {
          const key = (keys[i] || '').trim();
          if (key) {
            // ircManager.joinChannel can't carry a key; persist + reopen the
            // buffer the same way it does, then JOIN with the key ourselves.
            upsertChannel(this.networkId, channel, true);
            reopenBuffer(this.userId, this.networkId, channel);
            conn.raw(`JOIN ${channel} ${key}`);
          } else {
            ircManager.joinChannel(this.userId, this.networkId, channel);
          }
        });
        return;
      }
      case 'PART': {
        const channels = (msg.params[0] || '').split(',').filter(Boolean);
        const reason = msg.params[1];
        for (const channel of channels) {
          ircManager.partChannel(this.userId, this.networkId, channel, reason);
        }
        return;
      }
      case 'AWAY': {
        const message = (msg.params[0] || '').trim();
        // Route through the canonical user-level away writers so the web UI
        // and every other network connection stay in sync.
        if (message) ircManager.setAwayAll(this.userId, message);
        else ircManager.clearAwayAll(this.userId);
        return;
      }
      default:
        // Everything else (MODE, TOPIC, WHOIS, WHO, NAMES, LIST, KICK, INVITE,
        // NICK, …) forwards verbatim; replies come back via the raw relay.
        conn.raw(rebuildLine(msg));
        return;
    }
  }

  private handleClientMessage(msg: ParsedClientLine): void {
    const conn = this.conn!;
    const targets = (msg.params[0] || '').split(',').filter(Boolean);
    const text = msg.params[1] ?? '';
    if (targets.length === 0) {
      this.numeric('411', `:No recipient given (${msg.command})`);
      return;
    }
    if (!text) {
      this.numeric('412', ':No text to send');
      return;
    }
    for (const target of targets) {
      const isAction = text.startsWith('\u0001ACTION ') || text.startsWith('\u0001ACTION\u0001');
      if (text.startsWith('\u0001') && !isAction) {
        // Non-ACTION CTCP (VERSION, PING, replies…): forward on the wire
        // untouched; these aren't conversation and don't persist.
        conn.raw(rebuildLine({ command: msg.command, params: [target, text] }));
        continue;
      }
      if (isAction) {
        // eslint-disable-next-line no-control-regex
        const body = text.replace(/^\u0001ACTION ?/, '').replace(/\u0001$/, '');
        for (const chunk of splitAction(body)) this.registerEcho('action', target, chunk);
        ircManager.action(this.userId, this.networkId, target, body);
      } else if (msg.command === 'PRIVMSG') {
        const chunks = splitSay(text);
        for (const chunk of chunks) this.registerEcho('message', target, chunk);
        // On an E2E channel the self event carries the full body as ONE event
        // (not per wire chunk), so register the whole text too when it split.
        // The unmatched leftover key expires harmlessly (see pendingEcho).
        if (chunks.length > 1) this.registerEcho('message', target, text);
        ircManager.send(this.userId, this.networkId, target, text);
      } else {
        for (const chunk of splitSay(text)) this.registerEcho('notice', target, chunk);
        ircManager.notice(this.userId, this.networkId, target, text);
      }
    }
  }

  private registerEcho(type: string, target: string, text: string): void {
    this.prunePendingEcho();
    this.pendingEcho.push({ key: echoKey(type, target, text), at: Date.now() });
    if (this.pendingEcho.length > 500) this.pendingEcho.splice(0, this.pendingEcho.length - 500);
  }

  private prunePendingEcho(): void {
    const cutoff = Date.now() - 30_000;
    if (this.pendingEcho.length && this.pendingEcho[0].at < cutoff) {
      this.pendingEcho = this.pendingEcho.filter((e) => e.at >= cutoff);
    }
  }

  // Whether this client can render `:you PRIVMSG peer` self-messages in DMs.
  private wantsSelfMessages(): boolean {
    return this.caps.has('znc.in/self-message') || this.caps.has('echo-message');
  }

  // --- events from ircManager -------------------------------------------------

  deliverSelfEcho(type: string, target: string, text: string, time: string | null): void {
    if (this.closed) return;
    this.prunePendingEcho();
    const key = echoKey(type, target, text);
    const idx = this.pendingEcho.findIndex((e) => e.key === key);
    if (idx !== -1) {
      this.pendingEcho.splice(idx, 1);
      // This session originated the message; only clients that asked for
      // echo-message want it back.
      if (!this.caps.has('echo-message')) return;
    }
    // Cross-client DM sync is only intelligible to clients that negotiated
    // znc.in/self-message / echo-message — anyone else would render it as an
    // incoming PM from yourself (and auto-responders reply to it). Channel
    // self-lines render fine everywhere, so they always sync.
    if (!isChannelName(target) && !this.wantsSelfMessages()) return;
    const cmd = type === 'notice' ? 'NOTICE' : 'PRIVMSG';
    // Web-composed multiline messages arrive as one event with embedded
    // newlines; a raw newline inside a wire line would split into a bogus
    // second command, so emit one client line per body line.
    const bodies =
      type === 'action' ? [`\u0001ACTION ${text.replace(/\n/g, ' ')}\u0001`] : text.split('\n');
    for (const body of bodies) {
      let line = `:${this.selfPrefix()} ${cmd} ${target} :${body}`;
      if (this.caps.has('server-time') && time) line = `@time=${toIrcTime(time)} ${line}`;
      this.write(line);
    }
  }

  onUpstreamState(state: string): void {
    if (this.closed) return;
    // liveConn() closes us if the connection object was swapped out.
    if (!this.liveConn() || this.closed) return;
    if (state === 'connected') this.notice(`Upstream reconnected to '${this.network?.name}'.`);
    else if (state === 'reconnecting' || state === 'disconnected') {
      this.notice(`Upstream ${state} ('${this.network?.name}') — Lurker will keep retrying.`);
    }
  }

  heartbeat(now: number): void {
    if (this.closed) return;
    const idle = now - this.lastActivityAt;
    if (idle > HEARTBEAT_REAP_AFTER_MS) {
      this.closeWithError('Ping timeout');
    } else if (idle > HEARTBEAT_PING_AFTER_MS) {
      this.write(`PING :${SERVER_NAME}`);
    }
  }

  // --- teardown ---------------------------------------------------------------

  closeWithError(reason: string): void {
    this.write(`ERROR :${reason}`);
    // Graceful teardown: socket.destroy() would discard the not-yet-flushed
    // 464/ERROR bytes (especially over TLS), leaving the client a reasonless
    // "host disconnected". end() flushes and FINs; the timer backstops a peer
    // that never closes its half.
    this.destroy(reason, { graceful: true });
  }

  destroy(reason?: string, opts: { graceful?: boolean } = {}): void {
    if (this.closed) return;
    this.closed = true;
    if (this.regTimer) {
      clearTimeout(this.regTimer);
      this.regTimer = null;
    }
    if (this.onRawUpstream && this.conn) {
      try {
        this.conn.client.off('raw', this.onRawUpstream);
      } catch {
        /* ignore */
      }
    }
    this.onRawUpstream = null;
    sessions.delete(this);
    if (this.registered) {
      detachFromRegistry(this);
      systemLog.log({
        userId: this.userId,
        scope: 'bouncer',
        fields: { networkId: this.networkId },
        text: `IRC client detached${reason ? ` (${reason})` : ''} (${attachedSessionCount(this.userId, this.networkId)} still attached)`,
      });
    }
    try {
      if (opts.graceful) {
        this.socket.end();
        const backstop = setTimeout(() => {
          try {
            this.socket.destroy();
          } catch {
            /* ignore */
          }
        }, 3000);
        backstop.unref?.();
      } else {
        this.socket.destroy();
      }
    } catch {
      /* ignore */
    }
  }
}

function echoKey(type: string, target: string, text: string): string {
  return `${type}\u0000${target.toLowerCase()}\u0000${text}`;
}

// ---------------------------------------------------------------------------
// ircManager event fan-in
// ---------------------------------------------------------------------------

function dispatchIrcEvent(event: Record<string, unknown>): void {
  const userId = Number(event.userId);
  const networkId = Number(event.networkId);
  if (!userId || !networkId) return;
  const set = registry.get(registryKey(userId, networkId));
  if (!set || set.size === 0) return;
  const type = String(event.type || '');
  if (type === 'state') {
    const state = String(event.state || '');
    // Deleting from a Set mid-iteration is safe; handlers only ever remove.
    for (const session of set) session.onUpstreamState(state);
    return;
  }
  // Self-originated conversation (sent from the web UI, MCP, or another
  // attached IRC client) — the upstream never echoes it, so synthesize it.
  if (!event.self) return;
  if (type !== 'message' && type !== 'action' && type !== 'notice') return;
  const target = typeof event.target === 'string' ? event.target : '';
  if (!target || target.startsWith(':server:')) return;
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text) return;
  const time = typeof event.time === 'string' ? event.time : null;
  for (const session of set) session.deliverSelfEcho(type, target, text, time);
}

function dropSessionsForUser(userId: number, reason: string): void {
  for (const session of sessions) {
    if (session.userId === userId && session.isRegistered()) session.closeWithError(reason);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle + env config
// ---------------------------------------------------------------------------

let server: net.Server | tls.Server | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let onIrcEvent: ((event: Record<string, unknown>) => void) | null = null;
let onUserDisposed: ((payload: { userId: number }) => void) | null = null;
let onUserSuspended: ((payload: { userId: number }) => void) | null = null;

export function isBouncerEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test((process.env.LURKER_BOUNCER_ENABLED || '').trim());
}

export function bouncerPort(): number {
  const p = Number(process.env.LURKER_BOUNCER_PORT);
  return Number.isInteger(p) && p > 0 ? p : 6667;
}

// Optional bind address (LURKER_BOUNCER_BIND). Unset binds every interface —
// pair the default with TLS or a private network; plain-text IRC carries the
// login credential.
export function bouncerBindHost(): string | undefined {
  const host = (process.env.LURKER_BOUNCER_BIND || '').trim();
  return host || undefined;
}

function playbackLimit(): number {
  const n = Number(process.env.LURKER_BOUNCER_PLAYBACK);
  if (!Number.isFinite(n) || n < 0) return 50;
  return Math.min(1000, Math.floor(n));
}

// TLS when both cert and key paths are set (LURKER_BOUNCER_TLS_CERT/KEY).
// Read once at startup; a reload requires a restart, same as the web server.
function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  const certPath = (process.env.LURKER_BOUNCER_TLS_CERT || '').trim();
  const keyPath = (process.env.LURKER_BOUNCER_TLS_KEY || '').trim();
  if (!certPath || !keyPath) return null;
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

export function startBouncer(port: number = bouncerPort(), host?: string): void {
  if (server) return;
  const tlsOpts = tlsOptions();
  const onConnection = (socket: net.Socket) => {
    sessions.add(new BouncerSession(socket));
  };
  server = tlsOpts ? tls.createServer(tlsOpts, onConnection) : net.createServer(onConnection);
  server.on('error', (err) => {
    console.warn(`[bouncer] listener error: ${(err as Error).message}`);
  });
  server.listen(port, host, () => {
    console.log(
      `[bouncer] IRC bouncer listening on ${host || '0.0.0.0'}:${port}${tlsOpts ? ' (TLS)' : ''}`,
    );
    systemLog.log({
      scope: 'bouncer',
      text: `IRC bouncer listening on port ${port}${tlsOpts ? ' (TLS)' : ''}`,
    });
  });

  onIrcEvent = (event) => dispatchIrcEvent(event as Record<string, unknown>);
  ircManager.on('event', onIrcEvent);
  onUserDisposed = ({ userId }) => dropSessionsForUser(userId, 'Account removed');
  onUserSuspended = ({ userId }) => dropSessionsForUser(userId, 'Account paused');
  ircManager.on('user-disposed', onUserDisposed);
  ircManager.on('user-suspended', onUserSuspended);

  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const session of sessions) session.heartbeat(now);
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref?.();
}

export function stopBouncer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (onIrcEvent) {
    ircManager.off('event', onIrcEvent);
    onIrcEvent = null;
  }
  if (onUserDisposed) {
    ircManager.off('user-disposed', onUserDisposed);
    onUserDisposed = null;
  }
  if (onUserSuspended) {
    ircManager.off('user-suspended', onUserSuspended);
    onUserSuspended = null;
  }
  for (const session of sessions) session.destroy('Server shutting down');
  if (server) {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    server = null;
  }
}
