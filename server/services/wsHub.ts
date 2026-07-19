// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import type { Server as HttpServer, IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { WebSocket } from 'ws';
import type { User } from '../db/users.js';
import type { LogLine } from './systemLog.js';
import type { MessageEvent } from '../db/messages.js';
import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import cookieParser from 'cookie-parser';
import ircManager from './ircManager.js';
import type { IrcConnection } from './ircConnection.js';
import { e2eManager } from './e2e/manager.js';
import { MAX_IMPORT_BYTES } from './e2e/portable.js';
import settingsService from './settingsService.js';
import highlightRulesService from './highlightRulesService.js';
import draftsService from './draftsService.js';
import * as systemLog from './systemLog.js';
import * as pushService from './pushService.js';
import { evaluateIgnores, type IgnoreVerdict } from './ignoreMatch.js';
import ignoreRulesService from './ignoreRulesService.js';
import { parseIgnoreInput, maskToRuleInput } from './ignoreRuleInput.js';
import { findSession } from '../db/sessions.js';
import { findUserById, touchUserLastSeen } from '../db/users.js';
import {
  listMessages,
  listMessagesAround,
  hasOlderRow,
  hasNewerRow,
  hasMessageForTarget,
  listSpeakers,
  countNewer,
  countServerBufferUnread,
  countHighlightsNewer,
  maxIdByBuffer,
  maxIdForBuffer,
  maxMessageId,
  typeCountsForUnread,
} from '../db/messages.js';
import {
  listReadStateForUser,
  getReadState,
  setReadState,
  listClearedStateForUser,
  getClearedState,
  setClearedState,
} from '../db/bufferReads.js';
import {
  countNotableNewer,
  listSystemMessages,
  listSystemMessagesAround,
  hasOlderSystem,
  hasNewerSystem,
} from '../db/systemMessages.js';
import {
  addEntry as addInputHistory,
  listRecent as listRecentInputHistory,
} from '../db/inputHistory.js';
import {
  getBuffer,
  getState as getBufferState,
  ensureExists as ensureBufferExists,
  ensureOpen as ensureBufferOpen,
  reopen as reopenBufferRow,
  close as closeBufferRow,
  setAutojoin as setBufferAutojoin,
  listStatesForUser as listBufferStatesForUser,
  kindForTarget,
} from '../db/buffers.js';
import type { BufferStateRow } from '../db/buffers.js';
import {
  pinBuffer,
  unpinBuffer,
  unpinBufferCaseInsensitive,
  reorderPins,
  listPinnedForUserNetwork,
} from '../db/pinnedBuffers.js';
import { setNicklistCollapsed } from '../db/nicklistCollapsed.js';
import { addBookmark, removeBookmark, listBookmarkIdsForUser } from '../db/bookmarks.js';
import {
  getChannelNotifyAlways,
  setChannelNotifyAlways,
  getChannelFlags,
} from '../db/channelNotify.js';
import { getUserAwayState } from '../db/userAwayState.js';
import { findNotifyContactForTarget } from '../db/contacts.js';
import { ownsNetwork, listNetworksForUser } from '../db/networks.js';
import * as chanlistDb from '../db/chanlist.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { SESSION_COOKIE, loadBearerSession } from '../middleware/auth.js';
import { PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from '../protocol.js';
import { isAllowedBrowserOrigin } from '../utils/corsOrigins.js';
import { callVerb } from './verbRegistry.js';

// WebSocket extended with per-socket bookkeeping fields.
interface LurkerWebSocket extends WebSocket {
  userId?: number;
  sinceId?: number;
  presence?: { visible: boolean };
  // Liveness flag for the heartbeat reaper (see sweepWsHeartbeat). Set true on
  // connect and on every pong; set false right before each ping. A socket still
  // false at the next sweep missed a full interval's pong and is terminated as
  // dead. Without this, a client that dies uncleanly — a laptop sleeping with
  // the tab foregrounded, a phone dropping off the network — never sends a TCP
  // close, so the socket lingers OPEN with its last-reported presence (often
  // visible=true) and userHasVisibleClient() stays true forever, permanently
  // suppressing auto-away.
  isAlive?: boolean;
  // Mirrors the account's is_paused at connect time, then flipped live by the
  // user-suspended / user-resumed handlers so the read-only write guard never
  // needs a per-message DB read. (Named accountPaused, not isPaused, to avoid
  // colliding with the ws library's own WebSocket.isPaused.)
  accountPaused?: boolean;
  // Protocol version the client announced via `?v=` on the upgrade (#569), or
  // PROTOCOL_VERSION when it announced none (web client / legacy native build).
  protocolVersion?: number;
  // Per-socket inbound flood-control token bucket (#574). Lazily initialized on
  // the first message; see allowInboundMessage.
  floodTokens?: number;
  floodRefilledAt?: number;
}

// #574: cap a single inbound WS frame. The library default is 100 MB; client→
// server frames are IRC-shaped (a line of text plus a little JSON), so a low cap
// is safe and stops one frame from allocating a huge buffer. Uploads and imports
// go over REST, never the socket.
const MAX_WS_MESSAGE_BYTES = 256 * 1024;

// #574: per-socket inbound message-rate limiter. A token bucket sized well above
// any legitimate client — a human, plus the burst of open-buffer verbs a client
// fires right after connect, never approaches this — that caps an authenticated
// client trying to flood verbs. Checked BEFORE JSON.parse so a flood can't even
// pay parse cost.
const WS_MSG_BUCKET_CAPACITY = 120;
const WS_MSG_BUCKET_REFILL_PER_SEC = 40;

// Refill by elapsed time, spend one token. Returns false when the bucket is dry
// — the caller then closes the socket, since a client hitting this rate is
// misbehaving, not racing.
export function allowInboundMessage(ws: LurkerWebSocket): boolean {
  const now = Date.now();
  const last = ws.floodRefilledAt ?? now;
  const refilled = Math.min(
    WS_MSG_BUCKET_CAPACITY,
    (ws.floodTokens ?? WS_MSG_BUCKET_CAPACITY) +
      ((now - last) / 1000) * WS_MSG_BUCKET_REFILL_PER_SEC,
  );
  ws.floodRefilledAt = now;
  if (refilled < 1) {
    ws.floodTokens = refilled;
    return false;
  }
  ws.floodTokens = refilled - 1;
  return true;
}

// X-Forwarded-Host may carry a comma list when the request passed through a proxy
// chain; the first value is the original client-facing host. Node joins repeated
// headers into one comma-separated string (and hands back an array only in edge
// cases), so handle both.
function firstForwardedHost(raw: string | string[] | undefined): string | undefined {
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const first = value?.split(',')[0]?.trim();
  return first || undefined;
}

// Same-origin when the Origin and the request's public host resolve to the same
// URL origin. Both sides are run through the URL parser under the Origin's own
// scheme, so the comparison is case-insensitive on the host and treats a default
// port that one side spells out and the other omits as equal — a browser omits
// `:443`/`:80` in Origin, but a proxy (e.g. the `$host:$server_port` idiom) may
// append it to Host. A raw string compare would let those cosmetic differences
// spuriously fall through to the allowlist and reintroduce a 403.
function isSameOriginHost(originUrl: URL, effectiveHost: string): boolean {
  try {
    return new URL(`${originUrl.protocol}//${effectiveHost}`).origin === originUrl.origin;
  } catch {
    return false;
  }
}

// #574: same-origin / allowed-origin check for the WS upgrade. Browsers always
// send Origin on a WS handshake; native clients send none. We reject only a
// *browser* upgrade whose Origin is neither same-origin as the request's public
// host nor an explicitly allowlisted origin (CORS_ORIGIN) — i.e. a cross-site
// attempt. Absent Origin (native) and same-origin always pass, so this can't
// wedge a working deployment.
//
// "Public host" is the subtle part behind a reverse proxy. The socket's own Host
// header is whatever the proxy forwarded, and a great many proxies rewrite it to
// the upstream address (e.g. `127.0.0.1:8015`) unless explicitly told to preserve
// it. That would never equal the browser's Origin host, pushing every legitimate
// request onto the CORS_ORIGIN allowlist path — exactly the regression 1.1.1 hit.
// So we accept a same-origin match on EITHER the proxy-advertised public host
// (X-Forwarded-Host) OR the socket's own Host — a match on either is proof of
// same-origin, and requiring one specific header would 403 a legitimate upgrade
// whenever a proxy forwards an unexpected value in the other (e.g. an outer hop
// sets X-Forwarded-Host to an internal name while Host is still the public host).
// This is safe against the cross-site WS hijack this check defends against: a
// browser cannot set X-Forwarded-Host on a WebSocket handshake (the WS API forbids
// custom request headers) and cannot forge Host either, so neither candidate is
// attacker-controlled in a browser; and a non-browser client sends no Origin and
// is already allowed, so it gains nothing by forging one.
export function isAllowedUpgradeOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const candidateHosts = [firstForwardedHost(req.headers['x-forwarded-host']), req.headers.host];
  if (candidateHosts.some((host) => host && isSameOriginHost(originUrl, host))) return true;
  return isAllowedBrowserOrigin(origin);
}

// The protocol version a client announces via `?v=<n>` on the /ws upgrade (#569).
// Returns null when the param is absent OR present-but-unparseable, and the
// caller treats null as "current" (no version gate). Conflating the two is
// deliberate and consistent: a client that omits `?v` and one that sends garbage
// have both failed to announce a valid version, so both are treated identically.
// This is not a security bypass of MIN_PROTOCOL_VERSION — omitting `?v` is itself
// the sanctioned "treat me as current" path, so there is nothing a malformed
// value could bypass that an absent one couldn't. The gate is a compatibility
// courtesy (tell a well-behaved old client to update), not an auth control.
// Mirrors parseSinceParam.
export function parseProtocolParam(rawUrl: string): number | null {
  try {
    const raw = new URL(rawUrl, 'http://localhost').searchParams.get('v');
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

// Generic payload for outgoing WS messages.
type WsPayload = Record<string, unknown>;

// Inbound message types that mutate IRC state or produce outbound IRC traffic.
// A paused account is read-only, so these are rejected while reads (snapshot,
// history, search, chanlist-search) and local view state (read markers, pins,
// drafts, bookmarks, nicklist collapse) still work. open-buffer can resolve to
// a JOIN, so it's blocked; close-buffer is blocked because its disconnected
// fallback flips channels.joined=0 — a network-state mutation a read-only
// account shouldn't make (no PART goes out, since paused accounts hold no
// connection, but the persisted join intent would still change).
const PAUSED_BLOCKED_TYPES = new Set([
  'send',
  'action',
  'notice',
  'join',
  'open-buffer',
  'close-buffer',
  'part',
  'raw',
  'probe-presence',
  'list-channels',
  'away',
  'back',
  'typing',
  'e2e',
  'ctcp',
]);

// Options bag for fanOut.
interface FanOutOpts {
  exceptWs?: LurkerWebSocket;
}

// A MessageEvent decorated by decorateMessage with the extra signal fields.
interface DecoratedEvent extends MessageEvent {
  dm: boolean;
  notifyAlways: boolean;
  notify: boolean;
  kind: string;
}

function effectiveSetting(userId: number, key: string): unknown {
  const overrides = getUserSettings(userId) as Record<string, unknown>;
  if (key in overrides) return overrides[key];
  return (defaultsAsObject() as Record<string, unknown>)[key];
}

function isValidTimeZone(tz: unknown): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try {
    // Called without `new` purely for validation — it throws RangeError on an
    // unknown time zone, which the catch below turns into a false return.
    Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts (year/month/day/hour/minute/second) of `date` in the given
// IANA timezone, or in the server's local zone when `timeZone` is falsy/invalid.
function wallClockParts(date: Date, timeZone: string | null): Record<string, string> {
  const dtf = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  // Some locales render midnight as "24" instead of "00"; normalize so the
  // offset math below doesn't blow up on Date.UTC.
  if (out.hour === '24') out.hour = '00';
  return out;
}

function tzOffsetMinutes(date: Date, timeZone: string | null): number {
  if (!timeZone) return -date.getTimezoneOffset();
  const p = wallClockParts(date, timeZone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

const pad = (n: number) => String(n).padStart(2, '0');

// "afk since 2026-05-09 15:30:00-0500" — mirrors screen_away.py's default
// time_format. Renders in `timeZone` when provided, otherwise server local.
function fmtAwayTimestamp(date: Date, timeZone: unknown): string {
  const tz = isValidTimeZone(timeZone) ? timeZone : null;
  const p = wallClockParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const sign = off >= 0 ? '+' : '-';
  const aoff = Math.abs(off);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${sign}${pad(Math.floor(aoff / 60))}${pad(aoff % 60)}`;
}

function buildAutoAwayMessage(userId: number, since: Date): string {
  const base =
    ((effectiveSetting(userId, 'away.auto.message') as string | undefined) || 'afk').trim() ||
    'afk';
  const tz = effectiveSetting(userId, 'system.timezone');
  return `${base} since ${fmtAwayTimestamp(since, tz)}`;
}

// HH:MM (24h) into minutes-past-midnight, or null on a malformed value. The
// quiet-hours settings are plain strings rather than integers so the UI can
// use <input type="time"> directly without conversion juggling.
function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function currentMinutesInZone(date: Date, timeZone: unknown): number {
  const tz = isValidTimeZone(timeZone) ? timeZone : null;
  const p = wallClockParts(date, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

// True when current is inside [start, end). When start > end the window
// wraps midnight, e.g. 22:00–07:00 = [22:00, 24:00) ∪ [00:00, 07:00).
function isInQuietWindow(currentMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return currentMin >= startMin && currentMin < endMin;
  return currentMin >= startMin || currentMin < endMin;
}

// Message types that mark a target as a real DM conversation — used both to
// reopen a closed buffer on fresh activity (the fan-out guard) and to flag an
// event as a personal DM for notifications (isDirect). NOTICE is deliberately
// excluded (#439): a notice persists to the sender's buffer like a message, but
// it must NOT reopen a buffer the user explicitly closed (closed stays closed —
// the closed-buffer NOTICE is persisted as a durable copy in the server buffer
// instead) and a service notice (NickServ/ChanServ) must not fire a DM notification.
export const DM_ELIGIBLE_TYPES = new Set(['message', 'action']);

// Does this event outrank the user's closed flag and reopen the buffer?
//
// Two things qualify. A persisted message with a real id (DM, action) is a
// strong signal the buffer is wanted again. And a self-join is definitive — we
// ARE in that channel now — which is the same join-precedence the snapshot walk
// applies (eachUserBufferTarget). The two paths used to disagree on the second
// case: channel-joined carries no id, so the live event was dropped here while
// the snapshot showed the channel anyway. Rejoining a closed channel therefore
// did nothing visible until the user reloaded the client.
//
// Everything else — typing, away markers, names — stays out: ephemeral traffic
// must not resurrect a buffer the user closed.
export function reopensClosedBuffer(type: string, id: unknown): boolean {
  if (type === 'channel-joined') return true;
  return id != null && DM_ELIGIBLE_TYPES.has(type);
}

// Structural DM detection from a target string: ircConnection routes any direct
// message into a buffer keyed by the *other* person's nick, so a target that's
// not a channel (`#…`) and not a server pseudo-buffer (`:server:…`) is a direct
// conversation — that bucket includes both incoming DMs and your own outgoing
// DMs. Shared by isDirect (event path) and computeUnreadFor (read-state counts)
// so the two never drift on what counts as a DM.
function isDmTarget(target: string): boolean {
  return !!target && !target.startsWith('#') && !target.startsWith(':server:');
}

function isDirect(event: MessageEvent): boolean {
  if (!DM_ELIGIBLE_TYPES.has(event.type)) return false;
  return isDmTarget(event.target || '');
}

// Match state is persisted on each message at insert time (see
// ircConnection.publish), so events already arrive with matched/matchedRuleId
// populated — either from the live IRC pipeline or from rowToEvent for
// backlog reads. This decoration adds the per-broadcast `dm` and
// `notifyAlways` content signals and the derived `notify` delivery decision,
// and normalizes the match fields so non-persisted events (typing, names,
// etc.) don't surface as undefined. Content signals stay separate on the
// wire so clients can route toast/sound per signal type; `notify` is the
// union and is the single gate consulted by push delivery and the in-client
// notifier.
export function decorateMessage(userId: number, event: MessageEvent): DecoratedEvent {
  const matched = !!event.matched;
  const matchedRuleId = event.matchedRuleId ?? null;
  const dm = isDirect(event) && !event.self;
  const target = event.target || '';
  const isChannel = target.startsWith('#');
  // CTCP request/reply/echo lines are status, not conversation — never notify,
  // even when routed to a notify-always channel (otherwise running /ctcp from
  // such a channel would self-notify on your own echo). (#263)
  const isStatus = event.type === 'ctcp';
  const notifyAlways =
    !isStatus &&
    isChannel &&
    !event.self &&
    getChannelNotifyAlways(userId, event.networkId, target);
  const notify = !isStatus && (matched || dm || notifyAlways);
  return {
    ...event,
    matched,
    matchedRuleId,
    dm,
    notifyAlways,
    notify,
    kind: event.kind ?? '',
  } as DecoratedEvent;
}

// The app-scoped system buffer's target sentinel (mirrors the client's
// SYSTEM_KEY). Its buffer_reads row carries a NULL network_id.
const SYSTEM_TARGET = ':system:';

// Which system-log lines mark the system buffer unread (#355). Mirrors
// countNotableNewer's WHERE clause — keep the two in sync. 'warn' is excluded on
// purpose (a routine, auto-reconnecting disconnect logs at 'warn'), so ambient
// connectivity noise never marks the buffer unread. Gates the live read-state
// refresh so routine lifecycle lines don't fan out a no-op read-state to every tab.
function systemLineNotifies(line: LogLine): boolean {
  return line.source === 'admin' || line.source === 'control-plane' || line.level === 'error';
}

function computeUnreadFor(
  userId: number,
  networkId: number | null,
  target: string,
  lastReadId: number,
) {
  // System buffer: no network, and its content lives in system_messages (not
  // messages), so unread is the count of notable lines the user hasn't seen.
  // Notable lines double as highlights so the LURKER row lights up for them.
  if (networkId == null && target === SYSTEM_TARGET) {
    const unread = countNotableNewer(userId, lastReadId);
    return { lastReadId: lastReadId || 0, unread, highlights: unread, highlightsCapped: false };
  }
  const nid = networkId as number;
  // The server pseudo-buffer applies a notability filter (#470): routine
  // Lurker-generated connection-status notices don't mark it unread, but errors,
  // inbound notices, and closed-buffer mirrors do. Channels/DMs count normally.
  const unread = target.startsWith(':server:')
    ? countServerBufferUnread(nid, target, lastReadId)
    : countNewer(nid, target, lastReadId);
  // A DM is inherently a mention of you, so — like the system buffer — every
  // unread line counts as a highlight. This lights the buffer-list row up in
  // the highlight color and shows the ● badge, surfacing unread DMs above
  // ordinary channel traffic. Display-only: notification/push decisions are
  // made per-message in highlightEngine and are unaffected. Channels keep their
  // real mention-only highlight count (an indexed query, no scan cap).
  let highlights = 0;
  if (unread > 0) {
    highlights = isDmTarget(target) ? unread : countHighlightsNewer(nid, target, lastReadId);
  }
  return {
    lastReadId: lastReadId || 0,
    unread,
    highlights,
    highlightsCapped: false,
  };
}

// One yield per buffer.
export interface UserBufferTarget {
  networkId: number | null; // null == the app-scoped system buffer
  target: string;
  conn: IrcConnection | null; // the live connection, or null (offline / system)
}

// THE single source of "which buffers belong in this user's client store". Every
// site that has to walk a user's whole buffer set — the connect snapshot's live
// loop, buildOfflineBacklogFrames, and the push-badge total — used to hand-roll
// this walk and re-derive the system / :server: / closed-vs-joined carve-outs
// slightly differently, which let the PWA app-icon badge total drift from the
// in-app count (#454). Now they all iterate this generator, so the set can't
// diverge.
//
// The set is the buffers registry: the app-scoped system buffer (networkId
// null, uncloseable) first, then per network its :server: pseudo-buffer
// (uncloseable, synthesized — no row) followed by that network's open buffer
// rows. A closed row hides its buffer unless the channel is currently joined
// (join-precedence, matching the live filter's channel-joined reopen: in the
// close→PART-echo window the buffer is still materially there). A live-joined
// channel with no row at all (its row was forgotten mid-session) is yielded
// defensively so the sidebar can never lose a channel the user is actually in.
// `conn` is the live connection or null so callers can choose shell-vs-backlog
// without re-deriving liveness. Rows exist independently of history, so a
// never-spoken empty buffer is still enumerated — the client counts it from
// lastReadId 0, and callers use getReadState (defaults to 0) the same way.
export function* eachUserBufferTarget(userId: number): Generator<UserBufferTarget> {
  // System buffer first — app-scoped (networkId null), uncloseable.
  yield { networkId: null, target: SYSTEM_TARGET, conn: null };
  const liveById = new Map<number, IrcConnection>(
    ircManager.listConnections(userId).map((c) => [c.network.id, c]),
  );
  const rowsByNetwork = new Map<number, BufferStateRow[]>();
  for (const row of listBufferStatesForUser(userId)) {
    if (row.networkId == null) continue; // app-scoped rows are synthesized above
    let list = rowsByNetwork.get(row.networkId);
    if (!list) rowsByNetwork.set(row.networkId, (list = []));
    list.push(row);
  }
  for (const net of listNetworksForUser(userId)) {
    const conn = liveById.get(net.id) ?? null;
    yield { networkId: net.id, target: `:server:${net.id}`, conn };
    const seen = new Set<string>();
    for (const row of rowsByNetwork.get(net.id) ?? []) {
      seen.add(row.targetFolded);
      if (row.state === 'closed' && !conn?.channels.has(row.targetFolded)) continue;
      yield { networkId: net.id, target: row.target, conn };
    }
    if (conn) {
      for (const ch of conn.channels.values()) {
        if (!seen.has(ch.name.toLowerCase())) yield { networkId: net.id, target: ch.name, conn };
      }
    }
  }
}

// App-wide unread-highlight total for a user — the number the PWA app-icon badge
// shows while no client is open (#451). Must equal the client's `totalHighlights`
// getter (sum of every store buffer's `highlighted`), so it counts highlights
// over exactly the buffer set eachUserBufferTarget enumerates — the same set the
// snapshot ships. :server: pseudo-buffers are enumerated but isDmTarget excludes
// them, so they get no DM=unread shortcut — their only highlights are genuine
// mention-rule matches against server-notice text (normally none), which the
// client's snapshot counts identically, so the totals still agree. Only called on
// push delivery (no visible client), so the per-buffer indexed counts are cheap;
// computeUnreadFor skips the highlight query entirely when a buffer has no unread.
export function computeTotalHighlights(userId: number): number {
  let total = 0;
  for (const { networkId, target } of eachUserBufferTarget(userId)) {
    total += computeUnreadFor(
      userId,
      networkId,
      target,
      getReadState(userId, networkId, target),
    ).highlights;
  }
  return total;
}

// Single source of the "is this buffer joined?" rule: a #channel counts as
// joined only while a live connection is tracking it; DMs and the server
// pseudo-buffer have no join concept, so they always count as joined (never
// dimmed). `conn` is optional — an offline network passes none, which folds a
// #channel to parted. Centralized so the four snapshot/backlog sites can't drift
// (channel-case folding already bit this codebase — see #289/#269).
function channelJoined(
  target: string,
  conn?: { channels: { has(name: string): boolean } } | null,
): boolean {
  return target.startsWith('#') ? !!conn?.channels.has(target.toLowerCase()) : true;
}

// The per-buffer read/unread/cleared block shared by every backlog frame
// (buildBufferBacklog, buildBufferShell, the snapshot loop). `precomputed` lets
// the snapshot's hot path pass the values it already has from the bulk
// listReadStateForUser / listClearedStateForUser maps, so it doesn't re-issue a
// getReadState + getClearedState point query per buffer (the O(buffers) cost the
// shell optimization is meant to avoid). computeUnreadFor still runs per buffer —
// it's the unread count and has no bulk form.
function bufferStateFields(
  userId: number,
  networkId: number | null,
  target: string,
  precomputed?: {
    lastReadId?: number;
    cleared?: { clearedBeforeId: number; clearedAt: string | null };
  },
): {
  lastReadId: number;
  unread: number;
  highlights: number;
  highlightsCapped: boolean;
  clearedBeforeId: number;
  clearedAt: string | null;
} {
  const lastReadId = precomputed?.lastReadId ?? getReadState(userId, networkId, target);
  const counts = computeUnreadFor(userId, networkId, target, lastReadId);
  const cleared = precomputed?.cleared ?? getClearedState(userId, networkId, target);
  return {
    lastReadId: counts.lastReadId,
    unread: counts.unread,
    highlights: counts.highlights,
    highlightsCapped: counts.highlightsCapped,
    clearedBeforeId: cleared.clearedBeforeId,
    clearedAt: cleared.clearedAt,
  };
}

// Builds a one-off `backlog` frame for a single buffer — used when a closed
// buffer is reopened (the user clicked its channel name). Unlike the snapshot
// loop this ignores the resume cursor and always ships the recent slice; the
// client dedupes by id, so it's safe even if the buffer is already open.
export function buildBufferBacklog(userId: number, networkId: number, target: string): WsPayload {
  const conn = ircManager.getConnection(userId, networkId);
  const events = listMessages(networkId, target, { limit: 200 }).map((e) =>
    decorateMessage(userId, e),
  );
  return {
    kind: 'backlog',
    networkId,
    target,
    events,
    speakers: listSpeakers(networkId, target),
    joined: channelJoined(target, conn),
    ...bufferStateFields(userId, networkId, target),
    inputHistory: listRecentInputHistory(userId, networkId, target, INPUT_HISTORY_SLICE),
  };
}

// Lightweight `backlog` frame for a buffer we're NOT hydrating up front: the
// buffer row + its read/unread/cleared state, but NO message rows (`events: []`)
// and no input history. Deliberately skips the per-buffer listMessages/
// listSpeakers/inputHistory reads — those are the bulk of the synchronous
// snapshot cost. Used for offline-network buffers AND, on a FRESH connect (empty
// client, no active buffer), for online channel/DM buffers too: Lurker never
// auto-focuses a buffer on load, so shipping any message backlog is wasted work.
// `hasMoreOlder: true` makes the client treat it as an unhydrated shell: the
// first time the user opens it, activate() fires reattachToLive → a 'history'
// mode:'latest' fetch that fills it from the DB on demand (the same lazy path a
// brand-new buffer uses). Unread counts come from indexed queries, so the
// sidebar badge stays correct without touching the message body. `joined` is
// passed in because it differs by caller (offline = parted; online = the live
// connection's current membership).
export function buildBufferShell(
  userId: number,
  networkId: number,
  target: string,
  joined: boolean,
  precomputed?: {
    lastReadId?: number;
    cleared?: { clearedBeforeId: number; clearedAt: string | null };
  },
): WsPayload {
  return {
    kind: 'backlog',
    networkId,
    target,
    events: [],
    // Deliberately OMIT `speakers` and `inputHistory` (rather than shipping []).
    // The client applies both under a presence guard — `if (speakers !==
    // undefined)` and truthy `if (payload.inputHistory)` — so an empty array is
    // read as "replace with nothing" and would WIPE existing state on a
    // re-snapshot (e.g. an isFreshNetwork reconnect re-shells a buffer the client
    // still holds speakers/recall for). Omitting them makes the client keep what
    // it has; a brand-new shell buffer defaults to empty locally anyway. On open,
    // reattachToLive's 'history' latest reply re-seeds both.
    joined,
    // Shell marker: no messages loaded yet, but there IS history to fetch on
    // open. The client's empty-seed branch honors this flag (see replaceBacklog).
    hasMoreOlder: true,
    ...bufferStateFields(userId, networkId, target, precomputed),
  };
}

// Upper bound on how many missed rows a resume frame ships per buffer. Wider
// than the first-connect default so a normal flap fills in one shot, but
// bounded so a long disconnect can't produce an unbounded payload.
const RESUME_GAP_CAP = 500;
// When the gap exceeds the cap we fall back to a fresh latest slice; size it
// to match the first-connect default.
const RESUME_LATEST_LIMIT = 200;

// Per-buffer input-history slice shipped for up-arrow recall (on a :server:
// backlog, a resume frame, or a shell's 'history' latest hydrate). This is the
// recall DEPTH, not a first page: there is no client verb to fetch older input
// history, so entries beyond this slice are simply not reachable via up-arrow.
// Kept modest because it's N rows PER buffer on the connect path.
const INPUT_HISTORY_SLICE = 50;

// A synchronous snapshot slower than this is logged (console only) — it's a
// direct measure of how long the event loop was blocked serving one connect,
// the thing that starves IRC socket I/O when it gets large.
// A snapshot slower than this logs a per-phase breakdown. Env-tunable so a fast
// local/dev instance (which normally never crosses 250ms) can log every snapshot
// for comparison — e.g. LURKER_SNAPSHOT_SLOW_MS=0 in .env.
const SNAPSHOT_SLOW_MS = (() => {
  const raw = Number(process.env.LURKER_SNAPSHOT_SLOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 250;
})();

// Per-phase timing of one snapshot, so a slow one says WHERE the time went
// (member-list blob vs seeds vs the per-buffer loop vs offline frames) instead
// of just a total. See the sendSnapshot wrapper's log.
interface SnapshotBreakdown {
  bufferCount: number;
  fresh: boolean; // true = fresh connect → online loop shipped shells, not resume frames
  networksMs: number; // ircManager.snapshotForUser (serializes channel member lists)
  seedsMs: number; // drafts/bookmarks/system/contacts + the bulk read/cleared/closed maps
  onlineMs: number; // the live per-buffer loop (shells: unread counts; resume: +reads/speakers)
  offlineMs: number; // buildOfflineBacklogFrames
  // Online-loop op split (the rest of onlineMs is sends/input-history/overhead).
  // These are ms-resolution and each rounds independently, so treat as
  // approximate; `rest` is clamped at 0 in the log to avoid rounding negatives.
  // ≈computeUnreadFor plus a little frame/state-field assembly — read/cleared
  // lookups are NOT included (the loop passes precomputed values).
  unreadMs: number; // shell: buildBufferShell; resume: bufferStateFields
  sliceMs: number; // buildResumeSlice — message reads + decorate (resume path only)
}

// Decide the slice a resume snapshot ships for ONE buffer.
//
// Normal case: ship just the gap the client missed (id > sinceId). The client
// appends it to its existing tail (replaceBacklog's gap-fill path).
//
// The catch: that gap is capped at RESUME_GAP_CAP to bound the payload, and
// the client only retains MAX_PER_BUFFER rows anyway. So if the buffer took on
// MORE than the cap while the client was away, appending the oldest slice of
// the gap would splice a PERMANENT hole between the client's stale tail and the
// live tail (the dropped middle is never re-sent — fanOut only carries events
// created after reconnect). That's issue #205: a "big gap" only a full reload
// clears. Because message ids are a single global sequence, the client can't
// detect the hole from id-sparseness alone (a quiet buffer is legitimately
// sparse) — only the server knows it truncated. So when we detect truncation we
// ship the LATEST contiguous slice instead and flag `reset`, telling the client
// to replace the buffer wholesale (land on live tail, page upward for older)
// rather than append into a gap.
export function buildResumeSlice(
  userId: number,
  networkId: number,
  target: string,
  sinceId: number,
): { events: DecoratedEvent[]; reset: boolean; hasMoreOlder: boolean } {
  if (sinceId > 0) {
    const gap = listMessages(networkId, target, { afterId: sinceId, limit: RESUME_GAP_CAP });
    const lastGapId = gap.length ? (gap[gap.length - 1].id ?? sinceId) : sinceId;
    const truncated = gap.length >= RESUME_GAP_CAP && hasNewerRow(networkId, target, lastGapId);
    if (!truncated) {
      // hasMoreOlder must be accurate even though a LOADED buffer ignores it
      // (gap-fill just appends): a client holding this buffer only as an empty
      // SHELL (the fresh-connect optimization) empty-seeds from this frame, and a
      // false here would leave it unopenable (activate()'s lazy-fetch is gated on
      // hasMoreOlder). Anchor "is there older?" at the gap's oldest row, or just
      // past the cursor when the gap is empty (then all the buffer's history is
      // older than what we shipped).
      const anchor = gap.length ? (gap[0].id ?? sinceId + 1) : sinceId + 1;
      return {
        events: gap.map((e) => decorateMessage(userId, e)),
        reset: false,
        hasMoreOlder: hasOlderRow(networkId, target, anchor),
      };
    }
    // Truncated: fall through to the latest-slice replace below.
  }
  const latest = listMessages(networkId, target, { limit: RESUME_LATEST_LIMIT });
  const oldestId = latest.length ? (latest[0].id ?? 0) : 0;
  return {
    events: latest.map((e) => decorateMessage(userId, e)),
    // Only signal a replace on a real resume. First connect (sinceId<=0) lands
    // on the client's empty-buffer seed path, which already replaces — flagging
    // reset there is harmless but needlessly noisy.
    reset: sinceId > 0,
    hasMoreOlder: oldestId > 0 && hasOlderRow(networkId, target, oldestId),
  };
}

// Map a system line (LogLine or persisted row — same shape) to the MessageEvent
// wire shape network lines use, so the system buffer rides the unified backlog/
// irc/history frames instead of the old system-log path (#355). This is the
// former client `systemLogToMessage`, relocated server-side so the wire is
// identical; type 'system' + originNetworkId drive the prefix-column rendering.
export function systemLineToEvent(line: {
  id: number;
  ts: string;
  level: string;
  scope: string;
  source: string;
  text: string;
  fields: Record<string, unknown> | null;
}): WsPayload {
  const fields = line.fields;
  const originNetworkId = fields && typeof fields.networkId === 'number' ? fields.networkId : null;
  return {
    id: line.id,
    networkId: null,
    originNetworkId,
    target: SYSTEM_TARGET,
    type: 'system',
    nick: null,
    text: line.text,
    time: line.ts,
    level: line.level,
    scope: line.scope,
    source: line.source,
  };
}

// The system buffer's 'backlog' frame. Deliberately ignores the socket's
// `?since` cursor: system_messages has its OWN id sequence, independent of the
// `messages` table the cursor tracks, so a network sinceId is meaningless here.
// Instead it always ships the latest slice and lets the client's per-buffer
// gap-fill (replaceBacklog dedupes against the system buffer's own max id)
// reconcile on reconnect — exactly what the old system-log snapshot did. No
// speakers / input history; read & cleared state are null-keyed already (#355).
export function buildSystemBacklog(userId: number): WsPayload {
  const rows = listSystemMessages(userId, { limit: RESUME_LATEST_LIMIT });
  const oldestId = rows.length ? rows[0].id : 0;
  const lastRead = getReadState(userId, null, SYSTEM_TARGET);
  const counts = computeUnreadFor(userId, null, SYSTEM_TARGET, lastRead);
  const cleared = getClearedState(userId, null, SYSTEM_TARGET);
  return {
    kind: 'backlog',
    networkId: null,
    target: SYSTEM_TARGET,
    events: rows.map(systemLineToEvent),
    speakers: [],
    joined: true,
    lastReadId: counts.lastReadId,
    unread: counts.unread,
    highlights: counts.highlights,
    highlightsCapped: counts.highlightsCapped,
    clearedBeforeId: cleared.clearedBeforeId,
    clearedAt: cleared.clearedAt,
    inputHistory: [],
    reset: false,
    hasMoreOlder: oldestId > 0 && hasOlderSystem(userId, oldestId),
  };
}

// Build the `history` reply for a system-buffer page request — the system-side
// counterpart to the network 'around'/'after'/'latest'/'before' handling, with
// the same reply shapes so the client's history dispatch is identical. Returns
// an `{kind:'error'}` payload for a bad anchor/after id. Extracted (and pure
// over system_messages) so it's unit-testable; the WS handler just sends it (#355).
export function buildSystemHistoryReply(userId: number, msg: WsPayload): WsPayload {
  const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
  const mode = typeof msg.mode === 'string' ? msg.mode : 'before';
  const base = {
    kind: 'history',
    networkId: null,
    target: SYSTEM_TARGET,
    mode,
    token: msg.token ?? null,
    speakers: [] as never[],
  };
  if (mode === 'around') {
    const anchorId = Number(msg.anchorId);
    if (!Number.isInteger(anchorId) || anchorId <= 0) {
      return { kind: 'error', text: 'invalid anchorId' };
    }
    const slice = listSystemMessagesAround(userId, anchorId, limit);
    return {
      ...base,
      anchorId,
      events: slice.events.map(systemLineToEvent),
      hasMoreOlder: slice.hasMoreOlder,
      hasMoreNewer: slice.hasMoreNewer,
      anchorMissing: 'anchorMissing' in slice ? !!slice.anchorMissing : false,
      hasMore: slice.hasMoreOlder,
      before: null,
    };
  }
  if (mode === 'after') {
    const afterId = Number(msg.afterId);
    if (!Number.isInteger(afterId) || afterId < 0) {
      return { kind: 'error', text: 'invalid afterId' };
    }
    const rows = listSystemMessages(userId, { afterId, limit });
    const newestId = rows.length ? rows[rows.length - 1].id : afterId;
    return {
      ...base,
      afterId,
      events: rows.map(systemLineToEvent),
      hasMoreNewer: hasNewerSystem(userId, newestId),
      hasMoreOlder: true,
      hasMore: true,
      before: null,
    };
  }
  if (mode === 'latest') {
    const rows = listSystemMessages(userId, { limit });
    const oldestId = rows.length ? rows[0].id : 0;
    const more = oldestId > 0 && hasOlderSystem(userId, oldestId);
    return {
      ...base,
      events: rows.map(systemLineToEvent),
      hasMoreOlder: more,
      hasMoreNewer: false,
      hasMore: more,
      before: null,
    };
  }
  // 'before' (default): page older.
  const before = msg.before ? Number(msg.before) : undefined;
  const rows = listSystemMessages(userId, { before, limit });
  const oldestId = rows.length ? rows[0].id : 0;
  const more = oldestId > 0 && hasOlderSystem(userId, oldestId);
  return {
    ...base,
    before: msg.before || null,
    events: rows.map(systemLineToEvent),
    hasMoreOlder: more,
    hasMoreNewer: false,
    hasMore: more,
  };
}

// Backlog frames for every network the user owns that has NO live connection —
// a paused account (the is_paused gate forbids connecting), a manually
// disconnected network (stopNetwork deletes the connection), or one that was
// never autoconnected. The live snapshot path is connection-driven, so without
// these frames an offline network's persisted buffers stay invisible until a
// connection exists — which a paused user can never establish. Reuses
// buildBufferBacklog, which reads purely from the DB and reports joined:false
// when no connection is tracking the channel.
// The frame for one offline buffer. The server pseudo-buffer ships its real
// recent slice (one cheap read per network, and it's where the disconnect reason
// the user wants lives); channel/DM buffers ship as lazy-load shells — that's
// where the read cost and buffer count actually pile up on a long-lived account.
// No live conn, so channelJoined folds #channels to parted and DMs to joined
// (they never dim). Shared by buildOfflineBacklogFrames and the snapshot's single
// enumeration pass so the offline carve-out lives in exactly one place.
function buildOfflineFrame(userId: number, networkId: number, target: string): WsPayload {
  return target.startsWith(':server:')
    ? buildBufferBacklog(userId, networkId, target)
    : buildBufferShell(userId, networkId, target, channelJoined(target));
}

// `targets` lets the snapshot hand in the enumeration it already materialized for
// the live loop, so a connect snapshot walks eachUserBufferTarget — and its
// listBuffersForUser/listNetworksForUser DB reads — exactly ONCE instead of
// once here and once in the live loop. Standalone callers (tests) omit it and
// get a fresh walk.
export function buildOfflineBacklogFrames(
  userId: number,
  targets: Iterable<UserBufferTarget> = eachUserBufferTarget(userId),
): WsPayload[] {
  const frames: WsPayload[] = [];
  for (const { networkId, target, conn } of targets) {
    // Offline backlog only: the app-scoped system buffer ships via its own frame,
    // and live networks are handled by the snapshot's live loop. eachUserBufferTarget
    // has already applied the closed-flag carve-out (nothing is joined offline, so
    // there's no autorejoin race to defend against here — unlike the live loop).
    if (networkId == null || conn) continue;
    frames.push(buildOfflineFrame(userId, networkId, target));
  }
  return frames;
}

// A buffer the user closed and isn't currently joined to is hidden from the
// sidebar; broadcasting a read-state frame for it would resurrect it (#319).
// The closed set is folded `${networkId}::${folded}` keys built from the
// buffers registry (closedBufferKeySet); fold the target here too — servers
// hand us inconsistently-cased names (#289). A currently-joined channel always
// beats a stale closed flag (defensive against autorejoin/state races).
function isHiddenClosedBuffer(
  closed: Set<string>,
  joined: { has(name: string): boolean },
  networkId: number,
  target: string,
): boolean {
  const lower = target.toLowerCase();
  return closed.has(`${networkId}::${lower}`) && !joined.has(lower);
}

// The folded closed-buffer key set for isHiddenClosedBuffer, from the registry.
function closedBufferKeySet(userId: number): Set<string> {
  const set = new Set<string>();
  for (const row of listBufferStatesForUser(userId)) {
    if (row.state === 'closed' && row.networkId != null) {
      set.add(`${row.networkId}::${row.targetFolded}`);
    }
  }
  return set;
}

// Handles a client `open-buffer` request (a clicked channel name). Resolves
// the requested target against the buffers registry — folded, since IRC names
// are case-insensitive but rows store one canonical casing. A row with
// persisted history (even a closed one) is reopened and re-seeded without a
// re-JOIN; a channel with no history is one we've never sat in — a bare
// registry row can exist for it (a config-seeded autojoin entry), but there is
// nothing to show, so it gets joined and surfaces on the echo. A bare nick
// becomes a real (possibly empty) DM row — under the registry an empty DM can
// exist and survive a reload, which the derived model couldn't express.
// Either way the requesting socket is told the canonical target to focus, so
// it never has to guess the casing.
export function handleOpenBuffer(
  ws: LurkerWebSocket,
  userId: number,
  networkId: number,
  requested: string,
): void {
  if (!networkId || !requested || requested.startsWith(':server:')) return;
  const row = getBuffer(userId, networkId, requested);
  if (row && hasMessageForTarget(networkId, row.target)) {
    reopenBufferRow(userId, networkId, row.target);
    send(ws, buildBufferBacklog(userId, networkId, row.target));
    send(ws, { kind: 'buffer-opened', networkId, target: row.target });
  } else if (requested.startsWith('#')) {
    ircManager.joinChannel(userId, networkId, requested);
    send(ws, { kind: 'buffer-opened', networkId, target: requested });
  } else if (kindForTarget(requested) === 'dm') {
    // A bare nick becomes a real (possibly empty) DM row that survives a
    // reload. Gated on the DM classification, NOT "not '#'": a history-less
    // '&'/'+'/'!' channel must not be minted as a permanently-dead channel
    // buffer that never JOINs — those fall through as a no-op, exactly as the
    // pre-registry code behaved.
    const { record } = ensureBufferOpen(userId, networkId, requested);
    send(ws, buildBufferBacklog(userId, networkId, record.target));
    send(ws, { kind: 'buffer-opened', networkId, target: record.target });
  }
}

// Per-user socket bookkeeping lives at module scope so the verb registry can
// reach into fanOut without importing the WSS instance. The state is still
// owned by attachWsHub at runtime (it's the only writer to socketsByUser via
// addSocket/removeSocket); the registry just reads through it.
const socketsByUser = new Map<number, Set<LurkerWebSocket>>();

function send(ws: LurkerWebSocket, payload: WsPayload): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function fanOut(userId: number, payload: WsPayload, opts: FanOutOpts = {}): void {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const json = JSON.stringify(payload);
  const eventId = typeof payload.id === 'number' ? payload.id : null;
  for (const ws of set) {
    if (opts.exceptWs && ws === opts.exceptWs) continue;
    if (ws.readyState === ws.OPEN) {
      ws.send(json);
      // Advance the per-socket cursor so a subsequent sendSnapshot ships
      // only the gap newer than what this socket has already received.
      if (eventId != null && eventId > (ws.sinceId || 0)) {
        ws.sinceId = eventId;
      }
    }
  }
}

// Public alias for verb handlers that produce a value via MCP but still want
// the user's open WS tabs to react (e.g. set_nick_note). Same signature as
// the private fanOut; named to make the cross-module call site read clearly.
export function fanOutToUser(userId: number, payload: WsPayload, opts: FanOutOpts = {}): void {
  fanOut(userId, payload, opts);
}

// Push the user's current ignore list for one scope to all their open tabs.
// networkId null targets the global bucket; a number targets that network's own
// rules. The client replaces the matching bucket and re-unions at match time.
export function fanOutIgnoreList(userId: number, networkId: number | null): void {
  fanOut(userId, {
    kind: 'ignore-list-updated',
    networkId,
    masks:
      networkId == null
        ? ircManager.listGlobalIgnoresFor(userId)
        : ircManager.listIgnoredFor(userId, networkId),
  });
}

// One sweep of the liveness heartbeat over a batch of sockets. A socket that
// hasn't ponged since the previous sweep (isAlive still false) is terminated —
// firing its 'close' handler → removeSocket → evaluatePresence, which lets
// auto-away schedule normally. A socket that did pong is re-armed (isAlive set
// false) and pinged again. The browser WebSocket API answers ping frames
// automatically, so no client code participates. Exported (and pure over its
// argument) so the terminate/ping decision is unit-testable without a live WSS.
export function sweepWsHeartbeat(sockets: Iterable<LurkerWebSocket>): number {
  let terminated = 0;
  for (const ws of sockets) {
    if (ws.isAlive === false) {
      ws.terminate();
      terminated += 1;
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      // A ping can throw if the socket is already tearing down; the isAlive
      // flag we just set means the next sweep terminates it regardless.
    }
  }
  return terminated;
}

// Read-only introspection of the live socket registry for the admin presence
// diagnostic. For each user with at least one open socket it reports how many
// sockets are open and how many currently claim presence.visible=true — the
// exact quantity auto-away keys on — alongside the persisted away row. Lets an
// operator watch a dead socket (e.g. a slept laptop) get reaped by the
// heartbeat and the user flip to away, confirming the fix on a live cell.
// Mutates nothing.
export interface PresenceDiagnosticRow {
  userId: number;
  openSockets: number;
  visibleSockets: number;
  away: {
    active: boolean;
    autoSet: boolean;
    since: string | null;
    message: string | null;
  } | null;
}

export function presenceDiagnostics(): PresenceDiagnosticRow[] {
  const rows: PresenceDiagnosticRow[] = [];
  for (const [userId, set] of socketsByUser) {
    let openSockets = 0;
    let visibleSockets = 0;
    for (const ws of set) {
      if (ws.readyState !== ws.OPEN) continue;
      openSockets += 1;
      if (ws.presence?.visible) visibleSockets += 1;
    }
    // A user key lingers while their set is non-empty, but every socket in it
    // can be mid-teardown (CLOSING/CLOSED) before the 'close' handler prunes it.
    // Skip those transient all-zero rows so the diagnostic only lists users with
    // a genuinely live socket — matching what this function claims to report.
    if (openSockets === 0) continue;
    const awayRow = getUserAwayState(userId);
    rows.push({
      userId,
      openSockets,
      visibleSockets,
      away: awayRow
        ? {
            active: !!(awayRow.away_datetime && !awayRow.back_datetime),
            autoSet: !!awayRow.auto_set,
            since: awayRow.away_datetime ?? null,
            message: awayRow.away_message ?? null,
          }
        : null,
    });
  }
  return rows;
}

function parseSinceParam(rawUrl: string): number {
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const raw = url.searchParams.get('since');
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

// Reset the channel-list cache the moment we send `/LIST`, rather than waiting
// for the server's RPL_LISTSTART (321). Many ircds omit 321 entirely, and
// irc-framework only emits 'channel list start' (the sole other caller of
// clearChannels) when it arrives. Without an unconditional reset here, a refresh
// upserts the fresh rows on top of the stale cache and never drops channels that
// have since disappeared — they reappear forever (issue #396). Mirrors The
// Lounge's inputs/list.ts, which empties chanCache when the user sends /list.
export function startChanlistRefresh(networkId: number): void {
  chanlistDb.clearChannels(networkId);
  chanlistDb.setMeta(networkId, { inProgress: true, totalCount: 0, fetchedAt: null });
}

// Authenticate a `/ws` upgrade. Two accepted credentials, in order:
//
//   1. the signed `lurker_session` cookie — every browser client, unchanged;
//   2. `Authorization: Bearer <session token>` — native clients, which unlike
//      browsers can set arbitrary headers on the upgrade request.
//
// Both resolve to the same `sessions` row, so everything downstream of the
// upgrade (and every WS verb) is identical regardless of how the client
// authenticated. Lives at module scope rather than inside attachWsHub so it is
// reachable from tests without standing up a real WebSocket server.
export function authenticateUpgrade(req: IncomingMessage, sessionSecret: string): User | null {
  const header = req.headers.cookie;
  if (header) {
    const cookies = cookie.parse(header);
    const raw = cookies[SESSION_COOKIE];
    if (raw) {
      const token = raw.startsWith('s:') ? cookieParser.signedCookie(raw, sessionSecret) : false;
      if (token) {
        const session = findSession(token);
        // A present-but-dead cookie falls through to the bearer check rather
        // than short-circuiting to 401 — a native client sends no cookie at
        // all, so in practice only one credential is ever on the request.
        if (session) {
          const user = findUserById(session.user_id);
          if (user) return user;
        }
      }
    }
  }
  return loadBearerSession(req.headers.authorization)?.user ?? null;
}

export function attachWsHub(httpServer: HttpServer, sessionSecret: string) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_MESSAGE_BYTES });
  // Per-user pending auto-away timers. Set when a user goes from 1→0 sockets;
  // cleared on 0→1 or when the timer fires.
  const autoAwayTimers = new Map();
  // In-flight /LIST refreshes, keyed by network_id. We belt-and-suspender the
  // chanlist_meta.in_progress column with this in-memory set so a duplicate
  // `list-channels` from a second tab is rejected without first reading the
  // DB, and so a crash mid-/LIST self-clears on next process boot (the set
  // resets but the meta row can be cleaned by the next start handler).
  const chanlistInFlight = new Set();

  // Liveness heartbeat. Every interval, ping each open socket and reap any that
  // failed to pong since the previous sweep. This is the only thing that
  // detects a peer that vanished without a TCP close (slept laptop, dropped
  // mobile link) — and reaping such a socket is what finally lets auto-away
  // fire for a user who's actually gone. unref() so it never holds the process
  // open; matches the purgeExpiredSessions timer in server.ts.
  const HEARTBEAT_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const set of socketsByUser.values()) sweepWsHeartbeat(set);
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));

  function clearAutoAwayTimer(userId: number): void {
    const t = autoAwayTimers.get(userId);
    if (t) {
      clearTimeout(t);
      autoAwayTimers.delete(userId);
    }
  }

  function scheduleAutoAway(userId: number): void {
    if (autoAwayTimers.has(userId)) return;
    const enabled = !!effectiveSetting(userId, 'away.auto.enabled');
    if (!enabled) return;
    const rawDelay = Number(effectiveSetting(userId, 'away.auto.delay_seconds'));
    const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 30;
    // The user went idle the moment we scheduled this timer, not when it fires
    // `delaySec` later — backdate the away "since" to now so it reflects when
    // they actually stepped away (#155).
    const afkSince = new Date();
    const t = setTimeout(() => {
      autoAwayTimers.delete(userId);
      // Re-check: a client may have become visible during the delay.
      // "Visible" rather than "connected" so a backgrounded tab — which the
      // push pipeline already treats as absent — counts as absent here too.
      if (userHasVisibleClient(userId)) return;
      const message = buildAutoAwayMessage(userId, afkSince);
      ircManager.setAwayAll(userId, message, { autoSet: true, since: afkSince });
    }, delaySec * 1000);
    t.unref?.();
    autoAwayTimers.set(userId, t);
  }

  function addSocket(userId: number, ws: LurkerWebSocket): void {
    let set = socketsByUser.get(userId);
    if (!set) {
      set = new Set();
      socketsByUser.set(userId, set);
    }
    set.add(ws);
    // Intentionally no auto-away clear here. New sockets start at
    // presence.visible=false; the client confirms visibility moments later
    // and that flips state through evaluatePresence(). Clearing on raw
    // connect would falsely "bring the user back" when a backgrounded
    // service worker reconnects.
  }

  function removeSocket(userId: number, ws: LurkerWebSocket): void {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) socketsByUser.delete(userId);
    evaluatePresence(userId);
  }

  function userHasVisibleClient(userId: number): boolean {
    const set = socketsByUser.get(userId);
    if (!set) return false;
    for (const ws of set) {
      if (ws.readyState === ws.OPEN && ws.presence?.visible) return true;
    }
    return false;
  }

  // Single source of truth for "is the user present?" — shared by auto-away
  // and push so an idle/backgrounded tab can't keep one system thinking the
  // user is here while the other treats them as gone.
  function evaluatePresence(userId: number): void {
    if (userHasVisibleClient(userId)) {
      clearAutoAwayTimer(userId);
      ircManager.clearAwayAll(userId, { autoSet: true });
    } else {
      scheduleAutoAway(userId);
    }
  }

  // Single path for "tell every tab of this user what the buffer's unread
  // counts are now." Used by mark-read echo and by the live IRC-event fan-out
  // below — the client doesn't increment locally anymore, so this is the
  // only source of badge state.
  function broadcastReadState(
    userId: number,
    networkId: number | null,
    target: string,
    lastReadId: number,
  ): void {
    const counts = computeUnreadFor(userId, networkId, target, lastReadId);
    fanOut(userId, {
      kind: 'read-state',
      networkId,
      target,
      lastReadId: counts.lastReadId,
      unread: counts.unread,
      highlights: counts.highlights,
      highlightsCapped: counts.highlightsCapped,
    });
  }

  // Push-suppression gates shared by message and presence pushes: a manual
  // /away (when mute_when_away is on — auto-away is the case push matters most,
  // so it's not gated) and the user's configured quiet-hours window.
  function pushQuietOrAway(userId: number): boolean {
    if (effectiveSetting(userId, 'notifications.push.mute_when_away')) {
      const away = getUserAwayState(userId);
      if (away?.away_datetime && !away?.back_datetime && !away?.auto_set) return true;
    }
    if (effectiveSetting(userId, 'notifications.push.quiet_hours.enabled')) {
      const startMin = parseHHMM(effectiveSetting(userId, 'notifications.push.quiet_hours.start'));
      const endMin = parseHHMM(effectiveSetting(userId, 'notifications.push.quiet_hours.end'));
      if (startMin != null && endMin != null) {
        const tz = effectiveSetting(userId, 'system.timezone');
        const currentMin = currentMinutesInZone(new Date(), tz);
        if (isInQuietWindow(currentMin, startMin, endMin)) return true;
      }
    }
    return false;
  }

  // The user's ignore verdict for an event, off the cached compiled rule set (no
  // DB scan per event). senderHidden reads .hide for the render/reopen path;
  // maybePush additionally honors .nonotify (issue #359 — a NONOTIFY mute rule
  // freezes push without hiding the message).
  function ignoreVerdictFor(userId: number, decorated: DecoratedEvent): IgnoreVerdict {
    const compiled = ignoreRulesService.getCompiled(userId, decorated.networkId);
    if (!compiled.length) return { hide: false, nohilight: false, nonotify: false };
    // Evaluate even for a nick-less event: a scope mute (mask null — a muted
    // channel/network) must still veto its notification, so a nick-less line
    // (e.g. a server notice in a notify_always channel) doesn't slip past. A
    // sender-specific rule simply won't match a null nick.
    return evaluateIgnores(compiled, {
      nick: decorated.nick ?? null,
      userhost: decorated.userhost ?? null,
      target: decorated.target,
      text: decorated.text ?? '',
      type: decorated.type,
      isDm: !!decorated.dm,
    });
  }

  // True when the user's ignore rules would hide this event (a hide-level match,
  // not a modifier-only one). Shared by the push gate and the closed-DM reopen
  // guard.
  function senderHidden(userId: number, decorated: DecoratedEvent): boolean {
    return ignoreVerdictFor(userId, decorated).hide;
  }

  function maybePush(userId: number, decorated: DecoratedEvent): void {
    if (!decorated || !decorated.notify) return;
    if (decorated.self) return;
    if (userHasVisibleClient(userId)) return;
    // No push device subscribed → nothing to deliver, and no reason to compute
    // the badge total below (it's an O(buffers) scan). deliver() would no-op on
    // an empty subscription set anyway — bail before the work (#451 review).
    if (!pushService.hasSubscriptions(userId)) return;
    // Suppress push for events the user's ignore rules would hide OR mute
    // (NONOTIFY, e.g. a muted channel/network — issue #359). This is the one
    // piece of the ignore/mute feature that has to live server-side: push fires
    // while no client is open, so a client-side filter can't intercept. The
    // unread badge and render filter stay reactive client-side, so /unignore
    // still reveals; only push delivery is frozen here. A NOHIGHLIGHT rule does
    // NOT freeze push — the message is still visible, it just doesn't highlight.
    const pushVerdict = ignoreVerdictFor(userId, decorated);
    if (pushVerdict.hide || pushVerdict.nonotify) return;
    // Signal kind in priority order: DM beats matched beats always_notify.
    // The `kind` doubles as the settings-key namespace, so picking a single
    // priority winner here means a DM that also matched a rule still
    // delivers as one notification, gated by the DM master toggle.
    const kindKey = decorated.dm ? 'dm' : decorated.matched ? 'highlight' : 'always_notify';
    if (!effectiveSetting(userId, `notifications.${kindKey}.enabled`)) return;
    if (pushQuietOrAway(userId)) return;
    const network = ircManager.getConnection(userId, decorated.networkId)?.network;
    pushService
      .deliver(userId, {
        kind: kindKey,
        networkId: decorated.networkId,
        networkName: network?.name || `net:${decorated.networkId}`,
        target: decorated.target,
        nick: decorated.nick,
        text: decorated.text,
        time: decorated.time,
        messageId: decorated.id,
        // Current unread-highlight total so the SW can set the app-icon badge
        // (#451). The triggering message is already persisted at this point, so
        // the count includes it.
        badge: computeTotalHighlights(userId),
      })
      .catch((err) => console.warn('[push] deliver failed:', err?.message || err));
  }

  // Came-online push: fired from a peer-presence offline→online transition for
  // a friend the user flagged "notify when online", when no client is visible
  // (the in-app toast owns the visible case). The same enabled/quiet/away gates
  // as message pushes apply, keyed off the friend_online settings namespace.
  function maybePushFriendOnline(
    userId: number,
    networkId: number,
    nick: string | null | undefined,
  ): void {
    if (!nick) return;
    if (userHasVisibleClient(userId)) return;
    if (!effectiveSetting(userId, 'notifications.friend_online.enabled')) return;
    const contact = findNotifyContactForTarget(userId, networkId, nick);
    if (!contact) return;
    if (pushQuietOrAway(userId)) return;
    const network = ircManager.getConnection(userId, networkId)?.network;
    pushService
      .deliver(userId, {
        kind: 'friend_online',
        networkId,
        networkName: network?.name || `net:${networkId}`,
        // target is the friend's nick so a notification tap opens their DM.
        target: nick,
        displayName: contact.displayName,
        // No `badge` here on purpose (#451 review): a friend coming online isn't
        // a highlight, so the total can't have changed since the last message
        // push set it. The SW no-ops when data.badge is absent, so omitting it
        // avoids an O(buffers) scan that would only re-stamp the same number.
      })
      .catch((err) => console.warn('[push] friend-online deliver failed:', err?.message || err));
  }

  ircManager.on('event', (rawEvent) => {
    // EnrichedEvent (from ircConnection) is a strict superset of MessageEvent.
    const event = rawEvent as MessageEvent & { userId: number; state?: string };
    const eventUserId = event.userId;
    // DCC transfer updates (#270 phase 2) are user-scoped, not buffer messages —
    // fan them out as their own frame, skipping message decoration/buffer logic.
    if ((event as { type?: string }).type === 'dcc-transfer') {
      fanOut(eventUserId, {
        kind: 'dcc-transfer',
        transfer: (event as unknown as { transfer: unknown }).transfer,
      });
      return;
    }
    const decorated = decorateMessage(eventUserId, event);
    const target = decorated.target;
    if (target && decorated.networkId != null && !target.startsWith(':server:')) {
      const state = getBufferState(eventUserId, decorated.networkId, target);
      if (state === 'closed') {
        // See reopensClosedBuffer for which events outrank a closed flag; anything
        // else is dropped on the floor rather than resurrecting the buffer.
        const selfJoin = decorated.type === 'channel-joined';
        const reopens = reopensClosedBuffer(decorated.type, decorated.id);
        // Ignored senders cannot resurrect a closed DM either. Otherwise an
        // ignored user can force the buffer back into the sidebar simply by
        // sending — a soft harassment vector the client-side render filter
        // doesn't close, since the reopen happens server-side. A self-join has no
        // sender to ignore — it's our own action — so it skips this gate.
        const senderIgnored = reopens && !selfJoin && senderHidden(eventUserId, decorated);
        if (!reopens || senderIgnored) return;
        reopenBufferRow(eventUserId, decorated.networkId, target);
        fanOut(eventUserId, {
          kind: 'buffer-reopened',
          networkId: decorated.networkId,
          target,
        });
      } else if (state === undefined && decorated.id != null) {
        // A persisted event for a target with no registry row mints one — this
        // replaces the old derived-existence-from-messages. Covers first-contact
        // DMs (message OR notice: a NOTICE may create a buffer, #439, it just
        // can't reopen a closed one — that's the branch above) and any stray
        // persisted channel traffic. The event itself flows on unchanged; the
        // client materializes the buffer from it exactly as it always has.
        ensureBufferExists(eventUserId, decorated.networkId, target);
      }
    }
    fanOut(eventUserId, { ...decorated, kind: 'irc' });
    maybePush(eventUserId, decorated);
    // A friend coming online is a presence transition, not a message, so it
    // bypasses maybePush (no `notify`); push it on its own path.
    if (event.type === 'peer-presence' && (event as { cameOnline?: boolean }).cameOnline) {
      maybePushFriendOnline(eventUserId, event.networkId, event.nick);
    }

    // Countable persisted events change the buffer's unread/highlight counts
    // for this user. Broadcast the recomputed read-state so every tab —
    // including inactive ones — reflects the new badge without the client
    // having to mirror the server's counting logic. The `:server:` buffer also
    // counts 'error' lines (a disconnect/quit echo, a kill/ban); without matching
    // that here the badge wouldn't refresh until the NEXT countable event landed
    // (e.g. a reconnect's "Connecting…" notice) — the delayed-badge bug (#470).
    if (
      decorated.id != null &&
      decorated.target &&
      typeCountsForUnread(decorated.target, decorated.type)
    ) {
      const lastReadId = getReadState(eventUserId, decorated.networkId, decorated.target);
      broadcastReadState(eventUserId, decorated.networkId, decorated.target, lastReadId);
    }

    if (event.type === 'chanlist-end' && event.networkId) {
      chanlistInFlight.delete(event.networkId);
    }
    // A disconnect mid-/LIST means RPL_LISTEND will never arrive — release
    // the in-flight guard and reconcile the meta row so the next attempt
    // (after reconnect) isn't blocked by stale state.
    if (event.type === 'state' && event.state === 'disconnected' && event.networkId) {
      if (chanlistInFlight.delete(event.networkId)) {
        try {
          chanlistDb.setMeta(event.networkId, { inProgress: false });
        } catch (_) {
          /* ignore */
        }
      }
    }

    // After an IRC (re)connect, only auto-rejoined channels fire JOIN events,
    // so any buffer the user had parted (or any buffer that simply pre-dates
    // the live session) wouldn't otherwise reappear in the client's buffer
    // list until a page refresh. Re-emit a fresh snapshot to every active
    // socket so the buffer list always reflects the server's source of truth.
    //
    // Pass freshNetworkId so the just-connected network's buffers ship as lazy
    // SHELLS (they hydrate on open). ws.sinceId has been advanced by live events
    // on OTHER networks, so a cursor read against this network's persisted
    // history (all id <= sinceId) would return zero events and leave the user
    // staring at an empty buffer until a page refresh; a shell reappears in the
    // list and fetches its content on demand instead. (Note: a channel's shell
    // `joined` is read at this 'connected' instant, before auto-rejoin JOINs
    // land, so it may briefly render dimmed until its JOIN event arrives.)
    if (event.type === 'state' && event.state === 'connected') {
      const set = socketsByUser.get(event.userId);
      if (set) {
        for (const ws of set) {
          if (ws.readyState === ws.OPEN) sendSnapshot(ws, event.userId, event.networkId);
        }
      }
    }
  });

  settingsService.on('event', ({ userId, changes }) => {
    fanOut(userId, { kind: 'settings', changes: changes || {} });
    // If the user toggled / shortened auto-away while disconnected, re-evaluate
    // the pending timer with the new value.
    const touchedAway =
      changes && ('away.auto.enabled' in changes || 'away.auto.delay_seconds' in changes);
    if (touchedAway && (socketsByUser.get(userId)?.size || 0) === 0) {
      clearAutoAwayTimer(userId);
      scheduleAutoAway(userId);
    }
  });

  highlightRulesService.on('change', ({ userId }) => {
    fanOut(userId, { kind: 'highlight-rules-changed' });
  });

  // System-console fan-out. User-scoped lines reach just that user's tabs;
  // global lines (server startup, etc.) reach every connected user — they
  // describe shared infrastructure, not per-user state.
  systemLog.on('line', (rawLine) => {
    const line = rawLine as LogLine;
    // Global lines reach every connected user; per-user lines just that user.
    const recipients = line.userId == null ? [...socketsByUser.keys()] : [line.userId];
    const notable = systemLineNotifies(line);
    const event = systemLineToEvent(line);
    for (const userId of recipients) {
      fanOut(userId, { kind: 'irc', ...event });
      // Notable lines (admin/error) bump the system buffer's unread, so refresh
      // its badge live. Routine lifecycle lines skip this — they don't count
      // toward unread, so re-broadcasting would just be a no-op frame.
      if (notable) {
        broadcastReadState(userId, null, SYSTEM_TARGET, getReadState(userId, null, SYSTEM_TARGET));
      }
    }
  });

  // Drafts fan out to every tab of the same user. `originWs` is the socket
  // that triggered the change (if any) and gets excluded so the originator
  // doesn't clobber its own optimistic state with a stale echo. HTTP-driven
  // writes (sendBeacon on tab close) pass null and reach every tab.
  draftsService.on('change', ({ userId, networkId, target, body, originWs }) => {
    fanOut(
      userId,
      { kind: 'draft-updated', networkId, target, body },
      originWs ? { exceptWs: originWs } : undefined,
    );
  });

  // When a user is deleted, their WS connections are still authenticated
  // against a session that just got cascade-deleted. Stale handlers would
  // write to per-user tables (buffer_reads, user_settings, …) that no
  // longer have a parent row, hitting FK violations. Close the sockets
  // here so any in-flight message handlers stop firing.
  ircManager.on('user-disposed', ({ userId }) => {
    const set = socketsByUser.get(userId);
    if (set) {
      for (const ws of set) {
        try {
          ws.close(1000, 'user removed');
        } catch (_) {
          /* ignore */
        }
      }
      socketsByUser.delete(userId);
    }
    clearAutoAwayTimer(userId);
    systemLog.dropUser(userId);
  });

  // Pause: the user keeps their session and sockets — unlike a delete. Flip
  // every open tab to read-only in place and drop the pending auto-away timer.
  // The IrcConnections were already torn down by ircManager.suspendUser; here
  // we only react on the socket layer.
  ircManager.on('user-suspended', ({ userId }) => {
    const set = socketsByUser.get(userId);
    if (set) {
      for (const ws of set) ws.accountPaused = true;
    }
    clearAutoAwayTimer(userId);
    fanOut(userId, { kind: 'account-state', paused: true });
  });

  // Resume: clear the read-only flag on open tabs and drop the banner.
  // ircManager.resumeUser has already re-established autoconnect networks, whose
  // connection lifecycle events fan out through the normal snapshot/event path.
  ircManager.on('user-resumed', ({ userId }) => {
    const set = socketsByUser.get(userId);
    if (set) {
      for (const ws of set) ws.accountPaused = false;
    }
    fanOut(userId, { kind: 'account-state', paused: false });
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url || !req.url.startsWith('/ws')) return;
    // #574: reject a cross-site browser upgrade before we touch auth or the DB.
    // Native clients send no Origin and pass; same-origin/allowlisted pass.
    if (!isAllowedUpgradeOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // #569: a client too old for this server is told to update (426) rather than
    // handed a snapshot it would mis-render. A client that announces no version
    // (?v absent) is treated as current — the web client ships in lockstep and
    // any native build predating the handshake speaks today's protocol.
    const clientVersion = parseProtocolParam(req.url);
    if (clientVersion !== null && clientVersion < MIN_PROTOCOL_VERSION) {
      socket.write('HTTP/1.1 426 Upgrade Required\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = authenticateUpgrade(req, sessionSecret);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // `?since=N` cursors the initial backlog: a reconnecting client passes the
    // highest event id it has, and the server ships only events newer than that
    // for each buffer. The first connect omits it (or sends 0), getting the
    // current "last 50 per buffer" behavior. Hostname is irrelevant — URL
    // wants a base for relative parsing.
    const initialSinceId = parseSinceParam(req.url);
    touchUserLastSeen(user.id);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const lurkerWs = ws as LurkerWebSocket;
      lurkerWs.userId = user.id;
      lurkerWs.sinceId = initialSinceId;
      lurkerWs.protocolVersion = clientVersion ?? PROTOCOL_VERSION;
      lurkerWs.presence = { visible: false };
      lurkerWs.isAlive = true;
      lurkerWs.accountPaused = user.is_paused === 1;
      addSocket(user.id, lurkerWs);
      onConnection(lurkerWs, user);
    });
  });

  function onConnection(ws: LurkerWebSocket, user: User): void {
    sendSnapshot(ws, user.id);

    ws.on('message', (raw) => {
      // #574: per-socket flood control, checked before JSON.parse so a flood
      // pays no parse cost. Exhausting the bucket closes the socket (1008 policy
      // violation) rather than dropping silently — a client at this rate is
      // misbehaving, and closing makes it stop.
      if (!allowInboundMessage(ws)) {
        console.warn(`[wsHub] user ${user.id} exceeded WS message rate; closing socket`);
        try {
          send(ws, { kind: 'error', text: 'message rate exceeded' });
        } catch (_err) {
          /* socket may already be unwritable */
        }
        ws.close(1008, 'message rate exceeded');
        return;
      }
      let msg: WsPayload;
      try {
        msg = JSON.parse(raw.toString()) as WsPayload;
      } catch (_err) {
        send(ws, { kind: 'error', text: 'invalid json' });
        return;
      }
      handleClientMessage(ws, user, msg);
    });

    // The browser auto-answers ping frames; this just records that the answer
    // arrived so the next heartbeat sweep spares the socket.
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => removeSocket(user.id, ws));
    ws.on('error', () => removeSocket(user.id, ws));
  }

  // Wrapper around the (synchronous) snapshot builder. Two jobs: (1) time it,
  // so a stall serving one connect is visible; (2) contain any throw so a bad
  // snapshot for ONE client can't take down the process and drop every user's
  // IRC. There is no global unhandledRejection guard, so this is the backstop.
  function sendSnapshot(
    ws: LurkerWebSocket,
    userId: number,
    freshNetworkId: number | null = null,
  ): void {
    const startedAt = Date.now();
    let b: SnapshotBreakdown = {
      bufferCount: 0,
      fresh: false,
      networksMs: 0,
      seedsMs: 0,
      onlineMs: 0,
      offlineMs: 0,
      unreadMs: 0,
      sliceMs: 0,
    };
    let ok = false;
    try {
      b = sendSnapshotInner(ws, userId, freshNetworkId);
      ok = true;
    } catch (err) {
      console.error(
        `[wsHub] snapshot for user ${userId} failed after ${Date.now() - startedAt}ms ` +
          `(IRC left intact):`,
        err,
      );
    }
    const ms = Date.now() - startedAt;
    // Only attribute phases on success — a throw leaves the breakdown at its
    // zero defaults, which would mislead exactly when the log is meant to help.
    if (ok && ms >= SNAPSHOT_SLOW_MS) {
      console.warn(
        `[wsHub] snapshot for user ${userId} took ${ms}ms across ${b.bufferCount} buffers ` +
          `(${b.fresh ? 'fresh/shells' : 'resume'}) — networks=${b.networksMs}ms seeds=${b.seedsMs}ms ` +
          `online=${b.onlineMs}ms offline=${b.offlineMs}ms [online split: unread=${b.unreadMs}ms ` +
          `slice=${b.sliceMs}ms rest=${Math.max(0, b.onlineMs - b.unreadMs - b.sliceMs)}ms]. ` +
          `Runs synchronously on the event loop; on slow storage or a large account this can starve ` +
          `IRC socket I/O and trip ping timeouts (see [event-loop] logs). networks=member-list blob; ` +
          `unread≈computeUnreadFor(+frame assembly), slice=buildResumeSlice reads, ` +
          `rest=sends/input-history/overhead.`,
      );
    }
  }

  function sendSnapshotInner(
    ws: LurkerWebSocket,
    userId: number,
    freshNetworkId: number | null = null,
  ): SnapshotBreakdown {
    const tNetworks = Date.now();
    const networks = ircManager.snapshotForUser(userId);
    const networksMs = Date.now() - tNetworks;
    const tSeeds = Date.now();
    // A fresh connect (no resume cursor yet) means an empty client with no
    // active buffer — Lurker auto-focuses nothing on load. So we ship channel/DM
    // buffers as lazy shells (no backlog) below. `cursor` hands the client the
    // current global max id as its "caught up to now" mark, so its very next
    // reconnect's ?since only pulls genuinely-new events instead of re-gap-
    // filling everything it was never sent. Resume connects (sinceId>0) keep the
    // full gap-fill path untouched.
    const isFreshConnect = (ws.sinceId || 0) === 0;
    const cursor = isFreshConnect ? maxMessageId() : 0;
    // Global ignore rules (network_id NULL) aren't tied to any one network blob,
    // so they ride alongside the per-network snapshot as their own field (#350).
    send(ws, {
      kind: 'snapshot',
      // #569: the server's protocol version rides the snapshot so a client that
      // connected without pre-checking GET /api/config still learns what the
      // server speaks and can degrade knowingly.
      protocolVersion: PROTOCOL_VERSION,
      networks,
      globalIgnores: ircManager.listGlobalIgnoresFor(userId),
      ...(isFreshConnect ? { cursor } : {}),
    });
    // Drafts ship once per snapshot, separate from per-buffer backlog frames —
    // the keying is global to the user, not per-buffer, so a single message is
    // cheaper than fanning a body field into every backlog row.
    send(ws, { kind: 'draft-snapshot', drafts: draftsService.snapshotForUser(userId) });
    // Lightweight id-only seed for the bookmarks store. Per-row payloads are
    // lazy-loaded by the BookmarksModal via REST when the user opens it; this
    // snapshot exists solely so the message context menu can flip its label
    // ("Save" ↔ "Remove bookmark") without a network round-trip.
    send(ws, { kind: 'bookmark-ids-snapshot', ids: listBookmarkIdsForUser(userId) });
    // System buffer seed: the app-scoped system log rides the same 'backlog'
    // frame network buffers use (events + read-state + hasMoreOlder), so the
    // client treats it like any other buffer — no bespoke system-log path (#355).
    // Always the latest slice (the system id space is independent of the
    // `?since` cursor); the client dedupes/gap-fills by id, so a re-snapshot on
    // resync is safe. See buildSystemBacklog.
    send(ws, buildSystemBacklog(userId));
    // Friends/contacts seed: the user's full contact list (display name, notify
    // flag, per-network watch targets). User-level, so one message rather than a
    // per-network field. Drives the FRIENDS overview/sidebar + the came-online
    // toast gate.
    send(ws, { kind: 'contacts-snapshot', contacts: ircManager.listContacts(userId) });
    const readState = listReadStateForUser(userId);
    const clearedState = listClearedStateForUser(userId);
    // Walk the shared enumerator ONCE per snapshot and reuse it for both the live
    // loop and the offline backlog. Each walk runs one listBuffersForUser query
    // plus listNetworksForUser (SELECT * + decryptRow), so materializing here —
    // rather than iterating the generator separately in the live loop and again
    // in buildOfflineBacklogFrames — keeps those reads at 1× on this
    // ping-timeout-sensitive path (#454/#460). The array holds buffer references
    // (incl. live conns), which stay valid for the rest of this synchronous
    // snapshot. The system buffer / :server: / closed-joined precedence rules
    // all live in the enumerator. Counted in seedsMs (it's a bulk pre-loop read
    // like readState/clearedState), so onlineMs/offlineMs stay pure per-buffer
    // frame-build time.
    const allTargets = [...eachUserBufferTarget(userId)];
    const seedsMs = Date.now() - tSeeds;
    const tOnline = Date.now();
    let maxSentId = ws.sinceId || 0;
    let bufferCount = 0;
    let unreadMs = 0;
    let sliceMs = 0;
    // Live loop: the enumerator yields the system buffer and offline networks too —
    // skip both here. The system buffer ships via its own frame above, and offline
    // networks are handled by buildOfflineBacklogFrames below (same materialized set).
    for (const { networkId: nid, target, conn } of allTargets) {
      if (nid == null || !conn) continue;
      // Fresh-network branch: this connection just came online, so the client
      // has never received a backlog frame for any of its buffers this
      // session. ws.sinceId has been advanced by live events on other
      // networks, so a cursor read would return nothing — ship the full
      // recent slice instead.
      const isFreshNetwork = freshNetworkId != null && conn.network.id === freshNetworkId;
      // Fresh connect (empty client, nothing focused) or a just-connected
      // network: ship a lazy SHELL for channel/DM buffers instead of reading
      // their backlog. Lurker auto-focuses nothing on load, so no messages are
      // needed up front — the client hydrates whatever the user actually opens
      // (activate() → reattachToLive). The :server: pseudo-buffer stays real
      // (one cheap read per network; it holds connection notices worth seeing
      // without a click). isFreshNetwork routes here too: its buffers' history
      // all predates the advanced cursor, so a gap read would be empty — a
      // shell is both correct and cheaper than the old forced-latest slice.
      // Read/cleared state comes from the bulk maps this loop already built
      // (listReadStateForUser/listClearedStateForUser) — thread them through so
      // neither the shell nor the resume frame re-issues a per-buffer point
      // query (the O(buffers) synchronous work the shell optimization exists to
      // cut).
      const key = `${conn.network.id}::${target}`;
      const precomputed = {
        lastReadId: readState[key] || 0,
        cleared: clearedState[key] ?? { clearedBeforeId: 0, clearedAt: null },
      };
      if ((isFreshConnect || isFreshNetwork) && !target.startsWith(':server:')) {
        // Shell path: the only per-buffer work is buildBufferShell's unread
        // count (bufferStateFields → computeUnreadFor), so it goes to unreadMs.
        const tShell = Date.now();
        const shell = buildBufferShell(
          userId,
          conn.network.id,
          target,
          channelJoined(target, conn),
          precomputed,
        );
        unreadMs += Date.now() - tShell;
        send(ws, shell);
        bufferCount += 1;
        continue;
      }
      // Resume cursor: ship the gap the client missed (id > sinceId), or a
      // fresh latest slice + reset flag when that gap exceeds the cap (see
      // buildResumeSlice for the gap/reset rationale).
      const tSlice = Date.now();
      const slice = buildResumeSlice(userId, conn.network.id, target, ws.sinceId || 0);
      sliceMs += Date.now() - tSlice;
      const events = slice.events;
      for (const e of events) {
        if (e.id != null && e.id > maxSentId) maxSentId = e.id;
      }
      // Per-buffer input history for up-arrow recall — a recent slice
      // (INPUT_HISTORY_SLICE); older entries stay in the DB (no pagination
      // request exists, so this slice is the recall depth). The 'history' latest
      // reply re-seeds it when a shell is opened.
      const inputHistory = listRecentInputHistory(
        userId,
        conn.network.id,
        target,
        INPUT_HISTORY_SLICE,
      );
      // Speakers are deliberately NOT shipped on connect. The sidebar doesn't
      // use them, and computing them per buffer here (listSpeakers scanning
      // history × every buffer) was the snapshot's dominant cost once the other
      // scans were fixed. Nick autocomplete seeds them when you actually OPEN a
      // buffer (the 'history' latest reply carries them — see applyLatestReplace)
      // and live via recordSpeaker; omitting the key here leaves the client's
      // existing map untouched.
      const tUnread = Date.now();
      const stateFields = bufferStateFields(userId, conn.network.id, target, precomputed);
      unreadMs += Date.now() - tUnread;
      send(ws, {
        kind: 'backlog',
        networkId: conn.network.id,
        target,
        events,
        // reset=true means the resume gap overflowed the cap and `events` is
        // a fresh latest slice — the client must replace its buffer, not
        // append, or it splices a permanent hole (issue #205).
        reset: slice.reset,
        hasMoreOlder: slice.hasMoreOlder,
        joined: channelJoined(target, conn),
        ...stateFields,
        inputHistory,
      });
      bufferCount += 1;
    }
    const onlineMs = Date.now() - tOnline;
    const tOffline = Date.now();
    // Offline networks (no live connection) ship their buffers as lightweight
    // SHELLS (buffer row + unread/read state, no message rows) rather than the
    // full recent slice. The client hydrates a shell's history on first open via
    // reattachToLive (buffers.ts activate() → 'history' mode:'latest'), the same
    // lazy path brand-new buffers already use. This keeps the connect snapshot
    // from reading recent backlog for every historical/offline buffer — the bulk
    // of the synchronous read burst on a long-lived account. Reuses the enumeration
    // materialized above so this doesn't re-run the per-network DB reads.
    for (const frame of buildOfflineBacklogFrames(userId, allTargets)) {
      for (const e of frame.events as Array<{ id?: number | null }>) {
        if (e.id != null && e.id > maxSentId) maxSentId = e.id;
      }
      send(ws, frame);
      bufferCount += 1;
    }
    const offlineMs = Date.now() - tOffline;
    // Advance the resume cursor past everything we just shipped, so the next
    // sendSnapshot (in-band 'snapshot' request, or another IRC-state trigger)
    // resumes from where this snapshot left off. On a fresh (shell) connect we
    // shipped almost no message rows, so pin the cursor to the global max we
    // handed the client — otherwise a later re-snapshot on this socket would
    // re-gap-fill everything the shells deliberately skipped.
    ws.sinceId = Math.max(maxSentId, cursor);
    return {
      bufferCount,
      fresh: isFreshConnect,
      networksMs,
      seedsMs,
      onlineMs,
      offlineMs,
      unreadMs,
      sliceMs,
    };
  }

  function handleClientMessage(ws: LurkerWebSocket, user: User, msg: WsPayload): void {
    const userId = user.id;
    // Any message that carries a networkId must reference a network the caller
    // owns. Handlers below trust msg.networkId, so the check belongs here at
    // the boundary rather than at each call site. Messages without a
    // networkId (presence, snapshot, away, back) fall through.
    if (msg && msg.networkId !== undefined && msg.networkId !== null) {
      const networkId = Number(msg.networkId);
      if (!Number.isInteger(networkId) || !ownsNetwork(userId, networkId)) {
        send(ws, { kind: 'error', text: 'unknown network' });
        // Surface the failure on the originating send/action/notice so the
        // client can stop pretending the message succeeded.
        if (
          msg.clientId &&
          (msg.type === 'send' || msg.type === 'action' || msg.type === 'notice')
        ) {
          send(ws, {
            kind: 'send-result',
            clientId: msg.clientId,
            ok: false,
            error: 'unknown-network',
          });
        }
        return;
      }
      msg.networkId = networkId;
    }
    // Read-only guard for paused accounts. Reject anything that would touch IRC;
    // reads and local view state fall through to the switch. Resolve the
    // optimistic bubble on send/action so the originating tab stops showing it
    // as pending instead of hanging forever.
    if (ws.accountPaused && PAUSED_BLOCKED_TYPES.has(msg.type as string)) {
      send(ws, { kind: 'error', text: 'account paused' });
      if (msg.clientId && (msg.type === 'send' || msg.type === 'action' || msg.type === 'notice')) {
        send(ws, {
          kind: 'send-result',
          clientId: msg.clientId,
          ok: false,
          error: 'account-paused',
        });
      }
      return;
    }
    switch (msg.type) {
      case 'presence': {
        const next = !!msg.visible;
        const prev = ws.presence?.visible === true;
        ws.presence = { visible: next };
        if (next !== prev) evaluatePresence(userId);
        break;
      }
      case 'send':
      case 'action': {
        // Both share the same shape and the same WS-only echo on clientId.
        // The verb returns { ok, error? }; we translate to send-result on
        // behalf of the originating tab so its optimistic bubble can resolve.
        const verbName = msg.type === 'send' ? 'send_message' : 'send_action';
        let result: { ok: boolean; error?: string };
        try {
          result = callVerb(
            verbName,
            { userId, scope: 'read-write', transport: 'ws' },
            {
              networkId: msg.networkId,
              target: msg.target,
              text: msg.text,
            },
          ) as { ok: boolean; error?: string };
        } catch (err) {
          result = { ok: false, error: (err as NodeJS.ErrnoException).code || 'error' };
        }
        if (msg.clientId) {
          send(ws, {
            kind: 'send-result',
            clientId: msg.clientId,
            ok: !!result.ok,
            error: result.ok ? undefined : result.error,
          });
        }
        break;
      }
      case 'notice': {
        // The verb sends the NOTICE and publishes a self-copy that fans out to
        // every tab, so there's no optimistic bubble — but we still resolve the
        // originating tab's ACK on clientId (like send/action) so a not-connected
        // or validation failure surfaces as a toast instead of the input just
        // clearing with nothing happening.
        let result: { ok: boolean; error?: string };
        try {
          result = callVerb(
            'send_notice',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              networkId: msg.networkId,
              target: msg.target,
              text: msg.text,
            },
          ) as { ok: boolean; error?: string };
        } catch (err) {
          result = { ok: false, error: (err as NodeJS.ErrnoException).code || 'error' };
        }
        if (msg.clientId) {
          send(ws, {
            kind: 'send-result',
            clientId: msg.clientId,
            ok: !!result.ok,
            error: result.ok ? undefined : result.error,
          });
        }
        break;
      }
      case 'e2e': {
        // RPE2E `/e2e …` command (#382). The connection runs the subcommand and
        // publishes its own ephemeral status to the issuing buffer; we only need
        // to tell the user when the network isn't connected (no connection = no
        // place for that status to come from).
        const target = typeof msg.target === 'string' ? msg.target : '';
        const args = typeof msg.args === 'string' ? msg.args : '';
        // The system buffer carries networkId null; Number(null) → 0 would miss
        // every connection and fan a frame out with networkId 0 that the client
        // can't route (the client already gates /e2e on an active network, so
        // this is defensive). Require a real network id (#382, review #7).
        const networkId = msg.networkId == null ? NaN : Number(msg.networkId);
        if (!Number.isFinite(networkId) || networkId <= 0) break;
        const ok = ircManager.e2eCommand(userId, networkId, target, args);
        if (!ok) {
          const evt = {
            type: 'e2e',
            level: 'warn',
            networkId,
            target,
            text: '/e2e: this network isn’t connected',
            time: new Date().toISOString(),
            self: false,
          } as unknown as MessageEvent;
          fanOut(userId, { ...decorateMessage(userId, evt), kind: 'irc' });
        }
        break;
      }
      case 'ctcp': {
        // Outbound CTCP request (/ctcp <nick> <type> [args], /ping <nick>, #263).
        // The cell frames + sends it, echoes locally, and routes the reply back
        // to `issuingTarget`. Like /e2e it needs a live connection, so on a
        // disconnected network we surface that to the issuing buffer.
        const networkId = msg.networkId == null ? NaN : Number(msg.networkId);
        const ctcpTarget = typeof msg.target === 'string' ? msg.target.trim() : '';
        const ctcpType = typeof msg.ctcpType === 'string' ? msg.ctcpType.trim() : '';
        const ctcpArgs = typeof msg.args === 'string' ? msg.args : '';
        const issuingTarget = typeof msg.issuingTarget === 'string' ? msg.issuingTarget : '';
        if (!Number.isFinite(networkId) || networkId <= 0 || !ctcpTarget || !ctcpType) break;
        const ok = ircManager.ctcpRequest(
          userId,
          networkId,
          issuingTarget,
          ctcpTarget,
          ctcpType,
          ctcpArgs,
        );
        if (!ok) {
          // Name the command the user actually typed (/ping rides this same path).
          const cmdName = ctcpType.toUpperCase() === 'PING' ? '/ping' : '/ctcp';
          const evt = {
            type: 'ctcp',
            level: 'warn',
            networkId,
            target: issuingTarget,
            text: `${cmdName}: this network isn’t connected`,
            time: new Date().toISOString(),
            self: false,
          } as unknown as MessageEvent;
          fanOut(userId, { ...decorateMessage(userId, evt), kind: 'irc' });
        }
        break;
      }
      case 'e2e-export': {
        // Keyring portability (#382 follow-up). DB-backed via e2eManager — no live
        // connection needed (unlike `case 'e2e'`). Reply to THIS socket only: the
        // requesting tab turns the JSON into a file download, so a broadcast would
        // make every open tab download. networkId ownership is enforced at the
        // boundary above; reject the system-buffer (null/0) case here.
        const networkId = msg.networkId == null ? NaN : Number(msg.networkId);
        if (!Number.isFinite(networkId) || networkId <= 0) {
          send(ws, {
            kind: 'e2eExport',
            ok: false,
            reason: 'run /e2e export from a network buffer',
          });
          break;
        }
        send(ws, { kind: 'e2eExport', networkId, ...e2eManager.exportKeyring(userId, networkId) });
        break;
      }
      case 'e2e-import': {
        // Replace this network's keyring from an uploaded export. Validated +
        // applied atomically by importKeyring; reply to the requesting socket.
        const networkId = msg.networkId == null ? NaN : Number(msg.networkId);
        const json = typeof msg.json === 'string' ? msg.json : '';
        if (!Number.isFinite(networkId) || networkId <= 0) {
          send(ws, {
            kind: 'e2eImport',
            ok: false,
            reason: 'run /e2e import from a network buffer',
          });
          break;
        }
        // Reject an oversized payload at the boundary, before the parse/replace
        // work (defence-in-depth; parseAndValidate guards the same limit too).
        if (json.length > MAX_IMPORT_BYTES) {
          send(ws, { kind: 'e2eImport', ok: false, reason: 'import file too large' });
          break;
        }
        send(ws, {
          kind: 'e2eImport',
          networkId,
          ...e2eManager.importKeyring(userId, networkId, json),
        });
        break;
      }
      case 'join':
        ircManager.joinChannel(
          userId,
          msg.networkId as number,
          msg.channel as string,
          msg.key as string | undefined,
        );
        break;
      case 'open-buffer':
        // A clicked channel name — handleOpenBuffer resolves reopen-vs-join.
        handleOpenBuffer(
          ws,
          userId,
          Number(msg.networkId),
          typeof msg.target === 'string' ? msg.target : '',
        );
        break;
      case 'part':
        ircManager.partChannel(
          userId,
          msg.networkId as number,
          msg.channel as string,
          msg.reason as string | undefined,
        );
        break;
      case 'close-buffer': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Server pseudo-buffer can't be closed (it's the per-network log).
        if (!networkId || !target || target.startsWith(':server:')) break;
        closeBufferRow(userId, networkId, target);
        // The client renders the pinned section by intersecting pins with open
        // buffers, so a pin on a now-closed buffer is invisible — and leaving
        // the row would diverge the client's pin set from ours (issue #112).
        // Close implies unpin. Match case-insensitively: the registry hides
        // closed buffers folded, so a differently-cased close would otherwise
        // hide the buffer while leaving the exact-cased pin row stranded — an
        // invisible orphan (issue #405).
        const pinned = unpinBufferCaseInsensitive(userId, networkId, target);
        if (pinned) {
          fanOut(userId, { kind: 'pins-changed', networkId, pinned });
        }
        if (target.startsWith('#')) {
          // Send PART if connected; partChannel also lowers autojoin. If
          // disconnected, partChannel is a no-op, so lower autojoin here to
          // keep the channel from auto-rejoining the next time the network
          // connects. Update-only — closing a buffer that has no row must not
          // conjure one (the last of the old upsertChannel conjure sites).
          if (
            !ircManager.partChannel(userId, networkId, target, msg.reason as string | undefined)
          ) {
            setBufferAutojoin(userId, networkId, target, false);
          }
        } else {
          // Closing a DM means we stop tracking this peer. Drop them from
          // the in-memory tracker and the DB row so a future reopen starts
          // from a clean probe instead of inheriting stale state.
          const conn = ircManager.getConnection(userId, networkId);
          if (conn) conn.untrackDmPeer(target);
        }
        // Drop any draft for the now-closed buffer. The client mirror also
        // drops it on `buffer-closed`, so the cleanup happens on both sides.
        draftsService.clear(userId, networkId, target, ws);
        fanOut(userId, { kind: 'buffer-closed', networkId, target });
        break;
      }
      case 'snapshot':
        // ws.sinceId is kept current by fanOut and prior sendSnapshot calls,
        // so an in-band 'snapshot' resync (visibility return after a long
        // hide) naturally becomes a gap-fill from the highest id this socket
        // has already received.
        sendSnapshot(ws, userId);
        break;
      case 'raw':
        ircManager.getConnection(userId, msg.networkId as number)?.raw(msg.line as string);
        break;
      case 'probe-presence': {
        // Client just activated a DM — refresh its presence cache so the
        // banner/sidebar dim reflect current state rather than whatever stale
        // value was last broadcast. The whois reply is silent (no server-
        // buffer dump); just the side effect of updating presence.
        if (!msg.networkId) break;
        const nick = typeof msg.nick === 'string' ? msg.nick : '';
        if (!nick) break;
        ircManager.probePresence(userId, msg.networkId as number, nick);
        break;
      }
      case 'list-channels': {
        // Kicks off a /LIST refresh on the given network. Results are written
        // to the chanlist DB cache by ircConnection; progress comes through
        // as `chanlist-start` / `chanlist-progress` / `chanlist-end` events,
        // and the actual rows are fetched via `chanlist-search` against the
        // cache. We always echo a `chanlist-state` so the caller learns the
        // current state even when the refresh was dropped as a duplicate.
        const networkId = Number(msg.networkId);
        if (!networkId || !ownsNetwork(userId, networkId)) {
          send(ws, { kind: 'error', text: 'network not accessible' });
          break;
        }
        const meta = chanlistDb.getMeta(networkId);
        if (chanlistInFlight.has(networkId) || meta.inProgress) {
          send(ws, { kind: 'chanlist-state', networkId, ...meta });
          break;
        }
        const conn = ircManager.getConnection(userId, networkId);
        if (!conn) {
          send(ws, { kind: 'error', text: 'network not connected' });
          break;
        }
        chanlistInFlight.add(networkId);
        try {
          startChanlistRefresh(networkId);
          conn.raw('LIST');
        } catch (_) {
          chanlistInFlight.delete(networkId);
        }
        send(ws, { kind: 'chanlist-state', networkId, ...chanlistDb.getMeta(networkId) });
        break;
      }
      case 'chanlist-search': {
        const networkId = Number(msg.networkId);
        if (!networkId || !ownsNetwork(userId, networkId)) {
          send(ws, { kind: 'error', text: 'network not accessible' });
          break;
        }
        const query = typeof msg.query === 'string' ? msg.query : '';
        const sortBy = msg.sortBy === 'name' ? 'name' : 'users';
        const sortDir = msg.sortDir === 'asc' ? 'asc' : 'desc';
        const offset = Math.max(Number(msg.offset) || 0, 0);
        const limit = Math.min(Math.max(Number(msg.limit) || 200, 1), 500);
        const { rows, total } = chanlistDb.searchChannels(networkId, {
          query,
          sortBy,
          sortDir,
          offset,
          limit,
        });
        const meta = chanlistDb.getMeta(networkId);
        send(ws, {
          kind: 'chanlist-result',
          networkId,
          query,
          sortBy,
          sortDir,
          offset,
          limit,
          rows,
          total,
          fetchedAt: meta.fetchedAt,
          inProgress: meta.inProgress,
          totalCount: meta.totalCount,
        });
        break;
      }
      case 'away': {
        // Empty/whitespace-only message → treat as /back (idiomatic IRC).
        const message = ((msg.message as string) || '').trim();
        if (!message) ircManager.clearAwayAll(userId, { autoSet: false });
        else ircManager.setAwayAll(userId, message, { autoSet: false });
        break;
      }
      case 'back':
        ircManager.clearAwayAll(userId, { autoSet: false });
        break;
      case 'typing':
        ircManager.typing(
          userId,
          msg.networkId as number,
          msg.target as string,
          msg.state as string,
        );
        break;
      case 'mark-read': {
        const target = msg.target as string;
        const requested = Number(msg.messageId);
        if (!target || !Number.isFinite(requested) || requested <= 0) break;
        // The app-scoped system buffer (#355) has no network — its read pointer
        // keys on a NULL network_id. Everything else needs a real network id.
        const networkId = target === SYSTEM_TARGET ? null : Number(msg.networkId);
        if (networkId !== null && !networkId) break;
        const lastReadId = setReadState(userId, networkId, target, requested);
        broadcastReadState(userId, networkId, target, lastReadId);
        break;
      }
      case 'clear-buffer': {
        // /clear: anchor the marker at the current tail. Server-computed so
        // a message persisted between client send and server receive gets
        // hidden too — the user's intent is "everything visible right now."
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        if (!networkId || !target) break;
        const boundary = maxIdForBuffer(networkId, target);
        // Empty buffer: nothing to clear; don't write a no-op row.
        if (boundary <= 0) break;
        const next = setClearedState(userId, networkId, target, boundary, new Date().toISOString());
        fanOut(userId, {
          kind: 'buffer-cleared',
          networkId,
          target,
          clearedBeforeId: next.clearedBeforeId,
          clearedAt: next.clearedAt,
        });
        break;
      }
      case 'unclear-buffer': {
        // Drop the clear marker so previously-hidden messages reappear.
        // Fired by the "Show earlier messages" affordance on the divider
        // and by `/clear off`.
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        if (!networkId || !target) break;
        setClearedState(userId, networkId, target, 0, null);
        fanOut(userId, {
          kind: 'buffer-cleared',
          networkId,
          target,
          clearedBeforeId: 0,
          clearedAt: null,
        });
        break;
      }
      case 'mark-all-read': {
        // Clamp every buffer's read pointer to its tail across all of this
        // user's networks. Skip buffers already at-or-past the tail so we
        // don't broadcast a no-op read-state to every tab.
        //
        // maxIdByBuffer returns every target with history, including closed
        // buffers. "Mark all read" means *all*, so we still clamp the read
        // pointer for a closed buffer (otherwise reopening it later resurfaces
        // the stale unread the user just cleared) — but we must NOT broadcast a
        // read-state for one that's closed-and-not-joined: the client would
        // re-materialize it and pop it back into the sidebar (#319). So clamp
        // first, then skip only the broadcast.
        const closed = closedBufferKeySet(userId);
        for (const conn of ircManager.listConnections(userId)) {
          const networkId = conn.network.id;
          for (const row of maxIdByBuffer(networkId)) {
            const target = row.target;
            const maxId = Number(row.maxId);
            if (!target || !Number.isFinite(maxId) || maxId <= 0) continue;
            const before = getReadState(userId, networkId, target);
            if (before >= maxId) continue;
            const after = setReadState(userId, networkId, target, maxId);
            if (isHiddenClosedBuffer(closed, conn.channels, networkId, target)) continue;
            broadcastReadState(userId, networkId, target, after);
          }
        }
        break;
      }
      case 'input-history-add': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        const text = typeof msg.text === 'string' ? msg.text : '';
        if (!networkId || !target || !text) break;
        addInputHistory(userId, networkId, target, text);
        // Other tabs/devices need this for cross-client up-arrow consistency.
        // The originating socket already added it optimistically, so skip it
        // to avoid a duplicate append.
        fanOut(userId, { kind: 'input-history-added', networkId, target, text }, { exceptWs: ws });
        break;
      }
      case 'draft-set': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        const body = typeof msg.body === 'string' ? msg.body : '';
        if (!networkId || !target || target.startsWith(':server:')) break;
        draftsService.set(userId, networkId, target, body, ws);
        break;
      }
      case 'draft-clear': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        if (!networkId || !target) break;
        draftsService.clear(userId, networkId, target, ws);
        break;
      }
      case 'pin-buffer': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Server pseudo-buffer is the network header row, not a pinnable item.
        if (!networkId || !target || target.startsWith(':server:')) break;
        const pinned = pinBuffer(userId, networkId, target);
        fanOut(userId, { kind: 'pins-changed', networkId, pinned });
        break;
      }
      case 'unpin-buffer': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        if (!networkId || !target) break;
        const pinned = unpinBuffer(userId, networkId, target);
        fanOut(userId, { kind: 'pins-changed', networkId, pinned });
        break;
      }
      case 'reorder-pins': {
        const networkId = Number(msg.networkId);
        if (!networkId || !Array.isArray(msg.targets)) break;
        const targets = (msg.targets as unknown[]).filter(
          (t): t is string => typeof t === 'string' && !!t,
        );
        const next = reorderPins(userId, networkId, targets);
        if (next === null) {
          // Set mismatch (concurrent pin/unpin from another tab landed before
          // this reorder). Echo the authoritative current order so the
          // originating client snaps back to truth instead of staying out of
          // sync.
          fanOut(userId, {
            kind: 'pins-changed',
            networkId,
            pinned: listPinnedForUserNetwork(userId, networkId),
          });
          break;
        }
        fanOut(userId, { kind: 'pins-changed', networkId, pinned: next });
        break;
      }
      case 'set-nicklist-collapsed': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Only channels have a nicklist; server/DM buffers are never tracked.
        if (!networkId || !target.startsWith('#')) break;
        const collapsed = !!msg.collapsed;
        setNicklistCollapsed(userId, networkId, target, collapsed);
        fanOut(userId, { kind: 'nicklist-collapsed-changed', networkId, target, collapsed });
        break;
      }
      case 'set-channel-notify-always': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Always-notify is a channel-level concept. DMs are blanket-controlled
        // by notifications.dm.enabled; server pseudo-buffers can't carry it.
        if (!networkId || !target.startsWith('#')) break;
        setChannelNotifyAlways(userId, networkId, target, !!msg.notifyAlways);
        fanOut(userId, {
          kind: 'channel-notify-changed',
          networkId,
          target,
          ...getChannelFlags(userId, networkId, target),
        });
        break;
      }
      case 'set-nick-note': {
        // Verb owns the 4 KB cap, the empty-string-deletes rule, and the
        // fanOut to other open tabs. WS handler is now a thin delegator —
        // identical behavior whether the change came from this tab or MCP.
        try {
          callVerb(
            'set_nick_note',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              networkId: msg.networkId,
              nick: msg.nick,
              note: msg.note,
            },
          );
        } catch (_) {
          /* boundary already filtered bad networkId; ignore */
        }
        break;
      }
      case 'set-relay-bot': {
        // Relay-bot mark (#277). Same thin-delegator shape as set-nick-note:
        // the verb owns validation, the mark/unmark + custom-pattern logic, and
        // the relay-bot-updated fanOut to every open tab.
        try {
          callVerb(
            'set_relay_bot',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              networkId: msg.networkId,
              nick: msg.nick,
              marked: msg.marked,
              pattern: msg.pattern,
            },
          );
        } catch (_) {
          /* boundary already filtered bad networkId; ignore */
        }
        break;
      }
      case 'set-contact': {
        // Verb owns validation, the per-(network,nick) uniqueness guard, the
        // live MONITOR diff, and the fanOut. Thin delegator, same as nick-note.
        try {
          callVerb(
            'set_contact',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              contactId: msg.contactId,
              displayName: msg.displayName,
              notifyOnline: msg.notifyOnline,
              targets: msg.targets,
            },
          );
        } catch (_) {
          /* invalid input / not owned; ignore */
        }
        break;
      }
      case 'delete-contact': {
        try {
          callVerb(
            'delete_contact',
            { userId, scope: 'read-write', transport: 'ws' },
            { contactId: msg.contactId },
          );
        } catch (_) {
          /* not owned / gone; ignore */
        }
        break;
      }
      case 'set-bookmark': {
        const messageId = Number(msg.messageId);
        if (!Number.isFinite(messageId) || messageId <= 0) break;
        // addBookmark enforces ownership at the SQL layer; an attempt to
        // bookmark a message from someone else's network is a silent no-op.
        const saved = addBookmark(userId, messageId);
        if (saved) {
          fanOut(userId, { kind: 'bookmark-updated', messageId, saved: true });
        }
        break;
      }
      case 'unset-bookmark': {
        const messageId = Number(msg.messageId);
        if (!Number.isFinite(messageId) || messageId <= 0) break;
        removeBookmark(userId, messageId);
        fanOut(userId, { kind: 'bookmark-updated', messageId, saved: false });
        break;
      }
      case 'add-ignore': {
        // null networkId = a global rule (every network); a positive number
        // scopes it to one. `null` is a valid scope, so distinguish it from a
        // malformed/missing id rather than the old truthiness check.
        const networkId = msg.networkId == null ? null : Number(msg.networkId);
        if (networkId !== null && !(networkId > 0)) break;
        // New clients send a full `rule` object; the quick-ignore modal and
        // older clients send a bare `mask` string (an ALL-level rule).
        const input =
          msg.rule !== undefined
            ? parseIgnoreInput(msg.rule)
            : typeof msg.mask === 'string'
              ? maskToRuleInput(msg.mask)
              : null;
        if (!input) break;
        // The client parser pre-validates; a server-side rejection (bad regex /
        // levels) just doesn't add and skips the fan-out. add() invalidates the
        // compiled cache so the insert path sees the new rule immediately.
        const result = ircManager.addIgnore(userId, networkId, input);
        if (!result.ok) break;
        fanOutIgnoreList(userId, networkId);
        break;
      }
      case 'remove-ignore': {
        const networkId = msg.networkId == null ? null : Number(msg.networkId);
        if (networkId !== null && !(networkId > 0)) break;
        const id = typeof msg.id === 'number' ? msg.id : undefined;
        const mask = typeof msg.mask === 'string' && msg.mask.trim() ? msg.mask.trim() : undefined;
        if (id === undefined && mask === undefined) break;
        ircManager.removeIgnore(userId, networkId, { id, mask });
        // A by-mask delete on a network scope clears matching globals AND that
        // network's rules (removeByMask spans both), so refresh both buckets.
        // by-id, or a global-scoped delete, touches just one.
        if (mask !== undefined && networkId !== null) {
          fanOutIgnoreList(userId, null);
          fanOutIgnoreList(userId, networkId);
        } else {
          fanOutIgnoreList(userId, networkId);
        }
        break;
      }
      case 'history': {
        const histNetworkId = msg.networkId as number;
        const histTarget = msg.target as string;

        // System buffer: app-scoped, no IRC connection — dispatch to the
        // system_messages keyset access. Reply shapes match the network path
        // below exactly, so the client's history handlers are identical (#355).
        if (msg.networkId == null && histTarget === SYSTEM_TARGET) {
          send(ws, buildSystemHistoryReply(userId, msg));
          break;
        }

        // History is DB-backed and connection-independent (every mode below reads
        // by (networkId, target) only). Ownership was already enforced at the
        // handleClientMessage boundary, so we no longer require a LIVE connection
        // here — a disconnected/offline network can still serve its history. This
        // is what lets offline buffers ship as shells and hydrate on open
        // (reattachToLive), and it fixes offline scroll-back, which previously
        // errored "network not connected".
        if (!ownsNetwork(userId, histNetworkId)) {
          send(ws, { kind: 'error', text: 'unknown network' });
          break;
        }
        const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
        const mode = typeof msg.mode === 'string' ? msg.mode : 'before';
        const token = msg.token ?? null;
        const speakers = listSpeakers(histNetworkId, histTarget);
        const baseReply = {
          kind: 'history',
          networkId: histNetworkId,
          target: histTarget,
          mode,
          token,
          speakers,
        };

        if (mode === 'around') {
          // Detached jump path. The DB lookup enforces (networkId, target);
          // we reject :server: pseudo-buffers up front since they don't carry
          // jumpable per-message anchors.
          if (histTarget.startsWith(':server:')) {
            send(ws, { kind: 'error', text: 'cannot jump in server buffer' });
            break;
          }
          const anchorId = Number(msg.anchorId);
          if (!Number.isInteger(anchorId) || anchorId <= 0) {
            send(ws, { kind: 'error', text: 'invalid anchorId' });
            break;
          }
          // halfLimit caps each side at the request's limit (default 100,
          // clamped 1..500). Total slice length tops out at 2*limit + 1.
          const halfLimit = limit;
          const slice = listMessagesAround(histNetworkId, histTarget, anchorId, halfLimit);
          const events = slice.events.map((e) => decorateMessage(userId, e));
          send(ws, {
            ...baseReply,
            anchorId,
            events,
            hasMoreOlder: slice.hasMoreOlder,
            hasMoreNewer: slice.hasMoreNewer,
            anchorMissing: 'anchorMissing' in slice ? !!slice.anchorMissing : false,
            // Back-compat with any existing 'before'-mode reader.
            hasMore: slice.hasMoreOlder,
            before: null,
          });
          break;
        }

        if (mode === 'after') {
          const afterId = Number(msg.afterId);
          if (!Number.isInteger(afterId) || afterId < 0) {
            send(ws, { kind: 'error', text: 'invalid afterId' });
            break;
          }
          const events = listMessages(histNetworkId, histTarget, { afterId, limit }).map((e) =>
            decorateMessage(userId, e),
          );
          const newestId = events.length ? events[events.length - 1].id : afterId;
          send(ws, {
            ...baseReply,
            afterId,
            events,
            hasMoreNewer: hasNewerRow(histNetworkId, histTarget, newestId),
            hasMoreOlder: true, // caller already had older context; unchanged.
            hasMore: true,
            before: null,
          });
          break;
        }

        if (mode === 'latest') {
          // Return-to-present reattach — also the path that HYDRATES a shell on
          // first open. Equivalent to the implicit initial backlog (`limit` rows,
          // newest, no `before`); ships hasMoreOlder so the client can resume
          // upward paging cleanly, plus inputHistory so up-arrow recall is
          // restored for a shell (fresh-connect shells omit it, so this is the
          // only place a reloaded client gets its per-buffer recall back).
          const events = listMessages(histNetworkId, histTarget, { limit }).map((e) =>
            decorateMessage(userId, e),
          );
          const oldestId = events.length ? events[0].id : 0;
          send(ws, {
            ...baseReply,
            events,
            hasMoreOlder: oldestId > 0 && hasOlderRow(histNetworkId, histTarget, oldestId),
            hasMoreNewer: false,
            hasMore: oldestId > 0 && hasOlderRow(histNetworkId, histTarget, oldestId),
            before: null,
            inputHistory: listRecentInputHistory(
              userId,
              histNetworkId,
              histTarget,
              INPUT_HISTORY_SLICE,
            ),
          });
          break;
        }

        // 'before' (default, legacy). Delegates to the recent_messages verb —
        // shared with MCP — and wraps the value in the WS history reply shape
        // (mode/token/speakers + historical hasMore alias).
        const before = msg.before ? Number(msg.before) : undefined;
        let result: { messages: WsPayload[]; hasOlder: boolean };
        try {
          result = callVerb(
            'recent_messages',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              networkId: msg.networkId,
              target: msg.target,
              before,
              limit,
            },
          ) as { messages: WsPayload[]; hasOlder: boolean };
        } catch (_) {
          send(ws, { kind: 'error', text: 'history fetch failed' });
          break;
        }
        send(ws, {
          ...baseReply,
          before: msg.before || null,
          events: result.messages,
          hasMoreOlder: result.hasOlder,
          hasMoreNewer: false,
          hasMore: result.hasOlder,
        });
        break;
      }
      case 'search': {
        // Delegates to the search_messages verb. The boundary check above
        // already validated networkId ownership when a network filter was
        // present; searchMessages itself self-scopes the global case to the
        // caller's networks via its SQL join.
        let result: { messages: WsPayload[]; hasMore: boolean };
        try {
          result = callVerb(
            'search_messages',
            { userId, scope: 'read-write', transport: 'ws' },
            {
              query: msg.query,
              networkId: msg.networkId || undefined,
              target: typeof msg.target === 'string' && msg.target ? msg.target : undefined,
              nick: typeof msg.nick === 'string' && msg.nick ? msg.nick : undefined,
              nicks: Array.isArray(msg.nicks) ? msg.nicks : undefined,
              before: msg.before ? Number(msg.before) : undefined,
              limit: msg.limit,
            },
          ) as { messages: WsPayload[]; hasMore: boolean };
        } catch (_) {
          send(ws, { kind: 'error', text: 'search failed' });
          break;
        }
        send(ws, {
          kind: 'search-result',
          token: msg.token ?? null,
          results: result.messages,
          hasMore: result.hasMore,
          before: msg.before || null,
        });
        break;
      }
      default:
        send(ws, { kind: 'error', text: `unknown message type: ${msg.type}` });
    }
  }

  return wss;
}
