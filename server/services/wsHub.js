// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import cookieParser from 'cookie-parser';
import ircManager from './ircManager.js';
import settingsService from './settingsService.js';
import highlightRulesService from './highlightRulesService.js';
import draftsService from './draftsService.js';
import * as pushService from './pushService.js';
import { matchesAny as matchesIgnoreMask } from './maskMatch.js';
import { listMasks as listIgnoredMasks } from '../db/ignoredMasks.js';
import { findSession } from '../db/sessions.js';
import { findUserById, touchUserLastSeen } from '../db/users.js';
import { listMessages, listMessagesAround, hasOlderRow, hasNewerRow, listBufferTargets, listSpeakers, countNewer, countHighlightsNewer, maxIdByBuffer, searchMessages, COUNTABLE_TYPES } from '../db/messages.js';
import { listReadStateForUser, getReadState, setReadState } from '../db/bufferReads.js';
import { addEntry as addInputHistory, listRecent as listRecentInputHistory } from '../db/inputHistory.js';
import {
  closeBuffer,
  reopenBuffer,
  isClosed,
  closedKeySetForUser,
} from '../db/closedBuffers.js';
import {
  pinBuffer,
  unpinBuffer,
  reorderPins,
  listPinnedForUserNetwork,
} from '../db/pinnedBuffers.js';
import { setNicklistCollapsed } from '../db/nicklistCollapsed.js';
import {
  getChannelNotifyAlways,
  setChannelNotifyAlways,
} from '../db/channelNotify.js';
import { getUserAwayState } from '../db/userAwayState.js';
import { upsertChannel, ownsNetwork } from '../db/networks.js';
import * as chanlistDb from '../db/chanlist.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

function effectiveSetting(userId, key) {
  const overrides = getUserSettings(userId);
  if (key in overrides) return overrides[key];
  return defaultsAsObject()[key];
}

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts (year/month/day/hour/minute/second) of `date` in the given
// IANA timezone, or in the server's local zone when `timeZone` is falsy/invalid.
function wallClockParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') out[p.type] = p.value;
  // Some locales render midnight as "24" instead of "00"; normalize so the
  // offset math below doesn't blow up on Date.UTC.
  if (out.hour === '24') out.hour = '00';
  return out;
}

function tzOffsetMinutes(date, timeZone) {
  if (!timeZone) return -date.getTimezoneOffset();
  const p = wallClockParts(date, timeZone);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// "afk since 2026-05-09 15:30:00-0500" — mirrors screen_away.py's default
// time_format. Renders in `timeZone` when provided, otherwise server local.
function fmtAwayTimestamp(date, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : null;
  const p = wallClockParts(date, tz);
  const off = tzOffsetMinutes(date, tz);
  const pad = (n) => String(n).padStart(2, '0');
  const sign = off >= 0 ? '+' : '-';
  const aoff = Math.abs(off);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}${sign}${pad(Math.floor(aoff / 60))}${pad(aoff % 60)}`;
}

function buildAutoAwayMessage(userId) {
  const base = (effectiveSetting(userId, 'away.auto.message') || 'afk').trim() || 'afk';
  const tz = effectiveSetting(userId, 'system.timezone');
  return `${base} since ${fmtAwayTimestamp(new Date(), tz)}`;
}

// HH:MM (24h) into minutes-past-midnight, or null on a malformed value. The
// quiet-hours settings are plain strings rather than integers so the UI can
// use <input type="time"> directly without conversion juggling.
function parseHHMM(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function currentMinutesInZone(date, timeZone) {
  const tz = isValidTimeZone(timeZone) ? timeZone : null;
  const p = wallClockParts(date, tz);
  return Number(p.hour) * 60 + Number(p.minute);
}

// True when current is inside [start, end). When start > end the window
// wraps midnight, e.g. 22:00–07:00 = [22:00, 24:00) ∪ [00:00, 07:00).
function isInQuietWindow(currentMin, startMin, endMin) {
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
function isDirect(event) {
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
function decorateMessage(userId, event) {
  if (!event || typeof event !== 'object') return event;
  const matched = !!event.matched;
  const matchedRuleId = event.matchedRuleId ?? null;
  const dm = isDirect(event) && !event.self;
  const target = event.target || '';
  const isChannel = target.startsWith('#');
  const notifyAlways = isChannel && !event.self
    && getChannelNotifyAlways(userId, event.networkId, target);
  const notify = matched || dm || notifyAlways;
  return { ...event, matched, matchedRuleId, dm, notifyAlways, notify };
}

function computeUnreadFor(userId, networkId, target, lastReadId) {
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

export function attachWsHub(httpServer, sessionSecret) {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUser = new Map();
  // Per-user pending auto-away timers. Set when a user goes from 1→0 sockets;
  // cleared on 0→1 or when the timer fires.
  const autoAwayTimers = new Map();
  // In-flight /LIST refreshes, keyed by network_id. We belt-and-suspender the
  // chanlist_meta.in_progress column with this in-memory set so a duplicate
  // `list-channels` from a second tab is rejected without first reading the
  // DB, and so a crash mid-/LIST self-clears on next process boot (the set
  // resets but the meta row can be cleaned by the next start handler).
  const chanlistInFlight = new Set();

  function clearAutoAwayTimer(userId) {
    const t = autoAwayTimers.get(userId);
    if (t) {
      clearTimeout(t);
      autoAwayTimers.delete(userId);
    }
  }

  function scheduleAutoAway(userId) {
    if (autoAwayTimers.has(userId)) return;
    const enabled = !!effectiveSetting(userId, 'away.auto.enabled');
    if (!enabled) return;
    const rawDelay = Number(effectiveSetting(userId, 'away.auto.delay_seconds'));
    const delaySec = Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 30;
    const t = setTimeout(() => {
      autoAwayTimers.delete(userId);
      // Re-check: a socket may have reconnected during the delay.
      if (socketsByUser.get(userId)?.size > 0) return;
      const message = buildAutoAwayMessage(userId);
      ircManager.setAwayAll(userId, message, { autoSet: true });
    }, delaySec * 1000);
    t.unref?.();
    autoAwayTimers.set(userId, t);
  }

  function addSocket(userId, ws) {
    let set = socketsByUser.get(userId);
    if (!set) {
      set = new Set();
      socketsByUser.set(userId, set);
    }
    const wasEmpty = set.size === 0;
    set.add(ws);
    if (wasEmpty) {
      // First client back: cancel any pending auto-away and clear an
      // already-set auto-away across networks. Manual /away is preserved.
      clearAutoAwayTimer(userId);
      ircManager.clearAwayAll(userId, { autoSet: true });
    }
  }

  function removeSocket(userId, ws) {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      socketsByUser.delete(userId);
      scheduleAutoAway(userId);
    }
  }

  function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  function fanOut(userId, payload, opts = {}) {
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

  function userHasVisibleClient(userId) {
    const set = socketsByUser.get(userId);
    if (!set) return false;
    for (const ws of set) {
      if (ws.readyState === ws.OPEN && ws.presence?.visible) return true;
    }
    return false;
  }

  // Single path for "tell every tab of this user what the buffer's unread
  // counts are now." Used by mark-read echo and by the live IRC-event fan-out
  // below — the client doesn't increment locally anymore, so this is the
  // only source of badge state.
  function broadcastReadState(userId, networkId, target, lastReadId) {
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

  function maybePush(userId, decorated) {
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
    const kindKey = decorated.dm
      ? 'dm'
      : decorated.matched
        ? 'highlight'
        : 'always_notify';
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
    pushService.deliver(userId, {
      kind: kindKey,
      networkId: decorated.networkId,
      networkName: network?.name || `net:${decorated.networkId}`,
      target: decorated.target,
      nick: decorated.nick,
      text: decorated.text,
      time: decorated.time,
      messageId: decorated.id,
    }).catch((err) => console.warn('[push] deliver failed:', err?.message || err));
  }

  ircManager.on('event', (event) => {
    const decorated = decorateMessage(event.userId, event);
    const target = decorated.target;
    if (target && !target.startsWith(':server:')
        && isClosed(decorated.userId, decorated.networkId, target)) {
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
          userId: decorated.userId,
          networkId: decorated.networkId,
        });
        if (masks.length && matchesIgnoreMask(masks, decorated.nick, decorated.userhost)) {
          senderIgnored = true;
        }
      }
      if (!reopens || senderIgnored) return;
      reopenBuffer(decorated.userId, decorated.networkId, target);
      fanOut(decorated.userId, {
        kind: 'buffer-reopened',
        networkId: decorated.networkId,
        target,
      });
    }
    fanOut(decorated.userId, { ...decorated, kind: 'irc' });
    maybePush(decorated.userId, decorated);

    // Countable persisted events change the buffer's unread/highlight counts
    // for this user. Broadcast the recomputed read-state so every tab —
    // including inactive ones — reflects the new badge without the client
    // having to mirror the server's counting logic.
    if (decorated.id != null && decorated.target && COUNTABLE_TYPES.has(decorated.type)) {
      const lastReadId = getReadState(decorated.userId, decorated.networkId, decorated.target);
      broadcastReadState(decorated.userId, decorated.networkId, decorated.target, lastReadId);
    }

    if (event.type === 'chanlist-end' && event.networkId) {
      chanlistInFlight.delete(event.networkId);
    }
    // A disconnect mid-/LIST means RPL_LISTEND will never arrive — release
    // the in-flight guard and reconcile the meta row so the next attempt
    // (after reconnect) isn't blocked by stale state.
    if (event.type === 'state' && event.state === 'disconnected' && event.networkId) {
      if (chanlistInFlight.delete(event.networkId)) {
        try { chanlistDb.setMeta(event.networkId, { inProgress: false }); }
        catch (_) { /* ignore */ }
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
    const touchedAway = changes && ('away.auto.enabled' in changes || 'away.auto.delay_seconds' in changes);
    if (touchedAway && (socketsByUser.get(userId)?.size || 0) === 0) {
      clearAutoAwayTimer(userId);
      scheduleAutoAway(userId);
    }
  });

  highlightRulesService.on('change', ({ userId }) => {
    fanOut(userId, { kind: 'highlight-rules-changed' });
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
    if (!set) return;
    for (const ws of [...set]) {
      try { ws.close(1000, 'user removed'); } catch (_) { /* ignore */ }
    }
    socketsByUser.delete(userId);
    clearAutoAwayTimer(userId);
  });

  function parseSinceParam(rawUrl) {
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

  function authenticateRequest(req) {
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

  httpServer.on('upgrade', (req, socket, head) => {
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
      ws.userId = user.id;
      ws.sinceId = initialSinceId;
      ws.presence = { visible: false };
      addSocket(user.id, ws);
      onConnection(ws, user);
    });
  });

  function onConnection(ws, user) {
    sendSnapshot(ws, user.id);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        send(ws, { kind: 'error', text: 'invalid json' });
        return;
      }
      handleClientMessage(ws, user, msg);
    });

    ws.on('close', () => removeSocket(user.id, ws));
    ws.on('error', () => removeSocket(user.id, ws));
  }

  function sendSnapshot(ws, userId, freshNetworkId = null) {
    const networks = ircManager.snapshotForUser(userId);
    send(ws, { kind: 'snapshot', networks });
    // Drafts ship once per snapshot, separate from per-buffer backlog frames —
    // the keying is global to the user, not per-buffer, so a single message is
    // cheaper than fanning a body field into every backlog row.
    send(ws, { kind: 'draft-snapshot', drafts: draftsService.snapshotForUser(userId) });
    const readState = listReadStateForUser(userId);
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
        } else if (closed.has(`${conn.network.id}::${target}`)
            && !conn.channels.has(target.toLowerCase())) {
          continue;
        }
        // Resume cursor: ship only the gap (id > sinceId) when the client has
        // local state to merge with. Cap at 500 — a wider net than the
        // 200-row first-connect default — to cover longer flaps without
        // unbounded payloads. If the gap is larger than 500, the client's
        // dedupe still makes a later full re-fetch safe.
        const sinceId = ws.sinceId || 0;
        const events = (
          sinceId > 0 && !isFreshNetwork
            ? listMessages(conn.network.id, target, { afterId: sinceId, limit: 500 })
            : listMessages(conn.network.id, target, { limit: 200 })
        ).map((e) => decorateMessage(userId, e));
        for (const e of events) {
          if (e.id != null && e.id > maxSentId) maxSentId = e.id;
        }
        const speakers = listSpeakers(conn.network.id, target);
        const lastReadId = readState[`${conn.network.id}::${target}`] || 0;
        const counts = computeUnreadFor(userId, conn.network.id, target, lastReadId);
        // Per-buffer input history is unbounded on disk; ship a recent slice
        // for up-arrow recall. Older entries stay in the DB and could be
        // paginated in later if the slice ever proves too small.
        const inputHistory = listRecentInputHistory(userId, conn.network.id, target, 200);
        send(ws, {
          kind: 'backlog',
          networkId: conn.network.id,
          target,
          events,
          speakers,
          // For channels: are we currently joined? Drives the dim/active style
          // in the buffer list. Non-channel buffers (DMs, :server:) have no
          // join concept — flag them as joined so they never get dimmed.
          joined: target.startsWith('#') ? conn.channels.has(target.toLowerCase()) : true,
          lastReadId: counts.lastReadId,
          unread: counts.unread,
          highlights: counts.highlights,
          highlightsCapped: counts.highlightsCapped,
          inputHistory,
        });
      }
    }
    // Advance the resume cursor past everything we just shipped, so the next
    // sendSnapshot (in-band 'snapshot' request, or another IRC-state trigger)
    // resumes from where this snapshot left off.
    ws.sinceId = maxSentId;
  }

  function handleClientMessage(ws, user, msg) {
    const userId = user.id;
    // Any message that carries a networkId must reference a network the caller
    // owns. Handlers below trust msg.networkId, so the check belongs here at
    // the boundary rather than at each call site. Messages without a
    // networkId (presence, snapshot, away, back) fall through.
    if (msg && msg.networkId !== undefined && msg.networkId !== null) {
      const networkId = Number(msg.networkId);
      if (!Number.isInteger(networkId) || !ownsNetwork(userId, networkId)) {
        send(ws, { kind: 'error', text: 'unknown network' });
        // Surface the failure on the originating send/action so the client
        // can stop pretending the message succeeded.
        if (msg.clientId && (msg.type === 'send' || msg.type === 'action')) {
          send(ws, { kind: 'send-result', clientId: msg.clientId, ok: false, error: 'unknown-network' });
        }
        return;
      }
      msg.networkId = networkId;
    }
    switch (msg.type) {
      case 'presence':
        ws.presence = { visible: !!msg.visible };
        break;
      case 'send': {
        const ok = ircManager.send(userId, msg.networkId, msg.target, msg.text);
        if (msg.clientId) {
          send(ws, { kind: 'send-result', clientId: msg.clientId, ok, error: ok ? undefined : 'not-connected' });
        }
        break;
      }
      case 'action': {
        const ok = ircManager.action(userId, msg.networkId, msg.target, msg.text);
        if (msg.clientId) {
          send(ws, { kind: 'send-result', clientId: msg.clientId, ok, error: ok ? undefined : 'not-connected' });
        }
        break;
      }
      case 'join':
        ircManager.joinChannel(userId, msg.networkId, msg.channel);
        break;
      case 'part':
        ircManager.partChannel(userId, msg.networkId, msg.channel, msg.reason);
        break;
      case 'close-buffer': {
        const networkId = Number(msg.networkId);
        const target = typeof msg.target === 'string' ? msg.target : '';
        // Server pseudo-buffer can't be closed (it's the per-network log).
        if (!networkId || !target || target.startsWith(':server:')) break;
        closeBuffer(userId, networkId, target);
        if (target.startsWith('#')) {
          // Send PART if connected; partChannel also flips channels.joined=0.
          // If disconnected, partChannel is a no-op, so explicitly mark the
          // channel as not-joined here to keep it from auto-rejoining the
          // next time the network connects.
          if (!ircManager.partChannel(userId, networkId, target, msg.reason)) {
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
        ircManager.getConnection(userId, msg.networkId)?.raw(msg.line);
        break;
      case 'probe-presence': {
        // Client just activated a DM — refresh its presence cache so the
        // banner/sidebar dim reflect current state rather than whatever stale
        // value was last broadcast. The whois reply is silent (no server-
        // buffer dump); just the side effect of updating presence.
        if (!msg.networkId) break;
        const nick = typeof msg.nick === 'string' ? msg.nick : '';
        if (!nick) break;
        ircManager.probePresence(userId, msg.networkId, nick);
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
        try { conn.raw('LIST'); }
        catch (_) { chanlistInFlight.delete(networkId); }
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
          query, sortBy, sortDir, offset, limit,
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
        const message = (msg.message || '').trim();
        if (!message) ircManager.clearAwayAll(userId, { autoSet: false });
        else ircManager.setAwayAll(userId, message, { autoSet: false });
        break;
      }
      case 'back':
        ircManager.clearAwayAll(userId, { autoSet: false });
        break;
      case 'typing':
        ircManager.typing(userId, msg.networkId, msg.target, msg.state);
        break;
      case 'mark-read': {
        const networkId = Number(msg.networkId);
        const target = msg.target;
        const requested = Number(msg.messageId);
        if (!networkId || !target || !Number.isFinite(requested) || requested <= 0) break;
        const lastReadId = setReadState(userId, networkId, target, requested);
        broadcastReadState(userId, networkId, target, lastReadId);
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
        const targets = msg.targets.filter((t) => typeof t === 'string' && t);
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
        const notifyAlways = !!msg.notifyAlways;
        setChannelNotifyAlways(userId, networkId, target, notifyAlways);
        fanOut(userId, {
          kind: 'channel-notify-changed',
          networkId,
          target,
          notifyAlways,
        });
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
        const conn = ircManager.getConnection(userId, msg.networkId);
        if (!conn) {
          send(ws, { kind: 'error', text: 'network not connected' });
          break;
        }
        const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
        const mode = typeof msg.mode === 'string' ? msg.mode : 'before';
        const token = msg.token ?? null;
        const speakers = listSpeakers(msg.networkId, msg.target);
        const baseReply = {
          kind: 'history',
          networkId: msg.networkId,
          target: msg.target,
          mode,
          token,
          speakers,
        };

        if (mode === 'around') {
          // Detached jump path. The DB lookup enforces (networkId, target);
          // we reject :server: pseudo-buffers up front since they don't carry
          // jumpable per-message anchors.
          if (typeof msg.target === 'string' && msg.target.startsWith(':server:')) {
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
          const slice = listMessagesAround(msg.networkId, msg.target, anchorId, halfLimit);
          const events = slice.events.map((e) => decorateMessage(userId, e));
          send(ws, {
            ...baseReply,
            anchorId,
            events,
            hasMoreOlder: slice.hasMoreOlder,
            hasMoreNewer: slice.hasMoreNewer,
            anchorMissing: !!slice.anchorMissing,
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
          const events = listMessages(msg.networkId, msg.target, { afterId, limit })
            .map((e) => decorateMessage(userId, e));
          const newestId = events.length ? events[events.length - 1].id : afterId;
          send(ws, {
            ...baseReply,
            afterId,
            events,
            hasMoreNewer: hasNewerRow(msg.networkId, msg.target, newestId),
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
          const events = listMessages(msg.networkId, msg.target, { limit })
            .map((e) => decorateMessage(userId, e));
          const oldestId = events.length ? events[0].id : 0;
          send(ws, {
            ...baseReply,
            events,
            hasMoreOlder: oldestId > 0 && hasOlderRow(msg.networkId, msg.target, oldestId),
            hasMoreNewer: false,
            hasMore: oldestId > 0 && hasOlderRow(msg.networkId, msg.target, oldestId),
            before: null,
          });
          break;
        }

        // 'before' (default, legacy). Reply keeps the historical `hasMore`
        // field set to hasMoreOlder so older clients keep working.
        const before = msg.before ? Number(msg.before) : undefined;
        const events = listMessages(msg.networkId, msg.target, { before, limit })
          .map((e) => decorateMessage(userId, e));
        const hasMoreOlder = events.length === limit;
        send(ws, {
          ...baseReply,
          before: msg.before || null,
          events,
          hasMoreOlder,
          hasMoreNewer: false,
          hasMore: hasMoreOlder,
        });
        break;
      }
      case 'search': {
        // Full-text message search. The networkId boundary guard above already
        // validated ownership when a network filter is present; searchMessages
        // scopes the global case to the caller's own networks via the networks
        // join, so no extra access-control check is needed here.
        const limit = Math.min(Math.max(Number(msg.limit) || 50, 1), 100);
        const results = searchMessages(userId, {
          query: typeof msg.query === 'string' ? msg.query : '',
          networkId: msg.networkId || undefined,
          target: typeof msg.target === 'string' && msg.target ? msg.target : undefined,
          nick: typeof msg.nick === 'string' && msg.nick ? msg.nick : undefined,
          before: msg.before ? Number(msg.before) : undefined,
          limit,
        }).map((e) => decorateMessage(userId, e));
        send(ws, {
          kind: 'search-result',
          // Echoed so the client can drop results for a superseded query.
          token: msg.token ?? null,
          results,
          hasMore: results.length === limit,
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
