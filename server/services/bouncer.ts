// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Built-in IRC bouncer (ZNC-style). An opt-in TCP/TLS listener that speaks the
// IRC *server* protocol, so any ordinary IRC client (WeeChat, irssi, Textual,
// HexChat, …) can attach to a user's always-on Lurker connection and use it
// like a ZNC network: shared upstream socket, shared nick, history playback on
// attach, and everything the client sends flows through the same ircManager
// paths the web UI uses (so messages persist and fan out to web tabs too).
//
// Attach protocol. Two interchangeable credential transports:
//   1. PASS (ZNC-compatible floor — dumb clients like mIRC):
//        PASS <username>:<secret>                     single network
//        PASS <username>/<network>:<secret>           pick a network by name/id
//        …or put `username/network` in the USER field and only the secret in PASS.
//   2. SASL PLAIN (IRCv3, `sasl` cap): the authcid carries `username[/network]`
//        and the password rides the PLAIN response. Advertised as `sasl=PLAIN`
//        under CAP 302. Reuses the exact same credential backend as PASS.
// The secret may be the account password or an active read-write API token
// (Settings → API tokens) — tokens are recommended since client configs store
// the value in plaintext. A ZNC-style `@clientid` in the login is parsed and
// (for now) ignored. Multi-upstream `*` is deliberately unsupported (soju
// removed it too) — attach one network per connection.
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
import { StringDecoder } from 'node:string_decoder';
import ircManager from './ircManager.js';
import type { IrcConnection } from './ircConnection.js';
import * as systemLog from './systemLog.js';
import { findUserByUsername, getPasswordHash } from '../db/users.js';
import type { User } from '../db/users.js';
import { verifyPassword, hashPassword } from './password.js';
import { hashToken, findActiveByHash, touchLastUsed } from '../db/apiTokens.js';
import { listNetworksForUser, upsertChannel } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { reopenBuffer, closedKeySetForUser } from '../db/closedBuffers.js';
import { listMessages, listBuffersForNetwork } from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { splitSay, splitAction } from './messageSplit.js';
import { e2eManager } from './e2e/manager.js';
import { contextKey, isChannelContext } from './e2e/context.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';

const SERVER_NAME = 'lurker.bouncer';

// A scrypt hash used ONLY to equalize login latency (see verifyUser): every
// auth path runs one scrypt so an unknown/passwordless username can't be told
// apart from a real one by response time. Computed lazily on the first bouncer
// login rather than at import, so a disabled bouncer costs no startup scrypt.
let timingDummyHash: string | null = null;
function timingEqualizerHash(): string {
  if (timingDummyHash === null) timingDummyHash = hashPassword('lurker-bouncer-timing-equalizer');
  return timingDummyHash;
}

// Caps we can honestly offer an attaching client. server-time stamps playback
// and relayed lines; message-tags passes upstream tags through verbatim;
// echo-message opts the client into receiving its own sends back (otherwise we
// suppress the echo, since the client already rendered the message locally);
// znc.in/self-message is a marker cap — clients that know it render
// `:you PRIVMSG peer` playback/sync lines as *your* outgoing DMs.
const SUPPORTED_CAPS = [
  'sasl',
  'server-time',
  'message-tags',
  'echo-message',
  'znc.in/self-message',
  // soju's bouncer-networks: a control connection can enumerate/bind the user's
  // networks; -notify opts into unsolicited BOUNCER NETWORK state pushes.
  'soju.im/bouncer-networks',
  'soju.im/bouncer-networks-notify',
];

const CAP_BOUNCER_NETWORKS = 'soju.im/bouncer-networks';
const CAP_BOUNCER_NETWORKS_NOTIFY = 'soju.im/bouncer-networks-notify';

// The SASL mechanisms we implement. Advertised as a `sasl=…` value only under
// CAP 302 (bare `sasl` otherwise, since pre-302 CAP LS carries no cap values).
const SASL_MECHANISMS = ['PLAIN'];

/** Build the CAP LS token list, attaching cap values when the client sent 302. */
function capLsList(version: number): string {
  return SUPPORTED_CAPS.map((c) =>
    c === 'sasl' && version >= 302 ? `sasl=${SASL_MECHANISMS.join(',')}` : c,
  ).join(' ');
}

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
// Ceiling on an accumulated multi-chunk SASL response. A PLAIN payload is tiny
// (username + network + token); this only exists to stop an endless stream of
// 400-char AUTHENTICATE chunks from growing the heap without bound.
const MAX_SASL_RESPONSE = 8 * 1024;
// Cap DM buffers replayed on attach so a years-old account doesn't spew every
// conversation it ever had; joined channels are always replayed.
const PLAYBACK_MAX_DM_BUFFERS = 20;

// Per-IP failed-auth throttle: after MAX failures inside the window, further
// attempts from that address are refused before touching scrypt.
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAIL_MAX = 10;
// Cap the number of tracked IPs so a spray of one-off failures from many
// distinct addresses can't grow the map without bound; when the cap is hit we
// sweep expired entries (each lives at most AUTH_FAIL_WINDOW_MS).
const AUTH_FAIL_MAX_TRACKED = 10_000;
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
    if (authFailures.size >= AUTH_FAIL_MAX_TRACKED) {
      for (const [key, e] of authFailures) if (now > e.resetAt) authFailures.delete(key);
    }
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

export interface ParsedLogin {
  username: string;
  network: string | null;
  client: string | null;
}

// Parse a bouncer login part `username[/network][@client]`, matching soju's
// unmarshalUsername: `/` (network) and `@` (per-device client id) may appear in
// either order, and only the FIRST separator bounds the username. `@client` is
// a backlog-cursor hint parsed for soju parity but not yet acted on. Applies to
// the ZNC-combined PASS login, the USER field, and the SASL authcid alike.
export function unmarshalLogin(raw: string): ParsedLogin {
  let username = raw;
  let network: string | null = null;
  let client: string | null = null;
  const i = raw.search(/[/@]/);
  const j = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('@'));
  if (i >= 0) username = raw.slice(0, i);
  if (j >= 0) {
    if (raw[j] === '@') client = raw.slice(j + 1) || null;
    else network = raw.slice(j + 1) || null;
  }
  if (i >= 0 && j >= 0 && i < j) {
    if (raw[i] === '@') client = raw.slice(i + 1, j) || null;
    else network = raw.slice(i + 1, j) || null;
  }
  return { username, network, client };
}

export interface BouncerCredentials {
  username: string;
  secret: string;
  network: string | null;
}

// PASS carries `user[/network][@client]:secret` (ZNC shape); when PASS is just
// the secret, the login (and optional `/network`) rides the USER field instead.
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
  const parsed = unmarshalLogin(loginPart);
  let network = parsed.network;
  // The network selector may also ride the USER field while the login came
  // from PASS (`PASS user:secret` + `USER user/libera …`).
  if (!network && userField) network = unmarshalLogin(userField).network;
  if (!parsed.username || !secret) return null;
  return { username: parsed.username, secret, network };
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
  // *serv (NickServ/ChanServ/AuthServ/…) covers most networks; the short list
  // catches well-known non-*serv auth bots (QuakeNet Q, Undernet X/W) whose
  // self-lines also carry AUTH credentials. Best-effort — over-matching only
  // withholds a user's own DMs from playback; the durable fix is tagging
  // credential-bearing messages at persist time.
  return (
    /^[a-z]+serv$/.test(lower) ||
    lower === 'global' ||
    lower === 'services' ||
    lower === 'q' ||
    lower === 'x' ||
    lower === 'w'
  );
}

// IRCv3 message-tag value escaping (space→\s, ;→\:, \→\\, CR→\r, LF→\n). Used
// to encode a network's `key=value;…` attribute list for BOUNCER NETWORK.
export function escapeTagValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\:')
    .replace(/ /g, '\\s')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

// Build the tag-encoded attribute list for one network's BOUNCER NETWORK line.
// `state` is derived from whether the upstream is live; soju only ever emits
// connected/disconnected (never `connecting`), so we match that.
export function buildNetworkAttrs(
  network: { name: string; host: string; port: number; tls: number | boolean; nick: string },
  opts: { connected: boolean; nickname?: string },
): string {
  const attrs: Array<[string, string]> = [
    ['name', network.name],
    ['state', opts.connected ? 'connected' : 'disconnected'],
    ['host', network.host],
    ['port', String(network.port)],
    ['tls', network.tls ? '1' : '0'],
    ['nickname', opts.nickname || network.nick],
  ];
  return attrs.map(([k, v]) => `${k}=${escapeTagValue(v)}`).join(';');
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

const sessions = new Set<BouncerSession>();
const registry = new Map<string, Set<BouncerSession>>();
// Control (unbound) sessions: a `soju.im/bouncer-networks` client that
// registered without binding a network. Keyed by userId (not networkId — a
// control connection spans all of the user's networks) so state-change
// notifications can fan out to every control client the user has open.
const controlSessions = new Map<number, Set<BouncerSession>>();

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

function attachToControlRegistry(session: BouncerSession): void {
  let set = controlSessions.get(session.userId);
  if (!set) {
    set = new Set();
    controlSessions.set(session.userId, set);
  }
  set.add(session);
}

function detachFromControlRegistry(session: BouncerSession): void {
  const set = controlSessions.get(session.userId);
  if (!set) return;
  set.delete(session);
  if (set.size === 0) controlSessions.delete(session.userId);
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
  // Decode incrementally so a multi-byte UTF-8 character split across two TCP
  // segments isn't corrupted (chunk.toString() per packet would mangle it).
  private readonly decoder = new StringDecoder('utf8');
  private capNegotiating = false;
  // SASL PLAIN state: the requested mechanism (null until AUTHENTICATE <mech>),
  // an accumulator for base64 payloads that arrive in 400-byte chunks, and the
  // user/network resolved by a successful exchange (consumed at CAP END).
  private saslMechanism: string | null = null;
  private saslBuffer = '';
  private saslUser: User | null = null;
  private saslNetwork: string | null = null;
  private passRaw: string | null = null;
  private clientNick: string | null = null;
  private clientUser: string | null = null;
  private registered = false;
  private closed = false;
  private conn: IrcConnection | null = null;
  private network: Network | null = null;
  // Control (unbound) mode: a `soju.im/bouncer-networks` client that registered
  // without binding a network (no conn/networkId). It can only enumerate and
  // manage networks via BOUNCER, never send channel/user traffic.
  private isControl = false;
  // A pre-registration `BOUNCER BIND <id>` selector, consumed at completeAttach
  // (takes precedence over a username-embedded network name).
  private boundNetId: number | null = null;
  // A per-session counter for BATCH reference tags (LISTNETWORKS / initial dump).
  private batchSeq = 0;
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

  // True if `line` is an upstream reflection of our own PRIVMSG/NOTICE (prefix
  // nick matches our current nick) — used to drop duplicate self-echoes.
  private isReflectedSelfLine(line: string): boolean {
    const selfNick = this.currentNick();
    if (!selfNick) return false;
    let s = line;
    if (s.startsWith('@')) {
      const sp = s.indexOf(' ');
      if (sp === -1) return false;
      s = s.slice(sp + 1);
    }
    if (!s.startsWith(':')) return false; // no prefix → not attributable to us
    const sp = s.indexOf(' ');
    if (sp === -1) return false;
    const nick = s.slice(1, sp).split('!')[0];
    if (nick.toLowerCase() !== selfNick.toLowerCase()) return false;
    const cmd = s
      .slice(sp + 1)
      .split(' ', 1)[0]
      .toUpperCase();
    return cmd === 'PRIVMSG' || cmd === 'NOTICE';
  }

  private onData(chunk: Buffer | string): void {
    this.lastActivityAt = Date.now();
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
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
        this.handleSasl(msg);
        break;
      case 'BOUNCER':
        this.handleBouncerPreReg(msg);
        break;
      case 'PING':
        // Answer keepalive PINGs during CAP/registration so strict clients
        // don't treat the missing PONG as a ping timeout and drop the attach.
        this.write(`:${SERVER_NAME} PONG ${SERVER_NAME} :${msg.params[0] ?? ''}`);
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
      case 'LS': {
        if (!this.registered) this.capNegotiating = true;
        // 302 = versioned LS (advertise cap values); a bare/absent token is 301.
        const version = Number(msg.params[1]);
        const capVersion = Number.isFinite(version) && version >= 302 ? 302 : 301;
        this.write(`:${SERVER_NAME} CAP ${nick} LS :${capLsList(capVersion)}`);
        break;
      }
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

  // SASL PLAIN (IRCv3). Reuses the same credential backend as PASS — the only
  // difference is the transport. A success stashes the resolved user/network on
  // the session; the attach itself still happens at CAP END via authenticate().
  private handleSasl(msg: ParsedClientLine): void {
    const nick = this.clientNick || '*';
    const arg = msg.params[0] ?? '';
    if (!this.caps.has('sasl')) {
      this.write(`:${SERVER_NAME} 904 ${nick} :You must request the sasl capability first`);
      return;
    }
    // Step 1: mechanism selection (`AUTHENTICATE PLAIN`).
    if (this.saslMechanism === null) {
      const mech = arg.toUpperCase();
      if (!SASL_MECHANISMS.includes(mech)) {
        this.write(
          `:${SERVER_NAME} 908 ${nick} ${SASL_MECHANISMS.join(',')} :are available SASL mechanisms`,
        );
        this.write(`:${SERVER_NAME} 904 ${nick} :SASL authentication failed`);
        return;
      }
      this.saslMechanism = mech;
      this.saslBuffer = '';
      this.write('AUTHENTICATE +');
      return;
    }
    // Client aborted the in-progress exchange.
    if (arg === '*') {
      this.saslMechanism = null;
      this.saslBuffer = '';
      this.write(`:${SERVER_NAME} 906 ${nick} :SASL authentication aborted`);
      return;
    }
    // Step 2: accumulate the base64 response, which the spec splits into 400-
    // byte chunks (a chunk shorter than 400 — or a bare `+` for empty — ends it).
    if (arg !== '+') {
      this.saslBuffer += arg;
      // Bound the accumulator: MAX_INPUT_BUFFER only caps a single line, but
      // saslBuffer spans lines, so an endless stream of 400-char chunks would
      // otherwise grow the heap without limit. A PLAIN response is tiny.
      if (this.saslBuffer.length > MAX_SASL_RESPONSE) {
        this.saslBuffer = '';
        this.saslMechanism = null;
        this.write(`:${SERVER_NAME} 904 ${nick} :SASL message too long`);
        return;
      }
      if (arg.length === 400) return;
    }
    const payload = this.saslBuffer;
    this.saslBuffer = '';
    this.saslMechanism = null;
    this.finishSaslPlain(payload, nick);
  }

  private finishSaslPlain(b64: string, nick: string): void {
    const fail = () => this.write(`:${SERVER_NAME} 904 ${nick} :SASL authentication failed`);
    if (authThrottled(this.remoteIp)) {
      this.write(`:${SERVER_NAME} 904 ${nick} :Too many failed logins — try again later`);
      return;
    }
    // PLAIN response is `authzid \0 authcid \0 passwd`; the login (and optional
    // /network) rides authcid, falling back to authzid.
    const parts = Buffer.from(b64, 'base64').toString('utf8').split('\u0000');
    const [authzid, authcid, passwd] = parts.length === 3 ? parts : ['', '', ''];
    const login = unmarshalLogin(authcid || authzid);
    if (parts.length !== 3 || !login.username || !passwd) {
      // Malformed responses count toward the throttle too, so a client can't
      // probe unbounded without tripping the per-IP limit.
      noteAuthFailure(this.remoteIp);
      return fail();
    }
    const user = this.verifyUser(login.username, passwd);
    if (!user) {
      noteAuthFailure(this.remoteIp);
      return fail();
    }
    // Reject a paused account here rather than after signaling 903, so the
    // client isn't told auth succeeded and then killed at CAP END.
    if (user.is_paused) {
      this.write(`:${SERVER_NAME} 904 ${nick} :Account is paused`);
      return;
    }
    this.saslUser = user;
    this.saslNetwork = login.network;
    this.write(
      `:${SERVER_NAME} 900 ${nick} ${nick}!${user.username}@${SERVER_NAME} ${user.username} :You are now logged in as ${user.username}`,
    );
    this.write(`:${SERVER_NAME} 903 ${nick} :SASL authentication successful`);
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

  // Called at CAP END / registration completion. Auth may already be resolved
  // via SASL (this.saslUser); otherwise fall back to the ZNC-style PASS floor.
  private authenticate(): void {
    if (this.saslUser) {
      // SASL PLAIN already authenticated; the network selector rides the SASL
      // authcid, falling back to the USER field (`USER user/network …`).
      const networkSel = this.saslNetwork ?? unmarshalLogin(this.clientUser || '').network;
      this.completeAttach(this.saslUser, networkSel);
      return;
    }
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
    this.completeAttach(user, creds.network);
  }

  private clearRegTimer(): void {
    if (this.regTimer) {
      clearTimeout(this.regTimer);
      this.regTimer = null;
    }
  }

  // Called at CAP END / registration completion. Resolves the target network
  // (BIND id > username selector > single-network default), or drops into
  // control mode for a bouncer-networks client that named no network.
  private completeAttach(user: User, networkSel: string | null): void {
    if (user.is_paused) {
      this.failRegistration('Account is paused');
      return;
    }
    // soju's multi-upstream `*` mode was removed upstream; we never supported
    // it. Reject explicitly (deliberate divergence) rather than "unknown network".
    if (networkSel === '*') {
      this.failRegistration(
        'Multi-upstream (*) attach is not supported — attach one network per connection',
      );
      return;
    }
    // A valid login can otherwise open unbounded connections; cap how many a
    // single account may hold at once (bound and control connections both count).
    if (attachedSessionCount(user.id) >= maxSessionsPerUser()) {
      this.failRegistration(
        `Too many bouncer connections for this account (max ${maxSessionsPerUser()})`,
      );
      return;
    }

    // Control (unbound) mode: a bouncer-networks-aware client that named no
    // network manages its networks via BOUNCER instead of attaching to one.
    const hasSelector = this.boundNetId !== null || !!networkSel;
    if (!hasSelector && this.caps.has(CAP_BOUNCER_NETWORKS)) {
      this.registerControl(user);
      return;
    }

    const networks = listNetworksForUser(user.id);
    if (networks.length === 0) {
      this.failRegistration('No IRC networks configured — add one in the web UI first');
      return;
    }
    let network: Network | undefined;
    if (this.boundNetId !== null) {
      // A `BOUNCER BIND <id>` selector resolves by numeric id and reports
      // failures with the bouncer-networks FAIL vocabulary, not a 464.
      network = networks.find((n) => n.id === this.boundNetId);
      if (!network) {
        this.write(
          `:${SERVER_NAME} FAIL BOUNCER INVALID_NETID ${this.boundNetId} :Unknown network ID`,
        );
        this.closeWithError('Unknown network ID');
        return;
      }
    } else if (networkSel) {
      const sel = networkSel.toLowerCase();
      network = networks.find((n) => n.name.toLowerCase() === sel || String(n.id) === sel);
      if (!network) {
        this.failRegistration(
          `Unknown network '${networkSel}' — available: ${networks.map((n) => n.name).join(', ')}`,
        );
        return;
      }
    } else if (networks.length === 1) {
      network = networks[0];
    } else {
      this.failRegistration(
        `Multiple networks — log in as ${user.username}/<network>. Available: ${networks
          .map((n) => n.name)
          .join(', ')}`,
      );
      return;
    }
    this.bindNetwork(user, network);
  }

  // Attach the session to one network's live upstream and replay its welcome
  // burst. Shared by every bound-registration path.
  private bindNetwork(user: User, network: Network): void {
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
    this.clearRegTimer();
    attachToRegistry(this);
    this.sendAttachBurst();
    systemLog.log({
      userId: this.userId,
      scope: 'bouncer',
      fields: { networkId: this.networkId },
      text: `IRC client attached from ${this.remoteIp} (${attachedSessionCount(this.userId, this.networkId)} attached to ${network.name})`,
    });
  }

  // Register a control (unbound) connection: authenticated, bound to no network.
  private registerControl(user: User): void {
    this.userId = user.id;
    this.isControl = true;
    this.registered = true;
    this.clearRegTimer();
    attachToControlRegistry(this);
    this.sendControlBurst();
    systemLog.log({
      userId: this.userId,
      scope: 'bouncer',
      text: `Bouncer control connection from ${this.remoteIp}`,
    });
  }

  private verifyUser(username: string, secret: string): User | null {
    const user = findUserByUsername(username) ?? findUserByUsername(username.toLowerCase());
    const storedHash = user ? getPasswordHash(user.id) : null;
    // Always run exactly one scrypt (against a dummy hash when the user is
    // unknown or has no password) so login latency can't reveal whether the
    // username exists — verifyPassword(_, null) would otherwise return instantly.
    const passwordOk = verifyPassword(secret, storedHash ?? timingEqualizerHash());
    if (!user) return null;
    if (passwordOk && storedHash) return user;
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
    // Tell a bouncer-networks-aware client which network it bound to. The
    // upstream's own 005 can't carry this, so append our own ISUPPORT line.
    if (this.caps.has(CAP_BOUNCER_NETWORKS)) {
      this.write(
        `:${SERVER_NAME} 005 ${liveNick} BOUNCER_NETID=${this.networkId} :are supported by this server`,
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

    // A -notify client gets the full network list up-front (soju sends this at
    // registration completion for bound and control connections alike).
    if (this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) this.sendNetworkList();

    // Live relay attaches AFTER playback so replayed history and the live
    // stream don't interleave out of order.
    this.onRawUpstream = (event) => {
      if (this.closed || !event?.from_server || typeof event.line !== 'string') return;
      // Some upstreams (Ergo always-on, a chained bouncer, echo-message relays)
      // reflect our OWN PRIVMSG/NOTICE back. dispatchIrcEvent already synthesizes
      // the self-echo, so drop the reflected copy to avoid a duplicate line.
      if (this.isReflectedSelfLine(event.line)) return;
      const out = filterRelayLine(event.line, this.caps);
      if (out) this.write(out);
    };
    // irc-framework's Client is an eventemitter3, which has no listener-count
    // cap — several attached clients can listen on one upstream client freely.
    conn.client.on('raw', this.onRawUpstream);
  }

  // --- control (unbound) connection ------------------------------------------

  // Minimal welcome for a control connection: it binds no network, so no
  // registrationLines / JOIN / playback / relay. The bouncer-scoped ISUPPORT
  // omits BOUNCER_NETID (its absence is how a client detects control mode).
  private sendControlBurst(): void {
    const nick = this.clientNick || 'user';
    this.write(`:${SERVER_NAME} 001 ${nick} :Welcome to the ${APP_NAME} bouncer, ${nick}`);
    this.write(
      `:${SERVER_NAME} 002 ${nick} :Your host is ${SERVER_NAME}, running ${APP_NAME} ${APP_VERSION}`,
    );
    this.write(`:${SERVER_NAME} 003 ${nick} :This server was created for you`);
    this.write(`:${SERVER_NAME} 004 ${nick} ${SERVER_NAME} ${APP_NAME}-${APP_VERSION} o o`);
    this.write(
      `:${SERVER_NAME} 005 ${nick} NETWORK=${APP_NAME} CASEMAPPING=ascii :are supported by this server`,
    );
    this.write(`:${SERVER_NAME} 422 ${nick} :MOTD File is missing`);
    // A -notify client gets the full network list up-front as a batch.
    if (this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) this.sendNetworkList();
  }

  // --- BOUNCER command -------------------------------------------------------

  // Pre-registration BOUNCER: only BIND is legal here (soju parity). BIND
  // stashes the netid to resolve at completeAttach; everything else is refused.
  private handleBouncerPreReg(msg: ParsedClientLine): void {
    const sub = (msg.params[0] || '').toUpperCase();
    if (sub !== 'BIND') {
      this.write(`:${SERVER_NAME} FAIL BOUNCER UNKNOWN_COMMAND ${sub || '*'} :Unknown subcommand`);
      return;
    }
    // Binding needs an authenticated account. In our flow that means either SASL
    // already succeeded or a PASS is present to verify at CAP END.
    if (!this.saslUser && !this.passRaw) {
      this.write(
        `:${SERVER_NAME} FAIL BOUNCER ACCOUNT_REQUIRED BIND :Authentication needed to bind to bouncer network`,
      );
      return;
    }
    const raw = msg.params[1] || '';
    const id = Number(raw);
    if (!raw || !Number.isInteger(id) || id <= 0) {
      this.write(`:${SERVER_NAME} FAIL BOUNCER INVALID_NETID BIND ${raw} :Invalid network ID`);
      return;
    }
    this.boundNetId = id;
  }

  // Post-registration BOUNCER: LISTNETWORKS (+ BIND is now too late; CRUD is
  // deferred to the web UI).
  private handleBouncer(msg: ParsedClientLine): void {
    const sub = (msg.params[0] || '').toUpperCase();
    switch (sub) {
      case 'LISTNETWORKS':
        this.sendNetworkList();
        return;
      case 'BIND':
        this.write(
          `:${SERVER_NAME} FAIL BOUNCER REGISTRATION_IS_COMPLETED BIND :Cannot bind to a network after registration`,
        );
        return;
      case 'ADDNETWORK':
      case 'CHANGENETWORK':
      case 'DELNETWORK':
        // CRUD is managed in the web UI; keep soju's error vocabulary.
        this.write(
          `:${SERVER_NAME} FAIL BOUNCER UNKNOWN_COMMAND ${sub} :Manage networks in the ${APP_NAME} web UI`,
        );
        return;
      default:
        this.write(
          `:${SERVER_NAME} FAIL BOUNCER UNKNOWN_COMMAND ${sub || '*'} :Unknown subcommand`,
        );
        return;
    }
  }

  // Reply to LISTNETWORKS (and the initial -notify dump) with a
  // soju.im/bouncer-networks batch of BOUNCER NETWORK lines, one per network.
  private sendNetworkList(): void {
    const ref = `lbnc${++this.batchSeq}`;
    this.write(`:${SERVER_NAME} BATCH +${ref} soju.im/bouncer-networks`);
    for (const network of listNetworksForUser(this.userId)) {
      const conn = ircManager.getConnection(this.userId, network.id);
      const attrs = buildNetworkAttrs(network, {
        connected: conn?.state === 'connected',
        nickname: conn?.currentNick || network.nick,
      });
      this.write(`@batch=${ref} :${SERVER_NAME} BOUNCER NETWORK ${network.id} ${attrs}`);
    }
    this.write(`:${SERVER_NAME} BATCH -${ref}`);
  }

  // Push an unsolicited (unbatched) network state change to a -notify client.
  private notifyNetworkState(networkId: number, attrs: string): void {
    if (this.closed || !this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) return;
    this.write(`:${SERVER_NAME} BOUNCER NETWORK ${networkId} ${attrs}`);
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
    // One query for the whole closed-buffer set instead of one per candidate
    // buffer; listBuffersForNetwork is already ORDER BY lastMessageAt DESC, so
    // no re-sort is needed before taking the most-recent DMs.
    const closed = closedKeySetForUser(this.userId);
    const dms = listBuffersForNetwork(this.networkId)
      .filter((b) => !isChannelName(b.target) && !b.target.startsWith(':server:'))
      .filter((b) => !joined.has(b.target.toLowerCase()))
      .filter((b) => !closed.has(`${this.networkId}::${b.target.toLowerCase()}`))
      .slice(0, PLAYBACK_MAX_DM_BUFFERS);
    for (const b of dms) targets.push({ target: b.target, isChannel: false });

    // Bound the total burst: a user in very many buffers (or a high per-buffer
    // limit) could otherwise stall the shared event loop on attach.
    let budget = maxTotalPlaybackLines();
    for (const { target, isChannel } of targets) {
      if (budget <= 0) break;
      const rows = listMessages(this.networkId, target, { limit });
      for (const line of this.playbackLines(rows, target, isChannel)) {
        this.write(line);
        if (--budget <= 0) break;
      }
    }
  }

  private playbackLines(rows: MessageEvent[], bufferTarget: string, isChannel: boolean): string[] {
    const out: string[] = [];
    const selfNick = this.currentNick() || this.clientNick || '*';
    for (const row of rows) {
      if (row.type !== 'message' && row.type !== 'action' && row.type !== 'notice') continue;
      // Note: `fromIgnored` is deliberately NOT filtered here — the live relay
      // passes ignored senders through (ignore is a client-side Lurker feature,
      // not the bouncer's job), so playback stays consistent with it rather
      // than hiding in history what the client will then see live.
      if (row.mirrored || !row.text) continue;
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
      case 'AUTHENTICATE':
        // The bouncer owns the upstream's SASL. A post-registration
        // AUTHENTICATE from an attached client carries credentials and would
        // otherwise be relayed to the network (default branch) and drive an
        // unexpected upstream re-auth — swallow it.
        this.write(`:${SERVER_NAME} 904 ${this.currentNick() || '*'} :Already authenticated`);
        return;
      case 'BOUNCER':
        // Network enumeration/management works from any registered connection,
        // bound or control (it doesn't touch a specific upstream).
        this.handleBouncer(msg);
        return;
    }

    // A control connection has no upstream: it can only speak BOUNCER (handled
    // above). Anything network-facing is refused, soju-style.
    if (this.isControl) {
      this.notice(
        'Cannot interact with channels and users on the bouncer connection — bind a network.',
      );
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
      // /me actions and NOTICEs aren't encrypted yet, so ircManager refuses
      // them on an E2E channel and reports success — tell the attached client
      // instead of letting the send vanish with no feedback (a plain PRIVMSG
      // is fine: ircManager.send encrypts it).
      if (
        (isAction || msg.command === 'NOTICE') &&
        isChannelContext(target) &&
        e2eManager.isChannelEnabled(this.userId, this.networkId, contextKey(target, ''))
      ) {
        this.notice(
          `${isAction ? '/me actions' : 'Notices'} aren't encrypted yet — not sent on E2E channel ${target}`,
        );
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

  // A control connection's view of ANY of the user's networks changing state.
  // Emits only the changed attributes, soju-style (connect also clears error).
  onNetworkNotify(networkId: number, state: string): void {
    if (this.closed || !this.isControl) return;
    let attrs: string;
    if (state === 'connected') attrs = 'state=connected;error=';
    else if (state === 'reconnecting') attrs = 'state=connecting';
    else attrs = 'state=disconnected';
    this.notifyNetworkState(networkId, attrs);
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
    if (this.registered && this.isControl) {
      detachFromControlRegistry(this);
      systemLog.log({
        userId: this.userId,
        scope: 'bouncer',
        text: `Bouncer control connection closed${reason ? ` (${reason})` : ''}`,
      });
    } else if (this.registered) {
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
  const type = String(event.type || '');
  // Control connections track state for ALL the user's networks — including
  // ones no bound session is attached to — so fan state events to them before
  // the bound-session early-return below.
  if (type === 'state') {
    const controls = controlSessions.get(userId);
    if (controls) {
      const state = String(event.state || '');
      for (const session of controls) session.onNetworkNotify(networkId, state);
    }
  }
  const set = registry.get(registryKey(userId, networkId));
  if (!set || set.size === 0) return;
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

// Ceiling on the TOTAL lines replayed across all buffers on a single attach, so
// a user in many buffers can't stall the shared event loop. Generous — only
// pathological cases hit it.
export function maxTotalPlaybackLines(): number {
  const n = Number(process.env.LURKER_BOUNCER_MAX_PLAYBACK_TOTAL);
  if (!Number.isFinite(n) || n <= 0) return 10000;
  return Math.floor(n);
}

// Backstops against unbounded attach connections — a valid login can otherwise
// open arbitrarily many sessions (fd/memory exhaustion). Generous by default;
// operators tune via env. Per-user counts a user's sessions across all networks.
export function maxSessionsPerUser(): number {
  const n = Number(process.env.LURKER_BOUNCER_MAX_SESSIONS_PER_USER);
  if (!Number.isFinite(n) || n <= 0) return 32;
  return Math.floor(n);
}

export function maxSessionsTotal(): number {
  const n = Number(process.env.LURKER_BOUNCER_MAX_SESSIONS);
  if (!Number.isFinite(n) || n <= 0) return 512;
  return Math.floor(n);
}

// TLS when both cert and key paths are set (LURKER_BOUNCER_TLS_CERT/KEY).
// Read once at startup; a reload requires a restart, same as the web server.
function tlsOptions(): { cert: Buffer; key: Buffer } | null {
  const certPath = (process.env.LURKER_BOUNCER_TLS_CERT || '').trim();
  const keyPath = (process.env.LURKER_BOUNCER_TLS_KEY || '').trim();
  if (!certPath || !keyPath) return null;
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

export function startBouncer(
  port: number = bouncerPort(),
  host?: string,
): net.Server | tls.Server | null {
  // Already running → signal a no-op with null rather than handing back a server
  // that's already past its 'listening' event (a caller awaiting that event on
  // the returned handle would otherwise wait forever).
  if (server) return null;
  const tlsOpts = tlsOptions();
  const onConnection = (socket: net.Socket) => {
    // Global backstop: refuse new sockets once the process-wide ceiling is hit.
    // An unauthenticated flood is otherwise bounded only by the registration
    // timeout and the OS.
    if (sessions.size >= maxSessionsTotal()) {
      socket.end('ERROR :Bouncer connection limit reached\r\n');
      return;
    }
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
  return server;
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
