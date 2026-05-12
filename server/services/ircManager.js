import { EventEmitter } from 'events';
import { IrcConnection } from './ircConnection.js';
import { listNetworksForUser, getNetwork, listChannels, upsertChannel, deleteChannel } from '../db/networks.js';
import { reopenBuffer } from '../db/closedBuffers.js';
import { getUserAwayState, writeAwayMarker, writeBackMarker } from '../db/userAwayState.js';
import db from '../db/index.js';

// Translate a user_away_state row into the in-memory shape IrcConnection
// holds. Used both for seeding a brand-new connection on construction and
// when a returning client triggers a snapshot.
function awayStateFromRow(row) {
  if (!row || !row.away_datetime) {
    return { active: false, message: null, since: null, autoSet: false, backAt: null };
  }
  return {
    active: !row.back_datetime,
    message: row.away_message,
    since: row.away_datetime,
    autoSet: !!row.auto_set,
    backAt: row.back_datetime,
  };
}

class IrcManager extends EventEmitter {
  constructor() {
    super();
    this.byUser = new Map();
  }

  _userMap(userId) {
    let m = this.byUser.get(userId);
    if (!m) {
      m = new Map();
      this.byUser.set(userId, m);
    }
    return m;
  }

  getConnection(userId, networkId) {
    return this.byUser.get(userId)?.get(networkId) || null;
  }

  listConnections(userId) {
    return Array.from(this._userMap(userId).values());
  }

  initForUser(userId) {
    for (const network of listNetworksForUser(userId)) {
      if (network.autoconnect) this.startNetwork(userId, network.id);
    }
  }

  initAll() {
    const userIds = db.prepare('SELECT DISTINCT user_id AS id FROM networks').all().map((r) => r.id);
    for (const id of userIds) this.initForUser(id);
  }

  startNetwork(userId, networkId) {
    const network = getNetwork(networkId, userId);
    if (!network) return null;
    let conn = this.getConnection(userId, networkId);
    if (conn) return conn;

    conn = new IrcConnection({
      network,
      onEvent: (event) => this.emit('event', event),
    });
    this._userMap(userId).set(networkId, conn);
    // Seed self-presence from the per-user truth before the IRC handshake. The
    // 'registered' handler in IrcConnection re-asserts AWAY off of this state,
    // so it must be in place before connect() resolves the socket.
    conn.applyAwayState(awayStateFromRow(getUserAwayState(userId)));
    conn.connect();

    conn.client.on('registered', () => {
      const names = listChannels(networkId).filter((c) => c.joined).map((c) => c.name);
      // Send JOINs as comma-separated batches per IRC line. A tight loop of
      // single JOINs trips Libera's per-connection flood limit ("Closing Link:
      // ... (Excess Flood)"), so we coalesce into one line and chunk well under
      // the 512-byte IRC line cap.
      const MAX = 400;
      let chunk = [];
      let len = 0;
      for (const name of names) {
        const add = chunk.length === 0 ? name.length : name.length + 1;
        if (len + add > MAX && chunk.length > 0) {
          conn.join(chunk.join(','));
          chunk = [];
          len = 0;
        }
        chunk.push(name);
        len += add;
      }
      if (chunk.length > 0) conn.join(chunk.join(','));
    });

    return conn;
  }

  stopNetwork(userId, networkId, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    conn.disconnect(reason);
    this._userMap(userId).delete(networkId);
  }

  disposeNetwork(userId, networkId, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    conn.dispose(reason);
    this._userMap(userId).delete(networkId);
  }

  // Force a fresh connection: dispose the existing IrcConnection (if any) and
  // start a new one against the latest DB row. Use this both for the user's
  // explicit "reconnect" action and after editing connection-relevant fields,
  // since startNetwork is a no-op when a connection object already exists in
  // the map (even if it's in a disconnected state).
  restartNetwork(userId, networkId, reason = 'reconnecting') {
    this.disposeNetwork(userId, networkId, reason);
    return this.startNetwork(userId, networkId);
  }

  joinChannel(userId, networkId, name) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, true);
    // Joining is an explicit "I want this buffer back" — clear any stale
    // closed flag from a prior close. The matching channel-joined event will
    // recreate the buffer in clients via the normal flow.
    reopenBuffer(userId, networkId, name);
    conn.join(name);
    return true;
  }

  partChannel(userId, networkId, name, reason) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, false);
    // Don't touch closed_buffers here. The /close flow runs closeBuffer +
    // partChannel back to back, so reopening the buffer inside partChannel
    // would silently undo the close. Stale closed entries from the old
    // /part-as-close-buffer code path can still be cleared by /join (which
    // calls reopenBuffer explicitly).
    conn.part(name, reason);
    return true;
  }

  forgetChannel(userId, networkId, name) {
    deleteChannel(networkId, name);
  }

  send(userId, networkId, target, text) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.say(target, text);
    conn.publish({
      type: 'message',
      target,
      nick: conn.client.user?.nick,
      text,
      kind: 'privmsg',
      self: true,
    });
    return true;
  }

  action(userId, networkId, target, text) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.action(target, text);
    conn.publish({
      type: 'action',
      target,
      nick: conn.client.user?.nick,
      text,
      self: true,
    });
    return true;
  }

  typing(userId, networkId, target, state) {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    if (!target || target.startsWith(':server:')) return false;
    if (!['active', 'paused', 'done'].includes(state)) return false;
    conn.sendTyping(target, state);
    return true;
  }

  // Canonical /away writer. Persists the user-level state in user_away_state,
  // then fans the new state out to every IrcConnection so each one issues
  // AWAY on its IRC server and publishes an away-state event. Auto-away
  // (autoSet=true) is gated by the persisted current state so it can never
  // overwrite a manual /away. Returns the count of connections that received
  // the update.
  setAwayAll(userId, message, { autoSet = false } = {}) {
    const trimmed = (message || '').trim();
    if (!trimmed) return 0;
    const current = getUserAwayState(userId);
    const currentlyAway = !!(current && current.away_datetime && !current.back_datetime);
    if (currentlyAway && !current.auto_set && autoSet) return 0;
    const now = new Date().toISOString();
    writeAwayMarker(userId, { awayDatetime: now, awayMessage: trimmed, autoSet });
    const state = { active: true, message: trimmed, since: now, autoSet, backAt: null };
    let n = 0;
    for (const conn of this.listConnections(userId)) {
      conn.applyAwayState(state);
      n += 1;
    }
    return n;
  }

  // Canonical /back writer. Records back_datetime against the existing
  // user_away_state row (away_datetime/away_message/auto_set are preserved so
  // the client can render the completed pair) and pushes the new state to
  // every connection. Auto-clear (autoSet=true) is a no-op when the current
  // away was manual; that's how scheduleAutoAway → socket-reconnect leaves a
  // manual /away undisturbed.
  clearAwayAll(userId, { autoSet = false } = {}) {
    const current = getUserAwayState(userId);
    const currentlyAway = !!(current && current.away_datetime && !current.back_datetime);
    if (!currentlyAway) return 0;
    if (autoSet && !current.auto_set) return 0;
    const now = new Date().toISOString();
    writeBackMarker(userId, now);
    const state = {
      active: false,
      message: current.away_message,
      since: current.away_datetime,
      autoSet: !!current.auto_set,
      backAt: now,
    };
    let n = 0;
    for (const conn of this.listConnections(userId)) {
      conn.applyAwayState(state);
      n += 1;
    }
    return n;
  }

  shutdown() {
    for (const userMap of this.byUser.values()) {
      for (const conn of userMap.values()) {
        try { conn.disconnect(); } catch (_) { /* ignore */ }
      }
    }
    this.byUser.clear();
  }

  snapshotForUser(userId) {
    return this.listConnections(userId).map((conn) => conn.snapshot());
  }
}

const ircManager = new IrcManager();
export default ircManager;
