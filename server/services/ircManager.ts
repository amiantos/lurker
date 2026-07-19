// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { EventEmitter } from 'events';
import { IrcConnection } from './ircConnection.js';
import * as systemLog from './systemLog.js';
import connectScheduler from './connectScheduler.js';
import {
  listNetworksForUser,
  getNetwork,
  listChannels,
  upsertChannel,
  deleteChannel,
} from '../db/networks.js';
import { DCC_ACTIVE_STATES, getDccTransfer, updateDccTransferState } from '../db/dccTransfers.js';
import { findUserById } from '../db/users.js';
import { isNetworkHostAllowed } from './networkPolicy.js';
import { getUserAwayState, writeAwayMarker, writeBackMarker } from '../db/userAwayState.js';
import { listPinnedForUser } from '../db/pinnedBuffers.js';
import { listCollapsedForUser } from '../db/nicklistCollapsed.js';
import { listChannelNotifyForUser } from '../db/channelNotify.js';
import { listAllRulesForUser } from '../db/ignoredMasks.js';
import type { IgnoreRuleRow, IgnoreRuleInput } from '../db/ignoredMasks.js';
import ignoreRulesService from './ignoreRulesService.js';
import {
  listForUserGrouped as listNickNotesGrouped,
  setNote as setNickNoteRow,
  getNote as getNickNoteRow,
} from '../db/nickNotes.js';
import type { NoteResult } from '../db/nickNotes.js';
import {
  listForUserGrouped as listRelayBotsGrouped,
  setRelayBot as setRelayBotRow,
  removeRelayBot as removeRelayBotRow,
} from '../db/relayBots.js';
import type { RelayBotResult } from '../db/relayBots.js';
import {
  createContact,
  updateContactMeta,
  setContactTargets,
  deleteContact as deleteContactRow,
  getContact,
  listContactsForUser,
  findContactIdByTarget,
} from '../db/contacts.js';
import type { ContactRecord } from '../db/contacts.js';
import { splitSay, splitAction, hasInteriorNewline } from './messageSplit.js';
import { e2eManager } from './e2e/manager.js';
import { contextKey, isChannelContext } from './e2e/context.js';
import { e2eDbg } from './e2e/debug.js';
import db from '../db/index.js';

// RPE2E is wired for real IRC channels only in this phase (#382). DM
// pseudochannels (`@ident@host`) need the peer's server-stamped handle resolved
// at send time, which the outbound path doesn't have yet — they're a fast-follow.

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

// Plan the JOINs for auto-rejoin on (re)registration. A tight loop of single
// JOINs trips Libera's per-connection flood limit ("Closing Link: ... (Excess
// Flood)"), so channels coalesce into comma-separated JOIN lines chunked well
// under the 512-byte cap. Keyed and keyless channels go in SEPARATE lines:
// keyed lines carry a positional key list (JOIN #a,#b k_a,k_b), so keeping each
// keyed line all-keyed means every key lines up 1:1 with its channel — no
// cross-type alignment to get wrong. Pure + export-only so it's unit-testable
// without a socket; the caller maps each op to client.join(channels, keys).
export function planChannelRejoins(
  channels: Array<{ name: string; key: string | null }>,
): Array<{ channels: string; keys?: string }> {
  const MAX = 400;
  const ops: Array<{ channels: string; keys?: string }> = [];

  // Keyed channels: batch with an aligned key list. Budget both the channel and
  // key lists plus the single space that joins them on the wire.
  let names: string[] = [];
  let keys: string[] = [];
  let namesLen = 0;
  let keysLen = 0;
  const flushKeyed = () => {
    if (names.length > 0) ops.push({ channels: names.join(','), keys: keys.join(',') });
    names = [];
    keys = [];
    namesLen = 0;
    keysLen = 0;
  };
  for (const c of channels) {
    if (!c.key) continue;
    const addName = names.length === 0 ? c.name.length : c.name.length + 1;
    const addKey = keys.length === 0 ? c.key.length : c.key.length + 1;
    if (namesLen + addName + 1 + keysLen + addKey > MAX && names.length > 0) flushKeyed();
    names.push(c.name);
    keys.push(c.key);
    namesLen += names.length === 1 ? c.name.length : c.name.length + 1;
    keysLen += keys.length === 1 ? c.key.length : c.key.length + 1;
  }
  flushKeyed();

  // Keyless channels: names only.
  let chunk: string[] = [];
  let len = 0;
  const flush = () => {
    if (chunk.length > 0) ops.push({ channels: chunk.join(',') });
    chunk = [];
    len = 0;
  };
  for (const c of channels) {
    if (c.key) continue;
    const add = chunk.length === 0 ? c.name.length : c.name.length + 1;
    if (len + add > MAX && chunk.length > 0) flush();
    chunk.push(c.name);
    len += add;
  }
  flush();

  return ops;
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
    // Bulk path — cold-start autoconnect (via initAll) and un-pause resume. The
    // herd of connects this fans out is exactly what issue #236 throttles, so
    // route it through the per-host scheduler. Interactive single-network
    // connect/reconnect routes call startNetwork directly (deferrable omitted)
    // and stay immediate.
    for (const network of listNetworksForUser(userId)) {
      if (network.autoconnect) this.startNetwork(userId, network.id, { deferrable: true });
    }
  }

  initAll(): void {
    const userIds = db
      .prepare('SELECT DISTINCT user_id AS id FROM networks')
      .all()
      .map((r) => (r as { id: number }).id);
    for (const id of userIds) this.initForUser(id);
  }

  startNetwork(
    userId: number,
    networkId: number,
    opts: { deferrable?: boolean } = {},
  ): IrcConnection | null {
    // Paused accounts never hold a live IRC connection. This single gate is the
    // linchpin of the pause feature: it covers boot-time autoconnect
    // (initForUser → initAll), the explicit connect/reconnect routes, and
    // restartNetwork — so a paused user can produce no IRC traffic no matter
    // which path is taken. The boundary guards (REST/WS) exist only to return a
    // clean "account paused" instead of a silent no-op.
    if (findUserById(userId)?.is_paused) return null;
    const network = getNetwork(networkId, userId);
    if (!network) return null;
    // The instance network lockdown (#298), gated in the same place and for the
    // same reason as the pause check above: every connect path funnels through
    // here, so one check covers boot-time autoconnect, the connect/reconnect
    // routes and restartNetwork. Gating only the create route would leave the
    // lockdown trivially bypassable by anyone who already had the network — and
    // would do nothing at all on the next restart, when initAll reconnects it.
    if (!isNetworkHostAllowed(network.host)) return null;
    let conn = this.getConnection(userId, networkId);
    if (conn) return conn;

    conn = new IrcConnection({
      network,
      onEvent: (event) => this.emit('event', event),
    });
    this.connectionsForUser(userId).set(networkId, conn);
    // Seed self-presence from the per-user truth before the IRC handshake. The
    // 'registered' handler in IrcConnection re-asserts AWAY off of this state,
    // so it must be in place before connect() resolves the socket. Safe to set
    // now even when the actual connect() is deferred — it only mutates
    // in-memory state and publishes (no AWAY emitted while disconnected).
    conn.applyAwayState(awayStateFromRow(getUserAwayState(userId) as AwayStateRow | null));

    const connRef = conn;
    // Open the socket. Logged here (not at enqueue) so the "Starting connection"
    // line lands when the connect actually fires, and revalidated because a
    // deferred launch may have sat in the scheduler queue while the connection
    // was paused/suspended, disposed, stopped, or replaced by restartNetwork —
    // in every one of those cases the user's map no longer points at this exact
    // object, so we bail instead of opening an orphan socket.
    const launch = (): void => {
      if (this.getConnection(userId, networkId) !== connRef || connRef.disposed) return;
      systemLog.log({
        userId,
        scope: `net:${network.name}`,
        fields: { networkId },
        text: `Starting connection to ${network.host}:${network.port}${network.tls ? ' (TLS)' : ''}`,
      });
      connRef.connect();
    };
    if (opts.deferrable) {
      // Stagger bulk (re)connects per destination host so a fleet-wide restart
      // doesn't flood one IRC network from our IP. See connectScheduler / #236.
      connectScheduler.schedule(network.host, launch);
    } else {
      launch();
    }
    conn.client.on('registered', () => {
      const joined = listChannels(networkId).filter((c) => c.joined);
      const names = joined.map((c) => c.name);
      if (names.length > 0) {
        systemLog.log({
          userId,
          scope: `net:${network.name}`,
          fields: { networkId },
          text: `Auto-joining ${names.length} ${names.length === 1 ? 'channel' : 'channels'}: ${names.join(', ')}`,
        });
      }
      for (const op of planChannelRejoins(joined)) connRef.join(op.channels, op.keys);
    });

    return conn;
  }

  stopNetwork(userId: number, networkId: number, reason?: string): void {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return;
    systemLog.log({
      userId,
      scope: `net:${conn.network.name}`,
      fields: { networkId },
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
      fields: { networkId },
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

  joinChannel(userId: number, networkId: number, name: string, key?: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    // Coerce the key to a safe string-or-undefined once, up front. The ws/HTTP
    // join payloads are unvalidated, so a non-string (e.g. a number) can reach
    // here — it must not flow into upsertChannel → encryptSecret (which throws
    // on a non-string and, on the unguarded ws path, would take down the shared
    // cell process). An empty string coerces to undefined too, so a keyless
    // re-join preserves a stored key instead of wiping it (soju does the same);
    // a key that no longer applies is cleared by the MODE -k handler, not here.
    const safeKey = typeof key === 'string' && key !== '' ? key : undefined;
    // Persist the key (encrypted at rest) so the channel auto-rejoins keyed
    // after a reconnect/restart.
    upsertChannel(networkId, name, true, safeKey);
    // The closed flag is cleared by the channel-joined echo (wsHub), NOT here.
    // Clearing it on the request assumes the join lands on the channel we asked
    // for, which a forwarding server (470) breaks: the buffer for the requested
    // name gets un-closed while the join actually goes somewhere else, so a
    // channel you can never be in becomes a buffer you can never close.
    conn.join(name, safeKey);
    return true;
  }

  partChannel(userId: number, networkId: number, name: string, reason?: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    upsertChannel(networkId, name, false);
    // Don't touch closed_buffers here. The /close flow runs closeBuffer +
    // partChannel back to back, so reopening the buffer inside partChannel
    // would silently undo the close. Stale closed entries from the old
    // /part-as-close-buffer code path are cleared by a successful rejoin, when
    // the channel-joined echo reaches wsHub.
    conn.part(name, reason);
    return true;
  }

  forgetChannel(userId: number, networkId: number, name: string): void {
    deleteChannel(networkId, name);
  }

  // DCC transfer actions (#270 phase 2). Each loads the user-scoped row, finds the
  // connection for its network, and routes the action there (the connection holds
  // the live receiver + the WS push). Accept needs a live connection (it dials the
  // bot); reject/cancel fall back to a DB-only state flip when disconnected.
  acceptDccTransfer(
    userId: number,
    transferId: number,
  ): 'ok' | 'not-found' | 'not-connected' | 'not-pending' {
    const row = getDccTransfer(userId, transferId);
    if (!row) return 'not-found';
    // Only an unsolicited offer still awaiting a decision can be accepted. A row
    // that already moved on (receiving/completed/…) would be a silent no-op in
    // acceptPendingDcc, so reject it here and let the route surface a 409 rather
    // than a misleading 200 that looks successful to a stale client.
    if (row.state !== 'pending_approval') return 'not-pending';
    const conn = this.getConnection(userId, row.network_id);
    if (!conn) return 'not-connected';
    conn.acceptPendingDcc(row);
    return 'ok';
  }

  rejectDccTransfer(userId: number, transferId: number): boolean {
    const row = getDccTransfer(userId, transferId);
    if (!row) return false;
    const conn = this.getConnection(userId, row.network_id);
    // The connected path applies its own state guard; the disconnected DB-only
    // fallback must mirror it so a late reject can't clobber a terminal row.
    if (conn) conn.rejectDcc(transferId);
    else if (row.state === 'pending_approval' || row.state === 'requested')
      updateDccTransferState(transferId, 'rejected');
    return true;
  }

  cancelDccTransfer(userId: number, transferId: number): boolean {
    const row = getDccTransfer(userId, transferId);
    if (!row) return false;
    const conn = this.getConnection(userId, row.network_id);
    if (conn) conn.cancelDcc(transferId);
    else if (DCC_ACTIVE_STATES.has(row.state)) updateDccTransferState(transferId, 'cancelled');
    return true;
  }

  // Long messages need to be split: irc-framework breaks anything past ~350
  // bytes into separate PRIVMSGs on the wire, but we used to publish the full
  // text as a single self-message event — so the sender saw one bubble while
  // peers saw N. Splitting on our side and publishing per chunk keeps the
  // local view symmetric with what was actually transmitted.
  send(userId: number, networkId: number, target: string, text: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;

    // RPE2E: on an encryption-enabled channel, transmit ciphertext chunks on the
    // wire but show the SENDER the readable plaintext locally (one bubble, lock
    // flag). encryptOutgoing handles its own chunking, so this path bypasses the
    // multiline/splitSay plumbing entirely. 'disabled' falls through to plaintext;
    // 'error' must NOT fall through (that would leak cleartext on an E2E channel).
    if (isChannelContext(target)) {
      const outcome = e2eManager.encryptOutgoing(userId, networkId, contextKey(target, ''), text);
      e2eDbg(
        () =>
          `outbound ${target}: ${outcome.kind}` +
          (outcome.kind === 'encrypted' ? ` (${outcome.lines.length} line(s))` : ''),
      );
      // A lazy rotation (from /e2e revoke or /e2e rotate) regenerates the key
      // inside encryptOutgoing and queues a REKEY for each remaining trusted
      // peer; ship them now, while this channel's membership is current. Safe on
      // every outcome kind — the queue is empty unless a rotation actually fired.
      conn.flushE2eRekeys();
      if (outcome.kind === 'error') {
        conn.publishEphemeral({
          type: 'e2e',
          level: 'warn',
          target,
          text: `not sent — encryption failed: ${outcome.reason}`,
        });
        // Return false so the composer surfaces a send-failure toast and KEEPS
        // the text (vs clearing it), instead of relying only on the easily-missed
        // ephemeral line. This is leak-safe: the early return — not the boolean —
        // is what prevents a cleartext fallthrough, and the client never retries
        // a failed send as plaintext.
        return false;
      }
      if (outcome.kind === 'encrypted') {
        for (const line of outcome.lines) conn.say(target, line);
        conn.publish({
          type: 'message',
          target,
          nick: conn.client.user?.nick,
          text,
          kind: 'privmsg',
          self: true,
          e2e: true,
        });
        return true;
      }
      // kind === 'disabled' → fall through to the normal plaintext send below.
    }
    // A multi-line compose rides draft/multiline batches where the server
    // supports the cap: it lands as one logical message per batch (the body is
    // partitioned to the server's limits, so a big paste is N messages, not N
    // raw lines), and the sender echoes one bubble per batch to match. Networks
    // without the cap fall through to the per-line split that mirrors what
    // irc-framework actually puts on the wire. We gate on an INTERIOR newline
    // (not a bare newline) so "hello\n" stays a single-line send — splitMultiline
    // trims edge blanks, and the client's multilineMessageCount gates the same
    // way, so the two stay in sync. (#381)
    if (hasInteriorNewline(text) && conn.supportsMultiline()) {
      const nick = conn.client.user?.nick;
      for (const echo of conn.sendMultiline(target, text)) {
        conn.publish({ type: 'message', target, nick, text: echo, kind: 'privmsg', self: true });
      }
      return true;
    }
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

  // On an E2E-enabled channel, /me actions and notices have no interoperable
  // encrypted form: the RPE2E wire format carries only encrypted PRIVMSG bodies,
  // and repartee likewise can't decrypt an encrypted ACTION/NOTICE. Rather than
  // silently leak cleartext on a channel the user believes is encrypted, refuse
  // the send and say so inline. Encrypted actions are a future protocol feature.
  private refuseCleartextOnE2eChannel(
    conn: IrcConnection,
    userId: number,
    networkId: number,
    target: string,
    kind: 'action' | 'notice',
  ): boolean {
    if (!isChannelContext(target)) return false;
    if (!e2eManager.isChannelEnabled(userId, networkId, contextKey(target, ''))) return false;
    conn.publishEphemeral({
      type: 'e2e',
      level: 'warn',
      target,
      text: `${kind === 'action' ? '/me actions' : 'notices'} aren't encrypted yet — not sent on this E2E channel`,
    });
    return true;
  }

  action(userId: number, networkId: number, target: string, text: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    if (this.refuseCleartextOnE2eChannel(conn, userId, networkId, target, 'action')) return true;
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

  // IRC servers don't echo your own NOTICE back (and Lurker doesn't request the
  // echo-message cap), so — exactly like send/action — we publish a self copy
  // locally per wire chunk. splitSay applies because NOTICE shares PRIVMSG's
  // length budget.
  notice(userId: number, networkId: number, target: string, text: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    if (this.refuseCleartextOnE2eChannel(conn, userId, networkId, target, 'notice')) return true;
    const chunks = splitSay(text);
    for (const chunk of chunks) {
      conn.notice(target, chunk);
      conn.publish({
        type: 'notice',
        target,
        nick: conn.client.user?.nick,
        text: chunk,
        kind: 'notice',
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

  // RPE2E command surface (#382). Dispatches a `/e2e …` subcommand on a live
  // connection (handshakes/config/trust); the connection publishes its own
  // ephemeral status output to the issuing buffer. Returns false only when the
  // network isn't connected, so the WS layer can tell the user.
  e2eCommand(userId: number, networkId: number, target: string, argLine: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.runE2eCommand(target, argLine);
    return true;
  }

  probePresence(userId: number, networkId: number, nick: string): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.probePresence(nick);
    return true;
  }

  // Send an outbound CTCP request (/ctcp, /ping). `issuingTarget` is the buffer
  // the command came from so the reply routes back there. Returns false when the
  // network isn't connected (no wire to send on).
  ctcpRequest(
    userId: number,
    networkId: number,
    issuingTarget: string,
    target: string,
    type: string,
    args: string,
  ): boolean {
    const conn = this.getConnection(userId, networkId);
    if (!conn) return false;
    conn.sendCtcpRequest(issuingTarget, target, type, args);
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
    // Away is user-scoped (every connection), so the system buffer is its home.
    // Past the no-op guards above, this only fires on a real transition — not on
    // per-connection reconnect re-asserts (those call applyAwayState directly).
    systemLog.log({
      userId,
      scope: 'away',
      text: autoSet ? `Auto-away: ${trimmed}` : `You're now marked away: ${trimmed}`,
    });
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
    systemLog.log({
      userId,
      scope: 'away',
      text: autoSet ? 'Auto-away cleared — welcome back' : "You're no longer marked away",
    });
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

  // Pause: tear down the user's live IRC connections but leave their WS sockets
  // and session untouched — the opposite of disposeUser, which fires right
  // before a row delete and closes everything. A paused user keeps read-only
  // access; only their IRC presence goes away. Emits 'user-suspended' so wsHub
  // can flip already-open tabs into read-only in place. Call setUserPaused(id,
  // true) BEFORE this so the startNetwork gate won't immediately re-establish
  // anything (e.g. an in-flight reconnect timer).
  suspendUser(userId: number): void {
    const userMap = this.byUser.get(userId);
    if (userMap) {
      for (const conn of userMap.values()) {
        try {
          // disconnect(), NOT dispose(): dispose() sets disposed=true before the
          // QUIT, which makes publish() swallow the 'disconnected' state event —
          // so the still-open client (pause keeps the WS) would keep showing the
          // network as connected. disconnect() leaves publish() live, so the
          // socket-close handler's setState('disconnected') reaches the client,
          // and it quits with DEFAULT_QUIT_MESSAGE rather than a "paused" reason.
          // (dispose()'s disposed-guard matters for deletion, where a late write
          // would hit a FK violation; here the row stays, so it's harmless.)
          conn.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      this.byUser.delete(userId);
    }
    this.emit('user-suspended', { userId });
  }

  // Resume: re-establish autoconnect networks for an account that was just
  // un-paused. Call AFTER setUserPaused(id, false) so the startNetwork gate
  // lets the connections through. Emits 'user-resumed' so wsHub clears the
  // read-only banner on open tabs.
  resumeUser(userId: number): void {
    this.initForUser(userId);
    this.emit('user-resumed', { userId });
  }

  shutdown(): void {
    // Drop any queued (not-yet-fired) connect launches first — otherwise a
    // staggered launch could fire against a connection we're about to tear down.
    connectScheduler.reset();
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
    const relayBotsByNetwork = listRelayBotsGrouped(userId);
    // Attach the per-network user-preference blobs to a base snapshot. Shared by
    // the live-connection and offline branches so both shapes stay identical.
    const withExtras = <T extends { networkId: number }>(snap: T) => {
      const networkId = snap.networkId;
      return {
        ...snap,
        pinned: pinsByNetwork.get(networkId) || [],
        collapsedNicklists: collapsedByNetwork.get(networkId) || {},
        channelNotify: notifyByNetwork.get(networkId) || {},
        ignoredMasks: ignoresByNetwork.get(networkId) || [],
        nickNotes: notesByNetwork.get(networkId) || [],
        relayBots: relayBotsByNetwork.get(networkId) || [],
      };
    };
    const live = this.listConnections(userId);
    const liveIds = new Set(live.map((conn) => conn.network.id));
    const out: unknown[] = live.map((conn) => withExtras(conn.snapshot()));
    // Networks with no live connection (paused account, manually disconnected,
    // or never autoconnected) still own persisted buffers. Synthesize a
    // disconnected blob matching conn.snapshot()'s shape so the client renders
    // their buffers read-only (state !== 'connected' drives the dim styling)
    // instead of hiding them until a connection exists. Buffer rows themselves
    // arrive via the backlog frames, so channels can be empty here — members
    // are meaningless offline and topic/members repopulate on reconnect.
    for (const net of listNetworksForUser(userId)) {
      if (liveIds.has(net.id)) continue;
      out.push(
        withExtras({
          networkId: net.id,
          state: 'disconnected',
          nick: net.nick,
          userModes: '',
          lagMs: null,
          away: null,
          channels: [],
          peerPresence: {},
        }),
      );
    }
    return out;
  }

  // networkId null = a global rule (applies on every network); a number scopes
  // it to that one. The default at the command/UI layer is global (#350).
  addIgnore(
    userId: number,
    networkId: number | null,
    rule: IgnoreRuleInput,
  ): { ok: false; error: string } | { ok: true; id: number; created: boolean } {
    return ignoreRulesService.add(userId, networkId, rule);
  }

  removeIgnore(
    userId: number,
    networkId: number | null,
    by: { id?: number; mask?: string },
  ): boolean | number {
    if (typeof by.id === 'number') return ignoreRulesService.removeById(userId, networkId, by.id);
    if (by.mask) return ignoreRulesService.removeByMask(userId, networkId, by.mask);
    return false;
  }

  /** One network's own rules (excludes globals). */
  listIgnoredFor(userId: number, networkId: number): IgnoreRuleRow[] {
    return ignoreRulesService.list(userId, networkId);
  }

  /** The user's global rules (apply on every network). */
  listGlobalIgnoresFor(userId: number): IgnoreRuleRow[] {
    return ignoreRulesService.listGlobal(userId);
  }

  setNickNote(userId: number, networkId: number, nick: string, note: string): NoteResult | null {
    return setNickNoteRow({ userId, networkId, nick, note });
  }

  getNickNote(userId: number, networkId: number, nick: string): NoteResult | null {
    return getNickNoteRow({ userId, networkId, nick });
  }

  // Mark/unmark a relay bot (#277). Returns the stored row when marked, or null
  // after clearing the mark — the verb maps that to `marked`.
  setRelayBot(
    userId: number,
    networkId: number,
    nick: string,
    marked: boolean,
    pattern: string,
  ): RelayBotResult | null {
    if (!marked) {
      removeRelayBotRow({ userId, networkId, nick });
      return null;
    }
    return setRelayBotRow({ userId, networkId, nick, pattern });
  }

  listContacts(userId: number): ContactRecord[] {
    return listContactsForUser(userId);
  }

  // Create or update a contact and its per-network watch targets, then apply the
  // target diff to live connections so MONITOR starts/stops without a reconnect.
  // Targets are filtered to the caller's own networks, and a given (network,
  // nick) maps to at most one contact (others keep it). Returns the saved record,
  // or null if editing a contact the caller doesn't own.
  setContact(
    userId: number,
    input: {
      contactId?: number | null;
      displayName: string;
      notifyOnline: boolean;
      targets: Array<{ networkId: number; nick: string; isPrimary?: boolean }>;
    },
  ): ContactRecord | null {
    const displayName = (input.displayName || '').trim();
    if (!displayName) {
      throw Object.assign(new Error('displayName is empty'), { code: 'invalid_input' });
    }
    const ownedNetworkIds = new Set(listNetworksForUser(userId).map((n) => n.id));
    const cleaned: Array<{ networkId: number; nick: string; isPrimary: boolean }> = [];
    for (const t of input.targets || []) {
      const networkId = Number(t.networkId);
      const nick = typeof t.nick === 'string' ? t.nick.trim() : '';
      if (!nick || !ownedNetworkIds.has(networkId)) continue;
      const lower = nick.toLowerCase();
      // (network, nick) maps to at most one contact, and no exact dupes within
      // this contact's own list — but multiple nicks on one network are allowed.
      const owner = findContactIdByTarget(userId, networkId, nick);
      if (owner != null && owner !== input.contactId) continue;
      if (cleaned.some((c) => c.networkId === networkId && c.nick.toLowerCase() === lower))
        continue;
      cleaned.push({ networkId, nick, isPrimary: !!t.isPrimary });
    }
    // Exactly one primary — the DM that opens when the friend is clicked. Honor
    // the flagged target if one survived filtering; otherwise the first.
    if (cleaned.length) {
      const wanted = cleaned.find((t) => t.isPrimary);
      cleaned.forEach((t) => (t.isPrimary = false));
      (wanted ?? cleaned[0]).isPrimary = true;
    }

    let contactId = input.contactId ?? null;
    let prevTargets: Array<{ networkId: number; nick: string; isPrimary: boolean }> = [];
    if (contactId != null) {
      const existing = getContact(contactId, userId);
      if (!existing) return null;
      prevTargets = existing.targets;
      updateContactMeta({ contactId, userId, displayName, notifyOnline: !!input.notifyOnline });
    } else {
      contactId = createContact({ userId, displayName, notifyOnline: !!input.notifyOnline });
    }
    setContactTargets(contactId, cleaned);
    this.applyContactTargetDiff(userId, contactId, prevTargets, cleaned);
    return getContact(contactId, userId);
  }

  deleteContact(userId: number, contactId: number): boolean {
    const existing = getContact(contactId, userId);
    if (!existing) return false;
    for (const t of existing.targets) {
      this.getConnection(userId, t.networkId)?.untrackFriend(t.nick);
    }
    return deleteContactRow(contactId, userId);
  }

  // Track newly-added targets and untrack removed ones on the matching live
  // connection (keyed by network+lowernick). Targets present in both are left
  // alone — their friend watch is unchanged.
  private applyContactTargetDiff(
    userId: number,
    contactId: number,
    prev: Array<{ networkId: number; nick: string }>,
    next: Array<{ networkId: number; nick: string }>,
  ): void {
    const keyOf = (t: { networkId: number; nick: string }) =>
      `${t.networkId}::${t.nick.toLowerCase()}`;
    const prevKeys = new Set(prev.map(keyOf));
    const nextKeys = new Set(next.map(keyOf));
    for (const t of prev) {
      if (nextKeys.has(keyOf(t))) continue;
      this.getConnection(userId, t.networkId)?.untrackFriend(t.nick);
    }
    for (const t of next) {
      if (prevKeys.has(keyOf(t))) continue;
      this.getConnection(userId, t.networkId)?.trackFriend(t.nick, contactId);
    }
  }
}

// Group every ignore row for a user by network so snapshotForUser can attach
// them to the matching per-network blob in one pass (mirrors the listPinned /
// listCollapsed shape).
function ignoresGrouped(userId: number): Map<number, IgnoreRuleRow[]> {
  const out = new Map<number, IgnoreRuleRow[]>();
  for (const row of listAllRulesForUser(userId)) {
    const { networkId, ...rule } = row;
    // Global rules (networkId null) ride a separate snapshot field, not a
    // per-network blob — skip them here.
    if (networkId == null) continue;
    const list = out.get(networkId);
    if (list) list.push(rule);
    else out.set(networkId, [rule]);
  }
  return out;
}

const ircManager = new IrcManager();
export default ircManager;
