// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Built-in IRC bouncer (ZNC- and soju-compatible). An opt-in TCP/TLS listener
// that speaks the IRC *server* protocol, so any ordinary IRC client (WeeChat,
// irssi, Textual, HexChat, …) can attach to a user's always-on Lurker connection
// and use it like a ZNC network: shared upstream socket, shared nick, history
// playback on attach, and everything the client sends flows through the same
// ircManager paths the web UI uses (so messages persist and fan out to web tabs
// too). Modern clients also negotiate SASL, soju.im/bouncer-networks (network
// discovery/BIND), and draft/chathistory (on-demand scrollback).
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
import {
  listMessages,
  listBuffersForNetwork,
  loadHistoryWindow,
  listActiveTargetsInWindow,
} from '../db/messages.js';
import type { MessageEvent } from '../db/messages.js';
import { splitSay, splitAction } from './messageSplit.js';
import { e2eManager } from './e2e/manager.js';
import { contextKey, isChannelContext } from './e2e/context.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import {
  loadOrCreateSelfSignedCert,
  certFingerprint,
  keyMatchesCert,
} from '../utils/bouncerCert.js';

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
  // batch groups the BOUNCER NETWORK burst (LISTNETWORKS / initial -notify dump)
  // — advertised so a client can opt into the batched form; without it we send
  // the same lines unwrapped.
  'batch',
  // soju's bouncer-networks: a control connection can enumerate/bind the user's
  // networks; -notify opts into unsolicited BOUNCER NETWORK state pushes.
  'soju.im/bouncer-networks',
  'soju.im/bouncer-networks-notify',
  // draft/chathistory: on-demand scrollback fetch (CHATHISTORY BEFORE/AFTER/…).
  'draft/chathistory',
];

const CAP_BOUNCER_NETWORKS = 'soju.im/bouncer-networks';
const CAP_BOUNCER_NETWORKS_NOTIFY = 'soju.im/bouncer-networks-notify';
const CAP_CHATHISTORY = 'draft/chathistory';

// Max messages a single CHATHISTORY request may return (advertised as the
// CHATHISTORY ISUPPORT token). Requests over this are rejected, not clamped —
// matching soju, whose clients read the token and stay under it.
const MAX_CHATHISTORY = 1000;

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
// IRCv3 caps the client-only tag section at 4096 bytes including the leading
// `@` and the trailing space; 4094 is the room left for the tag content we relay.
const MAX_CLIENT_TAG_BYTES = 4094;
// How often to check the TLS cert file for a renewal and hot-swap it. Renewal
// is never time-critical (certs renew well before expiry), so a slow poll is
// fine and far simpler and more robust than fs.watch across symlink renames.
const CERT_RELOAD_INTERVAL_MS = 6 * 60 * 60 * 1000;
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
  // Client-only message tags (the `+`-prefixed ones, e.g. `+typing`,
  // `+draft/react`) exactly as the client sent them, joined by `;` with no
  // leading `@`. Preserved so a relayed TAGMSG (and other commands routed
  // through the verbatim `default:` relay) keeps its typing/reaction payload.
  // NOTE: PRIVMSG/NOTICE route through ircManager.send, which carries no tags,
  // so tags on a message body are NOT forwarded yet (tracked separately).
  // Server-authoritative tags (time, account, msgid, label, batch) are dropped
  // here — mirrors soju's copyClientTags.
  clientTags?: string;
}

/**
 * Parse one client→server IRC line. The `:prefix` is ignored; message tags are
 * dropped EXCEPT client-only (`+`-prefixed) tags, which are retained on
 * `clientTags` so they can be relayed upstream (typing, reactions, …).
 */
export function parseClientLine(raw: string): ParsedClientLine | null {
  // eslint-disable-next-line no-control-regex
  let line = raw.replace(/[\r\n\u0000]/g, '');
  let clientTags: string | undefined;
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp === -1) return null;
    // Keep only client-only tags (IRCv3 `+`-prefixed); server-authoritative
    // tags a client must not set (time, account, msgid, label, batch, …) are
    // discarded. Matches soju's copyClientTags.
    const kept = line
      .slice(1, sp)
      .split(';')
      .filter((t) => t.startsWith('+') && t.length > 1);
    // Bound what we'll relay upstream. The IRCv3 client-tag section is capped
    // at 4096 bytes (`@` + tags + space); a client could otherwise pad a line
    // up to MAX_INPUT_BUFFER with `+`-tags and have us forward an oversized
    // line that the network drops — killing the upstream socket shared by
    // every other session on this account. Over the limit → forward tagless.
    const joined = kept.join(';');
    if (kept.length > 0 && joined.length <= MAX_CLIENT_TAG_BYTES) clientTags = joined;
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
  return { command, params, clientTags };
}

/**
 * Rebuild a parsed client line for verbatim upstream forwarding, re-attaching
 * any preserved client-only tags as an `@tag;tag ` prefix so typing/reaction
 * payloads survive the round-trip to the network.
 */
export function rebuildLine({ command, params, clientTags }: ParsedClientLine): string {
  const prefix = clientTags ? `@${clientTags} ` : '';
  if (params.length === 0) return prefix + command;
  const head = params.slice(0, -1);
  const last = params[params.length - 1];
  const needsTrailing = last === '' || last.includes(' ') || last.startsWith(':');
  return prefix + [command, ...head, needsTrailing ? `:${last}` : last].join(' ');
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

// IRCv3 server-time layout used by CHATHISTORY `timestamp=` selectors:
// exactly `YYYY-MM-DDThh:mm:ss.sssZ` (millisecond precision, literal Z).
export function isValidServerTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && !Number.isNaN(Date.parse(s));
}

// A CHATHISTORY selector: `*` (LATEST only) or `timestamp=<iso>`. We advertise
// MSGREFTYPES=timestamp only — deliberately NOT msgid: our persisted history id
// (messages.id) and the upstream's opaque msgid on live-relayed lines are
// different namespaces, so honoring `msgid=` would break for a client paging
// from a live-captured id. Timestamp works off any line's @time. (Matches soju.)
type ChatBound = { star: true } | { iso: string };

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

// Map an IrcConnection state to a bouncer-networks `state` attribute value.
// soju itself only ever emits connected/disconnected, but the spec defines
// `connecting` and requires clients to accept it, so we surface the extra
// fidelity of the connecting/reconnecting phase (a deliberate divergence — a
// mid-connect network must not be advertised as `disconnected`).
export function bouncerNetworkState(connState: string | undefined): string {
  if (connState === 'connected') return 'connected';
  if (connState === 'connecting' || connState === 'reconnecting') return 'connecting';
  return 'disconnected';
}

// Build the tag-encoded attribute list for one network's BOUNCER NETWORK line.
// (v1 omits soju's `error`/`username`/`realname` — LISTNETWORKS is read-only and
// we don't yet plumb a per-network last-error string here.)
export function buildNetworkAttrs(
  network: { name: string; host: string; port: number; tls: number | boolean; nick: string },
  opts: { state: string; nickname?: string },
): string {
  const attrs: Array<[string, string]> = [
    ['name', network.name],
    ['state', opts.state],
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
  // It lives only in the global `sessions` set (no per-network registry); state
  // notifications reach it via the user-scoped fan-out in dispatchIrcEvent.
  private registerControl(user: User): void {
    this.userId = user.id;
    this.isControl = true;
    this.registered = true;
    this.clearRegTimer();
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
      this.writeWelcomeNumerics(requested);
    }
    if (requested !== liveNick) {
      this.write(
        `:${requested}!${conn.client.user?.username || 'lurker'}@${SERVER_NAME} NICK :${liveNick}`,
      );
    }
    // Append our own ISUPPORT for tokens the upstream's 005 can't carry:
    // BOUNCER_NETID (which network this connection bound) and the chathistory
    // limits. Bundled into one 005 line, gated on the relevant caps.
    const extraIsupport: string[] = [];
    if (this.caps.has(CAP_BOUNCER_NETWORKS)) extraIsupport.push(`BOUNCER_NETID=${this.networkId}`);
    if (this.caps.has(CAP_CHATHISTORY)) {
      extraIsupport.push(`CHATHISTORY=${MAX_CHATHISTORY}`, 'MSGREFTYPES=timestamp');
    }
    if (extraIsupport.length > 0) {
      this.write(
        `:${SERVER_NAME} 005 ${liveNick} ${extraIsupport.join(' ')} :are supported by this server`,
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

  // The 001–004 welcome numerics, shared by the control burst and the
  // no-registrationLines fallback of the bound attach burst.
  private writeWelcomeNumerics(nick: string): void {
    this.write(`:${SERVER_NAME} 001 ${nick} :Welcome to the ${APP_NAME} bouncer, ${nick}`);
    this.write(
      `:${SERVER_NAME} 002 ${nick} :Your host is ${SERVER_NAME}, running ${APP_NAME} ${APP_VERSION}`,
    );
    this.write(`:${SERVER_NAME} 003 ${nick} :This server was created for you`);
    this.write(`:${SERVER_NAME} 004 ${nick} ${SERVER_NAME} ${APP_NAME}-${APP_VERSION} o o`);
  }

  // Minimal welcome for a control connection: it binds no network, so no
  // registrationLines / JOIN / playback / relay. The bouncer-scoped ISUPPORT
  // omits BOUNCER_NETID (its absence is how a client detects control mode).
  private sendControlBurst(): void {
    const nick = this.clientNick || 'user';
    this.writeWelcomeNumerics(nick);
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
    if (!this.caps.has(CAP_BOUNCER_NETWORKS)) {
      this.write(
        `:${SERVER_NAME} FAIL BOUNCER UNKNOWN_COMMAND :Negotiate the soju.im/bouncer-networks capability first`,
      );
      return;
    }
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
    if (!this.caps.has(CAP_BOUNCER_NETWORKS)) {
      this.write(
        `:${SERVER_NAME} FAIL BOUNCER UNKNOWN_COMMAND :Negotiate the soju.im/bouncer-networks capability first`,
      );
      return;
    }
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

  // Reply to LISTNETWORKS (and the initial -notify dump) with a BOUNCER NETWORK
  // line per network. The soju.im/bouncer-networks batch wrapper (and its
  // `@batch=` message tag) is only used when the client negotiated `batch` —
  // otherwise we must not emit tags, so send the same lines unwrapped.
  // Run `fn(ref)` wrapped in a BATCH of the given type + params when the client
  // negotiated the `batch` cap (`ref` is the batch reference, or null unbatched
  // — IRCv3: no tags to clients that didn't ask). Mirrors soju's SendBatch.
  private withBatch(type: string, params: string[], fn: (ref: string | null) => void): void {
    const ref = this.caps.has('batch') ? `lb${++this.batchSeq}` : null;
    if (ref) this.write(`:${SERVER_NAME} BATCH +${ref} ${[type, ...params].join(' ')}`);
    fn(ref);
    if (ref) this.write(`:${SERVER_NAME} BATCH -${ref}`);
  }

  private sendNetworkList(): void {
    this.withBatch('soju.im/bouncer-networks', [], (ref) => {
      const tag = ref ? `@batch=${ref} ` : '';
      for (const network of listNetworksForUser(this.userId)) {
        const conn = ircManager.getConnection(this.userId, network.id);
        const attrs = buildNetworkAttrs(network, {
          state: bouncerNetworkState(conn?.state),
          nickname: conn?.currentNick || network.nick,
        });
        this.write(`${tag}:${SERVER_NAME} BOUNCER NETWORK ${network.id} ${attrs}`);
      }
    });
  }

  // Push an unsolicited (unbatched) network state change to a -notify client.
  private notifyNetworkState(networkId: number, attrs: string): void {
    if (this.closed || !this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) return;
    this.write(`:${SERVER_NAME} BOUNCER NETWORK ${networkId} ${attrs}`);
  }

  // --- CHATHISTORY (draft/chathistory) ---------------------------------------

  private handleChatHistory(msg: ParsedClientLine): void {
    const sub = (msg.params[0] || '').toUpperCase();
    // History is per-network; a control connection has no bound buffers.
    if (this.isControl || !this.networkId) {
      this.write(
        `:${SERVER_NAME} FAIL CHATHISTORY INVALID_TARGET ${sub || '*'} ${msg.params[1] || '*'} :Cannot fetch chat history on the bouncer connection`,
      );
      return;
    }
    if (sub === 'TARGETS') {
      this.handleChatHistoryTargets(msg);
      return;
    }
    if (!['BEFORE', 'AFTER', 'LATEST', 'AROUND', 'BETWEEN'].includes(sub)) {
      this.write(`:${SERVER_NAME} FAIL CHATHISTORY INVALID_PARAMS ${sub || '*'} :Unknown command`);
      return;
    }
    const target = msg.params[1] || '';
    if (!target) {
      this.numeric('461', 'CHATHISTORY :Not enough parameters');
      return;
    }
    const isBetween = sub === 'BETWEEN';
    const limit = this.parseChatHistoryLimit(sub, msg.params[isBetween ? 4 : 3] ?? '');
    if (limit === null) return;
    const bound0 = this.parseChatHistoryBound(sub, msg.params[2] || '', sub === 'LATEST', 'first');
    if (!bound0) return;
    let bound1: ChatBound | null = null;
    if (isBetween) {
      bound1 = this.parseChatHistoryBound(sub, msg.params[3] || '', false, 'second');
      if (!bound1) return;
    }
    const rows = this.loadChatHistory(sub, target, bound0, bound1, limit);
    this.sendChatHistoryBatch(target, rows);
  }

  private handleChatHistoryTargets(msg: ParsedClientLine): void {
    // TARGETS has no <target>; two timestamp bounds + limit (timestamp-only).
    const isoA = this.parseTimestampBound(msg.params[1] || '', 'first');
    if (isoA === null) return;
    const isoB = this.parseTimestampBound(msg.params[2] || '', 'second');
    if (isoB === null) return;
    const limit = this.parseChatHistoryLimit('TARGETS', msg.params[3] ?? '');
    if (limit === null) return;
    const targets = listActiveTargetsInWindow(this.networkId, isoA, isoB, limit);
    this.withBatch('draft/chathistory-targets', [], (ref) => {
      const tag = ref ? `@batch=${ref} ` : '';
      for (const t of targets) {
        this.write(
          `${tag}:${SERVER_NAME} CHATHISTORY TARGETS ${t.target} ${toIrcTime(t.lastMessageAt)}`,
        );
      }
    });
  }

  // Map a subcommand + timestamp bound(s) + limit onto a message-store window
  // fetch (exclusive time bounds), mirroring soju's LoadBeforeTime/LoadAfterTime.
  // Results are always chronological, oldest-first.
  private loadChatHistory(
    sub: string,
    target: string,
    bound0: ChatBound,
    bound1: ChatBound | null,
    limit: number,
  ): MessageEvent[] {
    const nid = this.networkId;
    // Only LATEST's bound can be `*` (unbounded); every other bound is a
    // timestamp by the time we get here (the parser rejects `*` elsewhere).
    const iso = (b: ChatBound): string | null => ('iso' in b ? b.iso : null);
    switch (sub) {
      case 'BEFORE':
        return loadHistoryWindow(nid, target, null, iso(bound0), limit, { newestFirst: true });
      case 'AFTER':
        return loadHistoryWindow(nid, target, iso(bound0), null, limit);
      case 'LATEST':
        return loadHistoryWindow(nid, target, iso(bound0), null, limit, { newestFirst: true });
      case 'AROUND': {
        // Split the limit around the point: newest half before, earliest after.
        const afterLimit = Math.floor(limit / 2);
        const older = loadHistoryWindow(nid, target, null, iso(bound0), limit - afterLimit, {
          newestFirst: true,
        });
        const newer = loadHistoryWindow(nid, target, iso(bound0), null, afterLimit);
        return [...older, ...newer];
      }
      case 'BETWEEN': {
        // Order the two time bounds; ascending → earliest `limit` in the window,
        // descending → most recent (soju semantics); always emit oldest-first.
        const a = iso(bound0);
        const b = iso(bound1!);
        const ascending = (a ?? '') <= (b ?? '');
        return loadHistoryWindow(nid, target, ascending ? a : b, ascending ? b : a, limit, {
          newestFirst: !ascending,
        });
      }
    }
    return [];
  }

  private sendChatHistoryBatch(target: string, rows: MessageEvent[]): void {
    this.withBatch('chathistory', [target], (ref) => {
      const lines = this.playbackLines(rows, target, isChannelName(target), {
        batchRef: ref ?? undefined,
        withMsgid: true,
      });
      for (const line of lines) this.write(line);
    });
  }

  // Parse a CHATHISTORY selector — `*` (LATEST only) or `timestamp=<iso>`. msgid
  // selectors are deliberately rejected (see the ChatBound type). Writes a FAIL
  // and returns null on error.
  private parseChatHistoryBound(
    sub: string,
    boundStr: string,
    allowStar: boolean,
    which: 'first' | 'second',
  ): ChatBound | null {
    if (allowStar && boundStr === '*') return { star: true };
    const eq = boundStr.indexOf('=');
    if (eq !== -1 && boundStr.slice(0, eq) === 'timestamp') {
      const val = boundStr.slice(eq + 1);
      if (isValidServerTime(val)) return { iso: val };
    }
    this.write(
      `:${SERVER_NAME} FAIL CHATHISTORY INVALID_PARAMS ${sub} ${boundStr} :Invalid ${which} bound`,
    );
    return null;
  }

  private parseTimestampBound(boundStr: string, which: 'first' | 'second'): string | null {
    const bound = this.parseChatHistoryBound('TARGETS', boundStr, false, which);
    return bound && 'iso' in bound ? bound.iso : null;
  }

  private parseChatHistoryLimit(sub: string, limitStr: string): number | null {
    // A missing/empty limit is a param error (Number('') === 0 would otherwise
    // silently become an empty-batch request); an explicit 0 is valid.
    const n = Number(limitStr);
    if (limitStr.trim() === '' || !Number.isInteger(n) || n < 0 || n > MAX_CHATHISTORY) {
      this.write(
        `:${SERVER_NAME} FAIL CHATHISTORY INVALID_PARAMS ${sub} ${limitStr} :Invalid limit`,
      );
      return null;
    }
    return n;
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

  // Assemble the leading IRCv3 tag block for a replayed line, honoring the
  // client's negotiated caps. `batch` ties a line to an open BATCH; `time`
  // needs server-time; `msgid` needs message-tags.
  private formatTags(opts: { time?: string; msgid?: number; batchRef?: string }): string {
    const tags: string[] = [];
    if (opts.batchRef) tags.push(`batch=${opts.batchRef}`);
    if (opts.time && this.caps.has('server-time')) tags.push(`time=${toIrcTime(opts.time)}`);
    if (opts.msgid != null && this.caps.has('message-tags')) tags.push(`msgid=${opts.msgid}`);
    return tags.length > 0 ? `@${tags.join(';')} ` : '';
  }

  private playbackLines(
    rows: MessageEvent[],
    bufferTarget: string,
    isChannel: boolean,
    opts: { batchRef?: string; withMsgid?: boolean } = {},
  ): string[] {
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
        const tags = this.formatTags({
          time: row.time,
          msgid: opts.withMsgid ? (row.id as number) : undefined,
          batchRef: opts.batchRef,
        });
        out.push(`${tags}:${prefix} ${cmd} ${target} :${body}`);
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
      case 'CHATHISTORY':
        // Answered locally from the message store — placed here so it works even
        // when the upstream is disconnected (a bouncer's whole point), bypassing
        // the liveConn() gate below.
        this.handleChatHistory(msg);
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
        this.relayRaw(conn, msg);
        return;
    }
  }

  // Forward a parsed client line to the upstream, re-attaching its client-only
  // tags only when the network speaks message-tags. On a non-IRCv3 server a
  // leading `@+tag …` prefix is parsed as the command, mangling the real
  // command into ERR_UNKNOWNCOMMAND — the same hazard IrcConnection.sendTyping
  // guards against — so drop the tags and forward the bare command there.
  private relayRaw(conn: IrcConnection, msg: ParsedClientLine): void {
    const forward =
      msg.clientTags && !conn.supportsMessageTags() ? { ...msg, clientTags: undefined } : msg;
    conn.raw(rebuildLine(forward));
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
        // untouched; these aren't conversation and don't persist. Spread msg so
        // any client-only tags ride along (gated on upstream message-tags).
        this.relayRaw(conn, { ...msg, params: [target, text] });
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

  // A -notify client's view of ANY of the user's networks changing state (both
  // control and bound connections receive these). Emits only the changed
  // attributes, soju-style (a connect also clears any prior error).
  onNetworkNotify(networkId: number, connState: string): void {
    if (this.closed) return;
    const state = bouncerNetworkState(connState);
    const attrs = state === 'connected' ? 'state=connected;error=' : `state=${state}`;
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
  // A -notify client (bound OR control) tracks state for ALL of the user's
  // networks — including ones no bound session is attached to — so fan state
  // events across every one of the user's sessions, before the per-network
  // early-return below. State transitions are infrequent, so the scan is cheap.
  if (type === 'state') {
    const state = String(event.state || '');
    for (const session of sessions) {
      if (session.userId === userId && session.isRegistered()) {
        session.onNetworkNotify(networkId, state);
      }
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
let certReloadTimer: ReturnType<typeof setInterval> | null = null;
// Paths + current fingerprint of the live TLS cert, so the reload poll can
// detect a renewed cert on disk and swap it in without a restart. null =
// plaintext listener.
let bouncerTlsState: { certPath: string; keyPath: string; fingerprint: string } | null = null;
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

// Plaintext IRC ships the login credential in the clear, so TLS is the default.
// Only an explicit LURKER_BOUNCER_TLS=off (0/false/no/off) turns it off.
function bouncerTlsDisabled(): boolean {
  return /^(0|false|no|off)$/i.test((process.env.LURKER_BOUNCER_TLS || '').trim());
}

function isLoopbackBind(host: string | undefined): boolean {
  const h = (host ?? bouncerBindHost() ?? '').trim();
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

interface ResolvedTls {
  cert: Buffer;
  key: Buffer;
  certPath: string;
  keyPath: string;
  source: 'configured' | 'self-signed';
  fingerprint: string;
}

// Resolve the bouncer's TLS material: an operator-supplied cert
// (LURKER_BOUNCER_TLS_CERT/KEY) if provided, otherwise an auto-generated
// self-signed cert persisted in the data dir. Returns null only when TLS is
// explicitly disabled. Async because first-boot self-signed generation is.
async function resolveBouncerTls(): Promise<ResolvedTls | null> {
  if (bouncerTlsDisabled()) return null;
  const envCert = (process.env.LURKER_BOUNCER_TLS_CERT || '').trim();
  const envKey = (process.env.LURKER_BOUNCER_TLS_KEY || '').trim();
  // Half a config (one of the pair set) is almost certainly a typo. Don't
  // silently self-sign under it — a client that trusted the intended real cert
  // would then get an unexpected self-signed one. Warn, then fall back.
  if (Boolean(envCert) !== Boolean(envKey)) {
    fallbackWarn(
      'LURKER_BOUNCER_TLS_CERT and LURKER_BOUNCER_TLS_KEY must BOTH be set to use your own certificate — only one is set',
    );
  } else if (envCert && envKey) {
    // Validate the operator's pair up front (as reload does): an unreadable or
    // mismatched cert/key would otherwise start a TLS listener whose every
    // handshake fails. Fall back to a working self-signed cert instead.
    try {
      const cert = fs.readFileSync(envCert);
      const key = fs.readFileSync(envKey);
      if (keyMatchesCert(cert, key)) {
        return {
          cert,
          key,
          certPath: envCert,
          keyPath: envKey,
          source: 'configured',
          fingerprint: certFingerprint(cert),
        };
      }
      fallbackWarn('the configured TLS certificate and key do not match');
    } catch (e) {
      fallbackWarn(`could not read the configured TLS certificate/key (${(e as Error).message})`);
    }
  }
  const { certPath, keyPath } = await loadOrCreateSelfSignedCert();
  const cert = fs.readFileSync(certPath);
  const key = fs.readFileSync(keyPath);
  return {
    cert,
    key,
    certPath,
    keyPath,
    source: 'self-signed',
    fingerprint: certFingerprint(cert),
  };
}

// Warn (console + system buffer) that a configured-cert problem forced the
// self-signed fallback, so the operator can see why TLS isn't using their cert.
function fallbackWarn(reason: string): void {
  const msg = `${reason} — falling back to a self-signed certificate.`;
  console.warn(`[bouncer] ${msg}`);
  systemLog.log({ scope: 'bouncer', text: msg });
}

// Re-read the cert from disk and hot-swap it into the running TLS server if it
// changed (an operator's LE renewal, or a control-plane wildcard rotation).
// Called on a poll and exported for tests. No fs.watch — a periodic
// fingerprint check is robust across certbot's atomic symlink renames, and cert
// renewal is never time-critical (certs renew well before expiry).
export function reloadBouncerTls(): 'reloaded' | 'unchanged' | 'skipped' | 'error' {
  if (!server || !bouncerTlsState || !('setSecureContext' in server)) return 'skipped';
  try {
    const cert = fs.readFileSync(bouncerTlsState.certPath);
    const fingerprint = certFingerprint(cert);
    if (fingerprint === bouncerTlsState.fingerprint) return 'unchanged';
    const key = fs.readFileSync(bouncerTlsState.keyPath);
    // Guard the renewal race: a poll can land after the cert file was replaced
    // but before the key. setSecureContext wouldn't catch the mismatch (it never
    // validates the pair) — so verify here, and if they don't match yet, keep
    // the current context and retry next poll (don't advance the fingerprint).
    if (!keyMatchesCert(cert, key)) {
      console.warn(
        '[bouncer] new TLS cert does not match the key on disk yet — keeping current cert',
      );
      return 'error';
    }
    (server as tls.Server).setSecureContext({ cert, key });
    bouncerTlsState.fingerprint = fingerprint;
    console.log(`[bouncer] reloaded TLS certificate (SHA-256 ${fingerprint})`);
    systemLog.log({
      scope: 'bouncer',
      text: `Reloaded TLS certificate — new fingerprint: ${fingerprint}`,
    });
    return 'reloaded';
  } catch (e) {
    // A partial write mid-renewal, etc. — keep the current context and retry next poll.
    console.warn(
      `[bouncer] TLS cert reload check failed (keeping current): ${(e as Error).message}`,
    );
    return 'error';
  }
}

export async function startBouncer(
  port: number = bouncerPort(),
  host?: string,
): Promise<net.Server | tls.Server | null> {
  // Already running → signal a no-op with null rather than handing back a server
  // that's already past its 'listening' event (a caller awaiting that event on
  // the returned handle would otherwise wait forever).
  if (server) return null;
  const tlsInfo = await resolveBouncerTls();
  // Between the await and here another call could have started the server; if so,
  // yield to it (drop the cert we just resolved).
  if (server) return null;
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
  if (tlsInfo) {
    server = tls.createServer({ cert: tlsInfo.cert, key: tlsInfo.key }, onConnection);
    bouncerTlsState = {
      certPath: tlsInfo.certPath,
      keyPath: tlsInfo.keyPath,
      fingerprint: tlsInfo.fingerprint,
    };
    certReloadTimer = setInterval(() => reloadBouncerTls(), CERT_RELOAD_INTERVAL_MS);
    certReloadTimer.unref?.();
  } else {
    server = net.createServer(onConnection);
    bouncerTlsState = null;
  }
  server.on('error', (err) => {
    console.warn(`[bouncer] listener error: ${(err as Error).message}`);
  });
  server.listen(port, host, () => {
    const mode = tlsInfo ? `TLS (${tlsInfo.source})` : 'PLAINTEXT';
    console.log(`[bouncer] IRC bouncer listening on ${host || '0.0.0.0'}:${port} — ${mode}`);
    systemLog.log({ scope: 'bouncer', text: `IRC bouncer listening on port ${port} — ${mode}` });
    if (tlsInfo) {
      const pin =
        tlsInfo.source === 'self-signed'
          ? ' (self-signed — verify/pin this fingerprint in your IRC client)'
          : '';
      console.log(`[bouncer] TLS certificate SHA-256: ${tlsInfo.fingerprint}${pin}`);
      systemLog.log({
        scope: 'bouncer',
        text: `TLS certificate fingerprint (SHA-256): ${tlsInfo.fingerprint}${pin}`,
      });
    } else if (!isLoopbackBind(host)) {
      const warning =
        'SECURITY: bouncer is running WITHOUT TLS on a non-loopback address — login credentials travel in the clear. Remove LURKER_BOUNCER_TLS=off, or bind to 127.0.0.1 behind a tunnel/VPN.';
      console.warn(`[bouncer] ${warning}`);
      systemLog.log({ scope: 'bouncer', text: warning });
    }
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
  if (certReloadTimer) {
    clearInterval(certReloadTimer);
    certReloadTimer = null;
  }
  bouncerTlsState = null;
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
