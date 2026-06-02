// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { IrcConnection } from './ircConnection.js';
import * as systemLog from './systemLog.js';
import {
  listNetworksForUser,
  getNetwork,
  listChannels,
  upsertChannel,
  deleteChannel,
} from '../db/networks.js';
import { reopenBuffer } from '../db/closedBuffers.js';
import { getUserAwayState, writeAwayMarker, writeBackMarker } from '../db/userAwayState.js';
import { listPinnedForUser } from '../db/pinnedBuffers.js';
import { listCollapsedForUser } from '../db/nicklistCollapsed.js';
import { listChannelNotifyForUser } from '../db/channelNotify.js';
import {
  addMask as addIgnoreRow,
  removeMask as removeIgnoreRow,
  listMasks as listIgnoreRows,
  listAllForUser as listAllIgnoreRows,
} from '../db/ignoredMasks.js';
import {
  listForUserGrouped as listNickNotesGrouped,
  setNote as setNickNoteRow,
  getNote as getNickNoteRow,
} from '../db/nickNotes.js';
import type { NoteResult } from '../db/nickNotes.js';
import { splitSay, splitAction } from './messageSplit.js';
import db from '../db/index.js';

// User away state row shape from userAwayState.ts (that file isn't typed yet).
interface AwayStateRow {
  away_datetime: string | null;
  back_datetime: string | null;
  away_message: string | null;
  auto_set: number | null;
}

// Translate a user_away_state row into the in-memory shape IrcConnection
// holds. Used both for seeding a brand-new connection on construction and
// when a returning client triggers a snapshot.
function awayStateFromRow(row: AwayStateRow | null) {
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
  byUser: Map<number, Map<number, IrcConnection>>;

  constructor() {
    super();
    this.byUser = new Map();
  }

  connectionsForUser(userId: number): Map<number, IrcConnection> {
    let m = this.byUser.get(userId);
    if (!m) {
      m = new Map();
      this.byUser.set(userId, m);
    }
    return m;
  }

  getConnection(userId: number, networkId: number): IrcConnection | null {
    return this.byUser.get(userId)?.get(networkId) || null;
  }

  listConnections(userId: number): IrcConnection[] {
    return Array.from(this.connectionsForUser(userId).values());
  }

  initForUser(userId: number): void {
    for (const network of listNetworksForUser(userId)) {
      if (network.autoconnect) this.startNetwork(userId, network.id);
    }
  }

  initAll(): void {
    const userIds = db
      .prepare('SELECT DISTINCT user_id AS id FROM networks')
      .all()
      .map((r) => (r as { id: number }).id);
    for (const id of userIds) this.initForUser(id);
  }

  startNetwork(userId: number, networkId: number): IrcConnection | null {
    const network = getNetwork(networkId, userId);
    if (!network) return null;
    let conn = this.getConnection(userId, networkId);
    if (conn) return conn;

    conn = new IrcConnection({
      network,
      onEvent: (event) => this.emit('event', event),
    });
    this.connectionsForUser(userId).set(networkId, conn);
    systemLog.log({
      userId,
      scope: `net:${network.name}`,
      text: `Starting connection to ${network.host}:${network.port}${network.tls ? ' (TLS)' : ''}`,
    });
    // Seed self-presence from the per-user truth before the IRC handshake. The
    // 'registered' handler in IrcConnection re-asserts AWAY off of this state,
    // so it must be in place before connect() resolves the socket.
    conn.applyAwayState(awayStateFromRow(getUserAwayState(userId) as AwayStateRow | null));
    conn.connect();

    const connRef = conn;
    conn.client.on('registered', () => {
      const names = listChannels(networkId)
        .filter((c) => c.joined)
        .map((c) => c.name);
      if (names.length > 0) {
        systemLog.log({
          userId,
          scope: `net:${network.name}`,
          text: `Auto-joining ${names.length} ${names.length === 1 ? 'channel' : 'channels'}: ${names.join(', ')}`,
        });
      }
      // Send JOINs as comma-separated batches per IRC line. A tight loop of
      // single JOINs trips Libera's per-connection flood limit ("Closing Link:
      // ... (Excess Flood)"), so we coalesce into one line and chunk well under
      // the 512-byte IRC line cap.
      const MAX = 400;
      let chunk: string[] = [];
      let len = 0;
      for (const name of names) {
        const add = chunk.length === 0 ? name.length : name.length + 1;
        if (len + add > MAX && chunk.length > 0) {
          connRef.join(chunk.join(','));
          chunk = [];
          len = 0;
        }
        chunk.push(name);
        len += add;
      }
      if (chunk.length > 0) connRef.join(chunk.join(','));
    });

    return conn;
  }

  stopNetwork(userId: number, networkId: number, reason?: string): void {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    systemLog.log({
      userId,
      scope: `net:${conn.network.name}`,
      text: reason ? `Stopping: ${reason}` : 'Stopping',
    });
    conn.disconnect(reason);
    this.connectionsForUser(userId).delete(networkId);
  }

  disposeNetwork(userId: number, networkId: number, reason?: string): void {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    systemLog.log({
      userId,
      scope: `net:${conn.network.name}`,
      text: reason ? `Disposing: ${reason}` : 'Disposing',
    });
    conn.dispose(reason);
    this.connectionsForUser(userId).delete(networkId);
  }

  // Force a fresh connection: dispose the existing IrcConnection (if any) and
  // start a new one against the latest DB row. Use this both for the user's
  // explicit "reconnect" action and after editing connection-relevant fields,
  // since startNetwork is a no-op when a connection object already exists in
  // the map (even if it's in a disconnected state).
  restartNetwork(
    userId: number,
    networkId: number,
    reason: string = 'reconnecting',
  ): IrcConnection | null {
    this.disposeNetwork(userId, networkId, reason);
    return this.startNetwork(userId, networkId);
  }

  joinChannel(userId: number, networkId: number, name: string): boolean {
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

  partChannel(userId: number, networkId: number, name: string, reason?: string): boolean {
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

  forgetChannel(userId: number, networkId: number, name: string): void {
    deleteChannel(networkId, name);
  }

  // Long messages need to be split: irc-framework breaks anything past ~350
  // bytes into separate PRIVMSGs on the wire, but we used to publish the full
  // text as a single self-message event — so the sender saw one bubble while
  // peers saw N. Splitting on our side and publishing per chunk keeps the
  // local view symmetric with what was actually transmitted.
  send(userId: number, networkId: number, target: string, text: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    const chunks = splitSay(text);
    for (const chunk of chunks) {
      conn.say(target, chunk);
      conn.publish({
        type: 'message',
        target,
        nick: conn.client.user?.nick,
        text: chunk,
        kind: 'privmsg',
        self: true,
      });
    }
    return true;
  }

  action(userId: number, networkId: number, target: string, text: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    const chunks = splitAction(text);
    for (const chunk of chunks) {
      conn.action(target, chunk);
      conn.publish({
        type: 'action',
        target,
        nick: conn.client.user?.nick,
        text: chunk,
        self: true,
      });
    }
    return true;
  }

  typing(userId: number, networkId: number, target: string, state: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    if (!target || target.startsWith(':server:')) return false;
    if (!['active', 'paused', 'done'].includes(state)) return false;
    conn.sendTyping(target, state);
    return true;
  }

  probePresence(userId: number, networkId: number, nick: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.probePresence(nick);
    return true;
  }

  // Canonical /away writer. Persists the user-level state in user_away_state,
  // then fans the new state out to every IrcConnection so each one issues
  // AWAY on its IRC server and publishes an away-state event. Auto-away
  // (autoSet=true) is gated by the persisted current state so it can never
  // overwrite a manual /away. Returns the count of connections that received
  // the update.
  // `since` backdates the away timestamp — auto-away passes the moment the user
  // went idle rather than when the timer fired (#155). Manual /away omits it and
  // gets "now".
  setAwayAll(
    userId: number,
    message: string,
    { autoSet = false, since }: { autoSet?: boolean; since?: Date } = {},
  ): number {
    const trimmed = (message || '').trim();
    if (!trimmed) return 0;
    const current = getUserAwayState(userId) as AwayStateRow | null;
    const currentlyAway = !!(current && current.away_datetime && !current.back_datetime);
    if (currentlyAway && !current!.auto_set && autoSet) return 0;
    const awayAt = (since ?? new Date()).toISOString();
    writeAwayMarker(userId, { awayDatetime: awayAt, awayMessage: trimmed, autoSet });
    const state = { active: true, message: trimmed, since: awayAt, autoSet, backAt: null };
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
  clearAwayAll(userId: number, { autoSet = false } = {}): number {
    const current = getUserAwayState(userId) as AwayStateRow | null;
    const currentlyAway = !!(current && current.away_datetime && !current.back_datetime);
    if (!currentlyAway) return 0;
    if (autoSet && !current!.auto_set) return 0;
    const now = new Date().toISOString();
    writeBackMarker(userId, now);
    const state = {
      active: false,
      message: current!.away_message,
      since: current!.away_datetime,
      autoSet: !!current!.auto_set,
      backAt: now,
    };
    let n = 0;
    for (const conn of this.listConnections(userId)) {
      conn.applyAwayState(state);
      n += 1;
    }
    return n;
  }

  // Tear down all IRC connections for a user and drop their byUser entry.
  // Called *before* a user-row delete so the in-memory IrcConnections stop
  // firing publish() / insertMessage() for now-deleted network_ids — without
  // this, an incoming PRIVMSG between the delete and the next reconnect
  // crashes the process on a FOREIGN KEY violation against networks(id).
  // Emits 'user-disposed' so other subsystems (wsHub) can clean up too.
  disposeUser(userId: number, reason: string = 'user deleted'): void {
    const userMap = this.byUser.get(userId);
    if (userMap) {
      for (const conn of userMap.values()) {
        try {
          conn.dispose(reason);
        } catch (_) {
          /* ignore */
        }
      }
      this.byUser.delete(userId);
    }
    this.emit('user-disposed', { userId });
  }

  shutdown(): void {
    for (const userMap of this.byUser.values()) {
      for (const conn of userMap.values()) {
        try {
          conn.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
    }
    this.byUser.clear();
  }

  snapshotForUser(userId: number): unknown[] {
    const pinsByNetwork = listPinnedForUser(userId);
    const collapsedByNetwork = listCollapsedForUser(userId);
    const notifyByNetwork = listChannelNotifyForUser(userId);
    const ignoresByNetwork = ignoresGrouped(userId);
    const notesByNetwork = listNickNotesGrouped(userId);
    return this.listConnections(userId).map((conn) => {
      const snap = conn.snapshot();
      const pinned = pinsByNetwork.get(snap.networkId) || [];
      const collapsedNicklists = collapsedByNetwork.get(snap.networkId) || {};
      const channelNotify = notifyByNetwork.get(snap.networkId) || {};
      const ignoredMasks = ignoresByNetwork.get(snap.networkId) || [];
      const nickNotes = notesByNetwork.get(snap.networkId) || [];
      return { ...snap, pinned, collapsedNicklists, channelNotify, ignoredMasks, nickNotes };
    });
  }

  addIgnore(userId: number, networkId: number, mask: string): unknown {
    return addIgnoreRow({ userId, networkId, mask });
  }

  removeIgnore(userId: number, networkId: number, mask: string): unknown {
    return removeIgnoreRow({ userId, networkId, mask });
  }

  listIgnoredFor(userId: number, networkId: number): unknown {
    return listIgnoreRows({ userId, networkId });
  }

  setNickNote(userId: number, networkId: number, nick: string, note: string): NoteResult | null {
    return setNickNoteRow({ userId, networkId, nick, note });
  }

  getNickNote(userId: number, networkId: number, nick: string): NoteResult | null {
    return getNickNoteRow({ userId, networkId, nick });
  }
}

// Group every ignore row for a user by network so snapshotForUser can attach
// them to the matching per-network blob in one pass (mirrors the listPinned /
// listCollapsed shape).
function ignoresGrouped(userId: number): Map<number, { mask: string; createdAt: string }[]> {
  const out = new Map<number, { mask: string; createdAt: string }[]>();
  for (const row of listAllIgnoreRows(userId)) {
    const list = out.get(row.networkId);
    const entry = { mask: row.mask, createdAt: row.createdAt };
    if (list) list.push(entry);
    else out.set(row.networkId, [entry]);
  }
  return out;
}

const ircManager = new IrcManager();
export default ircManager;
