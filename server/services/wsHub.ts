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
import settingsService from './settingsService.js';
import highlightRulesService from './highlightRulesService.js';
import draftsService from './draftsService.js';
import * as systemLog from './systemLog.js';
import * as pushService from './pushService.js';
import { matchesAny as matchesIgnoreMask } from './maskMatch.js';
import { listMasks as listIgnoredMasks } from '../db/ignoredMasks.js';
import { findSession } from '../db/sessions.js';
import { findUserById, touchUserLastSeen } from '../db/users.js';
import {
  listMessages,
  listMessagesAround,
  hasOlderRow,
  hasNewerRow,
  listBufferTargets,
  listSpeakers,
  countNewer,
  countHighlightsNewer,
  maxIdByBuffer,
  maxIdForBuffer,
  COUNTABLE_TYPES,
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
  addEntry as addInputHistory,
  listRecent as listRecentInputHistory,
} from '../db/inputHistory.js';
import { closeBuffer, reopenBuffer, isClosed, closedKeySetForUser } from '../db/closedBuffers.js';
import {
  pinBuffer,
  unpinBuffer,
  reorderPins,
  listPinnedForUserNetwork,
} from '../db/pinnedBuffers.js';
import { setNicklistCollapsed } from '../db/nicklistCollapsed.js';
import { addBookmark, removeBookmark, listBookmarkIdsForUser } from '../db/bookmarks.js';
import {
  getChannelNotifyAlways,
  setChannelNotifyAlways,
  setChannelMuted,
  getChannelFlags,
} from '../db/channelNotify.js';
import { getUserAwayState } from '../db/userAwayState.js';
import { upsertChannel, ownsNetwork, listNetworksForUser } from '../db/networks.js';
import * as chanlistDb from '../db/chanlist.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { SESSION_COOKIE } from '../middleware/auth.js';
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

const DM_ELIGIBLE_TYPES = new Set(['message', 'action', 'notice']);

// Structural DM detection: ircConnection routes any direct message into a
// buffer keyed by the *other* person's nick, so by the time we see an event
// here the target is no longer your own nick. Anything that's not a channel
// (`#…`) and not a server pseudo-buffer (`:server:…`) is a direct conversation
// — that bucket includes both incoming DMs and your own outgoing DMs.
function isDirect(event: MessageEvent): boolean {
  if (!DM_ELIGIBLE_TYPES.has(event.type)) return false;
  const target = event.target || '';
  return !!target && !target.startsWith('#') && !target.startsWith(':server:');
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
  const notifyAlways =
    isChannel && !event.self && getChannelNotifyAlways(userId, event.networkId, target);
  const notify = matched || dm || notifyAlways;
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

function computeUnreadFor(_userId: number, networkId: number, target: string, lastReadId: number) {
  const unread = countNewer(networkId, target, lastReadId);
  const highlights = unread === 0 ? 0 : countHighlightsNewer(networkId, target, lastReadId);
  return {
    lastReadId: lastReadId || 0,
    unread,
    highlights,
    // Both counts are now indexed queries — no scan cap, no undercount.
    highlightsCapped: false,
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
  const lastReadId = getReadState(userId, networkId, target);
  const counts = computeUnreadFor(userId, networkId, target, lastReadId);
  const cleared = getClearedState(userId, networkId, target);
  return {
    kind: 'backlog',
    networkId,
    target,
    events,
    speakers: listSpeakers(networkId, target),
    // A channel counts as joined only while a live connection is tracking it;
    // a stopped/offline network has no connection, so treat it as parted
    // rather than refusing to ship the history at all.
    joined: target.startsWith('#') ? !!conn?.channels.has(target.toLowerCase()) : true,
    lastReadId: counts.lastReadId,
    unread: counts.unread,
    highlights: counts.highlights,
    highlightsCapped: counts.highlightsCapped,
    clearedBeforeId: cleared.clearedBeforeId,
    clearedAt: cleared.clearedAt,
    inputHistory: listRecentInputHistory(userId, networkId, target, 200),
  };
}

// Upper bound on how many missed rows a resume frame ships per buffer. Wider
// than the first-connect default so a normal flap fills in one shot, but
// bounded so a long disconnect can't produce an unbounded payload.
const RESUME_GAP_CAP = 500;
// When the gap exceeds the cap we fall back to a fresh latest slice; size it
// to match the first-connect default.
const RESUME_LATEST_LIMIT = 200;

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
      return {
        events: gap.map((e) => decorateMessage(userId, e)),
        reset: false,
        hasMoreOlder: false,
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

// Backlog frames for every network the user owns that has NO live connection —
// a paused account (the is_paused gate forbids connecting), a manually
// disconnected network (stopNetwork deletes the connection), or one that was
// never autoconnected. The live snapshot path is connection-driven, so without
// these frames an offline network's persisted buffers stay invisible until a
// connection exists — which a paused user can never establish. Reuses
// buildBufferBacklog, which reads purely from the DB and reports joined:false
// when no connection is tracking the channel.
// `closed` defaults to a fresh query so standalone callers (tests) stay simple;
// sendSnapshot passes the Set it already computed for the live loop to avoid a
// redundant DB read per snapshot.
export function buildOfflineBacklogFrames(
  userId: number,
  closed: Set<string> = closedKeySetForUser(userId),
): WsPayload[] {
  const liveIds = new Set(ircManager.listConnections(userId).map((c) => c.network.id));
  const frames: WsPayload[] = [];
  for (const net of listNetworksForUser(userId)) {
    if (liveIds.has(net.id)) continue;
    const targets = new Set(listBufferTargets(net.id));
    targets.add(`:server:${net.id}`);
    for (const target of targets) {
      // Server pseudo-buffer is uncloseable; otherwise honor a closed flag.
      // Nothing is joined on an offline network, so there's no autorejoin race
      // to defend against here (unlike the live loop in sendSnapshot).
      if (!target.startsWith(':server:') && closed.has(`${net.id}::${target}`)) continue;
      frames.push(buildBufferBacklog(userId, net.id, target));
    }
  }
  return frames;
}

// Handles a client `open-buffer` request (a clicked channel name). Resolves
// the requested target against buffers that already have persisted history —
// case-insensitively, since IRC channel names are case-insensitive but
// message rows store one canonical casing. A match (even a since-/closed
// buffer) is reopened and re-seeded without a re-JOIN; a channel with no
// history anywhere is one we've never visited, so it gets joined. Either way
// the requesting socket is told the canonical target to focus, so it never
// has to guess the casing.
export function handleOpenBuffer(
  ws: LurkerWebSocket,
  userId: number,
  networkId: number,
  requested: string,
): void {
  if (!networkId || !requested || requested.startsWith(':server:')) return;
  const canonical = listBufferTargets(networkId).find(
    (t) => t.toLowerCase() === requested.toLowerCase(),
  );
  if (canonical) {
    reopenBuffer(userId, networkId, canonical);
    send(ws, buildBufferBacklog(userId, networkId, canonical));
    send(ws, { kind: 'buffer-opened', networkId, target: canonical });
  } else if (requested.startsWith('#')) {
    ircManager.joinChannel(userId, networkId, requested);
    send(ws, { kind: 'buffer-opened', networkId, target: requested });
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

export function attachWsHub(httpServer: HttpServer, sessionSecret: string) {
  const wss = new WebSocketServer({ noServer: true });
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
    networkId: number,
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

  function maybePush(userId: number, decorated: DecoratedEvent): void {
    if (!decorated || !decorated.notify) return;
    if (decorated.self) return;
    if (userHasVisibleClient(userId)) return;
    // Suppress push for senders the user has ignored. This is the one piece
    // of the ignore feature that has to live server-side: push fires while
    // no client is open, so a client-side filter can't possibly intercept.
    // The unread badge and the render filter remain reactive client-side,
    // so /unignore still reveals; only push delivery is frozen here.
    if (decorated.nick) {
      const masks = listIgnoredMasks({ userId, networkId: decorated.networkId });
      if (masks.length && matchesIgnoreMask(masks, decorated.nick, decorated.userhost)) {
        return;
      }
    }
    // Signal kind in priority order: DM beats matched beats always_notify.
    // The `kind` doubles as the settings-key namespace, so picking a single
    // priority winner here means a DM that also matched a rule still
    // delivers as one notification, gated by the DM master toggle.
    const kindKey = decorated.dm ? 'dm' : decorated.matched ? 'highlight' : 'always_notify';
    if (!effectiveSetting(userId, `notifications.${kindKey}.enabled`)) return;
    // Suppress push while the user has a *manual* /away set. Auto-away is the
    // case where push is needed most (all tabs closed), so it's deliberately
    // not gated here.
    if (effectiveSetting(userId, 'notifications.push.mute_when_away')) {
      const away = getUserAwayState(userId);
      if (away?.away_datetime && !away?.back_datetime && !away?.auto_set) return;
    }
    // Quiet hours: skip when inside the user's configured local-time window.
    // Times compare in the user's system.timezone so DST transitions don't
    // shift the window relative to wall-clock time.
    if (effectiveSetting(userId, 'notifications.push.quiet_hours.enabled')) {
      const startMin = parseHHMM(effectiveSetting(userId, 'notifications.push.quiet_hours.start'));
      const endMin = parseHHMM(effectiveSetting(userId, 'notifications.push.quiet_hours.end'));
      if (startMin != null && endMin != null) {
        const tz = effectiveSetting(userId, 'system.timezone');
        const currentMin = currentMinutesInZone(new Date(), tz);
        if (isInQuietWindow(currentMin, startMin, endMin)) return;
      }
    }
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
      })
      .catch((err) => console.warn('[push] deliver failed:', err?.message || err));
  }

  ircManager.on('event', (rawEvent) => {
    // EnrichedEvent (from ircConnection) is a strict superset of MessageEvent.
    const event = rawEvent as MessageEvent & { userId: number; state?: string };
    const eventUserId = event.userId;
    const decorated = decorateMessage(eventUserId, event);
    const target = decorated.target;
    if (
      target &&
      !target.startsWith(':server:') &&
      isClosed(eventUserId, decorated.networkId, target)
    ) {
      // A persisted message with a real id (DM, message, action, notice, etc.)
      // is a strong signal the buffer is wanted again — reopen it. Ephemeral
      // events (typing, away markers fanned to this target, names) shouldn't
      // resurrect a closed buffer, so we drop them on the floor.
      const reopens = decorated.id != null && DM_ELIGIBLE_TYPES.has(decorated.type);
      // Ignored senders cannot resurrect a closed DM either. Otherwise an
      // ignored user can force the buffer back into the sidebar simply by
      // sending — a soft harassment vector the client-side render filter
      // doesn't close, since the reopen happens server-side.
      let senderIgnored = false;
      if (reopens && decorated.nick) {
        const masks = listIgnoredMasks({
          userId: eventUserId,
          networkId: decorated.networkId,
        });
        if (masks.length && matchesIgnoreMask(masks, decorated.nick, decorated.userhost)) {
          senderIgnored = true;
        }
      }
      if (!reopens || senderIgnored) return;
      reopenBuffer(eventUserId, decorated.networkId, target);
      fanOut(eventUserId, {
        kind: 'buffer-reopened',
        networkId: decorated.networkId,
        target,
      });
    }
    fanOut(eventUserId, { ...decorated, kind: 'irc' });
    maybePush(eventUserId, decorated);

    // Countable persisted events change the buffer's unread/highlight counts
    // for this user. Broadcast the recomputed read-state so every tab —
    // including inactive ones — reflects the new badge without the client
    // having to mirror the server's counting logic.
    if (decorated.id != null && decorated.target && COUNTABLE_TYPES.has(decorated.type)) {
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
    // Pass freshNetworkId so the just-connected network ships its backlog
    // wholesale — ws.sinceId has been advanced by live events on OTHER
    // networks, so a cursor read against this network's persisted history
    // (all id <= sinceId) would return zero events and leave the user
    // staring at an empty buffer until a page refresh.
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
    if (line.userId == null) {
      for (const userId of socketsByUser.keys()) {
        fanOut(userId, { kind: 'system-log', line });
      }
      return;
    }
    fanOut(line.userId, { kind: 'system-log', line });
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

  function authenticateRequest(req: IncomingMessage): User | null | undefined {
    const header = req.headers.cookie;
    if (!header) return null;
    const cookies = cookie.parse(header);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    const token = raw.startsWith('s:') ? cookieParser.signedCookie(raw, sessionSecret) : false;
    if (!token) return null;
    const session = findSession(token);
    if (!session) return null;
    return findUserById(session.user_id);
  }

  httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    if (!req.url || !req.url.startsWith('/ws')) return;
    const user = authenticateRequest(req);
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

  function sendSnapshot(
    ws: LurkerWebSocket,
    userId: number,
    freshNetworkId: number | null = null,
  ): void {
    const networks = ircManager.snapshotForUser(userId);
    send(ws, { kind: 'snapshot', networks });
    // Drafts ship once per snapshot, separate from per-buffer backlog frames —
    // the keying is global to the user, not per-buffer, so a single message is
    // cheaper than fanning a body field into every backlog row.
    send(ws, { kind: 'draft-snapshot', drafts: draftsService.snapshotForUser(userId) });
    // Lightweight id-only seed for the bookmarks store. Per-row payloads are
    // lazy-loaded by the BookmarksModal via REST when the user opens it; this
    // snapshot exists solely so the message context menu can flip its label
    // ("Save" ↔ "Remove bookmark") without a network round-trip.
    send(ws, { kind: 'bookmark-ids-snapshot', ids: listBookmarkIdsForUser(userId) });
    // System console seed: ring contents up to the current moment. Live
    // lines after this point arrive via the `system-log` fan-out. The
    // client store dedupes by id, so a redundant re-snapshot on visibility-
    // return resync is harmless.
    send(ws, { kind: 'system-log-snapshot', lines: systemLog.getRecent(userId) });
    // Friends/contacts seed: the user's full contact list (display name, notify
    // flag, per-network watch targets). User-level, so one message rather than a
    // per-network field. Drives the FRIENDS overview/sidebar + the came-online
    // toast gate.
    send(ws, { kind: 'contacts-snapshot', contacts: ircManager.listContacts(userId) });
    const readState = listReadStateForUser(userId);
    const clearedState = listClearedStateForUser(userId);
    const closed = closedKeySetForUser(userId);
    let maxSentId = ws.sinceId || 0;
    for (const conn of ircManager.listConnections(userId)) {
      const targets = new Set(listBufferTargets(conn.network.id));
      targets.add(`:server:${conn.network.id}`);
      // Currently-joined channels are always shown — they take precedence over
      // a stale closed flag (shouldn't normally exist since joining clears it,
      // but defensive against autorejoin/state races).
      for (const ch of conn.channels.values()) targets.add(ch.name);
      // Fresh-network branch: this connection just came online, so the client
      // has never received a backlog frame for any of its buffers this
      // session. ws.sinceId has been advanced by live events on other
      // networks, so a cursor read would return nothing — ship the full
      // recent slice instead.
      const isFreshNetwork = freshNetworkId != null && conn.network.id === freshNetworkId;
      for (const target of targets) {
        if (target.startsWith(':server:')) {
          // Server pseudo-buffer is uncloseable — never filter.
        } else if (
          closed.has(`${conn.network.id}::${target}`) &&
          !conn.channels.has(target.toLowerCase())
        ) {
          continue;
        }
        // Resume cursor: ship the gap the client missed (id > sinceId), or a
        // fresh latest slice + reset flag when that gap exceeds the cap (see
        // buildResumeSlice for the gap/reset rationale). isFreshNetwork forces
        // the latest path: ws.sinceId was advanced by other networks' live
        // events this session, so a cursor read here would wrongly return
        // nothing and starve a just-connected network of its backlog.
        const slice = buildResumeSlice(
          userId,
          conn.network.id,
          target,
          isFreshNetwork ? 0 : ws.sinceId || 0,
        );
        const events = slice.events;
        for (const e of events) {
          if (e.id != null && e.id > maxSentId) maxSentId = e.id;
        }
        const speakers = listSpeakers(conn.network.id, target);
        const lastReadId = readState[`${conn.network.id}::${target}`] || 0;
        const counts = computeUnreadFor(userId, conn.network.id, target, lastReadId);
        const cleared = clearedState[`${conn.network.id}::${target}`] ?? {
          clearedBeforeId: 0,
          clearedAt: null,
        };
        // Per-buffer input history is unbounded on disk; ship a recent slice
        // for up-arrow recall. Older entries stay in the DB and could be
        // paginated in later if the slice ever proves too small.
        const inputHistory = listRecentInputHistory(userId, conn.network.id, target, 200);
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
          speakers,
          // For channels: are we currently joined? Drives the dim/active style
          // in the buffer list. Non-channel buffers (DMs, :server:) have no
          // join concept — flag them as joined so they never get dimmed.
          joined: target.startsWith('#') ? conn.channels.has(target.toLowerCase()) : true,
          lastReadId: counts.lastReadId,
          unread: counts.unread,
          highlights: counts.highlights,
          highlightsCapped: counts.highlightsCapped,
          clearedBeforeId: cleared.clearedBeforeId,
          clearedAt: cleared.clearedAt,
          inputHistory,
        });
      }
    }
    // Offline networks (no live connection) still ship their persisted buffers
    // so a paused/disconnected user can read history. Frames carry joined:false
    // and the client dims them via the network's disconnected snapshot state.
    for (const frame of buildOfflineBacklogFrames(userId, closed)) {
      for (const e of frame.events as Array<{ id?: number | null }>) {
        if (e.id != null && e.id > maxSentId) maxSentId = e.id;
      }
      send(ws, frame);
    }
    // Advance the resume cursor past everything we just shipped, so the next
    // sendSnapshot (in-band 'snapshot' request, or another IRC-state trigger)
    // resumes from where this snapshot left off.
    ws.sinceId = maxSentId;
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
      case 'join':
        ircManager.joinChannel(userId, msg.networkId as number, msg.channel as string);
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
        closeBuffer(userId, networkId, target);
        // The client renders the pinned section by intersecting pins with open
        // buffers, so a pin on a now-closed buffer is invisible — and leaving
        // the row would diverge the client's pin set from ours, snapping the
        // next reorder back as a mismatch (issue #112). Close implies unpin.
        if (listPinnedForUserNetwork(userId, networkId).includes(target)) {
          const pinned = unpinBuffer(userId, networkId, target);
          fanOut(userId, { kind: 'pins-changed', networkId, pinned });
        }
        if (target.startsWith('#')) {
          // Send PART if connected; partChannel also flips channels.joined=0.
          // If disconnected, partChannel is a no-op, so explicitly mark the
          // channel as not-joined here to keep it from auto-rejoining the
          // next time the network connects.
          if (
            !ircManager.partChannel(userId, networkId, target, msg.reason as string | undefined)
          ) {
            upsertChannel(networkId, target, false);
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
        const networkId = Number(msg.networkId);
        const target = msg.target as string;
        const requested = Number(msg.messageId);
        if (!networkId || !target || !Number.isFinite(requested) || requested <= 0) break;
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
        for (const conn of ircManager.listConnections(userId)) {
          const networkId = conn.network.id;
          for (const row of maxIdByBuffer(networkId)) {
            const target = row.target;
            const maxId = Number(row.maxId);
            if (!target || !Number.isFinite(maxId) || maxId <= 0) continue;
            const before = getReadState(userId, networkId, target);
            if (before >= maxId) continue;
            const after = setReadState(userId, networkId, target, maxId);
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
        // Broadcast the full flag pair (notifyAlways + muted) so the muted flag
        // isn't clobbered when only notify_always changed, and vice versa.
        fanOut(userId, {
          kind: 'channel-notify-changed',
          networkId,
          target,
          ...getChannelFlags(userId, networkId, target),
        });
        break;
      }
      case 'set-channel-muted': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Mute is a buffer-list display concern and channel-only — DMs always
        // want their unread shown, server pseudo-buffers can't carry it.
        if (!networkId || !target.startsWith('#')) break;
        setChannelMuted(userId, networkId, target, !!msg.muted);
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
              primaryNetworkId: msg.primaryNetworkId,
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
        const networkId = Number(msg.networkId);
        const mask = typeof msg.mask === 'string' ? msg.mask.trim() : '';
        if (!networkId || !mask) break;
        ircManager.addIgnore(userId, networkId, mask);
        fanOut(userId, {
          kind: 'ignore-list-updated',
          networkId,
          masks: ircManager.listIgnoredFor(userId, networkId),
        });
        break;
      }
      case 'remove-ignore': {
        const networkId = Number(msg.networkId);
        const mask = typeof msg.mask === 'string' ? msg.mask.trim() : '';
        if (!networkId || !mask) break;
        ircManager.removeIgnore(userId, networkId, mask);
        fanOut(userId, {
          kind: 'ignore-list-updated',
          networkId,
          masks: ircManager.listIgnoredFor(userId, networkId),
        });
        break;
      }
      case 'history': {
        const histNetworkId = msg.networkId as number;
        const histTarget = msg.target as string;
        const conn = ircManager.getConnection(userId, histNetworkId);
        if (!conn) {
          send(ws, { kind: 'error', text: 'network not connected' });
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
          // Return-to-present reattach. Equivalent to the implicit initial
          // backlog (`limit` rows, newest, no `before`); ships hasMoreOlder so
          // the client can resume upward paging cleanly.
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
