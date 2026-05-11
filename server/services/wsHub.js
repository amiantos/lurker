import { WebSocketServer } from 'ws';
import cookie from 'cookie';
import cookieParser from 'cookie-parser';
import ircManager from './ircManager.js';
import settingsService from './settingsService.js';
import highlightRulesService from './highlightRulesService.js';
import * as pushService from './pushService.js';
import { findSession } from '../db/sessions.js';
import { findUserById } from '../db/users.js';
import { listMessages, listBufferTargets, listSpeakers, countNewer, countHighlightsNewer } from '../db/messages.js';
import { listReadStateForUser, setReadState } from '../db/bufferReads.js';
import { addEntry as addInputHistory, listRecent as listRecentInputHistory } from '../db/inputHistory.js';
import {
  closeBuffer,
  reopenBuffer,
  isClosed,
  closedKeySetForUser,
} from '../db/closedBuffers.js';
import { upsertChannel } from '../db/networks.js';
import { getUserSettings } from '../db/settings.js';
import { defaultsAsObject } from './settingsRegistry.js';
import { SESSION_COOKIE } from '../middleware/auth.js';

function effectiveSetting(userId, key) {
  const overrides = getUserSettings(userId);
  if (key in overrides) return overrides[key];
  return defaultsAsObject()[key];
}

// "afk since 2026-05-09 15:30:00-0500" — mirrors screen_away.py's default
// time_format. Local time + numeric tz offset.
function fmtAwayTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const aoff = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(aoff / 60))}${pad(aoff % 60)}`
  );
}

function buildAutoAwayMessage(userId) {
  const base = (effectiveSetting(userId, 'away.auto.message') || 'afk').trim() || 'afk';
  return `${base} since ${fmtAwayTimestamp(new Date())}`;
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
// backlog reads. This decoration only adds the per-broadcast `dm` flag and
// normalizes the match fields so non-persisted events (typing, names, etc.)
// don't surface as undefined.
function decorateMessage(userId, event) {
  if (!event || typeof event !== 'object') return event;
  const matched = !!event.matched;
  const matchedRuleId = event.matchedRuleId ?? null;
  const dm = isDirect(event) && !event.self;
  return { ...event, matched, matchedRuleId, dm };
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
    for (const ws of set) {
      if (opts.exceptWs && ws === opts.exceptWs) continue;
      if (ws.readyState === ws.OPEN) ws.send(json);
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

  function maybePush(userId, decorated) {
    if (!decorated || (!decorated.matched && !decorated.dm)) return;
    if (decorated.self) return;
    if (userHasVisibleClient(userId)) return;
    const network = ircManager.getConnection(userId, decorated.networkId)?.network;
    pushService.deliver(userId, {
      kind: decorated.dm ? 'dm' : 'highlight',
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
      if (!reopens) return;
      reopenBuffer(decorated.userId, decorated.networkId, target);
      fanOut(decorated.userId, {
        kind: 'buffer-reopened',
        networkId: decorated.networkId,
        target,
      });
    }
    fanOut(decorated.userId, { ...decorated, kind: 'irc' });
    maybePush(decorated.userId, decorated);

    // After an IRC (re)connect, only auto-rejoined channels fire JOIN events,
    // so any buffer the user had parted (or any buffer that simply pre-dates
    // the live session) wouldn't otherwise reappear in the client's buffer
    // list until a page refresh. Re-emit a fresh snapshot to every active
    // socket so the buffer list always reflects the server's source of truth.
    if (event.type === 'state' && event.state === 'connected') {
      const set = socketsByUser.get(event.userId);
      if (set) {
        for (const ws of set) {
          if (ws.readyState === ws.OPEN) sendSnapshot(ws, event.userId);
        }
      }
    }
  });

  settingsService.on('event', ({ userId, changes, resetAll }) => {
    fanOut(userId, { kind: 'settings', changes: changes || {}, resetAll: !!resetAll });
    // If the user toggled / shortened auto-away while disconnected, re-evaluate
    // the pending timer with the new value.
    const touchedAway = resetAll
      || (changes && ('away.auto.enabled' in changes || 'away.auto.delay_seconds' in changes));
    if (touchedAway && (socketsByUser.get(userId)?.size || 0) === 0) {
      clearAutoAwayTimer(userId);
      scheduleAutoAway(userId);
    }
  });

  highlightRulesService.on('change', ({ userId }) => {
    fanOut(userId, { kind: 'highlight-rules-changed' });
  });

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
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
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

  function sendSnapshot(ws, userId) {
    const networks = ircManager.snapshotForUser(userId);
    send(ws, { kind: 'snapshot', networks });
    const readState = listReadStateForUser(userId);
    const closed = closedKeySetForUser(userId);
    for (const conn of ircManager.listConnections(userId)) {
      const targets = new Set(listBufferTargets(conn.network.id));
      targets.add(`:server:${conn.network.id}`);
      // Currently-joined channels are always shown — they take precedence over
      // a stale closed flag (shouldn't normally exist since joining clears it,
      // but defensive against autorejoin/state races).
      for (const ch of conn.channels.values()) targets.add(ch.name);
      for (const target of targets) {
        if (target.startsWith(':server:')) {
          // Server pseudo-buffer is uncloseable — never filter.
        } else if (closed.has(`${conn.network.id}::${target}`)
            && !conn.channels.has(target.toLowerCase())) {
          continue;
        }
        const events = listMessages(conn.network.id, target, { limit: 50 })
          .map((e) => decorateMessage(userId, e));
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
  }

  function handleClientMessage(ws, user, msg) {
    const userId = user.id;
    switch (msg.type) {
      case 'presence':
        ws.presence = { visible: !!msg.visible };
        break;
      case 'send':
        ircManager.send(userId, msg.networkId, msg.target, msg.text);
        break;
      case 'action':
        ircManager.action(userId, msg.networkId, msg.target, msg.text);
        break;
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
        }
        fanOut(userId, { kind: 'buffer-closed', networkId, target });
        break;
      }
      case 'snapshot':
        sendSnapshot(ws, userId);
        break;
      case 'raw':
        ircManager.getConnection(userId, msg.networkId)?.raw(msg.line);
        break;
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
        // Counts are guaranteed 0/0 here (we just advanced the pointer to the
        // requested id, and the requested id is the client's view of the
        // current max), but recompute to handle the race where a new message
        // arrived between client send and server apply.
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
      case 'history': {
        const conn = ircManager.getConnection(userId, msg.networkId);
        if (!conn) {
          send(ws, { kind: 'error', text: 'network not connected' });
          break;
        }
        const limit = Math.min(Math.max(Number(msg.limit) || 100, 1), 500);
        const events = listMessages(msg.networkId, msg.target, {
          before: msg.before ? Number(msg.before) : undefined,
          limit,
        }).map((e) => decorateMessage(userId, e));
        const speakers = listSpeakers(msg.networkId, msg.target);
        send(ws, {
          kind: 'history',
          networkId: msg.networkId,
          target: msg.target,
          before: msg.before || null,
          events,
          hasMore: events.length === limit,
          speakers,
        });
        break;
      }
      default:
        send(ws, { kind: 'error', text: `unknown message type: ${msg.type}` });
    }
  }

  return wss;
}
