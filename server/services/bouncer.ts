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
// A login that names no network registers as a *control* connection rather
// than failing (soju parity — its register() never rejects a missing network
// name). A bouncer-networks client uses that to enumerate and BIND; a client
// without the cap gets a NOTICE naming its networks. The exception is the ZNC
// floor above: no cap, no selector, exactly one network → attach it.
//
// Design notes / v1 limitations, all deliberate:
// - Upstream→client traffic is relayed as the RAW wire lines the network sent
//   (minus registration/PING plumbing), so semantics stay exact, then trimmed
//   per client to the caps that client negotiated: the network speaks to Lurker
//   with Lurker's caps, not the client's (see bouncerClientFilter.ts, which
//   every line to a client passes through). Raw relay also means Lurker-level
//   ignore rules and RPE2E decryption do NOT apply to live relay:
//   an ignored sender is still visible in an attached client, and E2E channel
//   traffic shows as ciphertext there (your own sends echo as plaintext).
// - A reply to a query (WHO, WHOIS, LIST, NAMES, MODE, …) goes only to whoever
//   asked: this client, another one, the web app, or Lurker itself. The
//   network's replies don't say, so each query waits its turn on the connection
//   (replyRouter.ts, #931).
// - Detaching (client QUIT / socket drop) never touches the upstream
//   connection; Lurker stays online exactly like ZNC.
// - Away is per network (#994), as in ZNC and soju: a client's AWAY sets or
//   clears it on the network it's attached to, and that network's clients hear
//   the change as a 305 or 306. A control connection's AWAY covers every
//   network. `AWAY *` (draft/pre-away) marks a connection that isn't the user,
//   and any other attached client holds auto-away off (presence.ts).

import net from 'net';
import { REDACTION_CAP } from '../../shared/redaction.js';
import tls from 'tls';
import fs from 'fs';
import { StringDecoder } from 'node:string_decoder';
import ircManager from './ircManager.js';
import type { IrcConnection } from './ircConnection.js';
import * as systemLog from './systemLog.js';
import { findUserById } from '../db/users.js';
import type { User } from '../db/users.js';
import { verifyBouncerLogin } from './bouncerLogin.js';
import { bouncerAuthThrottle } from '../middleware/rateLimit.js';
import { isNodeMode } from '../utils/edition.js';
import { configuredBaseUrl } from '../utils/publicOrigin.js';
import { resolveUploader } from './uploadProviders/resolve.js';
import { getNetwork, listNetworksForUser } from '../db/networks.js';
import type { Network } from '../db/networks.js';
import { closedFoldedSetForNetwork, foldTargetFor } from '../db/buffers.js';
import {
  HISTORY_EVENT_TYPES,
  listBuffersForNetwork,
  listRecentMessages,
  isHistoryReaction,
  loadHistoryWindow,
  listActiveTargetsInWindow,
  readMarkerTime,
  newestIdAtOrBefore,
  findReplyParent,
} from '../db/messages.js';
import type { HistoryEvents, HistoryReaction, HistoryRow, MessageEvent } from '../db/messages.js';
import { getReadState } from '../db/bufferReads.js';
import { resolveBuffer, resolveBufferIdByNetwork } from '../db/bufferResolve.js';
import { findReactionParent } from '../db/reactions.js';
import type { AwayChange, ReadMarkerMove } from './ircManager.js';
import { broadcastReadState } from './wsHub.js';
import { evaluatePresence, setPresenceSource } from './presence.js';
import { setAttachedIrcClientCounter } from './attachedIrcClients.js';
import { changedSettings } from './settingsService.js';
import { CTCP_ANSWER_SETTINGS, ctcpAnsweredBySettings, ctcpVersionVia } from './ctcp.js';
import { getNetworkAwayState, isAwayRow, listNetworkAwayStates } from '../db/networkAwayState.js';
import { e2eManager } from './e2e/manager.js';
import { contextKey, isChannelContext } from './e2e/context.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import {
  loadOrCreateSelfSignedCert,
  certFingerprint,
  keyMatchesCert,
} from '../utils/bouncerCert.js';
import { isChannelTarget, isDccChatTarget } from '../../shared/channels.js';
import { stripFormatting } from './textMatch.js';
import {
  bouncerBindHost,
  bouncerPort,
  bouncerTlsDisabled,
  setBouncerTlsState,
} from '../utils/bouncerConfig.js';
import {
  ClientLineFilter,
  EXTENDED_MONITOR_CAPS,
  parseLine,
  restrictTags,
  withoutUpstreamFilehost,
} from './bouncerClientFilter.js';
import type { MonitorHolder } from './monitorList.js';
import { METADATA_CAP, isValidMetadataKey } from './ircMetadata.js';
import { reassembleMultiline, splitSay } from './messageSplit.js';
import { IRC_LINE_BYTES, MIN_TEXT_BUDGET } from '../../shared/wireBudget.js';
import { isServicesNick } from '../utils/servicesNick.js';
import type { ReplyClient } from './replyRouter.js';

const SERVER_NAME = 'lurker.bouncer';

// Caps we can honestly offer an attaching client, whatever network it binds.
// server-time stamps playback and relayed lines; message-tags passes upstream
// tags through verbatim; echo-message opts the client into receiving its own
// sends back (otherwise we suppress the echo, since the client already rendered
// the message locally); znc.in/self-message is a marker cap — clients that know
// it render `:you PRIVMSG peer` playback/sync lines as *your* outgoing DMs.
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
  // draft/event-playback: joins, parts, quits, nick changes, kicks and mode and
  // topic changes in that history too. Lurker's own store serves them, so it
  // doesn't depend on the network (soju offers it the same way).
  'draft/event-playback',
  // cap-notify: CAP NEW/DEL as the bound network's caps come and go (see
  // updateSupportedCaps). CAP LS 302 turns it on without a REQ.
  'cap-notify',
  // invite-notify: other people's INVITEs. A network that doesn't send them
  // just means fewer, which the spec allows; soju offers it regardless too.
  'invite-notify',
  // draft/read-marker: MARKREAD reads and moves the account's read pointer, the
  // one the web and iOS apps share (handleMarkRead). soju offers it everywhere too.
  'draft/read-marker',
  // draft/pre-away: AWAY before registration, and `AWAY *` for a connection that
  // isn't the user, such as goguma's background sync (handleAway). soju offers it
  // everywhere too.
  'draft/pre-away',
];

// Caps offered only while the bound network has them, because the lines they
// promise come from the network (soju's passthroughDownstreamCaps). Without the
// cap, the client filter keeps those lines away from the client.
// userhost-in-names is ZNC's addition; soju doesn't offer it. extended-monitor is
// offered under both names while the network has either: the filter decides who
// gets its lines (ClientLineFilter.inAudience), so the name needn't match. Not
// offered yet: labeled-response (reply routing, #493).
const PASSTHROUGH_CAPS = [
  'away-notify',
  'account-notify',
  'account-tag',
  'chghost',
  'extended-join',
  'multi-prefix',
  'userhost-in-names',
  ...EXTENDED_MONITOR_CAPS,
  // draft/metadata-2 (#607): SUB/UNSUB/SUBS answered here from a per-client
  // list merged onto the network's one subscription (handleMetadata), the
  // rest relayed; the network's 761/766 lines go to the clients that asked
  // for that key (wantsMetadataLine).
  METADATA_CAP,
  // draft/message-redaction (#1013): the network's REDACTs reach the clients
  // that asked for them (the filter gates the command on the cap); a client's
  // own REDACT takes the web app's road (handleClientRedact). Offered only
  // while the network has it, since every REDACT a client sees comes from it.
  REDACTION_CAP,
];

// A line that could be metadata: the command, after an optional tag and
// source prefix.
const METADATA_LINE_RE = /^(?:@\S+ )?(?::\S+ )?(?:METADATA|76\d|77[0-5]) /;

const CAP_BOUNCER_NETWORKS = 'soju.im/bouncer-networks';
const CAP_BOUNCER_NETWORKS_NOTIFY = 'soju.im/bouncer-networks-notify';
const CAP_CHATHISTORY = 'draft/chathistory';
const CAP_EVENT_PLAYBACK = 'draft/event-playback';
const CAP_READ_MARKER = 'draft/read-marker';

// Max messages a single CHATHISTORY request may return (advertised as the
// CHATHISTORY ISUPPORT token). Requests over this are rejected, not clamped —
// matching soju, whose clients read the token and stay under it.
const MAX_CHATHISTORY = 1000;

// The SASL mechanisms we implement. Advertised as a `sasl=…` value only under
// CAP 302 (bare `sasl` otherwise, since pre-302 CAP LS carries no cap values).
const SASL_MECHANISMS = ['PLAIN'];

/**
 * Build the CAP LS token list, attaching cap values when the client sent 302:
 * ours for sasl, the network's for a pass-through cap that carries one
 * (draft/metadata-2's limits), through `networkValue`.
 */
function capLsList(
  caps: Iterable<string>,
  version: number,
  networkValue: (cap: string) => string | undefined = () => undefined,
): string {
  return [...caps]
    .map((c) => {
      if (version < 302) return c;
      if (c === 'sasl') return `sasl=${SASL_MECHANISMS.join(',')}`;
      const value = networkValue(c);
      return value ? `${c}=${value}` : c;
    })
    .join(' ');
}

export {
  isBouncerEnabled,
  bouncerPort,
  bouncerBindHost,
  bouncerPublicAddress,
  bouncerTerminatesTls,
  bouncerTlsInfo,
} from '../utils/bouncerConfig.js';

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

// Per-IP failed-auth throttle: after enough failures, further attempts from that
// address are refused before touching scrypt. A verified login clears the
// address's count; an admin can lift a lockout early (#1039).
function throttledMessage(ip: string): string | null {
  const retryAfter = bouncerAuthThrottle.retryAfter(ip);
  if (retryAfter === null) return null;
  const minutes = Math.ceil(retryAfter / 60);
  return `Too many failed logins — try again in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Tests reset between cases; production never calls this.
export function resetAuthThrottle(): void {
  bouncerAuthThrottle.clear();
}

// ---------------------------------------------------------------------------
// Pure protocol helpers (exported for tests)
// ---------------------------------------------------------------------------

export interface ParsedClientLine {
  command: string;
  params: string[];
  // Client-only message tags (the `+`-prefixed ones, e.g. `+typing`,
  // `+draft/react`) exactly as the client sent them, joined by `;` with no
  // leading `@`. Preserved so a relayed TAGMSG keeps its payload (a reaction or
  // typing is sent again the web app's way, see handleClientTagmsg), as does
  // any other command routed through the verbatim `default:` relay.
  // A PRIVMSG or /me routes through ircManager instead, which carries only the
  // reply tag (handleClientMessage, #483), and a NOTICE none; any other tag on
  // them is dropped. A non-ACTION CTCP is relayed verbatim, tags and all.
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

// Rewrite the target-nick param of a server numeric (`[@tags ]:prefix NNN nick …`).
// Used to point the replayed registration burst at whatever nick the attaching
// client asked for, ZNC-style, before we NICK it over to the live one. The burst
// is stored as it came off the wire, so a leading tag block is stepped over
// rather than read as an unprefixed line (#892).
export function rewriteNumericTarget(line: string, nick: string): string {
  // [\s\S] instead of `.` so a stray trailing CR can't stop the tail group
  // short of `$` and silently skip the rewrite.
  const m = /^((?:@\S+ )?:\S+ \S+ )\S+([\s\S]*)$/.exec(line);
  if (!m) return line;
  return `${m[1]}${nick}${m[2]}`;
}

// A relayed line that may be a NICK, for a look before parsing. The command is
// case-insensitive on the wire, as every IRC command is.
const SELF_NICK_HINT = / nick /i;

// The new nick when `line` is a NICK from `self` — the nick a client knows
// itself by, compared under the network's casemapping — else null.
export function selfNickChange(
  line: string,
  self: string | null,
  networkId: number,
): string | null {
  if (!self) return null;
  const m = /^(?:@\S+ )?:([^!@\s]+)\S* NICK :?(\S+)/i.exec(line);
  if (!m || foldTargetFor(networkId, m[1]) !== foldTargetFor(networkId, self)) return null;
  return m[2];
}

/**
 * Filter one raw upstream line before it is relayed: drop the connection
 * plumbing Lurker handles itself. What each client may then receive is up to
 * its ClientLineFilter. Returns null to drop the line.
 */
export function filterRelayLine(line: string): string | null {
  // irc-framework's raw event line keeps its trailing CR — strip it so the
  // relayed copy doesn't carry a stray control char into our own CRLF framing.
  line = line.replace(/[\r\n]+$/, '');
  let afterPrefix = line;
  if (afterPrefix.startsWith('@')) {
    const sp = afterPrefix.indexOf(' ');
    if (sp === -1) return null;
    afterPrefix = afterPrefix.slice(sp + 1);
  }
  if (afterPrefix.startsWith(':')) {
    const sp = afterPrefix.indexOf(' ');
    if (sp === -1) return null;
    afterPrefix = afterPrefix.slice(sp + 1);
  }
  const command = (afterPrefix.split(' ', 1)[0] || '').toUpperCase();
  if (RELAY_DROP.has(command)) return null;
  return line;
}

// The `@tags :prefix ` a server line starts with, either part optional, so the
// rest of a relayed line can be rewritten.
function lineHead(line: string): string {
  let head = '';
  let rest = line;
  for (const sigil of ['@', ':']) {
    if (!rest.startsWith(sigil)) continue;
    const sp = rest.indexOf(' ');
    if (sp === -1) return head;
    head += rest.slice(0, sp + 1);
    rest = rest.slice(sp + 1);
  }
  return head;
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

/**
 * Every prefix symbol a member's modes earn, highest rank first (`@+` for +ov).
 * The client filter cuts it to the highest one for a client without
 * multi-prefix.
 */
export function memberPrefixSymbols(
  memberModes: string[],
  prefixes: Array<{ mode: string; symbol: string }> = DEFAULT_PREFIXES,
): string {
  return prefixes
    .filter((p) => memberModes.includes(p.mode))
    .map((p) => p.symbol)
    .join('');
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

/**
 * Join network names onto `head`, dropping the tail as `+N more` so the result
 * fits `budget` bytes.
 *
 * Network names are unbounded TEXT (no length cap on create, unlike API token
 * names) and an account may hold any number of them, so a bare join can push
 * these lines past the 512-byte wire cap — where clients truncate or drop them,
 * defeating the point of listing the networks at all. Same hazard buildNamesLines
 * chunks NAMES to avoid; one line suffices here because this is advice, not data.
 * Counted in bytes, not code units: names can be multi-byte and the wire cap is
 * bytes. The trailing trim is the backstop for a single pathological name.
 */
/** `text` cut to `budget` bytes, marked when it was cut. */
export function clampToBudget(text: string, budget: number): string {
  if (Buffer.byteLength(text) <= budget) return text;
  const marker = '…';
  // The marker is 3 bytes of the budget, not one character of it, and the cut
  // runs over code points so it can't split a surrogate pair (an emoji in a
  // server's ban reason) into a lone half.
  const room = budget - Buffer.byteLength(marker);
  if (room <= 0) return '';
  let out = '';
  for (const ch of text) {
    if (Buffer.byteLength(out) + Buffer.byteLength(ch) > room) break;
    out += ch;
  }
  return `${out}${marker}`;
}

export function withNetworkList(head: string, names: string[], budget: number): string {
  let out = head;
  let shown = 0;
  for (const name of names) {
    const piece = shown === 0 ? name : `, ${name}`;
    const hidden = names.length - shown - 1;
    const tail = hidden > 0 ? `, +${hidden} more` : '';
    if (shown > 0 && Buffer.byteLength(out + piece + tail) > budget) break;
    out += piece;
    shown += 1;
  }
  if (names.length > shown) out += `, +${names.length - shown} more`;
  // A whole code point at a time, so the trim can't leave half an emoji (#1038).
  while (Buffer.byteLength(out) > budget && out.length > head.length + 1) {
    out = out.slice(0, out.codePointAt(out.length - 2)! > 0xffff ? -2 : -1);
  }
  return out;
}

function toIrcTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// IRCv3 server-time layout used by CHATHISTORY `timestamp=` selectors:
// exactly `YYYY-MM-DDThh:mm:ss.sssZ` (millisecond precision, literal Z).
export function isValidServerTime(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && !Number.isNaN(serverTimeMs(s));
}

// The time a `YYYY-MM-DDThh:mm:ss…Z` string names, or NaN. Date.parse rolls an
// impossible date over (2023-02-30 reads as March 2), so the result has to print
// back as the same date and time.
function serverTimeMs(s: string): number {
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return NaN;
  return new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19) ? ms : NaN;
}

// A CHATHISTORY selector: `*` (LATEST only) or `timestamp=<iso>`. We advertise
// MSGREFTYPES=timestamp only, as soju does (its msgid support is a TODO). History
// lines carry the network's msgid (networkMsgid), but not every message has one,
// and resolving `msgid=` is #641. Timestamp works off any line's @time.
type ChatBound = { star: true } | { iso: string };

// soju.im/FILEHOST: where this account's IRC clients upload a file
// (routes/filehost.ts), or null when there's nowhere to send them. goguma and
// gamja read it on a bound connection and halloy on an unbound one, so both
// bursts carry it, spelled exactly: goguma and halloy match it case-sensitively.
// It needs an https PUBLIC_BASE_URL, which a client on a TLS connection must
// insist on, and which is the only origin the bouncer can know without an HTTP
// request to read one from. Not on a hosted cell, which doesn't mount the route,
// nor for an account with no usable uploader, whose uploads would only fail.
function filehostToken(userId: number): string | null {
  if (isNodeMode()) return null;
  let url: URL;
  try {
    url = new URL(configuredBaseUrl());
  } catch {
    return null;
  }
  // An https origin, maybe with a path, and nothing a path can't follow.
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    return null;
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  const user = findUserById(userId);
  if (!user) return null;
  try {
    resolveUploader({ userId, isAdmin: user.role === 'admin', requestedId: null });
  } catch {
    return null;
  }
  return `soju.im/FILEHOST=${base}/api/filehost`;
}

// How long an echo registered for a line that never went out, and was never
// reported dropped, is remembered (see registerEcho).
const UNSENT_ECHO_TTL_MS = 10 * 60_000;

function isChannelName(target: string): boolean {
  return isChannelTarget(target);
}

export { isServicesNick };

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

// The inverse, for a value a client sent: `\X` for any other X is X, and a
// trailing lone backslash is dropped (message-tags spec).
export function unescapeTagValue(value: string): string {
  const escapes: Record<string, string> = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };
  return value.replace(/\\(.?)/gs, (_m, c: string) => escapes[c] ?? c);
}

// A client's `+`-tags (ParsedClientLine.clientTags) by name, values unescaped.
function clientTagMap(clientTags: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const tag of clientTags.split(';')) {
    const eq = tag.indexOf('=');
    if (eq === -1) tags.set(tag, '');
    else tags.set(tag.slice(0, eq), unescapeTagValue(tag.slice(eq + 1)));
  }
  return tags;
}

// The msgid a client's `+reply` (or `+draft/reply`) names, the ratified name first.
function clientReplyMsgid(clientTags: string): string | undefined {
  const tags = clientTagMap(clientTags);
  return tags.get('+reply') || tags.get('+draft/reply') || undefined;
}

// The msgid a line built from a stored message carries: the network's own
// (#450), the one a client saw on that message live, or none. The chathistory
// spec wants the msgid "as originally sent by the IRC server", and soju and ZNC
// replay the network's or none. A Lurker id would be a second id for the same
// message, which clients can't match. A decrypted E2E message gets none: its
// msgid names the ciphertext line, which a client already got live under it.
function networkMsgid(message: { msgid?: unknown; e2e?: unknown }): string | undefined {
  if (message.e2e) return undefined;
  return typeof message.msgid === 'string' && message.msgid !== '' ? message.msgid : undefined;
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

// One network's BOUNCER NETWORK attributes, in wire order. `error` is there only
// while the network has one: why its last connection attempt failed.
// (soju's `username` and `realname` aren't attributes here.)
export function networkAttrs(
  network: { name: string; host: string; port: number; tls: number | boolean; nick: string },
  opts: { state: string; nickname?: string; error?: string | null },
): Map<string, string> {
  const attrs = new Map<string, string>([
    ['name', network.name],
    ['state', opts.state],
    ['host', network.host],
    ['port', String(network.port)],
    ['tls', network.tls ? '1' : '0'],
    ['nickname', opts.nickname || network.nick],
  ]);
  if (opts.error) attrs.set('error', opts.error);
  return attrs;
}

// Build the tag-encoded attribute list for one network's BOUNCER NETWORK line.
export function buildNetworkAttrs(
  network: { name: string; host: string; port: number; tls: number | boolean; nick: string },
  opts: { state: string; nickname?: string; error?: string | null },
): string {
  return formatNetworkAttrs(networkAttrs(network, opts));
}

function formatNetworkAttrs(attrs: Iterable<[string, string]>): string {
  return Array.from(attrs, ([k, v]) => `${k}=${escapeTagValue(v)}`).join(';');
}

// The attributes to notify a client of, given what it was last sent: all of
// them for a network it hasn't been told about, otherwise only those that
// changed, which is what the spec asks. A removed attribute goes out as `key=`:
// HexDroid reads that as a clear and skips a bare `key`. Null if nothing changed.
export function networkAttrsUpdate(
  sent: Map<string, string> | undefined,
  now: Map<string, string>,
): string | null {
  if (!sent) return formatNetworkAttrs(now);
  const changed: Array<[string, string]> = [];
  for (const [k, v] of now) if (sent.get(k) !== v) changed.push([k, v]);
  for (const k of sent.keys()) if (!now.has(k)) changed.push([k, '']);
  return changed.length > 0 ? formatNetworkAttrs(changed) : null;
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

// The tag block for a replayed line (formatTags). `clientTags` are client-only
// tags (`+reply`, `+draft/react`), which need message-tags.
interface ReplayTags {
  time?: string;
  msgid?: string;
  batchRef?: string;
  clientTags?: Array<[string, string]>;
}

// A reply's tags as a line replayed from history carries them (#991): both
// names, as halloy and goguma send them and Lurker reads them — `+reply` is the
// ratified one, `+draft/reply` what older clients still read.
function replyTags(msgid: string): Array<[string, string]> {
  return [
    ['+draft/reply', msgid],
    ['+reply', msgid],
  ];
}

class BouncerSession implements MonitorHolder, ReplyClient {
  readonly caps = new Set<string>();
  // This client's MONITOR list: folded nick → the nick as the client sent it.
  // The network has one list, which merges this with Lurker's nicks and other
  // clients' lists (monitorList.ts). soju keeps a list per client the same way.
  private readonly monitored = new Map<string, string>();
  // Channels whose NAMES the attach burst held back because the connection
  // hadn't heard them yet, folded. They go out once it has (onNamesHeard).
  private readonly namesPending = new Set<string>();
  // Channels this client has been sent a JOIN for, folded: in its join burst, or
  // relayed. An engine re-attach replays a JOIN for every channel, and only the
  // ones not in here reach the client.
  private readonly joinsSent = new Set<string>();
  // Whether this client has had a welcome: its attach burst, or any live line
  // from the network. The rest of an engine re-attach's replay (LUSERS, MOTD)
  // reaches only a client that hasn't.
  private welcomed = false;
  // What the client may request right now: SUPPORTED_CAPS, plus whichever
  // pass-through caps apply (see handleCap and updateSupportedCaps).
  private readonly availableCaps = new Set<string>(SUPPORTED_CAPS);
  // The highest CAP LS version the client sent; 301 until it sends 302.
  private capVersion = 301;
  userId = 0;
  // The API token this session authenticated with, or null for the password.
  apiTokenId: number | null = null;
  networkId = 0;
  lastActivityAt = Date.now();

  private readonly socket: net.Socket;
  private readonly remoteIp: string;
  private buf = '';
  // Decode incrementally so a multi-byte UTF-8 character split across two TCP
  // segments isn't corrupted (chunk.toString() per packet would mangle it).
  private readonly decoder = new StringDecoder('utf8');
  // Every line written to this client passes through it (see write()).
  private readonly clientFilter: ClientLineFilter;
  private capNegotiating = false;
  // SASL PLAIN state: the requested mechanism (null until AUTHENTICATE <mech>),
  // an accumulator for base64 payloads that arrive in 400-byte chunks, and
  // whether an exchange succeeded, with the network it named (consumed at CAP
  // END). The account it authenticated is `userId`.
  private saslMechanism: string | null = null;
  private saslBuffer = '';
  private saslAuthenticated = false;
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
  // An AWAY sent before registration (draft/pre-away), applied once the account
  // is known. null for none; '' for a bare AWAY.
  private pendingAway: string | null = null;
  // This client's AWAY before registration was answered then. That 305/306
  // stands for the account's state too, so the attach burst doesn't repeat it.
  private awayAnswered = false;
  // This client said `AWAY *`: it isn't the user, so it doesn't count as the
  // user being here (presence.ts).
  private notPresent = false;
  // The last 305 (false) or 306 (true) this client was sent. A control
  // connection is away when every network is (allNetworksAway), which a network
  // added or deleted can change as well as an away, so it's reconciled against
  // this rather than told about each change.
  private reportedAway = false;
  // A pre-registration `BOUNCER BIND <id>` selector, consumed at completeAttach
  // (takes precedence over a username-embedded network name).
  private boundNetId: number | null = null;
  // A per-session counter for BATCH reference tags (LISTNETWORKS / initial dump).
  private batchSeq = 0;
  // The bound network's state this client was last told about in a notice.
  private noticedState: string | null = null;
  // The reason last said with it, so the same state saying something new is news.
  private noticedError = '';
  // The attributes this client was last sent for each network: in the network
  // list or a notification. A notification is a change to what the client
  // holds, and clients attach at different times, so this is what each
  // client's notifications are measured against. The networks are the
  // account's; this only records what this client has been told.
  private networksSent = new Map<number, Map<string, string>>();
  // Outbound sends awaiting their self-echo event from ircManager, so a
  // client that didn't negotiate echo-message doesn't get its own message
  // back (it already rendered it locally). Other attached clients and web
  // tabs still receive the echo. Keys are per wire chunk, and entries expire
  // after a short window so an unconsumed key (from the rare chunking-
  // mismatch cases) can't suppress an identical message sent much later.
  private pendingEcho: Array<{ key: string; at: number; since: number }> = [];
  private onRawUpstream: ((event: { from_server: boolean; line: string }) => void) | null = null;
  // draft/metadata-2 (#607): the keys this client subscribed to. Merged onto
  // the network's one list through IrcConnection.addMetadataKeys.
  private readonly metadataSubs = new Set<string>();
  private metadataBatchSeq = 0;
  private onUpstreamCaps: (() => void) | null = null;
  private onUpstreamMetadata: ((change: Record<string, unknown>) => void) | null = null;
  // The upstream registering again under an attached client (#1202). Armed by
  // its 001, consumed at the end of that burst by sendRegistrationUpdate.
  private onUpstreamRegistered: (() => void) | null = null;
  private onUpstreamMotd: (() => void) | null = null;
  private burstPending = false;
  // The nick this client was last told is its own: the attach burst's, then
  // every self-NICK relayed since. The nick the upstream registers under can
  // differ from it — a 433 fallback comes with no NICK line.
  private toldNick: string | null = null;
  private regTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.remoteIp = socket.remoteAddress || 'unknown';
    this.clientFilter = new ClientLineFilter({
      caps: this.caps,
      serverName: SERVER_NAME,
      nick: () => this.currentNick() || this.clientNick,
      prefixes: () => this.isupportPrefixes(),
      sharedChannels: (nick) => this.sharedChannels(nick),
      monitors: (nick) => this.monitored.has(nick.toLowerCase()),
    });
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

  isControlSession(): boolean {
    return this.isControl;
  }

  // `relayedAt` marks a line the network sent (see ClientLineFilter.apply).
  private write(line: string, relayedAt?: Date): void {
    if (this.closed) return;
    try {
      // No generated line legitimately contains CR/LF/NUL; scrub rather than
      // let an embedded newline in interpolated text split into a second
      // injected command. Matching control chars is the point of the regex.
      // eslint-disable-next-line no-control-regex
      const scrubbed = line.replace(/[\r\n\u0000]/g, ' ');
      // The one exit point: whatever wrote the line, the client gets only what
      // its caps allow (#926).
      for (const out of this.clientFilter.apply(scrubbed, relayedAt))
        this.socket.write(out + '\r\n');
    } catch {
      this.destroy();
    }
  }

  private numeric(code: string, params: string): void {
    const nick = this.currentNick() || this.clientNick || '*';
    this.write(`:${SERVER_NAME} ${code} ${nick} ${params}`);
  }

  // Bytes of message text that still fit on one 512-byte IRC line after this
  // session's `:<server> <verb> <nick> :` prefix. Measured against the widest
  // verb these list lines use (NOTICE), so it also covers the shorter 464.
  // 480 leaves the same headroom for CRLF and prefix drift as buildNamesLines.
  private wireTextBudget(): number {
    const nick = this.currentNick() || this.clientNick || '*';
    return Math.max(64, 480 - Buffer.byteLength(`:${SERVER_NAME} NOTICE ${nick} :`));
  }

  private notice(text: string): void {
    const nick = this.currentNick() || this.clientNick || '*';
    // A server's own words reach these (a ban reason in a disconnect notice),
    // and a line past 512 bytes is truncated or dropped by the client.
    this.write(`:${SERVER_NAME} NOTICE ${nick} :${clampToBudget(text, this.wireTextBudget())}`);
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
      case 'AWAY':
        // draft/pre-away. Accepted with or without the cap, as soju does
        // (downstream.go:936): goguma sends it ahead of CAP END.
        this.handleAway(msg);
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
        this.capVersion = Math.max(this.capVersion, capVersion);
        if (capVersion >= 302) {
          // Before registration the network isn't known, so a 302 client is
          // shown the pass-through caps too, and binding takes back the ones
          // the network lacks with a CAP DEL (soju does the same). 302 also
          // turns on cap-notify, which is what carries that DEL to the client.
          if (!this.registered) for (const cap of PASSTHROUGH_CAPS) this.availableCaps.add(cap);
          this.caps.add('cap-notify');
        }
        this.write(
          `:${SERVER_NAME} CAP ${nick} LS :${capLsList(this.availableCaps, capVersion, (cap) =>
            this.networkCapValue(cap),
          )}`,
        );
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
        const supported = requested.every((c) => this.availableCaps.has(c.replace(/^-/, '')));
        // cap-notify can't be turned off once CAP LS 302 has turned it on.
        const dropsCapNotify = this.capVersion >= 302 && requested.includes('-cap-notify');
        if (!supported || dropsCapNotify || requested.length === 0) {
          this.write(`:${SERVER_NAME} CAP ${nick} NAK :${requested.join(' ')}`);
          break;
        }
        for (const cap of requested) {
          if (cap.startsWith('-')) this.caps.delete(cap.slice(1));
          else this.caps.add(cap);
        }
        // A client that gives up batch is done with every batch it was sent,
        // even if it asks for batch again before one ends.
        if (requested.includes('-batch')) this.clientFilter.forgetSentBatches();
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

  // soju's updateSupportedCaps: the pass-through caps follow the bound network.
  // Runs once registration settles on a network (or on none, for a control
  // connection) and again whenever that network's caps may have changed. A cap
  // the network lacks leaves both sets, or the client would wait for lines that
  // never come. `nick` is the one the client knows itself by at that moment.
  private updateSupportedCaps(nick: string): void {
    const upstream = new Set<string>(
      !this.isControl && this.conn?.state === 'connected'
        ? (this.conn.client.network?.cap?.enabled ?? [])
        : [],
    );
    const added: string[] = [];
    const removed: string[] = [];
    const networkHas = (cap: string) =>
      EXTENDED_MONITOR_CAPS.includes(cap)
        ? EXTENDED_MONITOR_CAPS.some((name) => upstream.has(name))
        : upstream.has(cap);
    for (const cap of PASSTHROUGH_CAPS) {
      if (networkHas(cap) && !this.availableCaps.has(cap)) {
        this.availableCaps.add(cap);
        added.push(cap);
      } else if (!networkHas(cap) && this.availableCaps.has(cap)) {
        this.availableCaps.delete(cap);
        this.caps.delete(cap);
        removed.push(cap);
      }
    }
    if (!this.caps.has('cap-notify')) return;
    if (added.length > 0) this.write(`:${SERVER_NAME} CAP ${nick} NEW :${added.join(' ')}`);
    if (removed.length > 0) this.write(`:${SERVER_NAME} CAP ${nick} DEL :${removed.join(' ')}`);
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
    const throttled = throttledMessage(this.remoteIp);
    if (throttled) {
      this.write(`:${SERVER_NAME} 904 ${nick} :${throttled}`);
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
      bouncerAuthThrottle.recordFailure(this.remoteIp);
      return fail();
    }
    const verified = verifyBouncerLogin(login.username, passwd);
    if (!verified) {
      bouncerAuthThrottle.recordFailure(this.remoteIp);
      return fail();
    }
    bouncerAuthThrottle.reset(this.remoteIp);
    const { user } = verified;
    // Reject a paused account here rather than after signaling 903, so the
    // client isn't told auth succeeded and then killed at CAP END.
    if (user.is_paused) {
      this.write(`:${SERVER_NAME} 904 ${nick} :Account is paused`);
      return;
    }
    // The session is the account's from here, not from CAP END, which can be a
    // minute away: a pause, recovery or deletion in between closes it, and so
    // does revoking the token it used (#914).
    this.userId = user.id;
    this.apiTokenId = verified.apiTokenId;
    this.saslAuthenticated = true;
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
  // via SASL (this.saslAuthenticated); otherwise fall back to the ZNC-style PASS floor.
  private authenticate(): void {
    if (this.saslAuthenticated) {
      // SASL PLAIN already authenticated; the network selector rides the SASL
      // authcid, falling back to the USER field (`USER user/network …`).
      const networkSel = this.saslNetwork ?? unmarshalLogin(this.clientUser || '').network;
      this.completeAttach(this.userId, networkSel);
      return;
    }
    const throttled = throttledMessage(this.remoteIp);
    if (throttled) {
      this.closeWithError(throttled);
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
    const verified = verifyBouncerLogin(creds.username, creds.secret);
    if (!verified) {
      bouncerAuthThrottle.recordFailure(this.remoteIp);
      this.failRegistration('Invalid username or password/token');
      return;
    }
    bouncerAuthThrottle.reset(this.remoteIp);
    this.userId = verified.user.id;
    this.apiTokenId = verified.apiTokenId;
    this.completeAttach(verified.user.id, creds.network);
  }

  private clearRegTimer(): void {
    if (this.regTimer) {
      clearTimeout(this.regTimer);
      this.regTimer = null;
    }
  }

  // Called at CAP END / registration completion. Resolves the target network
  // (BIND id > username selector > capless single-network default), or drops
  // into control mode for any client that named no network. The account is
  // read as it is now: a SASL login may be a minute old (soju reads its live
  // user at attach too).
  private completeAttach(userId: number, networkSel: string | null): void {
    const user = findUserById(userId);
    if (!user) {
      this.failRegistration('Account removed');
      return;
    }
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

    // Control (unbound) mode. A bouncer-networks-aware client that named no
    // network manages its networks via BOUNCER instead of attaching to one —
    // and soju parity means a client that named no network registers even when
    // it *can't* do that (soju's register() never fails on a missing network
    // name), rather than eating a 464 mid-onboarding. Goguma is the case that
    // forced this: its first-run registration negotiates nothing but sasl and
    // carries no network selector, so it used to hit the "multiple networks"
    // 464 below and could never get far enough to discover them.
    //
    // The one exception is the documented ZNC floor (`PASS user:secret` with a
    // single network): a client with no bouncer-networks cap can't do anything
    // useful in our control mode, which carries no channel traffic, so keep
    // auto-binding its only network.
    const hasSelector = this.boundNetId !== null || !!networkSel;
    const networks = listNetworksForUser(user.id);
    if (!hasSelector && (this.caps.has(CAP_BOUNCER_NETWORKS) || networks.length !== 1)) {
      this.registerControl(user, networks);
      return;
    }

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
          withNetworkList(
            `Unknown network '${networkSel}' — available: `,
            networks.map((n) => n.name),
            this.wireTextBudget(),
          ),
        );
        return;
      }
    } else {
      // Selector-less and capless: the guard above leaves exactly one network.
      network = networks[0];
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
    // Which reason the last attempt left before this attach touched anything. A
    // restart below supersedes it — but a restart that fails on the spot (a
    // proxy or certificate refusal is synchronous) records a NEW one, which
    // stands. The recording, not its text: the same host refusing the same
    // certificate twice says the same words.
    const errorBefore = ircManager.connectionErrorSeqFor(user.id, network.id);
    let conn = ircManager.getConnection(user.id, network.id);
    let restarted = false;
    if (!conn) {
      conn = ircManager.startNetwork(user.id, network.id);
      restarted = true;
    } else if (conn.state === 'disconnected') {
      conn = ircManager.restartNetwork(user.id, network.id, 'bouncer client attached');
      restarted = true;
    }
    const superseded = restarted ? errorBefore : 0;
    if (!conn) {
      this.failRegistration('Network is unavailable');
      return;
    }

    this.userId = user.id;
    this.networkId = network.id;
    this.network = network;
    this.conn = conn;
    this.noticedState = conn.state;
    this.noticedError = ircManager.connectionError(user.id, network.id) || '';
    this.registered = true;
    this.clearRegTimer();
    attachToRegistry(this);
    // Before the burst, so everything in it already follows the settled caps.
    this.updateSupportedCaps(this.clientNick || '*');
    // Before the burst too, so its 306 follows an AWAY sent before registration.
    this.applyPendingAway();
    this.sendAttachBurst(superseded);
    // An attached client is the user being here, unless it said `AWAY *`.
    evaluatePresence(this.userId);
    systemLog.log({
      userId: this.userId,
      scope: 'bouncer',
      fields: { networkId: this.networkId },
      text: `IRC client attached from ${this.remoteIp} (${attachedSessionCount(this.userId, this.networkId)} attached to ${network.name})`,
    });
  }

  // True if the client speaks the bouncer-networks extension at all. BIND needs
  // the base cap, but for *explaining* an unbound connection either cap means
  // the client can read the BOUNCER NETWORK lines and doesn't need the prose.
  private knowsBouncerNetworks(): boolean {
    return this.caps.has(CAP_BOUNCER_NETWORKS) || this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY);
  }

  // Register a control (unbound) connection: authenticated, bound to no network.
  // It lives only in the global `sessions` set (no per-network registry); state
  // notifications reach it via the user-scoped fan-out in dispatchIrcEvent.
  private registerControl(user: User, networks: Network[]): void {
    this.userId = user.id;
    this.isControl = true;
    this.registered = true;
    this.clearRegTimer();
    this.updateSupportedCaps(this.clientNick || '*');
    this.applyPendingAway();
    this.sendControlBurst(user, networks);
    // failRegistration used to console.warn the reason for the commonest
    // misconfiguration (bare username, several networks). It no longer fails,
    // so record the reason where an operator debugging "it connects but shows
    // nothing" will look.
    const reason =
      networks.length === 0
        ? 'no networks configured'
        : this.caps.has(CAP_BOUNCER_NETWORKS)
          ? 'client picks a network itself'
          : `no network named, ${networks.length} available`;
    systemLog.log({
      userId: this.userId,
      scope: 'bouncer',
      text: `Bouncer control connection from ${this.remoteIp} (${reason})`,
    });
  }

  // --- attach burst ----------------------------------------------------------

  private sendAttachBurst(superseded = 0): void {
    const conn = this.conn!;
    const requested = this.clientNick || conn.currentNick || 'user';
    const liveNick = conn.currentNick || requested;

    // ZNC's welcome shape: numerics target the nick the client asked for, then
    // an explicit NICK line moves it onto the connection's real nick. Replay
    // the network's own 001–005 when we have them so the client sees the real
    // ISUPPORT tokens (CHANTYPES/PREFIX/NETWORK drive its parsing).
    if (conn.state === 'connected' && conn.registrationLines.length > 0) {
      for (const line of conn.registrationLines) this.replayBurstLine(line, requested);
    } else {
      this.writeWelcomeNumerics(requested);
    }
    if (requested !== liveNick) this.writeSelfNick(requested, liveNick);
    this.toldNick = liveNick;
    this.writeExtraIsupport(liveNick);
    this.write(`:${SERVER_NAME} 422 ${liveNick} :MOTD File is missing`);

    if (conn.state !== 'connected') {
      // Why it's down, for a client that attached after it went: soju sends the
      // same on attach (user.go:823). `superseded` is the reason this attach's
      // own restart replaced — saying "not reconnecting automatically" would
      // contradict the retry under way — while a reason that restart just
      // recorded is about what's happening now, and is said.
      const current = ircManager.connectionError(this.userId, this.networkId) || '';
      const stale = ircManager.connectionErrorSeqFor(this.userId, this.networkId) === superseded;
      const why = stale ? '' : current;
      this.notice(
        `Network '${this.network?.name}' is ${conn.state}; channels will appear once it registers.` +
          (why ? ` ${why}` : ''),
      );
    } else {
      this.sendJoinBurst();
      this.sendPlayback();
    }

    // A -notify client gets the full network list up-front (soju sends this at
    // registration completion for bound and control connections alike).
    if (this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) this.sendNetworkList();

    // A network that's away says so, as ZNC does for a client that attaches
    // (IRCNetwork.cpp:708), but after the channels: halloy keeps its own away
    // state on each channel's member list.
    if (!this.awayAnswered && isAwayRow(getNetworkAwayState(this.networkId))) {
      this.sendAwayReply(true);
    }

    // Live relay attaches AFTER playback so replayed history and the live
    // stream don't interleave out of order.
    this.onRawUpstream = (event) => {
      if (this.closed || !event?.from_server || typeof event.line !== 'string') return;
      // A disposed connection (a network edit, a reconnect) acts on nothing its
      // socket still delivers (#936), so its raw listener doesn't route the
      // line either: owner and answerer below would read null and let a reply
      // to Lurker through. This session is dead with it (see liveConn()).
      if (conn.disposed) return;
      // An engine re-attach replays the session into the connection: the
      // registration burst, LUSERS, MOTD and a JOIN for every channel. What of it
      // reaches this client is decided below. The backlog after the replay is
      // what the client missed, and comes through.
      const replaying = !!conn.restoring;
      if (!replaying) this.welcomed = true;
      // A line of a batch that was open when the link to the engine dropped
      // comes again with the backlog (#1286), for irc-framework, which lost
      // it. This client was sent it the first time.
      if (conn.lineKept) return;
      // A reply goes only to whoever asked for it: this client, another one,
      // the user or Lurker (replyRouter.ts). The connection decided in its own
      // raw listener, which runs before this one.
      const owner = conn.replyOwner;
      if (owner != null && owner !== 'unasked' && owner !== this) return;
      // One side answers a CTCP request (IrcConnection.ctcpAnswerer, #932). A
      // request Lurker answers, or nobody does, never reaches a client.
      if (conn.ctcpAnswerer === 'lurker' || conn.ctcpAnswerer === 'nobody') return;
      // Some upstreams (Ergo always-on, a chained bouncer, echo-message relays)
      // reflect our OWN PRIVMSG/NOTICE back. dispatchIrcEvent already synthesizes
      // the self-echo, so drop the reflected copy to avoid a duplicate line.
      if (this.isReflectedSelfLine(event.line)) return;
      // The time the connection gave this line, so a line without server-time
      // goes out with the time its stored row has (IrcConnection.lineArrivedAt).
      const relayedAt = conn.lineArrivedAt ?? new Date();
      const monitorReplies = this.monitorRelay(event.line);
      if (monitorReplies) {
        for (const line of monitorReplies) this.write(line, relayedAt);
        return;
      }
      // A metadata line nobody here asked for goes to the clients that
      // subscribed to its key and can see its target; a reply to this
      // client's own query (owner === this) comes through whole.
      if (owner !== this && !this.wantsMetadataLine(event.line)) return;
      const out = filterRelayLine(event.line);
      if (!out) return;
      // `out`, not event.line: irc-framework's raw line keeps its CRLF, which
      // would end up on the channel name.
      const joined = selfJoinChannel(out, this.currentNick());
      // Our own NICK, from the nick this client knows us by (look before
      // parsing: almost no relayed line is a NICK).
      const renamed = SELF_NICK_HINT.test(out)
        ? selfNickChange(out, this.toldNick, this.networkId)
        : null;
      // A replayed line reaches this client only if it's news.
      // - A JOIN: only for a channel the client hasn't been sent a JOIN for.
      //   irssi rebuilds any channel it gets a second self-JOIN for. A client
      //   that attached while the link was down, or partway through the replay,
      //   learns its channels this way.
      // - A self-NICK off the nick it was told: the replayed 001 carries the
      //   nick the socket registered with, and the NICK behind it the live one
      //   (ircConnection 'registered'). A client that attached between the two
      //   was told the first; one that stayed knows the second already, and
      //   its prefix doesn't match.
      // - The rest: only for a client that hasn't had a welcome.
      if (replaying) {
        const news = joined
          ? !this.joinsSent.has(foldTargetFor(this.networkId, joined))
          : renamed
            ? true
            : !this.welcomed;
        if (!news) return;
      }
      this.write(out, relayedAt);
      if (renamed) this.toldNick = renamed;
      // The network's own NAMES for a channel the burst held back: nothing more
      // to send for it.
      if (this.namesPending.size > 0) {
        const names = parseClientLine(out);
        if (names?.command === '366' && names.params[1]) {
          this.namesPending.delete(foldTargetFor(this.networkId, names.params[1]));
        }
      }
      if (joined) {
        this.joinsSent.add(foldTargetFor(this.networkId, joined));
        // A replayed JOIN brings no NAMES: the restore asks for them itself, and
        // their replies are Lurker's. They follow once the connection has them.
        if (replaying && conn.membersPending(joined)) {
          this.namesPending.add(foldTargetFor(this.networkId, joined));
        }
        // The spec wants MARKREAD after our JOIN and before the channel's 366.
        // The network's NAMES are relayed as they come, so right after the JOIN
        // is it.
        if (this.caps.has(CAP_READ_MARKER)) this.sendReadMarker(joined);
      }
    };
    // irc-framework's Client is an eventemitter3, which has no listener-count
    // cap — several attached clients can listen on one upstream client freely.
    conn.client.on('raw', this.onRawUpstream);
    // The network's caps can change under a live connection: its own CAP
    // NEW/DEL, or a REQ Lurker sends after registration (#888).
    this.onUpstreamCaps = () => {
      if (!this.closed && !conn.disposed) this.updateSupportedCaps(this.currentNick() || '*');
    };
    conn.client.on('cap ack', this.onUpstreamCaps);
    conn.client.on('cap del', this.onUpstreamCaps);
    // A new registration burst, for sendRegistrationUpdate. Armed at the 001
    // and sent at the end of the burst: the connection says 'connected' at the
    // 001, before any 005 has arrived. A restore replays an old burst into the
    // connection, not a new registration (bouncer.reattach.test.ts).
    this.onUpstreamRegistered = () => {
      if (!this.closed && !conn.disposed && !conn.restoring) this.burstPending = true;
    };
    this.onUpstreamMotd = () => {
      if (!this.burstPending) return;
      this.burstPending = false;
      if (!this.closed && !conn.disposed) this.sendRegistrationUpdate();
    };
    conn.client.on('registered', this.onUpstreamRegistered);
    conn.client.on('motd', this.onUpstreamMotd);
    // Attached between the 001 and the end of its burst: the attach replayed
    // what of the burst had come, and the 001 that would have armed this is
    // past. Lurker's boot is this window for a client whose reconnect beats
    // the network's 005s.
    this.burstPending = conn.state === 'connected' && !conn.isupportComplete && !conn.restoring;
    // A metadata change that came as somebody else's reply (#607): the raw
    // relay gave it to its asker alone, so it's said here to everyone else
    // who subscribed to the key and can see the target.
    this.onUpstreamMetadata = (change) => {
      const { owner } = change;
      const target = String(change.target ?? '');
      const key = String(change.key ?? '');
      const value = change.value == null ? null : String(change.value);
      if (this.closed || conn.disposed || owner === this || !target || !key) return;
      const line =
        value === null
          ? `:${SERVER_NAME} 766 * ${target} ${key} :Key deleted`
          : `:${SERVER_NAME} 761 * ${target} ${key} * :${value}`;
      if (this.wantsMetadataLine(line)) this.write(line);
    };
    conn.client.on('lurker metadata', this.onUpstreamMetadata);
  }

  // Append our own ISUPPORT for tokens the upstream's 005 can't carry:
  // BOUNCER_NETID (which network this connection bound) and the chathistory
  // limits. Bundled into one 005 line, gated on the relevant caps.
  private writeExtraIsupport(nick: string): void {
    const extraIsupport: string[] = [];
    if (this.caps.has(CAP_BOUNCER_NETWORKS)) extraIsupport.push(`BOUNCER_NETID=${this.networkId}`);
    if (this.caps.has(CAP_CHATHISTORY)) {
      extraIsupport.push(`CHATHISTORY=${MAX_CHATHISTORY}`, 'MSGREFTYPES=timestamp');
    }
    const filehost = filehostToken(this.userId);
    if (filehost) extraIsupport.push(filehost);
    if (extraIsupport.length > 0) {
      this.write(
        `:${SERVER_NAME} 005 ${nick} ${extraIsupport.join(' ')} :are supported by this server`,
      );
    }
  }

  // Move the client from the nick it knows itself by onto the connection's, as
  // ZNC does (IRCNetwork.cpp:677): the client's own hostmask, not the network's.
  private writeSelfNick(from: string, to: string): void {
    const user = this.conn?.client.user?.username || 'lurker';
    this.write(`:${from}!${user}@${SERVER_NAME} NICK :${to}`);
  }

  // The upstream registered again under this client (#1202). A client that
  // bound while the network was down had Lurker's own 001–004 and no 005 at
  // all; one that bound to a live network has the old socket's. The 001–005
  // themselves are RELAY_DROP, replayed only at attach, so the new burst's
  // 005s are sent now — whole, not diffed: a client replaces a token it is
  // told again, and solanum repeats its own ISUPPORT after every VERSION.
  // First the registered nick, when the client wasn't told it: a 433 fallback
  // during registration has no NICK line, unlike a rename after it, which the
  // relay carried and toldNick followed. soju sends the changed tokens and the
  // NICK at upstream connect (user.go:702, downstream.go:1365); ZNC forwards
  // the whole burst live and NICKs each client (IRCSock.cpp:870).
  private sendRegistrationUpdate(): void {
    const conn = this.conn!;
    const live = conn.currentNick;
    if (live && this.toldNick && live !== this.toldNick) {
      this.writeSelfNick(this.toldNick, live);
      this.toldNick = live;
    }
    const nick = this.toldNick || live || this.clientNick || '*';
    for (const line of conn.registrationLines) {
      if (parseClientLine(line)?.command === '005') this.replayBurstLine(line, nick);
    }
    this.writeExtraIsupport(nick);
  }

  // One line of the network's registration burst, to a client. Saved at
  // registration with the upstream's tags, so any per-delivery tag on it
  // (msgid, batch) is stale by now. Like ZNC, the replay keeps at most `time`,
  // and write() drops that too unless the client negotiated server-time (#892).
  // The network's own FILEHOST never goes out: our clients upload with their
  // Lurker credentials (filehostToken). The numeric is pointed at `nick`.
  private replayBurstLine(line: string, nick: string): void {
    const tagged = restrictTags(line, (key) => key === 'time');
    const out = tagged && withoutUpstreamFilehost(tagged);
    if (out) this.write(rewriteNumericTarget(out, nick));
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
  private sendControlBurst(user: User, networks: Network[]): void {
    const nick = this.clientNick || 'user';
    this.writeWelcomeNumerics(nick);
    const filehost = filehostToken(user.id);
    this.write(
      `:${SERVER_NAME} 005 ${nick} NETWORK=${APP_NAME} CASEMAPPING=ascii${filehost ? ` ${filehost}` : ''} :are supported by this server`,
    );
    // Say why nothing is here, ahead of the MOTD-missing line that closes the
    // burst. A bouncer-networks client with networks to pick from needs no
    // explanation (it's about to LISTNETWORKS/BIND), but an empty account gives
    // it an empty list, and a client that knows nothing of the extension has
    // landed somewhere it can't act on at all — that used to be a 464 carrying
    // this same advice, so keep the advice now that registration succeeds.
    if (networks.length === 0) {
      this.notice('No IRC networks configured yet — add one in the web UI, then reconnect.');
    } else if (!this.knowsBouncerNetworks()) {
      this.notice(
        withNetworkList(
          `Not attached to a network — log in as ${user.username}/<network> to attach. Available: `,
          networks.map((n) => n.name),
          this.wireTextBudget(),
        ),
      );
    }
    this.write(`:${SERVER_NAME} 422 ${nick} :MOTD File is missing`);
    // A -notify client gets the full network list up-front as a batch.
    if (this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) this.sendNetworkList();
    // A control connection stands for the whole account: away when every
    // network is, as its own AWAY sets every network.
    if (!this.awayAnswered && allNetworksAway(this.userId)) this.sendAwayReply(true);
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
    if (!this.saslAuthenticated && !this.passRaw) {
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

  // Run `fn(ref)` wrapped in a BATCH of the given type + params when the client
  // negotiated the `batch` cap (`ref` is the batch reference, or null unbatched
  // — IRCv3: no tags to clients that didn't ask). Mirrors soju's SendBatch.
  private withBatch(type: string, params: string[], fn: (ref: string | null) => void): void {
    const ref = this.caps.has('batch') ? `lb${++this.batchSeq}` : null;
    if (ref) this.write(`:${SERVER_NAME} BATCH +${ref} ${[type, ...params].join(' ')}`);
    fn(ref);
    if (ref) this.write(`:${SERVER_NAME} BATCH -${ref}`);
  }

  // Reply to LISTNETWORKS (and the initial -notify dump) with a BOUNCER NETWORK
  // line per network. The soju.im/bouncer-networks batch wrapper (and its
  // `@batch=` message tag) is only used when the client negotiated `batch` —
  // otherwise we must not emit tags, so send the same lines unwrapped. The list
  // is everything the client now knows, so later notifications start from it.
  private sendNetworkList(): void {
    this.networksSent.clear();
    this.withBatch('soju.im/bouncer-networks', [], (ref) => {
      const tag = ref ? `@batch=${ref} ` : '';
      for (const network of listNetworksForUser(this.userId)) {
        const attrs = this.currentNetworkAttrs(network);
        this.networksSent.set(network.id, attrs);
        this.write(
          `${tag}:${SERVER_NAME} BOUNCER NETWORK ${network.id} ${formatNetworkAttrs(attrs)}`,
        );
      }
    });
  }

  private currentNetworkAttrs(network: Network): Map<string, string> {
    const conn = ircManager.getConnection(this.userId, network.id);
    return networkAttrs(network, {
      state: bouncerNetworkState(conn?.state),
      nickname: conn?.currentNick || network.nick,
      error: ircManager.connectionError(this.userId, network.id),
    });
  }

  // One of the account's networks was added, edited or deleted, or changed
  // state (`network` is its row now, undefined once deleted). A client bound to
  // it takes the new row, so its notices name the network right. A -notify
  // client hears what changed since it was last told: every attribute of a
  // network new to it, `*` for one it knew that's gone (soju's deleteNetwork).
  onNetworkChanged(networkId: number, network: Network | undefined): void {
    if (this.closed) return;
    if (network && this.networkId === networkId) this.network = network;
    // A network added beside away ones, or the last one not away deleted.
    this.reconcileControlAway();
    if (!this.caps.has(CAP_BOUNCER_NETWORKS_NOTIFY)) return;
    const sent = this.networksSent.get(networkId);
    if (!network) {
      if (!sent) return;
      this.networksSent.delete(networkId);
      this.write(`:${SERVER_NAME} BOUNCER NETWORK ${networkId} *`);
      return;
    }
    const now = this.currentNetworkAttrs(network);
    const update = networkAttrsUpdate(sent, now);
    this.networksSent.set(networkId, now);
    if (update) this.write(`:${SERVER_NAME} BOUNCER NETWORK ${networkId} ${update}`);
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
    const bound0 = this.parseChatHistoryBound(
      sub,
      target,
      msg.params[2] || '',
      sub === 'LATEST',
      'first',
    );
    if (!bound0) return;
    let bound1: ChatBound | null = null;
    if (isBetween) {
      bound1 = this.parseChatHistoryBound(sub, target, msg.params[3] || '', false, 'second');
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
    // Closed buffers are excluded, matching the playback burst — before the
    // buffers registry this path enumerated straight from messages and offered
    // conversations the user had closed everywhere else.
    const closed = closedFoldedSetForNetwork(this.networkId);
    // The set holds target_folded values — per-network folds since #707, so
    // the probe must fold the same way or a closed 'foo[m]' (stored 'foo{m}'
    // on an rfc1459 network) slips past and gets re-offered.
    const targets = listActiveTargetsInWindow(this.networkId, isoA, isoB, limit, {
      events: this.historyEvents(),
      reactions: this.replaysReactions(),
      withoutSelfInDms: !this.wantsSelfMessages(),
    }).filter((t) => !closed.has(foldTargetFor(this.networkId, t.target)));
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
  ): HistoryRow[] {
    const nid = this.networkId;
    const events = this.historyEvents();
    const reactions = this.replaysReactions();
    // Our own lines this client won't be sent stay out of the window itself.
    const withoutSelf = !this.replaysSelfLine(isChannelName(target), target);
    // Only LATEST's bound can be `*` (unbounded); every other bound is a
    // timestamp by the time we get here (the parser rejects `*` elsewhere).
    const iso = (b: ChatBound): string | null => ('iso' in b ? b.iso : null);
    switch (sub) {
      case 'BEFORE':
        return loadHistoryWindow(nid, target, null, iso(bound0), limit, {
          newestFirst: true,
          events,
          reactions,
          withoutSelf,
        });
      case 'AFTER':
        return loadHistoryWindow(nid, target, iso(bound0), null, limit, {
          events,
          reactions,
          withoutSelf,
        });
      case 'LATEST':
        return loadHistoryWindow(nid, target, iso(bound0), null, limit, {
          newestFirst: true,
          events,
          reactions,
          withoutSelf,
        });
      case 'AROUND': {
        // Split the limit around the point: newest half before, earliest after.
        const afterLimit = Math.floor(limit / 2);
        const older = loadHistoryWindow(nid, target, null, iso(bound0), limit - afterLimit, {
          newestFirst: true,
          events,
          reactions,
          withoutSelf,
        });
        const newer = loadHistoryWindow(nid, target, iso(bound0), null, afterLimit, {
          events,
          reactions,
          withoutSelf,
        });
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
          events,
          reactions,
          withoutSelf,
        });
      }
    }
    return [];
  }

  private sendChatHistoryBatch(target: string, rows: HistoryRow[]): void {
    this.withBatch('chathistory', [target], (ref) => {
      const lines = this.playbackLines(rows, target, isChannelName(target), {
        batchRef: ref ?? undefined,
      });
      for (const line of lines) this.write(line);
    });
  }

  // For a draft/event-playback client, the event rows its history windows also
  // hold (see historyFilter): everything but those naming our current nick.
  private historyEvents(): HistoryEvents | null {
    if (!this.caps.has(CAP_EVENT_PLAYBACK)) return null;
    return { me: this.currentNick() || this.network?.nick || null };
  }

  // Whether this client's history windows hold the reactions made in them, as
  // TAGMSGs (#991). soju's rule: its store keeps a reaction TAGMSG with no text,
  // and a window without draft/event-playback takes only rows with text
  // (database/sqlite.go `m.text IS NOT NULL`), so only an event-playback client
  // gets them — goguma and halloy ask for it. And a TAGMSG never goes to a client
  // without message-tags (downstream.go SendMessage). Attach playback never
  // replays them, as soju's backlog doesn't (it loads without Events).
  private replaysReactions(): boolean {
    return this.caps.has(CAP_EVENT_PLAYBACK) && this.caps.has('message-tags');
  }

  // Parse a CHATHISTORY selector — `*` (LATEST only) or `timestamp=<iso>`. msgid
  // selectors are deliberately rejected (see the ChatBound type). Writes a FAIL
  // and returns null on error.
  //
  // The spec separates two failure modes and we honor the distinction, because a
  // client probing for msgid support reads the code to decide what to do next:
  //   INVALID_MSGREFTYPE — a well-formed `<reftype>=<value>` we don't implement.
  //     Retrying with different syntax will never help; use timestamp instead.
  //   INVALID_PARAMS — the selector is malformed (unparseable timestamp value, or
  //     not a `key=value` selector at all). A syntax error the client can fix.
  // Reporting the first as the second is a lie that hides the real reason, and
  // it's the kind of thing a conformance-minded onlooker checks.
  //
  // The two codes also take DIFFERENT parameter layouts, which is easy to get
  // wrong: INVALID_MSGREFTYPE is `<command> <target> [context]` while
  // INVALID_PARAMS is `<command> [timestamp]` with NO target. So `target` is
  // only ever emitted on the msgreftype path. TARGETS has no target argument at
  // all and passes '*', keeping the parameter count stable so a client reading
  // positionally can't mistake the bound for a buffer name.
  private parseChatHistoryBound(
    sub: string,
    target: string,
    boundStr: string,
    allowStar: boolean,
    which: 'first' | 'second',
  ): ChatBound | null {
    if (allowStar && boundStr === '*') return { star: true };
    const eq = boundStr.indexOf('=');
    const reftype = eq === -1 ? '' : boundStr.slice(0, eq);
    if (reftype && reftype !== 'timestamp') {
      // Known-shaped selector, unsupported type — `msgid=` today. We advertise
      // MSGREFTYPES=timestamp; see the ChatBound notes for why msgid isn't there.
      this.write(
        `:${SERVER_NAME} FAIL CHATHISTORY INVALID_MSGREFTYPE ${sub} ${target || '*'} ${boundStr} :Unsupported message reference type`,
      );
      return null;
    }
    if (reftype === 'timestamp' && isValidServerTime(boundStr.slice(eq + 1))) {
      return { iso: boundStr.slice(eq + 1) };
    }
    this.write(
      `:${SERVER_NAME} FAIL CHATHISTORY INVALID_PARAMS ${sub} ${boundStr} :Invalid ${which} bound`,
    );
    return null;
  }

  private parseTimestampBound(boundStr: string, which: 'first' | 'second'): string | null {
    // TARGETS takes no target argument — '*' holds the slot (see parseChatHistoryBound).
    const bound = this.parseChatHistoryBound('TARGETS', '*', boundStr, false, which);
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

  // The channels `nick` shares with us, with its modes and account in each, for
  // the client filter's CHGHOST fallback. Members are keyed by lowercased nick,
  // the way IrcConnection stores them.
  private sharedChannels(
    nick: string,
  ): Array<{ channel: string; modes: string[]; account?: string | null }> {
    const key = nick.toLowerCase();
    const shared: Array<{ channel: string; modes: string[]; account?: string | null }> = [];
    for (const ch of this.conn?.channels.values() ?? []) {
      const member = ch.members.get(key);
      if (member) {
        shared.push({ channel: ch.name, modes: member.modes || [], account: member.account });
      }
    }
    return shared;
  }

  // Each channel's JOIN, topic and NAMES, built in their fullest form: an
  // extended-join JOIN, every prefix, hostmasks where known. write() trims them
  // to what the client negotiated, as it trims the network's own lines.
  private sendJoinBurst(): void {
    const conn = this.conn!;
    this.welcomed = true;
    const nick = this.currentNick() || '*';
    const realname = conn.client.user?.gecos || this.network?.realname || nick;
    for (const ch of conn.channels.values()) {
      // Our own account as this channel knows it, from our extended JOIN or ACCOUNT.
      const account = ch.members.get(nick.toLowerCase())?.account;
      const accountParam = typeof account === 'string' ? account : '*';
      this.write(`:${this.selfPrefix()} JOIN ${ch.name} ${accountParam} :${realname}`);
      this.joinsSent.add(foldTargetFor(this.networkId, ch.name));
      if (ch.topic) this.write(`:${SERVER_NAME} 332 ${nick} ${ch.name} :${ch.topic}`);
      // After the topic and before NAMES, where soju sends it (forwardChannel).
      this.sendReadMarker(ch.name);
      // A channel whose NAMES the connection hasn't heard yet (a restore asks
      // for them one channel at a time) gets its 353/366 once it has
      // (onNamesHeard). An empty list now would stick: irssi takes a channel's
      // members from the first NAMES only.
      if (conn.membersPending(ch.name)) {
        this.namesPending.add(foldTargetFor(this.networkId, ch.name));
        continue;
      }
      this.sendNames(ch.name);
    }
    // The metadata the spec has a server send after a JOIN (#607), for the keys
    // this client subscribed to before it attached (a re-attach keeps them).
    this.replayMetadata();
  }

  // --- draft/metadata-2 (#607) ---------------------------------------------

  // The value the network advertised for a pass-through cap, for CAP LS 302.
  private networkCapValue(cap: string): string | undefined {
    if (cap !== METADATA_CAP) return undefined;
    const available = this.conn?.client?.network?.cap?.available as Map<string, string> | undefined;
    const value = available?.get(cap);
    return value || undefined;
  }

  // soju has no downstream METADATA; this is the MONITOR shape applied to it.
  // SUB/UNSUB/SUBS answer from this client's own list, with the union of every
  // client's keys and Lurker's on the network's one subscription; everything
  // else relays, its reply routed back to this client (replyRouter.ts).
  private handleMetadata(conn: IrcConnection, msg: ParsedClientLine): void {
    const nick = this.currentNick() || this.clientNick || '*';
    if (!this.caps.has(METADATA_CAP) || !conn.metadataLimits()) {
      this.numeric('421', 'METADATA :Unknown command');
      return;
    }
    const sub = (msg.params[1] || '').toUpperCase();
    if (!msg.params[0] || !sub) {
      this.numeric('461', 'METADATA :Not enough parameters');
      return;
    }
    switch (sub) {
      case 'SUB': {
        const keys = msg.params.slice(2).map((k) => k.toLowerCase());
        for (const key of keys) {
          if (!isValidMetadataKey(key)) {
            this.write(`:${SERVER_NAME} FAIL METADATA KEY_INVALID ${key} :Invalid key name`);
            return;
          }
        }
        // Only what the socket can carry gets a 770; the rest a
        // TOO_MANY_SUBS, as the spec has it, naming the first key that
        // didn't fit. The list is processed in order, so the ones before it
        // stand.
        const { accepted, refused } = conn.addMetadataKeys(keys, this);
        const fresh = accepted.filter((key) => !this.metadataSubs.has(key));
        for (const key of accepted) this.metadataSubs.add(key);
        if (accepted.length > 0) this.write(`:${SERVER_NAME} 770 ${nick} ${accepted.join(' ')}`);
        if (refused.length > 0) {
          this.write(
            `:${SERVER_NAME} FAIL METADATA TOO_MANY_SUBS ${refused[0]} :Too many subscriptions`,
          );
        }
        // The current values for what it just asked for, as the spec has a
        // server send on a SUB.
        if (fresh.length > 0) this.replayMetadata(new Set(fresh));
        return;
      }
      case 'UNSUB': {
        const keys = msg.params.slice(2).map((k) => k.toLowerCase());
        for (const key of keys) this.metadataSubs.delete(key);
        conn.removeMetadataKeys(keys, this);
        if (keys.length > 0) this.write(`:${SERVER_NAME} 771 ${nick} ${keys.join(' ')}`);
        return;
      }
      case 'SYNC': {
        // Answered from what the connection holds, for this client's keys
        // only: relaying it would return the socket's whole subscription —
        // every client's keys — to whoever asked. `*ALL` is ergo's everything.
        const target = msg.params[0] === '*' ? nick : msg.params[0];
        const ref = `lm${++this.metadataBatchSeq}`;
        this.write(`:${SERVER_NAME} BATCH +${ref} metadata ${target}`);
        const targets: string[] = [];
        if (target === '*ALL') {
          targets.push(nick);
          for (const ch of conn.channels.values()) {
            targets.push(ch.name, ...[...ch.members.values()].map((m) => m.nick));
          }
        } else if (isChannelTarget(target)) {
          const ch = conn.channelState(target);
          if (ch) targets.push(ch.name, ...[...ch.members.values()].map((m) => m.nick));
        } else {
          targets.push(target);
        }
        this.replayMetadata(undefined, targets, ref);
        this.write(`:${SERVER_NAME} BATCH -${ref}`);
        return;
      }
      case 'SUBS': {
        const ref = `lm${++this.metadataBatchSeq}`;
        this.write(`:${SERVER_NAME} BATCH +${ref} metadata-subs`);
        if (this.metadataSubs.size > 0) {
          this.write(
            `@batch=${ref} :${SERVER_NAME} 772 ${nick} ${[...this.metadataSubs].join(' ')}`,
          );
        }
        this.write(`:${SERVER_NAME} BATCH -${ref}`);
        return;
      }
      default:
        this.relayRaw(conn, msg);
        return;
    }
  }

  // Whether an unasked metadata line is this client's: a key it subscribed to,
  // on a channel (every client is in all of the connection's channels), on
  // itself, or on a nick it shares a channel with or watches. Lurker's own
  // acknowledgements (770–774) are nobody's. Any other line: yes.
  private wantsMetadataLine(line: string): boolean {
    // Nearly every line isn't one; a parse per client per line is the hot
    // path's to keep, so look before parsing.
    if (!METADATA_LINE_RE.test(line)) return true;
    const msg = parseClientLine(line);
    if (!msg) return true;
    const { command, params } = msg;
    if (command === '770' || command === '771' || command === '772' || command === '774') {
      return false;
    }
    let target: string | undefined;
    let key: string | undefined;
    if (command === 'METADATA') [target, key] = params;
    else if (command === '761' || command === '766' || command === '760') [, target, key] = params;
    else return true;
    if (!target || !key || !this.metadataSubs.has(key.toLowerCase())) return false;
    if (isChannelTarget(target)) return true;
    const self = this.currentNick();
    if (self && target.toLowerCase() === self.toLowerCase()) return true;
    if (this.monitored.has(target.toLowerCase())) return true;
    return this.sharedChannels(target).length > 0;
  }

  // What the connection knows, as 761s, for this client's keys (or `only`
  // those): every channel's own record, every member's, the nicks it
  // watches, and ours — or just `targets`, tagged into batch `ref`.
  private replayMetadata(only?: Set<string>, targets?: string[], ref?: string): void {
    const conn = this.conn;
    if (!conn || !this.caps.has(METADATA_CAP) || this.metadataSubs.size === 0) return;
    const nick = this.currentNick() || '*';
    const head = ref ? `@batch=${ref} :${SERVER_NAME}` : `:${SERVER_NAME}`;
    const wanted = (key: string) => this.metadataSubs.has(key) && (!only || only.has(key));
    const say = (target: string, record: Record<string, string> | null | undefined) => {
      for (const [key, value] of Object.entries(record ?? {})) {
        if (wanted(key)) this.write(`${head} 761 ${nick} ${target} ${key} * :${value}`);
      }
    };
    const seen = new Set<string>();
    const sayTarget = (t: string) => {
      const lower = t.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      if (isChannelTarget(t)) say(conn.channelState(t)?.name ?? t, conn.channelState(t)?.metadata);
      else say(t, conn.userMetadataRecord(t));
    };
    if (targets) {
      for (const t of targets) sayTarget(t);
      return;
    }
    sayTarget(nick);
    for (const ch of conn.channels.values()) {
      sayTarget(ch.name);
      for (const member of ch.members.values()) sayTarget(member.nick);
    }
    for (const watched of this.monitored.values()) sayTarget(watched);
  }

  // A channel's 353 lines and 366, in their fullest form like the rest of the
  // burst: every prefix, hostmasks where known.
  private sendNames(channel: string): void {
    // Folded the network's way: a restored channel can come back spelled
    // differently under RFC1459 casemapping.
    const ch = this.conn?.channelState(channel);
    if (!ch) return;
    const nick = this.currentNick() || '*';
    const prefixes = this.isupportPrefixes();
    const names = Array.from(ch.members.values()).map((m) => {
      const mask = m.user && m.host ? `!${m.user}@${m.host}` : '';
      return memberPrefixSymbols(m.modes || [], prefixes) + m.nick + mask;
    });
    for (const line of buildNamesLines(nick, ch.name, names)) this.write(line);
  }

  // The connection heard a channel's NAMES. If the burst held them back, they go
  // out now, unless the network's own 353/366 already reached this client.
  onNamesHeard(channel: string): void {
    if (this.closed || !this.namesPending.delete(foldTargetFor(this.networkId, channel))) return;
    this.sendNames(channel);
  }

  private sendPlayback(): void {
    // A draft/chathistory client fetches its own history, so replaying it here
    // shows every line twice. soju skips it the same way (downstream.go:1841).
    if (this.caps.has(CAP_CHATHISTORY)) return;
    const limit = playbackLimit();
    if (limit <= 0) return;
    const conn = this.conn!;
    const targets: Array<{ target: string; isChannel: boolean }> = [];
    for (const ch of conn.channels.values()) targets.push({ target: ch.name, isChannel: true });
    const joined = new Set(Array.from(conn.channels.keys()));
    // One registry query for the whole closed set instead of one per candidate
    // buffer; listBuffersForNetwork (messages-derived) is already ORDER BY
    // lastMessageAt DESC, so it stays the recency source — the registry decides
    // closed-ness.
    const closed = closedFoldedSetForNetwork(this.networkId);
    const dms = listBuffersForNetwork(this.networkId)
      .filter((b) => !isChannelName(b.target) && !b.target.startsWith(':server:'))
      .filter((b) => !joined.has(b.target.toLowerCase()))
      // Fold like the set was built (per-network target_folded, #707) — the
      // legacy lowercase probe replays closed DMs on every attach once the
      // folds diverge, the exact pre-registry regression this filter stops.
      .filter((b) => !closed.has(foldTargetFor(this.networkId, b.target)))
      .slice(0, PLAYBACK_MAX_DM_BUFFERS);
    for (const b of dms) targets.push({ target: b.target, isChannel: false });

    // Bound the total burst: a user in very many buffers (or a high per-buffer
    // limit) could otherwise stall the shared event loop on attach.
    let budget = maxTotalPlaybackLines();
    for (const { target, isChannel } of targets) {
      if (budget <= 0) break;
      const rows = listRecentMessages(this.networkId, target, limit);
      for (const line of this.playbackLines(rows, target, isChannel)) {
        this.write(line);
        if (--budget <= 0) break;
      }
    }
  }

  // Assemble the leading IRCv3 tag block for a replayed line, honoring the
  // client's negotiated caps. `batch` ties a line to an open BATCH; `time`
  // needs server-time; `msgid` and client-only tags (`+reply`, `+draft/react`)
  // need message-tags.
  private formatTags(opts: ReplayTags): string {
    const tags: string[] = [];
    if (opts.batchRef) tags.push(`batch=${opts.batchRef}`);
    if (opts.time && this.caps.has('server-time')) tags.push(`time=${toIrcTime(opts.time)}`);
    if (this.caps.has('message-tags')) {
      if (opts.msgid) tags.push(`msgid=${escapeTagValue(opts.msgid)}`);
      for (const [name, value] of opts.clientTags ?? []) {
        tags.push(`${name}=${escapeTagValue(value)}`);
      }
    }
    return tags.length > 0 ? `@${tags.join(';')} ` : '';
  }

  // A stored message as client lines, one per body line. As in the live
  // multiline fallback (bouncerClientFilter.ts), blank lines are skipped and
  // only the first line carries the msgid: halloy drops a later line that
  // repeats an id as a duplicate. The reply tag rides with it — the first line
  // is the message's, as a multiline reply's tag rides its BATCH line.
  private messageLines(head: string, bodies: string[], tags: ReplayTags): string[] {
    const out: string[] = [];
    // A body wider than the wire is cut to it, word-greedy as the network cuts
    // one: a stored line that was one draft/multiline message (a long line that
    // came in as concat continuations, or went up as one batch) is longer than
    // a client's 512-byte line, and the bouncer never offers the cap, so the
    // client takes the pieces as the lines they are. Tags are not in the 512.
    const budget = Math.max(MIN_TEXT_BUDGET, IRC_LINE_BYTES - Buffer.byteLength(`${head} :`) - 2);
    for (const body of bodies) {
      if (body === '') continue;
      for (const piece of splitSay(body, budget)) {
        const block = this.formatTags(
          out.length === 0 ? tags : { ...tags, msgid: undefined, clientTags: undefined },
        );
        out.push(`${block}${head} :${piece}`);
      }
    }
    return out;
  }

  // A stored event as the line the network sent it as, which is what soju
  // replays. The JOIN is the plain form: an extended JOIN's realname isn't
  // stored, and goguma would take an empty one as the user's. A row missing
  // what its line needs gives none.
  private eventLine(
    row: MessageEvent,
    bufferTarget: string,
    tags: { time?: string; batchRef?: string },
  ): string | null {
    const nick = row.nick || '';
    if (!nick) return null;
    // Without a stored mask (mode and topic rows keep none), the bare name: a
    // valid source for a user or a server alike, which is how a server sends
    // its own MODE. Guessing a server from a dot fails for one named `localhost`
    // (Copilot, #943).
    const source = row.userhost?.includes('!') ? row.userhost : nick;
    const head = `${this.formatTags(tags)}:${source}`;
    const text = row.text ?? '';
    // A reason is optional on PART, QUIT and KICK, so an empty one is left off
    // rather than sent as an empty trailing parameter. TOPIC keeps its: an empty
    // topic is a cleared one.
    const reason = text ? ` :${text}` : '';
    switch (row.type) {
      case 'join':
        return `${head} JOIN ${bufferTarget}`;
      case 'part':
        return `${head} PART ${bufferTarget}${reason}`;
      case 'quit':
        return `${head} QUIT${reason}`;
      case 'nick':
        return typeof row.newNick === 'string' && row.newNick
          ? `${head} NICK ${row.newNick}`
          : null;
      case 'kick':
        return typeof row.kicked === 'string' && row.kicked
          ? `${head} KICK ${bufferTarget} ${row.kicked}${reason}`
          : null;
      case 'mode':
        return text ? `${head} MODE ${bufferTarget} ${text}` : null;
      case 'topic':
        return `${head} TOPIC ${bufferTarget} :${text}`;
    }
    return null;
  }

  // Whether a stored line from us in a DM may be replayed to this client, and
  // how any replayed line is addressed. Shared by messages and reactions: a
  // reaction is a line from its sender to the buffer, like a message.
  //
  // A self-message in a DM is `:you PRIVMSG peer` — a shape only clients
  // that negotiated znc.in/self-message (or echo-message) can attribute
  // correctly. Anything else (e.g. mIRC) misreads it as an INCOMING PM
  // "from you", which confuses query windows and trips auto-responders.
  // ZNC gates on the same caps. Channel self-lines are safe for everyone.
  //
  // Never replay your OWN lines to services (NickServ/ChanServ/…) even to
  // capable clients: that's where credentials live (IDENTIFY from a
  // client's perform), and each reconnect would replay them into that
  // client's logs. The services' replies still play back normally.
  private replaysSelfLine(isChannel: boolean, bufferTarget: string): boolean {
    if (isChannel) return true;
    return this.wantsSelfMessages() && !isServicesNick(bufferTarget);
  }

  private replayedSource(nick: string, userhost: string | null | undefined): string {
    return userhost && userhost.includes('!') ? userhost : `${nick}!${nick}@${SERVER_NAME}`;
  }

  // Channel rows keep the channel as the target; DM rows address inbound
  // lines to us and outbound (self) lines to the peer, ZNC-style.
  private replayedTarget(
    self: boolean,
    isChannel: boolean,
    bufferTarget: string,
    selfNick: string,
  ): string {
    return isChannel || self ? bufferTarget : selfNick;
  }

  // A stored reaction as the TAGMSG that made it (#991): its value, and the
  // reply tags naming the line it's on — or, for a tombstone's event, the
  // TAGMSG that took it back (#1009). No msgid — a reaction's own isn't kept.
  // Only ever here for a message-tags client (replaysReactions decides), the
  // only kind a TAGMSG can reach.
  private reactionLine(
    r: HistoryReaction,
    bufferTarget: string,
    isChannel: boolean,
    selfNick: string,
    batchRef: string | undefined,
  ): string {
    const tags = this.formatTags({
      time: r.time,
      batchRef,
      clientTags: [
        [r.unreact ? '+draft/unreact' : '+draft/react', r.value],
        ...replyTags(r.parentMsgid),
      ],
    });
    const target = this.replayedTarget(r.self, isChannel, bufferTarget, selfNick);
    return `${tags}:${this.replayedSource(r.nick, r.userhost)} TAGMSG ${target}`;
  }

  private playbackLines(
    rows: HistoryRow[],
    bufferTarget: string,
    isChannel: boolean,
    opts: { batchRef?: string } = {},
  ): string[] {
    const out: string[] = [];
    const selfNick = this.currentNick() || this.clientNick || '*';
    for (const row of rows) {
      // Reaction rows are here only for a client that takes them: the query
      // decides (replaysReactions).
      if (isHistoryReaction(row)) {
        out.push(this.reactionLine(row, bufferTarget, isChannel, selfNick, opts.batchRef));
        continue;
      }
      // Event rows are here only for a draft/event-playback client: the query
      // decides (historyFilter).
      if (HISTORY_EVENT_TYPES.includes(row.type)) {
        const line = this.eventLine(row, bufferTarget, { time: row.time, batchRef: opts.batchRef });
        if (line) out.push(line);
        continue;
      }
      if (row.type !== 'message' && row.type !== 'action' && row.type !== 'notice') continue;
      // Note: `fromIgnored` is deliberately NOT filtered here — the live relay
      // passes ignored senders through (ignore is a client-side Lurker feature,
      // not the bouncer's job), so playback stays consistent with it rather
      // than hiding in history what the client will then see live.
      if (row.mirrored || !row.text) continue;
      if (row.self && !this.replaysSelfLine(isChannel, bufferTarget)) continue;
      const prefix = this.replayedSource(row.nick || 'unknown', row.userhost);
      const target = this.replayedTarget(row.self, isChannel, bufferTarget, selfNick);
      const cmd = row.type === 'notice' ? 'NOTICE' : 'PRIVMSG';
      // Persisted multiline bodies (IRCv3 draft/multiline) become one playback
      // line per row line; ACTION collapses to a single line.
      const bodies =
        row.type === 'action'
          ? [`\u0001ACTION ${row.text.replace(/\n/g, ' ')}\u0001`]
          : row.text.split('\n');
      out.push(
        ...this.messageLines(`:${prefix} ${cmd} ${target}`, bodies, {
          time: row.time,
          msgid: networkMsgid(row),
          batchRef: opts.batchRef,
          // A reply names the line it answers, as its sender tagged it (#991) —
          // not on an E2E line, whose parent history replays without a msgid.
          clientTags: row.replyMsgid && !row.e2e ? replyTags(row.replyMsgid) : undefined,
        }),
      );
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

  // MARKREAD reads or moves the account's read pointer for a buffer, the one the
  // web and iOS apps share, as soju's handler does (downstream.go:3271). The
  // pointer is a message id, so a time moves it to the newest message at or
  // before that time. A time that moves nothing, and a MARKREAD without one, get
  // the stored marker back.
  private handleMarkRead(msg: ParsedClientLine): void {
    const target = msg.params[0] ?? '';
    if (!target) {
      this.write(`:${SERVER_NAME} FAIL MARKREAD NEED_MORE_PARAMS :Missing parameters`);
      return;
    }
    if (this.isControl || !this.networkId) {
      this.write(
        `:${SERVER_NAME} FAIL MARKREAD INTERNAL_ERROR ${target} :Cannot set read markers on the bouncer connection`,
      );
      return;
    }
    const lastReadId = getReadState(this.userId, this.networkId, target);
    const bound = msg.params[1];
    if (bound !== undefined) {
      const iso = readMarkerBoundTime(bound);
      if (!iso) {
        this.write(`:${SERVER_NAME} FAIL MARKREAD INVALID_PARAMS ${bound} :Invalid timestamp`);
        return;
      }
      const id = newestIdAtOrBefore(this.networkId, target, lastReadId, iso);
      const lastRead =
        id > 0 ? ircManager.markRead(this.userId, this.networkId, target, id) : lastReadId;
      if (lastRead > lastReadId) {
        // Every client on the network, this one included, has heard the move
        // through ircManager's 'read-marker' event. The apps hear it as read-state.
        const buffer = resolveBuffer(this.userId, this.networkId, target);
        if (buffer) {
          broadcastReadState(this.userId, this.networkId, buffer.target, lastRead, buffer.id);
        }
        return;
      }
    }
    this.write(
      `:${SERVER_NAME} MARKREAD ${target} ${readMarkerParam(this.networkId, target, lastReadId)}`,
    );
  }

  // MARKREAD for one buffer, to a client that negotiated read markers. `param` is
  // `timestamp=…` or `*`, passed in when several clients get the same move;
  // without it, the account's current marker is looked up.
  sendReadMarker(target: string, param?: string): void {
    if (this.closed || !this.caps.has(CAP_READ_MARKER)) return;
    const marker =
      param ??
      readMarkerParam(this.networkId, target, getReadState(this.userId, this.networkId, target));
    this.write(`:${SERVER_NAME} MARKREAD ${target} ${marker}`);
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
      case 'MARKREAD':
        // The read pointer is Lurker's own state, so like CHATHISTORY this works
        // with the network down.
        this.handleMarkRead(msg);
        return;
      case 'AWAY':
        // Away is the account's too, so it works on a control connection and
        // with the network down.
        this.handleAway(msg);
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
          // joinChannel now carries the optional key: it persists it (encrypted,
          // for keyed auto-rejoin), reopens the buffer, and JOINs with the key.
          const key = (keys[i] || '').trim();
          ircManager.joinChannel(this.userId, this.networkId, channel, key || undefined);
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
      case 'MONITOR':
        this.handleMonitor(conn, msg);
        return;
      case 'METADATA':
        this.handleMetadata(conn, msg);
        return;
      case 'TAGMSG':
        this.handleClientTagmsg(conn, msg);
        return;
      case 'REDACT':
        this.handleClientRedact(conn, msg);
        return;
      default:
        // Everything else (MODE, TOPIC, WHOIS, WHO, NAMES, LIST, KICK, INVITE,
        // NICK, …) forwards verbatim; replies come back via the raw relay.
        this.relayRaw(conn, msg);
        return;
    }
  }

  // --- AWAY ------------------------------------------------------------------

  // A client's AWAY is /away on its own network (see setAway): `AWAY :<message>`
  // sets it and a bare `AWAY` clears it. `AWAY *` (draft/pre-away) says this
  // connection isn't the user, as goguma's background sync says, so it stops
  // counting for auto-away and the networks are left alone.
  // The client always gets its 305 or 306, before registration too: irssi takes
  // its own away state from them alone, and goguma waits for one.
  private handleAway(msg: ParsedClientLine): void {
    const message = (msg.params[0] || '').trim();
    if (!this.registered) {
      this.pendingAway = message;
      this.awayAnswered = true;
    } else {
      const counted = this.countsAsPresent();
      this.setAway(message);
      if (this.countsAsPresent() !== counted) evaluatePresence(this.userId);
    }
    this.sendAwayReply(message !== '');
  }

  // What a client's AWAY does: to this client's presence, and to the network
  // it's attached to (#994), as in ZNC and soju. The away.all_networks setting
  // doesn't reach here: the IRC client has its own scope (irssi sends its /away
  // to every network, WeeChat's /away -all too). A control connection is bound
  // to no network, so its AWAY sets every one.
  private setAway(message: string): void {
    this.notPresent = message === '*';
    if (this.notPresent) return;
    const scope = this.isControl ? 'all' : this.networkId;
    if (message) ircManager.setAway(this.userId, scope, message, { origin: this });
    else ircManager.clearAway(this.userId, scope, { origin: this });
  }

  // An AWAY sent before registration, now that the account is known.
  private applyPendingAway(): void {
    const pending = this.pendingAway;
    this.pendingAway = null;
    if (pending !== null) this.setAway(pending);
  }

  // Whether this client counts as the user being here (presence.ts): attached to
  // a network, and not `AWAY *`. A control connection doesn't count, as in soju;
  // goguma keeps one open beside its networks.
  countsAsPresent(): boolean {
    return this.registered && !this.closed && !this.isControl && !this.notPresent;
  }

  // A control connection whose last 305 or 306 no longer says whether every
  // network is away is told again. `allAway` saves the lookup when the caller
  // has it.
  reconcileControlAway(allAway?: boolean): void {
    if (!this.isControl || !this.registered || this.closed) return;
    const away = allAway ?? allNetworksAway(this.userId);
    if (away !== this.reportedAway) this.sendAwayReply(away);
  }

  // RPL_NOWAWAY or RPL_UNAWAY.
  sendAwayReply(away: boolean): void {
    this.reportedAway = away;
    if (away) this.numeric('306', ':You have been marked as being away');
    else this.numeric('305', ':You are no longer marked as being away');
  }

  // --- MONITOR ---------------------------------------------------------------

  // A client's MONITOR changes its own list, not the network's, which Lurker and
  // every attached client share. L and S answer from the client's list. This is
  // soju's downstream MONITOR handler.
  private handleMonitor(conn: IrcConnection, msg: ParsedClientLine): void {
    const sub = (msg.params[0] || '').toUpperCase();
    if (!sub) {
      this.numeric('461', 'MONITOR :Not enough parameters');
      return;
    }
    // A network without MONITOR has no such command, as in soju. That's only
    // known once its registration burst is over, since the 005 naming MONITOR
    // comes after the 001 that marks it connected. Until then the list is kept
    // for the seed.
    if (conn.state === 'connected' && conn.isupportComplete && !conn.useMonitor) {
      this.numeric('421', 'MONITOR :Unknown command');
      return;
    }
    const nick = this.currentNick() || this.clientNick || '*';
    switch (sub) {
      case '+': {
        const targets = (msg.params[1] || '').split(',').filter(Boolean);
        const cap = maxMonitorPerClient();
        const overCap: string[] = [];
        for (const target of targets) {
          const key = target.toLowerCase();
          if (this.monitored.has(key)) continue;
          if (this.monitored.size >= cap) overCap.push(target);
          else this.monitored.set(key, target);
        }
        if (overCap.length > 0) this.onMonitorDropped(overCap, cap);
        conn.monitor.addHolder(this);
        conn.syncMonitor();
        // The network won't answer for a nick it already watched, so answer
        // from its last word. One past the limit already got a 734.
        let unanswered = false;
        for (const target of targets) {
          if (!this.monitored.has(target.toLowerCase())) continue;
          const online = conn.monitor.status(target);
          if (online === true) this.write(`:${SERVER_NAME} 730 ${nick} :${target}`);
          else if (online === false) this.write(`:${SERVER_NAME} 731 ${nick} :${target}`);
          else if (online === null) unanswered = true;
        }
        // A network needn't answer a MONITOR + for a nick it already lists, such
        // as one a connect command added. So ask about any nick still without
        // an answer, as Lurker's own adds do (#302).
        if (unanswered) conn.monitor.requestStatus();
        return;
      }
      case '-':
        for (const target of (msg.params[1] || '').split(',')) {
          this.monitored.delete(target.toLowerCase());
        }
        conn.syncMonitor();
        return;
      case 'C':
        this.monitored.clear();
        conn.syncMonitor();
        return;
      case 'L':
        // One nick per line: halloy reads a 732 as a single nick.
        for (const target of this.monitored.values()) {
          this.write(`:${SERVER_NAME} 732 ${nick} :${target}`);
        }
        this.write(`:${SERVER_NAME} 733 ${nick} :End of MONITOR list`);
        return;
      case 'S':
        // A nick the network hasn't answered for counts as offline, as in soju.
        for (const target of this.monitored.values()) {
          const code = conn.monitor.status(target) === true ? '730' : '731';
          this.write(`:${SERVER_NAME} ${code} ${nick} :${target}`);
        }
        return;
      default:
        return;
    }
  }

  monitorTargets(): Iterable<string> {
    return this.monitored.values();
  }

  // Nicks that didn't fit, under the network's limit or maxMonitorPerClient:
  // the client's MONITOR + failed for them.
  onMonitorDropped(nicks: string[], limit: number): void {
    const nick = this.currentNick() || this.clientNick || '*';
    for (const target of nicks) {
      this.monitored.delete(target.toLowerCase());
      this.write(`:${SERVER_NAME} 734 ${nick} ${limit} ${target} :Monitor list is full`);
    }
  }

  // The network's MONITOR replies, cut down to this client's nicks, one nick
  // per line as soju sends them. null for any other line. A 732/733 answers a
  // MONITOR L that no client sent upstream, so it's dropped.
  private monitorRelay(line: string): string[] | null {
    if (!/(^| )73[0-4] /.test(line)) return null;
    const msg = parseClientLine(line);
    if (!msg) return null;
    const { command, params } = msg;
    if (command === '732' || command === '733') return [];
    if (command !== '730' && command !== '731' && command !== '734') return null;
    const head = lineHead(line);
    const out: string[] = [];
    if (command === '734') {
      // The network refused these nicks, so the client isn't watching them.
      const [nick = '*', limit = '', targets = '', text = 'Monitor list is full'] = params;
      for (const target of targets.split(',')) {
        if (!this.monitored.delete(target.toLowerCase())) continue;
        out.push(`${head}734 ${nick} ${limit} ${target} :${text}`);
      }
      return out;
    }
    const [nick = '*', targets = ''] = params;
    for (const target of targets.split(',')) {
      const name = target.split('!')[0];
      if (name && this.monitored.has(name.toLowerCase())) {
        out.push(`${head}${command} ${nick} :${target}`);
      }
    }
    return out;
  }

  // Forward a parsed client line to the upstream, re-attaching its client-only
  // tags only when the network speaks message-tags. On a non-IRCv3 server a
  // leading `@+tag …` prefix is parsed as the command, mangling the real
  // command into ERR_UNKNOWNCOMMAND — the same hazard IrcConnection.sendTyping
  // guards against — so drop the tags and forward the bare command there.
  private relayRaw(conn: IrcConnection, msg: ParsedClientLine): void {
    const forward =
      msg.clientTags && !conn.supportsMessageTags() ? { ...msg, clientTags: undefined } : msg;
    // A query waits its turn on the connection, and its reply comes back to
    // this client alone (replyRouter.ts).
    conn.raw(rebuildLine(forward), this);
  }

  // A client's TAGMSG on its way to the network. A TAGMSG is nothing but its
  // client-only tags, so one with none left goes nowhere: a network without
  // message-tags gets no tags (relayRaw), and a bare TAGMSG is an unknown
  // command there, its 421 coming back for every keystroke of the client's
  // typing. ZNC drops it the same way (Client.cpp, HasMessageTagCap).
  //
  // Reactions and typing take the web app's road, so they meet its rules
  // rather than a copy of them: ircManager.react (the line must be one we hold,
  // never an E2E line or on an E2E channel, the network must carry the tags) and
  // ircManager.typing (a target that refused us, an offline DM peer).
  private handleClientTagmsg(conn: IrcConnection, msg: ParsedClientLine): void {
    if (!msg.clientTags) return;
    const target = msg.params[0] || '';
    // ⚠⚠ `=nick` is a DCC chat, never an IRC target (see handleClientMessage),
    // not even inside a target list.
    if (!target || target.split(',').some(isDccChatTarget)) return;
    const tags = clientTagMap(msg.clientTags);
    const react = tags.get('+draft/react');
    const unreact = tags.get('+draft/unreact');
    const reaction = react !== undefined || unreact !== undefined;
    if (!conn.supportsMessageTags()) {
      // A reaction says it wasn't sent, as every refusal below does. Typing
      // stays quiet: it's a nicety, and it would say so on every keystroke.
      if (reaction) this.notice(`Reaction not sent to ${target}`);
      return;
    }
    if (reaction) {
      // The line it names, in the buffer it was sent to (a target list or a
      // STATUSMSG target names no buffer, so it names no line either).
      const parentMsgid = tags.get('+reply') || tags.get('+draft/reply');
      const bufferId = resolveBufferIdByNetwork(this.networkId, target);
      const parent =
        parentMsgid && bufferId !== undefined && (react === undefined || unreact === undefined)
          ? findReactionParent(this.networkId, bufferId, parentMsgid)
          : null;
      const value = (react ?? unreact) as string;
      if (!parent || !ircManager.react(this.userId, parent.id, value, unreact !== undefined)) {
        this.notice(`Reaction not sent to ${target}`);
      }
      return;
    }
    const typing = tags.get('+typing');
    if (typing !== undefined) {
      ircManager.typing(this.userId, this.networkId, target, typing);
      return;
    }
    this.relayRaw(conn, msg);
  }

  // A client's REDACT on its way to the network (#1013): `REDACT <target>
  // <msgid> [:reason]`. The line it names is found in the buffer it was sent
  // to, then it takes the web app's road (ircManager.redact: a line we hold
  // with a msgid, a writable connection, no reason on an E2E channel). The
  // network's answer comes back through the relay — its REDACT to every client
  // that negotiated the cap, the web app included, and a FAIL to all of them,
  // since a REDACT isn't a query the reply router owns. A refusal here, before
  // anything went out, is said as a notice, as a reaction's is.
  private handleClientRedact(conn: IrcConnection, msg: ParsedClientLine): void {
    const target = msg.params[0] || '';
    const msgid = msg.params[1] || '';
    const reason = msg.params[2];
    if (!target || !msgid || isDccChatTarget(target)) return;
    if (!conn.supportsRedaction()) {
      this.notice(`Message not deleted: ${this.network?.name} doesn't support deleting messages`);
      return;
    }
    const bufferId = resolveBufferIdByNetwork(this.networkId, target);
    const line =
      bufferId !== undefined ? findReactionParent(this.networkId, bufferId, msgid) : null;
    if (!line || !ircManager.redact(this.userId, line.id, reason)) {
      this.notice(`Message not deleted in ${target}`);
    }
  }

  // A client's CTCP on its way to the network. Its VERSION reply gets " via
  // Lurker <version>", as ZNC adds itself (Client.cpp:1378). Not once the user
  // changed the VERSION reply or turned replies off: the request never reached
  // the client then (IrcConnection.ctcpAnswererFor), and the suffix would give
  // away the version they chose not to send.
  private outgoingCtcp(command: string, text: string): string {
    if (command !== 'NOTICE') return text;
    const withVia = ctcpVersionVia(text, `${APP_NAME} ${APP_VERSION}`);
    if (withVia === text) return text;
    const changed = changedSettings(this.userId, CTCP_ANSWER_SETTINGS);
    return ctcpAnsweredBySettings('VERSION', changed) ? text : withVia;
  }

  // The network's own lines answering this client's query, kept from an earlier
  // reply: a MODE #chan, answered as soju and ZNC answer it. Their tags were
  // another delivery's, so none survive.
  replyFromCache(lines: string[]): void {
    const nick = this.currentNick() || '*';
    for (const line of lines) {
      const out = restrictTags(line, () => false);
      if (out) this.write(rewriteNumericTarget(out, nick));
    }
  }

  // This client's query ended without its reply: the network went away, or
  // never answered. Its end numeric, so a client waiting on it moves on (irssi's
  // channel sync, gamja's WHO queue).
  replyAborted(numeric: string, params: string[]): void {
    this.numeric(numeric, [...params, ':Command aborted'].join(' '));
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
    // Upstream in reconnect backoff: ircManager refuses the write rather than
    // persisting a message that never reaches IRC (#809). Say so here, or the
    // line vanishes with no feedback at all — and skip registerEcho below, whose
    // keys would otherwise sit in the pending list until they time out.
    // Asked through ircManager, not by re-testing conn.state here: the whole point
    // of consolidating the writable test is that a second copy of it can drift
    // from the one ircManager.send actually applies, and then we either
    // double-refuse or go back to dropping lines silently. conn.state is read
    // only to NAME the state in the notice.
    if (!ircManager.writableConnection(this.userId, this.networkId)) {
      this.notice(`Upstream '${this.network?.name}' is ${conn.state} — message not sent.`);
      return;
    }
    // The msgid a reply names (#483), parsed once for every target.
    const replyMsgid = msg.clientTags ? clientReplyMsgid(msg.clientTags) : undefined;
    for (const target of targets) {
      const isAction = text.startsWith('\u0001ACTION ') || text.startsWith('\u0001ACTION\u0001');
      if (text.startsWith('\u0001') && !isAction) {
        // Non-ACTION CTCP (VERSION, PING, replies…): forward on the wire; these
        // aren't conversation and don't persist. A VERSION reply says Lurker
        // carried it (outgoingCtcp). Spread msg so any client-only tags ride
        // along (gated on upstream message-tags).
        this.relayRaw(conn, { ...msg, params: [target, this.outgoingCtcp(msg.command, text)] });
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
      // A reply goes the web app's way too (#483): named by the line it answers,
      // so ircManager puts on the tags the network allows, stores it as a reply
      // and echoes it as one to every client. Not a NOTICE: the web app has no
      // notice reply, so ircManager.notice takes none.
      const replyTo =
        replyMsgid && msg.command === 'PRIVMSG'
          ? this.clientReplyTo(replyMsgid, target)
          : undefined;
      // Split the way ircManager will, to the network's line budget (#1043):
      // a line the client already fitted to the wire goes up as it is, the way
      // soju and ZNC relay one, so its echoes come back on the boundaries it
      // sent (#1041). Only a line too long for the wire — a client that doesn't
      // split at all — is cut, rather than truncated by the network.
      const body = isAction
        ? // eslint-disable-next-line no-control-regex
          text.replace(/^\u0001ACTION ?/, '').replace(/\u0001$/, '')
        : text;
      const chunks = isAction
        ? conn.actionChunks(target, body)
        : conn.sayChunks(msg.command === 'NOTICE' ? 'NOTICE' : 'PRIVMSG', target, text);
      // Nothing would reach the wire (an empty /me, or nothing but spaces for
      // longer than a line): answer as a server would, rather than let the
      // client's line vanish with no echo and no error.
      if (chunks.length === 0) {
        this.numeric('412', ':No text to send');
        continue;
      }
      const kind = isAction ? 'action' : msg.command === 'PRIVMSG' ? 'message' : 'notice';
      // On an E2E channel the self event carries the full body as ONE event,
      // not one per wire chunk, so the chunks are not what comes back; an
      // action or notice there is refused and echoes nothing.
      const e2e =
        isChannelName(target) &&
        e2eManager.isChannelEnabled(this.userId, this.networkId, contextKey(target, ''));
      // Keyed by the self events ircManager will publish: one per wire chunk —
      // or, for a line too long for the wire on a network with draft/multiline,
      // one per batch, the reassembled text the room sees. ircManager.send takes
      // the same gate (conn.outboundBatches), so the keys name what comes back.
      const batches = kind === 'message' ? conn.outboundBatches(target, text) : null;
      const echoes = batches ? batches.map(reassembleMultiline) : chunks;
      const registered: string[] = [];
      if (!e2e) for (const echo of echoes) registered.push(this.registerEcho(kind, target, echo));
      // Each echo's clock starts when its line has gone, which behind a
      // backlog is later than now (#1149); a line dropped with its socket has
      // no echo coming.
      const lineHooks = {
        sent: (line: string) => this.stampEcho(kind, target, line),
        dropped: (line: string) => this.forgetEcho(kind, target, line),
      };
      let accepted: boolean;
      if (isAction) {
        accepted = ircManager.action(this.userId, this.networkId, target, body, {
          replyTo,
          lineHooks,
        });
      } else if (msg.command === 'PRIVMSG') {
        if (e2e) registered.push(this.registerEcho('message', target, text));
        accepted = ircManager.send(this.userId, this.networkId, target, text, {
          replyTo,
          lineHooks,
        });
      } else {
        accepted = ircManager.notice(this.userId, this.networkId, target, text, { lineHooks });
      }
      // Refused (not writable, too long to encrypt): nothing is coming back.
      if (!accepted) for (const key of registered) this.forgetEchoKey(key);
    }
  }

  // The stored line a client's reply names, in the buffer the message goes to:
  // what the web app's Reply hands ircManager. Found as a reply's quote is
  // (findReplyParent: a chat line, not from someone ignored). Anything else — a
  // line we don't hold (a replay we dropped, one retention took), one from
  // someone ignored, a msgid from another buffer — sends a plain line, its
  // `nick: ` still saying who it's for. A bouncer client mirrors the account,
  // and the account couldn't say what it answers; and #b must not be told
  // about a line only #a saw.
  private clientReplyTo(msgid: string, target: string): number | undefined {
    const bufferId = resolveBufferIdByNetwork(this.networkId, target);
    if (bufferId === undefined) return undefined;
    return findReplyParent(this.networkId, bufferId, msgid)?.id;
  }

  // `at` is 0 until the line has gone (stampEcho): the 30 s window counts
  // from the wire, and a line still queued is not pruned on it. A line that
  // never goes and is never dropped either (a path that forgot to say) is
  // pruned on `since`, generously, so it cannot swallow a later line forever.
  private registerEcho(type: string, target: string, text: string): string {
    this.prunePendingEcho();
    const key = echoKey(type, target, text);
    this.pendingEcho.push({ key, at: 0, since: Date.now() });
    if (this.pendingEcho.length > 500) this.pendingEcho.splice(0, this.pendingEcho.length - 500);
    return key;
  }

  private stampEcho(type: string, target: string, text: string): void {
    const key = echoKey(type, target, text);
    const entry = this.pendingEcho.find((e) => e.key === key && e.at === 0);
    if (entry) entry.at = Date.now();
  }

  private forgetEcho(type: string, target: string, text: string): void {
    this.forgetEchoKey(echoKey(type, target, text));
  }

  private forgetEchoKey(key: string): void {
    const idx = this.pendingEcho.findIndex((e) => e.key === key && e.at === 0);
    if (idx !== -1) this.pendingEcho.splice(idx, 1);
  }

  private prunePendingEcho(): void {
    const now = Date.now();
    const stale = (e: { at: number; since: number }) =>
      e.at === 0 ? e.since < now - UNSENT_ECHO_TTL_MS : e.at < now - 30_000;
    if (this.pendingEcho.some(stale)) this.pendingEcho = this.pendingEcho.filter((e) => !stale(e));
  }

  // Whether this client can render `:you PRIVMSG peer` self-messages in DMs.
  private wantsSelfMessages(): boolean {
    return this.caps.has('znc.in/self-message') || this.caps.has('echo-message');
  }

  // --- events from ircManager -------------------------------------------------

  deliverSelfEcho(
    type: string,
    target: string,
    text: string,
    time: string | null,
    msgid?: string,
    replyMsgid?: string,
  ): void {
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
    const head = `:${this.selfPrefix()} ${cmd} ${target}`;
    const tags: ReplayTags = {
      time: time ?? undefined,
      msgid,
      // A reply says so here as it does in CHATHISTORY, or a client shows it
      // threaded only after a reload.
      clientTags: replyMsgid ? replyTags(replyMsgid) : undefined,
    };
    for (const line of this.messageLines(head, bodies, tags)) {
      this.write(line);
    }
  }

  onUpstreamState(state: string, error: string): void {
    if (this.closed) return;
    // Batches the old upstream connection left open will never close.
    this.clientFilter.resetBatches();
    // liveConn() closes us if the connection object was swapped out.
    if (!this.liveConn() || this.closed) return;
    // A connect brings the network's caps; a disconnect takes them away.
    this.updateSupportedCaps(this.currentNick() || '*');
    // A connection says its state again without a change: 'socket close' says
    // disconnected with the reason and 'close' says it again with none. The
    // same state with a NEW reason is news, though — a stopped retry re-asserts
    // 'disconnected' to say why it stopped — so the reason, and only a reason,
    // re-notices (soju dedupes on the error text alone, user.go:741).
    if (state === this.noticedState && (!error || error === this.noticedError)) return;
    this.noticedState = state;
    this.noticedError = error;
    const name = this.network?.name;
    if (state === 'connected') this.notice(`Upstream connected to '${name}'.`);
    else if (state === 'reconnecting') this.notice(`Upstream reconnecting to '${name}'.`);
    else if (state === 'disconnected') {
      // Never a promise to keep retrying: a ban, three failed SASL attempts, a
      // policy stop and a manual disconnect all end here, and a retry that IS
      // coming announces itself as 'reconnecting'. soju makes no such promise
      // either, and says why (user.go:753). The reason is a sentence of its own.
      this.notice(
        error
          ? `Upstream disconnected from '${name}': ${error}`
          : `Upstream disconnected from '${name}'.`,
      );
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
        if (this.onUpstreamCaps) {
          this.conn.client.off('cap ack', this.onUpstreamCaps);
          this.conn.client.off('cap del', this.onUpstreamCaps);
        }
        if (this.onUpstreamMetadata) {
          this.conn.client.off('lurker metadata', this.onUpstreamMetadata);
        }
        if (this.onUpstreamRegistered) {
          this.conn.client.off('registered', this.onUpstreamRegistered);
        }
        if (this.onUpstreamMotd) this.conn.client.off('motd', this.onUpstreamMotd);
        // The keys only this client held go off the socket with it.
        this.conn.releaseMetadataHolder(this);
      } catch {
        /* ignore */
      }
    }
    this.onRawUpstream = null;
    this.onUpstreamCaps = null;
    this.onUpstreamRegistered = null;
    this.onUpstreamMotd = null;
    // Take this client's nicks off the network's list, except ones someone else
    // still watches.
    if (this.conn?.monitor.removeHolder(this)) this.conn.syncMonitor();
    // Its queries go too, and replies to one already on the wire go nowhere.
    this.conn?.replies.dropClient(this);
    sessions.delete(this);
    // It may have been the last thing that counted as the user being here.
    if (this.registered && !this.isControl) evaluatePresence(this.userId);
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

// The text goes in without its formatting codes (#612): a channel in a
// strip-formatting mode (UnrealIRCd +S, InspIRCd stripcolor) echoes a message
// back with the codes gone, and a byte-exact key misses — which hands the
// sender its own line a second time.
//
// ⚠ Two texts that differ only in formatting now share a key. For this session's
// own sends that costs nothing: either echo consumes either entry. What it
// widens is the existing hazard of a key nothing ever consumes — a send the
// network refused (+m, a ban) leaves one behind, and the next message with the
// same words from ANY surface (the web app, iOS, another client) is what
// consumes it, so this session doesn't see that one. Before, only a byte-exact
// repeat could do that; now a repeat that differs in formatting can too. The
// 30s window is the bound on it, which is the reason not to lengthen it.
function echoKey(type: string, target: string, text: string): string {
  return `${type}\u0000${target.toLowerCase()}\u0000${stripFormatting(text)}`;
}

// ---------------------------------------------------------------------------
// ircManager event fan-in
// ---------------------------------------------------------------------------

// MARKREAD's marker for a read pointer: `timestamp=` and the time of the message
// it names (or of the one below it, if that row is gone), or `*` for none.
function readMarkerParam(networkId: number, target: string, lastReadId: number): string {
  const time = readMarkerTime(networkId, target, lastReadId);
  return time ? `timestamp=${toIrcTime(time)}` : '*';
}

// The time in a client's `timestamp=` MARKREAD bound, as Lurker stores times, or
// null. The fraction is optional: HexDroid formats with Java's Instant.toString(),
// which drops a `.000`.
function readMarkerBoundTime(bound: string): string | null {
  const match = /^timestamp=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/.exec(bound);
  const ms = match ? serverTimeMs(match[1]) : NaN;
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The channel a relayed line has `nick` joining, or null for any other line.
function selfJoinChannel(line: string, nick: string | null): string | null {
  if (!nick || !/^JOIN /i.test(line.slice(lineHead(line).length))) return null;
  const msg = parseLine(line);
  const source = msg?.source?.split('!')[0];
  if (!msg || !source || source.toLowerCase() !== nick.toLowerCase()) return null;
  return msg.params[0] || null;
}

// A read pointer moved, in the apps or over IRC. Every client on that network
// that negotiated read markers hears it, the one whose MARKREAD moved it included
// (the spec's reply). The :server: and system buffers aren't IRC targets, and
// neither is a `=nick` DCC chat — its buffer is deliberately invisible to
// attached clients (they never see it in playback or CHATHISTORY TARGETS), so
// a MARKREAD naming one would be the single place a name they can't resolve,
// and must never PRIVMSG, still reached them.
function dispatchReadMarker(move: ReadMarkerMove): void {
  const { networkId, target } = move;
  if (networkId == null || target.startsWith(':') || isDccChatTarget(target)) return;
  const set = registry.get(registryKey(move.userId, networkId));
  if (!set) return;
  // The apps mark read on every line into a focused buffer, so the time is only
  // looked up once some client here can take it.
  let param: string | undefined;
  for (const session of set) {
    if (!session.caps.has(CAP_READ_MARKER)) continue;
    param ??= readMarkerParam(networkId, target, move.lastReadId);
    session.sendReadMarker(target, param);
  }
}

// Whether every one of the account's networks is away: a control
// connection's view, since it's bound to none.
function allNetworksAway(userId: number): boolean {
  const away = new Set(
    listNetworkAwayStates(userId)
      .filter(isAwayRow)
      .map((r) => r.network_id),
  );
  const networks = listNetworksForUser(userId);
  return networks.length > 0 && networks.every((n) => away.has(n.id));
}

// Away turned on or off on some of the account's networks: in the apps, by
// auto-away, or from a client. Each client attached to one of those networks
// hears it as a 305 or 306, so irssi and halloy stay in step. A control
// connection is reconciled with allNetworksAway instead. A client whose AWAY
// made the change sends its own.
function dispatchAway(change: AwayChange): void {
  const networks = new Set(change.networkIds);
  let allAway: boolean | undefined;
  for (const session of sessions) {
    if (session.userId !== change.userId || !session.isRegistered()) continue;
    if (session === change.origin) continue;
    if (session.isControlSession()) {
      allAway ??= allNetworksAway(change.userId);
      session.reconcileControlAway(allAway);
    } else if (networks.has(session.networkId)) {
      session.sendAwayReply(change.active);
    }
  }
}

// How many of a user's clients count as the user being here: on any network,
// for auto-away (presence.ts), or on one, which is then left its CTCP requests
// (attachedIrcClients.ts).
function presentClientCount(userId: number, networkId?: number): number {
  let n = 0;
  for (const session of sessions) {
    if (session.userId !== userId || !session.countsAsPresent()) continue;
    if (networkId === undefined || session.networkId === networkId) n += 1;
  }
  return n;
}

// One of a user's networks was added, edited, deleted or changed state. The
// clients bound to a deleted network are closed, as soju and ZNC close theirs;
// every other client of the user hears of the change. Rare enough (a state
// transition, a settings save) that reading the row and scanning is cheap.
function dispatchNetworkChange(userId: number, networkId: number): void {
  let network: Network | undefined;
  let read = false;
  for (const session of sessions) {
    if (session.userId !== userId || !session.isRegistered()) continue;
    if (!read) {
      network = getNetwork(networkId, userId);
      read = true;
    }
    if (!network && session.networkId === networkId) session.closeWithError('Network removed');
    else session.onNetworkChanged(networkId, network);
  }
}

function dispatchIrcEvent(event: Record<string, unknown>): void {
  const userId = Number(event.userId);
  const networkId = Number(event.networkId);
  if (!userId || !networkId) return;
  const type = String(event.type || '');
  // The app's link to the engine dropped, or came back, while the engine kept
  // the IRC socket open (IrcConnection's `engineLink`). The network itself never
  // moved, so no client hears anything: a notice, a CAP DEL/NEW pair and a
  // BOUNCER NETWORK update would all say something untrue.
  if (type === 'state' && event.engineLink) return;
  // A -notify client (bound OR control) tracks state for ALL of the user's
  // networks — including ones no bound session is attached to — so this goes to
  // every one of the user's sessions, before the per-network early-return below.
  if (type === 'state') dispatchNetworkChange(userId, networkId);
  const set = registry.get(registryKey(userId, networkId));
  if (!set || set.size === 0) return;
  if (type === 'state') {
    const state = String(event.state || '');
    const error = typeof event.error === 'string' ? event.error : '';
    // Deleting from a Set mid-iteration is safe; handlers only ever remove.
    for (const session of set) session.onUpstreamState(state, error);
    return;
  }
  // The connection heard a channel's NAMES: a client whose attach burst held
  // them back gets them now. A list published while they're still pending
  // isn't them.
  if (type === 'names' && !event.membersPending) {
    const target = typeof event.target === 'string' ? event.target : '';
    if (target) for (const session of set) session.onNamesHeard(target);
    return;
  }
  // Self-originated conversation (sent from the web UI, MCP, or another
  // attached IRC client) — the upstream never echoes it, so synthesize it.
  if (!event.self) return;
  // Not one of our own lines a history backfill brought back (#1283): the
  // batch it came in was kept from the clients, and so is this.
  if (event.replay) return;
  if (type !== 'message' && type !== 'action' && type !== 'notice') return;
  const target = typeof event.target === 'string' ? event.target : '';
  // ⚠⚠ `=nick` is a DCC chat buffer, not an IRC target. Without this, a line the
  // user types in the web UI is echoed to attached clients as `PRIVMSG =alice`,
  // they open a query window named `=alice`, and a reply typed there comes back
  // through handleClientMessage and onto the wire. This is the one remaining
  // door in the "a `=` target never reaches IRC" invariant — playback,
  // CHATHISTORY TARGETS and read markers all exclude these buffers already.
  if (!target || target.startsWith(':server:') || isDccChatTarget(target)) return;
  const text = typeof event.text === 'string' ? event.text : '';
  if (!text) return;
  const time = typeof event.time === 'string' ? event.time : null;
  // The msgid the row took from the network's echo (echo-message), so the client
  // has the id history will give it.
  const msgid = networkMsgid(event);
  // The line it answers (publish() resolved the tag into replyTo). Never on an
  // E2E line, as history never replays one there (!row.e2e): its reply went out
  // without tags (ircManager.send publishes it without replyMsgid today).
  const replyTo = event.replyTo as { msgid?: unknown } | undefined;
  const replyMsgid =
    !event.e2e && typeof replyTo?.msgid === 'string' && replyTo.msgid ? replyTo.msgid : undefined;
  for (const session of set) {
    session.deliverSelfEcho(type, target, text, time, msgid, replyMsgid);
  }
}

/**
 * Close every attached bouncer session for a user.
 *
 * Exported for account recovery (#855), which has to reach past the web client:
 * a bouncer session authenticates once at login and then carries its userId in
 * the session object — the same "checked once, never re-checked" shape as a
 * WebSocket. Without this, an attached IRC client keeps receiving playback and
 * sending as the member after the account has been recovered. A no-op when the
 * bouncer isn't running, since `sessions` is then empty.
 */
export function dropSessionsForUser(userId: number, reason: string): void {
  for (const session of sessions) {
    // Deliberately NOT gated on isRegistered(). A SASL login sets userId when it
    // succeeds, but the session isn't registered until CAP END, and it gets a
    // 60s grace to get there. Skipping those left a hole: authenticate, stall,
    // wait out the recovery, then finish registering and arrive attached to an
    // account that was just recovered (#914). The isRegistered() filter belongs
    // to the count/dispatch callers, not to revocation.
    if (session.userId === userId) session.closeWithError(reason);
  }
}

/**
 * Close every bouncer session that authenticated with an API token, registered
 * or not: the api-tokens revoke route calls this, so a revoked token stops
 * working on the connections it already opened (#914). The account's other
 * sessions, on its password or another token, stay up.
 */
export function dropSessionsForApiToken(tokenId: number, reason: string): void {
  for (const session of sessions) {
    if (session.apiTokenId === tokenId) session.closeWithError(reason);
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
let bouncerTlsState: {
  certPath: string;
  keyPath: string;
  fingerprint: string;
  source: 'configured' | 'self-signed';
} | null = null;

let onIrcEvent: ((event: Record<string, unknown>) => void) | null = null;
let onReadMarker: ((move: ReadMarkerMove) => void) | null = null;
let onAway: ((change: AwayChange) => void) | null = null;
let onUserDisposed: ((payload: { userId: number }) => void) | null = null;
let onUserSuspended: ((payload: { userId: number }) => void) | null = null;
let onNetworkChanged: ((payload: { userId: number; networkId: number }) => void) | null = null;

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

// Ceiling on one client's MONITOR list, as soju has. While the network is up
// its own limit trims the list sooner; this bounds it while the network is down
// and the list waits for the seed.
export function maxMonitorPerClient(): number {
  const n = Number(process.env.LURKER_BOUNCER_MAX_MONITOR);
  if (!Number.isFinite(n) || n <= 0) return 1000;
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
    // Settings → Bouncer shows this for a member to check against, so a renewal
    // has to move it: a stale one has them pinning a certificate that's gone.
    setBouncerTlsState({ selfSigned: bouncerTlsState.source === 'self-signed', fingerprint });
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
      source: tlsInfo.source,
    };
    setBouncerTlsState({
      selfSigned: tlsInfo.source === 'self-signed',
      fingerprint: tlsInfo.fingerprint,
    });
    certReloadTimer = setInterval(() => reloadBouncerTls(), CERT_RELOAD_INTERVAL_MS);
    certReloadTimer.unref?.();
  } else {
    server = net.createServer(onConnection);
    bouncerTlsState = null;
    setBouncerTlsState(null);
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
  onReadMarker = (move) => dispatchReadMarker(move);
  ircManager.on('read-marker', onReadMarker);
  onAway = (change) => dispatchAway(change);
  ircManager.on('away', onAway);
  // An attached client counts as the user being here, for auto-away, and is
  // left the CTCP requests on its network.
  setPresenceSource('irc', presentClientCount);
  setAttachedIrcClientCounter(presentClientCount);
  onUserDisposed = ({ userId }) => dropSessionsForUser(userId, 'Account removed');
  onUserSuspended = ({ userId }) => dropSessionsForUser(userId, 'Account paused');
  ircManager.on('user-disposed', onUserDisposed);
  ircManager.on('user-suspended', onUserSuspended);
  onNetworkChanged = ({ userId, networkId }) => dispatchNetworkChange(userId, networkId);
  ircManager.on('network-changed', onNetworkChanged);

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
  setBouncerTlsState(null);
  if (onIrcEvent) {
    ircManager.off('event', onIrcEvent);
    onIrcEvent = null;
  }
  if (onReadMarker) {
    ircManager.off('read-marker', onReadMarker);
    onReadMarker = null;
  }
  if (onAway) {
    ircManager.off('away', onAway);
    onAway = null;
  }
  setPresenceSource('irc', null);
  setAttachedIrcClientCounter(null);
  if (onUserDisposed) {
    ircManager.off('user-disposed', onUserDisposed);
    onUserDisposed = null;
  }
  if (onUserSuspended) {
    ircManager.off('user-suspended', onUserSuspended);
    onUserSuspended = null;
  }
  if (onNetworkChanged) {
    ircManager.off('network-changed', onNetworkChanged);
    onNetworkChanged = null;
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
