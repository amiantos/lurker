// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: Elastic-2.0

import IRC, { ircLineParser } from 'irc-framework';
import { insertMessage, hasMessageForTarget, listBufferTargets } from '../db/messages.js';
import { upsertChannel } from '../db/networks.js';
import { isClosed as isBufferClosed } from '../db/closedBuffers.js';
import * as chanlistDb from '../db/chanlist.js';
import {
  getPeerPresence,
  listPeerPresenceForNetwork,
  writePeerState,
  deletePeerPresence,
} from '../db/peerPresence.js';
import highlightRulesService from './highlightRulesService.js';
import { matchEvent } from './highlightEngine.js';
import { IRC_VERSION, APP_VERSION } from '../utils/userAgent.js';

// Shown to peers as the QUIT reason on a clean disconnect. Most IRC clients
// surface this in JOIN/PART messages, so it doubles as a Lurker
// announcement — gives operators a quick read on what client + version is
// being used. Per-disconnect overrides (network removal, no-nick failure,
// etc.) pass their own reason and bypass this default.
const DEFAULT_QUIT_MESSAGE =
  `Lurker ${APP_VERSION} (the truth is out there) https://github.com/amiantos/lurker`;

const NON_PERSISTED_TYPES = new Set([
  'state', 'names', 'channel-joined', 'channel-parted', 'typing', 'away-state',
  'channel-modes', 'lag', 'peer-presence',
]);

function isDmTargetName(target) {
  if (!target) return false;
  return !target.startsWith('#') && !target.startsWith(':server:');
}

function extractExtras(event) {
  switch (event.type) {
    case 'kick': return { kicked: event.kicked };
    case 'nick': return { newNick: event.newNick };
    case 'mode': return { modes: event.modes };
    default: return null;
  }
}

// Canonical nick!ident@hostname string used for client-side hostmask ignore
// matching. Missing parts are left empty rather than starred — the client's
// glob matcher handles either form, and storing the literal observed value
// keeps the data honest. Returns null when there's no nick (server events).
function buildUserhost(event) {
  if (!event || !event.nick) return null;
  const ident = event.ident || '';
  const host = event.hostname || '';
  if (!ident && !host) return null;
  return `${event.nick}!${ident}@${host}`;
}

function memberSnapshot(m) {
  return {
    nick: m.nick,
    modes: m.modes,
    away: !!m.away,
    user: m.user || null,
    host: m.host || null,
  };
}

export class IrcConnection {
  constructor({ network, onEvent }) {
    this.network = network;
    this.onEvent = onEvent;
    // `version` is the string irc-framework returns in response to CTCP
    // VERSION queries — without this, peers see the library's default
    // "node.js irc-framework". Identifying as Lurker lets server operators
    // tell our traffic apart from generic library bots.
    this.client = new IRC.Client({ version: IRC_VERSION });
    this.client.requestCap('message-tags');
    this.state = 'disconnected';
    this.channels = new Map();
    this.userModes = new Set();
    this.awayState = { active: false, message: null, since: null, autoSet: false, backAt: null };
    // Lowercase nicks we treat as "this user has a DM buffer with them",
    // used to gate the per-peer presence writes so we don't churn the DB
    // (and the WS broadcast stream) on every JOIN/QUIT for an unrelated
    // user on a busy network. Hydrated on 'registered' from message history
    // and grown as new DM activity arrives.
    this.trackedDmPeers = new Set();
    // MONITOR (IRCv3) is the presence transport. `useMonitor` is set once
    // ISUPPORT confirms the server speaks it; `monitorLimit` is the per-
    // connection watch cap. `pendingMonitorSeed` flips true on 'registered'
    // so the 'server options' handler knows to bulk-add the tracked DM
    // peers once ISUPPORT arrives. Networks without MONITOR get no presence
    // tracking — by design, no WHOIS fallback.
    this.useMonitor = false;
    this.monitorLimit = 0;
    this.pendingMonitorSeed = false;
    this.disposed = false;
    this.lagMs = null;
    this.lagPingTimer = null;
    this.lagPendingToken = null;
    this.lagPendingSentAt = 0;
    // Pre-registration nick-fallback state. Counts ERR_NICKNAMEINUSE hits while
    // we're still trying to register; resets on every (re)connect so each socket
    // gets a fresh ladder. Once 'registered' fires we stop auto-falling back,
    // because a later 'nick in use' is the user's own /nick attempt.
    this.preRegistered = true;
    this.nickAttempt = 0;
    // Nick-regain state. When set, we're sitting on a fallback nick and have a
    // server-side MONITOR watch on the configured primary. Cleared once we
    // reclaim it, or the user manually picks a different nick, or the socket
    // dies. `pendingRegainSetup` defers the actual MONITOR + until ISUPPORT
    // tells us the server supports it (005 arrives after 001/'registered').
    this.regainNick = null;
    this.pendingRegainSetup = false;
    this.bind();
  }

  publishUserModes() {
    this.publish({
      type: 'usermode',
      target: this.serverTarget(),
      modes: [...this.userModes].join(''),
    });
  }

  publishAwayState() {
    const a = this.awayState;
    // Emit the full pair whenever we have ANY away history (since set). The
    // client uses active+since to anchor the "you went away" divider and
    // backAt to anchor the "you came back" divider, so both timestamps must
    // ship even after the user returns.
    const away = a.since
      ? { active: a.active, since: a.since, message: a.message, autoSet: a.autoSet, backAt: a.backAt }
      : null;
    this.publish({ type: 'away-state', target: this.serverTarget(), away });
  }

  shouldPersist(event) {
    if (!event.target) return false;
    return !NON_PERSISTED_TYPES.has(event.type);
  }

  publish(event) {
    if (this.disposed) return;
    const time = event.time || new Date().toISOString();
    const enriched = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };

    if (this.shouldPersist(event)) {
      // Run the highlight engine before persisting so the match decision is
      // stored on the row. The cheap path (engine gates on type & self) keeps
      // this off the hot path for non-highlightable events.
      let matchedRuleId = null;
      try {
        const compiled = highlightRulesService.getCompiled(this.network.user_id);
        const { matched, ruleId } = matchEvent(event, compiled);
        if (matched) matchedRuleId = ruleId;
      } catch (e) {
        console.warn('[highlight] match-on-insert failed:', e?.message || e);
      }
      const { id, alt } = insertMessage({
        networkId: this.network.id,
        target: event.target,
        time,
        type: event.type,
        nick: event.nick,
        text: event.text,
        kind: event.kind,
        self: event.self,
        extra: extractExtras(event),
        matchedRuleId,
        userhost: event.userhost ?? null,
      });
      enriched.id = id;
      enriched.alt = alt;
      enriched.matched = matchedRuleId != null;
      enriched.matchedRuleId = matchedRuleId;
    }

    this.onEvent(enriched);
  }

  publishEphemeral(event) {
    if (this.disposed) return;
    this.onEvent({
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time: event.time || new Date().toISOString(),
    });
  }

  setState(state, extra = {}) {
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
  }

  bind() {
    const c = this.client;

    // Surface server numerics (welcome banner, lusers, SASL confirmation,
    // umode, hostmask) into the server buffer. irc-framework consumes these
    // for internal state and emits structured events ('registered', 'server
    // options', …) without re-emitting the original text, so the raw stream
    // is the only place the wire text is still visible. See
    // formatServerNumeric() for the per-command rendering and the deliberate
    // exclusions (005/ISUPPORT, etc.).
    c.on('raw', (event) => {
      if (!event?.from_server || typeof event.line !== 'string') return;
      let msg;
      try { msg = ircLineParser(event.line); } catch (_) { return; }
      const text = formatServerNumeric(msg);
      if (!text) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    c.on('registered', (event) => {
      this.userModes.clear();
      this.lagMs = null;
      // From here on, 'nick in use' is the user's /nick attempt — not us racing
      // to register. Freeze the fallback ladder.
      this.preRegistered = false;
      // irc-framework's command-handler fires its 'all' proxy (which routes
      // events to us via the client) BEFORE its own specific-event listener
      // that updates `c.user.nick` to the registered nick. So at this moment
      // `c.user.nick` is still the configured primary — useless for detecting
      // fallback. Take the confirmed nick straight from the RPL_WELCOME payload.
      const registeredNick = event?.nick || c.user.nick;
      const fallbackUsed = this.nickAttempt > 0 && registeredNick !== this.network.nick;
      this.startLagPinger();
      // Hydrate the DM-peer tracking set from open DM buffers — the union
      // of (a) targets we have any persisted history with and (b) targets
      // not in closed_buffers for this user. Closed DMs explicitly opted
      // out, so we don't track them until the user reopens. Filtering here
      // (not later) means we never write peer_presence_state rows for
      // closed buffers in the first place.
      this.trackedDmPeers.clear();
      try {
        for (const target of listBufferTargets(this.network.id)) {
          if (!isDmTargetName(target)) continue;
          if (isBufferClosed(this.network.user_id, this.network.id, target)) continue;
          this.trackedDmPeers.add(target.toLowerCase());
        }
      } catch (e) {
        console.warn('[presence] hydrate failed:', e?.message || e);
      }
      this.setState('connected', { nick: registeredNick });
      // Defer the MONITOR + handshake until ISUPPORT tells us the server
      // supports it (same pattern the nick-regain watch uses). 005 always
      // follows 001, so the 'server options' handler trips shortly after.
      // Without MONITOR there is no presence tracking on this network —
      // by design, no WHOIS fallback.
      this.pendingMonitorSeed = true;
      if (fallbackUsed) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          text: `Connected as ${registeredNick} (configured nick ${this.network.nick} was unavailable).`,
        });
        // Defer the MONITOR + handshake until ISUPPORT tells us the server
        // supports it. 005 always follows 001, so the 'server options' handler
        // below will trip soon.
        this.regainNick = this.network.nick;
        this.pendingRegainSetup = true;
      }
      // Summary line for CAP negotiation. irc-framework doesn't re-emit the
      // CAP LS/REQ/ACK wire lines individually, but by the time 'registered'
      // fires the negotiated set is final on network.cap.enabled.
      try {
        const enabled = (c.network?.cap?.enabled || []).slice().sort();
        if (enabled.length > 0) {
          this.publish({
            type: 'motd',
            target: this.serverTarget(),
            text: `Negotiated capabilities: ${enabled.join(' ')}`,
          });
        }
      } catch (_) { /* ignore */ }
      try {
        highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, registeredNick);
      } catch (e) {
        console.warn('[highlight] failed to upsert auto nick rule:', e?.message || e);
      }
      // Re-assert /away on reconnect so the IRC server keeps showing us as
      // away — both manual and auto-away. For auto, if a client returns soon
      // after, the socket-reconnect path runs clearAwayAll({autoSet:true}) and
      // clears it cleanly; if not, staying away across an IRC blip is the
      // correct behavior.
      if (this.awayState.active && this.awayState.message) {
        try { this.client.raw('AWAY :' + this.awayState.message); } catch (_) { /* ignore */ }
      }
    });
    c.on('close', () => {
      this.userModes.clear();
      this.stopLagPinger();
      this.lagMs = null;
      // Next socket starts a fresh fallback ladder from the configured nick.
      this.preRegistered = true;
      this.nickAttempt = 0;
      // Drop the regain watch — the new socket will re-evaluate from scratch
      // after re-registering. (MONITOR state is server-side and dies with the
      // connection, so no explicit `MONITOR -` is needed here.)
      this.regainNick = null;
      this.pendingRegainSetup = false;
      // Same for the DM peer watches: server-side MONITOR list dies with
      // the socket, so the next 'server options' will re-seed from scratch.
      // The DB-backed peer_presence_state survives so reconnect can render
      // "X went offline at <prior time>" markers without losing the anchor.
      this.useMonitor = false;
      this.monitorLimit = 0;
      this.pendingMonitorSeed = false;
      this.setState('disconnected');
    });

    // ERR_NICKNAMEINUSE while we're still racing to register. Climb the
    // fallback ladder (nick1, nick2, …, nick9) until the server accepts a
    // NICK or we exhaust attempts. Post-registration hits are user-driven
    // /nick attempts — surface a notice and leave the user in control.
    c.on('nick in use', (event) => {
      const requested = event?.nick || '';
      if (!this.preRegistered) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          text: `Nick ${requested} is already in use.`,
        });
        return;
      }
      const next = computeFallbackNick(this.network.nick, this.nickAttempt);
      this.nickAttempt += 1;
      if (!next) {
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: `Nick ${this.network.nick} and all numeric fallbacks are taken; giving up. Edit the network to pick a different nick.`,
        });
        try { this.client.quit('No available nickname'); } catch (_) { /* ignore */ }
        return;
      }
      try { this.client.changeNick(next); } catch (_) { /* ignore */ }
    });

    // ISUPPORT (numeric 005) — irc-framework re-emits this once per line as
    // it accumulates options. We use it to defer MONITOR-dependent setup
    // (nick-regain watch + DM-peer presence watch) until ISUPPORT confirms
    // the server actually supports MONITOR. The token shows up as
    // options.MONITOR === '100' (the per-connection watch limit). Without
    // this guard we'd send `MONITOR +` blind and trigger 421 on older
    // ircds, which our 'irc error' path surfaces to the user.
    c.on('server options', () => {
      // 005 lines arrive in multiple bursts; this handler fires once per
      // line as irc-framework accumulates options. The MONITOR token isn't
      // necessarily in the first line, so only act when we transition
      // from "MONITOR unknown" to "MONITOR confirmed supported". If
      // MONITOR never appears, the deferred flags stay pending forever
      // (harmless — they're just booleans, and trackDmPeer's per-add path
      // also checks useMonitor before sending).
      const opts = this.client.network?.options || {};
      const limit = Number(opts.MONITOR) || 0;
      if (limit === 0 || this.useMonitor) return;
      this.useMonitor = true;
      this.monitorLimit = limit;
      console.log(`[presence:${this.network.id}] MONITOR detected (limit ${limit})`);
      if (this.pendingRegainSetup && this.regainNick) {
        this.pendingRegainSetup = false;
        try { this.client.addMonitor(this.regainNick); } catch (_) { /* ignore */ }
      }
      if (this.pendingMonitorSeed) {
        this.pendingMonitorSeed = false;
        if (this.trackedDmPeers.size > 0) this._seedMonitorWatch();
      }
    });

    // RPL_MONONLINE — peers in our MONITOR watch list that are currently
    // online. Fires both on initial seed (server replies with the current
    // state of each newly-added nick) and live when a watched peer
    // connects. The regain handler doesn't react to online events, so
    // there's no conflict to filter.
    c.on('users online', (event) => {
      const nicks = Array.isArray(event?.nicks) ? event.nicks : [];
      console.log(`[presence:${this.network.id}] users online: [${nicks.join(', ')}]`);
      for (const nick of nicks) {
        if (typeof nick === 'string') this.markPeerEvent(nick, 'online');
      }
    });

    // RPL_MONOFFLINE: a nick we're MONITORing has gone offline. Two
    // consumers share this event:
    //   1. Nick-regain — if the offline nick is the primary we're trying
    //      to reclaim, race to grab it before someone else does.
    //   2. DM peer presence — for any tracked DM peer that just went
    //      offline, write the transition. The two consumers never conflict:
    //      the regain target is never one of our own DM peers, and the
    //      tracked-peer gate inside markPeerEvent filters out anything else.
    c.on('users offline', (event) => {
      const nicks = Array.isArray(event?.nicks) ? event.nicks : [];
      console.log(`[presence:${this.network.id}] users offline: [${nicks.join(', ')}]`);
      if (this.regainNick) {
        const target = this.regainNick.toLowerCase();
        if (nicks.some((n) => typeof n === 'string' && n.toLowerCase() === target)) {
          try { this.client.changeNick(this.regainNick); } catch (_) { /* ignore */ }
        }
      }
      for (const nick of nicks) {
        if (typeof nick === 'string') this.markPeerEvent(nick, 'offline');
      }
    });

    c.on('pong', (event) => {
      const token = event?.message;
      if (!token || token !== this.lagPendingToken) return;
      this.lagMs = Math.max(0, Date.now() - this.lagPendingSentAt);
      this.lagPendingToken = null;
      this.lagPendingSentAt = 0;
      this.publishLag();
    });
    // irc-framework's net transport stashes socket-level errors (DNS lookup
    // failures, ECONNREFUSED, TLS handshake errors, etc.) in last_socket_error
    // and hands them to the close handler instead of emitting 'error', so this
    // is the only place we get to see why the connection actually died. Without
    // surfacing it to the server buffer the user just sees a red dot and no
    // log line.
    c.on('socket close', (err) => {
      this.setState('disconnected');
      if (err && (err.message || err.code)) {
        const code = err.code ? `${err.code}: ` : '';
        const where = `${this.network.host}:${this.network.port}`;
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: `Connection failed (${where}): ${code}${err.message || 'unknown error'}`,
        });
      }
    });
    c.on('reconnecting', (event) => {
      this.setState('reconnecting');
      const wait = event && event.wait ? Math.max(1, Math.round(event.wait / 1000)) : null;
      const attempt = event && event.attempt;
      const text = wait != null && attempt
        ? `Reconnecting in ${wait}s (attempt ${attempt})…`
        : 'Reconnecting…';
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'lurker',
        text,
      });
    });
    c.on('connecting', () => this.setState('connecting'));

    // RPL_UMODEIS arrives when the server sends our current umode (e.g. on
    // login or in response to /MODE <self>). irc-framework normalises it to
    // 'user info' with the raw mode string ('+iwx').
    c.on('user info', (event) => {
      if (!c.user.nick || event.nick.toLowerCase() !== c.user.nick.toLowerCase()) return;
      this.userModes = new Set((event.raw_modes || '').replace(/^[+-]/, '').split(''));
      this.publishUserModes();
    });

    // irc-framework fires 'user updated' for both CHGHOST (ident/host change)
    // and SETNAME (realname change). The cloaked-vhost case after SASL on
    // Libera arrives as a CHGHOST, but only when we've requested the chghost
    // cap (see the client constructor). Surface self changes in the server
    // buffer so users see "your host became X" the way other clients do.
    c.on('user updated', (event) => {
      if (!event || !c.user.nick || event.nick?.toLowerCase() !== c.user.nick.toLowerCase()) return;
      if (event.new_hostname || event.new_ident) {
        const ident = event.new_ident || event.ident || '';
        const host = event.new_hostname || event.hostname || '';
        const mask = ident ? `${ident}@${host}` : host;
        if (mask) {
          this.publish({
            type: 'motd',
            target: this.serverTarget(),
            text: `Your hostmask: ${mask}`,
          });
        }
      }
    });

    c.on('motd', (event) => {
      // irc-framework also fires 'motd' for ERR_NOMOTD (no MOTD configured)
      // with `error` instead of `motd`, and for servers with an empty MOTD
      // file `motd` is just ''. Skip the blank-line publish either way.
      const text = event.motd || event.error || '';
      if (!text.trim()) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    c.on('message', (event) => {
      const me = c.user?.nick;
      // Skip self-echoes. ircManager.send/.action already publishes a local
      // copy of every outgoing PRIVMSG/ACTION, so when the IRC server reflects
      // it back to us (echo-message cap, ergo's always-on relay, some
      // bouncers) the second copy would land in the database with a fresh id
      // and surface as a duplicate in the buffer. The local publish is the
      // source of truth for anything this backend sent.
      if (event.nick && me && event.nick.toLowerCase() === me.toLowerCase()) return;
      const isServer = !event.nick;
      const targetIsChannel = event.target && event.target.startsWith('#');
      const isNotice = event.type === 'notice';

      let target;
      if (isServer) target = `:server:${this.network.id}`;
      else if (targetIsChannel) target = event.target;
      else if (isNotice) {
        // NOTICE routing: keep replies inside an active conversation if the
        // user has one open (e.g. they /msg'd ChanServ and ChanServ is
        // NOTICE'ing back — those belong in the ChanServ buffer), but route
        // unsolicited NOTICEs (NickServ cloak alert on connect, server-wide
        // wallops, oper notices) to the server buffer the way IRCCloud and
        // most modern clients do. "Active" = there's history for that
        // target on this network AND the user hasn't explicitly closed it.
        // IRC nicks are case-insensitive at the protocol layer but the DB
        // stores whatever case the buffer was created with, so match
        // case-insensitively and use the persisted casing as the routing
        // target so we don't accidentally split history across "ChanServ"
        // and "chanserv".
        const dmLower = event.nick.toLowerCase();
        const existingTarget = listBufferTargets(this.network.id)
          .find((t) => t.toLowerCase() === dmLower);
        const hasOpenDm = existingTarget
          && !isBufferClosed(this.network.user_id, this.network.id, existingTarget);
        target = hasOpenDm ? existingTarget : `:server:${this.network.id}`;
      }
      else target = event.nick;

      const type = event.type === 'action' ? 'action' : event.type === 'notice' ? 'notice' : 'message';
      const nick = event.nick || event.hostname || 'server';

      this.publish({
        type,
        target,
        nick,
        text: event.message,
        kind: event.type,
        self: false,
        userhost: buildUserhost(event),
      });
      // An incoming PRIVMSG (not NOTICE) is the moment this nick becomes a
      // tracked DM peer — add them via trackDmPeer so MONITOR + fires too.
      // NOTICEs go to the server buffer above, so there's no DM peer to
      // track for them. Channel chatter still flips presence only for peers
      // we already track.
      if (event.nick && !isServer && !targetIsChannel && !isNotice) {
        this.trackDmPeer(event.nick);
      }
      if (event.nick) this.markPeerEvent(event.nick, 'online');
    });

    c.on('join', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.members.set(event.nick.toLowerCase(), {
        nick: event.nick,
        modes: [],
        away: false,
        user: event.ident || null,
        host: event.hostname || null,
      });
      this.publish({
        type: 'join',
        target: event.channel,
        nick: event.nick,
        userhost: buildUserhost(event),
      });
      if (event.nick !== c.user.nick) {
        // JOIN means they're online. If they were marked away and JOIN fires,
        // the away marker stays — markPeerEvent is idempotent against the
        // current state, and 'online' from JOIN doesn't fire if state is
        // already 'online'. (It WILL fire if state is 'offline' or null.)
        // The away-notify 'back' event is the authoritative back signal.
        this.markPeerEvent(event.nick, 'online');
      }
      if (event.nick === c.user.nick) {
        this.publish({ type: 'channel-joined', target: event.channel });
        // Most servers volunteer 324 on join, but a few don't. Request it so
        // the channel's mode flags reach the status bar consistently.
        try { c.raw('MODE', event.channel); } catch (_) { /* ignore */ }
      }
    });

    c.on('part', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.nick.toLowerCase());
      this.publish({
        type: 'part',
        target: event.channel,
        nick: event.nick,
        text: event.message,
        userhost: buildUserhost(event),
      });
      if (event.nick === c.user.nick) {
        this.channels.delete(event.channel.toLowerCase());
        this.publish({ type: 'channel-parted', target: event.channel });
      }
    });

    c.on('kick', (event) => {
      const ch = this.channels.get(event.channel.toLowerCase());
      if (ch) ch.members.delete(event.kicked.toLowerCase());
      this.publish({
        type: 'kick',
        target: event.channel,
        nick: event.nick,
        kicked: event.kicked,
        text: event.message,
        userhost: buildUserhost(event),
      });
      // Mirror the self-PART path when we ourselves are the one kicked, so
      // the buffer dims in the sidebar instead of staying styled as joined.
      // Persisting joined=false here also prevents auto-rejoin on reconnect.
      if (event.kicked && c.user.nick && event.kicked.toLowerCase() === c.user.nick.toLowerCase()) {
        this.channels.delete(event.channel.toLowerCase());
        try { upsertChannel(this.network.id, event.channel, false); } catch (_) { /* ignore */ }
        this.publish({ type: 'channel-parted', target: event.channel });
      }
    });

    c.on('quit', (event) => {
      const lower = event.nick.toLowerCase();
      const userhost = buildUserhost(event);
      for (const ch of this.channels.values()) {
        if (ch.members.delete(lower)) {
          this.publish({
            type: 'quit',
            target: ch.name,
            nick: event.nick,
            text: event.message,
            userhost,
          });
        }
      }
      // QUIT means they've left the network entirely, not just a channel —
      // any DM with this nick is now into-the-void territory.
      this.markPeerEvent(event.nick, 'offline');
    });

    c.on('nick', (event) => {
      const oldLower = event.nick.toLowerCase();
      const newLower = event.new_nick.toLowerCase();
      // irc-framework's command-handler runs the 'all' proxy (which routes
      // events to us) BEFORE its specific-event listeners. So when we receive
      // this event, `c.user.nick` is still the OLD nick — not the new one.
      // Detect self by matching the event's old nick against the current
      // tracked nick, mirroring what the framework's own listener does at
      // client.js:265 before it updates user.nick.
      const isSelfNick = !!c.user.nick && c.user.nick.toLowerCase() === oldLower;
      if (isSelfNick) {
        try {
          highlightRulesService.upsertAutoNickRule(this.network.user_id, this.network.id, event.new_nick);
        } catch (e) {
          console.warn('[highlight] failed to update auto nick rule:', e?.message || e);
        }
        // If a regain watch is active, tear it down on any self-nick change:
        // either we just reclaimed the primary (publish a notice), or the user
        // manually picked a different nick (their choice, drop the watch
        // silently). Either way the watch is now stale.
        if (this.regainNick) {
          const reclaimed = newLower === this.regainNick.toLowerCase();
          try { this.client.removeMonitor(this.regainNick); } catch (_) { /* ignore */ }
          if (reclaimed) {
            this.publish({
              type: 'notice',
              target: this.serverTarget(),
              nick: 'lurker',
              text: `Reclaimed nick ${this.regainNick}.`,
            });
          }
          this.regainNick = null;
          this.pendingRegainSetup = false;
        }
      }
      const userhost = buildUserhost(event);
      for (const ch of this.channels.values()) {
        const member = ch.members.get(oldLower);
        if (member) {
          ch.members.delete(oldLower);
          ch.members.set(newLower, {
            nick: event.new_nick,
            modes: member.modes,
            away: !!member.away,
            user: event.ident || member.user || null,
            host: event.hostname || member.host || null,
          });
          this.publish({
            type: 'nick',
            target: ch.name,
            nick: event.nick,
            newNick: event.new_nick,
            userhost,
          });
        }
      }
      // From a DM-buffer perspective: the old name is no longer reachable
      // (sending to it would 401), and the new name is reachable (if we have
      // a DM with them, or now). Don't fire either side for our own /nick.
      if (!isSelfNick) {
        this.markPeerEvent(event.nick, 'offline');
        this.markPeerEvent(event.new_nick, 'online');
      }
    });

    c.on('topic', (event) => {
      const ch = this.upsertChannel(event.channel);
      ch.topic = event.topic;
      if (event.nick) {
        // Live TOPIC change — persist + render in the message list.
        this.publish({ type: 'topic', target: event.channel, nick: event.nick, text: event.topic });
      } else {
        // RPL_TOPIC on join — sync the topic bar without printing a row, so
        // rejoining an already-open buffer doesn't repeat the same topic line
        // every time.
        this.publishEphemeral({ type: 'channel-topic', target: event.channel, topic: event.topic });
      }
    });

    c.on('mode', (event) => {
      const target = event.target;

      // Self user-mode change (e.g. server sets +i on connect, /OPER yields +o, etc.)
      if (target && c.user.nick && target.toLowerCase() === c.user.nick.toLowerCase()) {
        let changed = false;
        for (const m of (event.modes || [])) {
          if (!m || !m.mode) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          if (sign === '+' && !this.userModes.has(letter)) { this.userModes.add(letter); changed = true; }
          else if (sign === '-' && this.userModes.delete(letter)) { changed = true; }
        }
        if (changed) this.publishUserModes();
        // Solanum-style servers (Libera) send self-modes as a MODE command
        // after MOTD instead of RPL_UMODEIS (221). The raw-numeric forwarder
        // catches 221; this surfaces the MODE path so the user mode lands in
        // the server buffer either way.
        if (event.raw_modes) {
          this.publish({
            type: 'motd',
            target: this.serverTarget(),
            text: `Your user mode: ${event.raw_modes}`,
          });
        }
        return;
      }

      if (!target || !target.startsWith('#')) return;
      const ch = this.channels.get(target.toLowerCase());
      // Apply per-user prefix modes (+o/-o, +v/-v, etc.) to the member map so
      // the snapshot keeps current modes after page reload.
      let memberModesChanged = false;
      let chanModesChanged = false;
      if (ch) {
        for (const m of (event.modes || [])) {
          if (!m || !m.mode) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          // Per-user prefix mode: lands on the member, not on the channel.
          if (m.param && isPrefixMode(letter)) {
            const member = ch.members.get(m.param.toLowerCase());
            if (!member) continue;
            const set = new Set(member.modes);
            if (sign === '+') set.add(letter);
            else set.delete(letter);
            member.modes = [...set];
            memberModesChanged = true;
            continue;
          }
          // Channel-level flag mode (no param, or list-type mode like +b that
          // we don't surface in the status bar). We only track flag modes
          // (no param) so +b/+e/+I bans don't pollute the (+...) display.
          if (!m.param) {
            if (sign === '+' && !ch.modes.has(letter)) { ch.modes.add(letter); chanModesChanged = true; }
            else if (sign === '-' && ch.modes.delete(letter)) { chanModesChanged = true; }
          }
        }
      }
      const text = [event.raw_modes, ...(event.raw_params || [])].filter(Boolean).join(' ');
      this.publish({
        type: 'mode',
        target,
        nick: event.nick,
        text,
        modes: event.modes,
      });
      if (memberModesChanged && ch) {
        this.publish({
          type: 'names',
          target: ch.name,
          members: Array.from(ch.members.values()).map(memberSnapshot),
        });
      }
      if (chanModesChanged && ch) this.publishChannelModes(ch);
    });

    // RPL_CHANNELMODEIS (324) and friends. Sent on join by most servers and
    // on demand via `MODE #chan`. Captures the current flag set without
    // requiring us to have observed the +/− history.
    c.on('channel info', (event) => {
      if (!event?.channel || !event.modes) return;
      const ch = this.channels.get(event.channel.toLowerCase());
      if (!ch) return;
      const next = new Set();
      for (const m of event.modes) {
        if (!m || !m.mode || m.param) continue;
        const letter = m.mode.replace(/^[+-]/, '');
        if (!letter) continue;
        next.add(letter);
      }
      const before = [...ch.modes].sort().join('');
      const after = [...next].sort().join('');
      if (before !== after) {
        ch.modes = next;
        this.publishChannelModes(ch);
      }
    });

    c.on('userlist', (event) => {
      const ch = this.upsertChannel(event.channel);
      // Preserve known away flags AND user/host across re-issued NAMES
      // (e.g. on /NAMES or a fresh join). NAMES doesn't carry ident/host on
      // most ircds — the JOIN event and WHO reply do — so we hold onto
      // whatever we already learned.
      const prev = new Map();
      for (const [k, v] of ch.members) prev.set(k, { away: !!v.away, user: v.user || null, host: v.host || null });
      ch.members.clear();
      for (const u of event.users) {
        const lc = u.nick.toLowerCase();
        const carry = prev.get(lc) || {};
        ch.members.set(lc, {
          nick: u.nick,
          modes: u.modes || [],
          away: carry.away || false,
          user: u.ident || carry.user || null,
          host: u.hostname || carry.host || null,
        });
      }
      this.publish({
        type: 'names',
        target: event.channel,
        members: Array.from(ch.members.values()).map(memberSnapshot),
      });
      // Issue a WHO so we learn the current away state for everyone in the
      // channel. away-notify keeps it live after this initial sync.
      try { c.who(event.channel); } catch (_) { /* ignore */ }
    });

    c.on('wholist', (event) => {
      const ch = this.channels.get(event.target?.toLowerCase());
      if (!ch) return;
      let changed = false;
      for (const u of (event.users || [])) {
        if (!u || !u.nick) continue;
        const m = ch.members.get(u.nick.toLowerCase());
        if (!m) continue;
        const next = !!u.away;
        if (m.away !== next) {
          m.away = next;
          changed = true;
        }
        // WHO carries ident/host (RPL_WHOREPLY 352) — backfill so the
        // nicklist's right-click "Ignore…" modal has a hostmask to suggest
        // even for members whose join we never observed (e.g. they were
        // already in the channel when we joined).
        if (u.ident && m.user !== u.ident) { m.user = u.ident; changed = true; }
        if (u.hostname && m.host !== u.hostname) { m.host = u.hostname; changed = true; }
      }
      if (!changed) return;
      this.publish({
        type: 'names',
        target: ch.name,
        members: Array.from(ch.members.values()).map(memberSnapshot),
      });
    });

    // Per-user away/back. away-notify drives the non-self events; self events
    // come from RPL_NOWAWAY/RPL_UNAWAY in response to our own /AWAY. We honor
    // both so the self nick also dims in the nicklist.
    c.on('away', (event) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick, true);
      this.markPeerEvent(event.nick, 'away', event.message || null);
    });
    c.on('back', (event) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick, false);
      this.markPeerEvent(event.nick, 'back');
    });

    // irc-framework aggregates RPL_WHOIS* (311/312/317/319/330/...) into a
     // single 'whois' event when RPL_ENDOFWHOIS arrives. We fan it out as
     // motd-style lines on the server buffer so the user actually sees the
     // result of /whois (raw fall-through alone hides everything because the
     // numerics are consumed by irc-framework instead of becoming messages).
    // irc-framework aggregates RPL_WHOIS* (311/312/317/319/330/...) into a
    // single 'whois' event when RPL_ENDOFWHOIS arrives. WHOIS is now purely
    // user-driven output — presence comes from MONITOR + away-notify, not
    // whois — so this handler just formats the reply into motd lines.
    c.on('whois', (event) => {
      if (!event || !event.nick) return;
      const lines = formatWhoisLines(event);
      for (const text of lines) {
        this.publish({ type: 'motd', target: this.serverTarget(), text });
      }
    });

    // Channel list (`/LIST`). irc-framework batches RPL_LIST every 50 rows and
    // again at RPL_LISTEND. Each batch lands in the per-network SQLite cache;
    // clients only see progress events (running count) — the actual rows are
    // fetched via the chanlist-search WS handler against the cache. Keeps a
    // 6k-row libera.chat list off the wire and out of client memory.
    c.on('channel list start', () => {
      const nid = this.network.id;
      try {
        chanlistDb.clearChannels(nid);
        chanlistDb.setMeta(nid, { inProgress: true, totalCount: 0, fetchedAt: null });
      } catch (e) {
        console.warn(`[chanlist:${nid}] start failed:`, e?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-start' });
    });
    c.on('channel list', (channels) => {
      const nid = this.network.id;
      try {
        chanlistDb.upsertChannels(nid, channels || []);
        const total = chanlistDb.countChannels(nid);
        chanlistDb.setMeta(nid, { totalCount: total, inProgress: true });
        this.publishEphemeral({ type: 'chanlist-progress', total });
      } catch (e) {
        console.warn(`[chanlist:${nid}] batch failed:`, e?.message || e);
      }
    });
    c.on('channel list end', () => {
      const nid = this.network.id;
      let total = 0;
      try {
        total = chanlistDb.countChannels(nid);
        chanlistDb.setMeta(nid, {
          inProgress: false,
          totalCount: total,
          fetchedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`[chanlist:${nid}] end failed:`, e?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-end', total });
    });

    c.on('irc error', (event) => {
      // irc-framework maps the IRC ERROR command (sent right before the
      // server drops you) and ERR_* numerics to this event. `error` is a
      // short tag like 'irc' / 'no_such_nick' / 'password_mismatch';
      // `reason` is the human-readable trailing param from the server
      // ("Closing Link: foo[u@h] (G-Lined)", etc.). The earlier handler
      // returned the first truthy of (error, reason), so an ERROR command
      // with both fields collapsed to the literal string "irc" and the
      // actual disconnect reason was thrown away.
      const tag = event?.error || 'irc error';
      const reason = event?.reason;
      const isDmMiss = tag === 'no_such_nick' && event?.nick
        && isDmTargetName(event.nick);
      // For ERR_NOSUCHNICK against a nick the user has any DM history with,
      // route the error into that DM buffer so the failure surfaces where
      // they sent the message instead of getting lost in the server buffer.
      // Presence is no longer driven from here — MONITOR is the authority
      // for online/offline state.
      if (isDmMiss && hasMessageForTarget(this.network.id, event.nick)) {
        const message = reason || 'No such nick — they may be offline.';
        this.publish({
          type: 'error',
          target: event.nick,
          text: message,
          raw: event,
        });
        return;
      }
      const ctx = [event?.nick, event?.channel, event?.server].filter(Boolean).join(' ');
      const parts = [tag];
      if (ctx) parts.push(ctx);
      if (reason) parts.push(`— ${reason}`);
      const text = parts.join(' ');
      console.warn(`[irc:${this.network.id}] ${text}`);
      this.publish({
        type: 'error',
        target: this.serverTarget(),
        text,
        raw: event,
      });
    });

    c.on('tagmsg', (event) => {
      const me = c.user?.nick;
      const isSelf = !!event.nick && event.nick === me;
      if (isSelf) return;
      const typing = event.tags && event.tags['+typing'];
      if (!typing) return;
      const targetIsChannel = event.target && event.target.startsWith('#');
      const target = targetIsChannel ? event.target : event.nick;
      this.publishEphemeral({
        type: 'typing',
        target,
        nick: event.nick,
        state: typing,
      });
    });
  }

  serverTarget() {
    return `:server:${this.network.id}`;
  }

  // Bail-out for transition writes: gate by tracked-peer set and self-nick.
  // Returns the eligible canonical nick (preserving the case as sent),
  // or null when the caller should no-op.
  _eligiblePeer(nick) {
    if (!nick) return null;
    const me = this.client.user?.nick;
    if (me && nick.toLowerCase() === me.toLowerCase()) return null;
    if (!this.trackedDmPeers.has(nick.toLowerCase())) return null;
    return nick;
  }

  // Emit the current row to clients. Peer presence is network-level state
  // on the client (mirroring self away/back), so target is the server
  // pseudo-buffer — that way the wsHub closed-buffer guard doesn't drop
  // updates for DMs the user dismissed (state still flows to
  // networks.states[networkId].peerPresence). The `nick` field carries the
  // routing key the client uses for its peerPresence map.
  _publishPeerPresence(nick, row) {
    this.publishEphemeral({
      type: 'peer-presence',
      target: this.serverTarget(),
      nick,
      state: row?.state || null,
      stateAt: row?.stateAt || null,
      awayMessage: row?.awayMessage || null,
    });
  }

  // Single transition entry point. `state` is one of 'online' | 'offline' |
  // 'away' | 'back'. Per-state gating keeps the marker timestamp pinned to
  // the *moment of transition* rather than every later re-assertion:
  //   'online'  — fires only from 'offline' or null. A JOIN/PRIVMSG from a
  //               peer we already know is online (or away) is not a fresh
  //               transition — they didn't just come back online.
  //   'offline' — fires unless already offline.
  //   'away'    — fires unless already away.
  //   'back'    — fires *only* when transitioning out of 'away' (back from
  //               away). A back signal against any other prior state is
  //               meaningless ("back" from what?) and dropped.
  // `awayMessage` is optional and only used when state='away' — the /away
  // reason text. For other states it's ignored, and the DB column is
  // cleared so a stale message from a previous cycle can't bleed through.
  markPeerEvent(nick, state, awayMessage = null) {
    const canonical = this._eligiblePeer(nick);
    if (!canonical) {
      console.log(`[presence:${this.network.id}] markPeerEvent ${nick} → ${state} SKIP (not tracked)`);
      return;
    }
    const prev = getPeerPresence(this.network.id, canonical);
    const prevState = prev?.state || null;
    let allowed = false;
    if (state === 'online') allowed = (prevState === null || prevState === 'offline');
    else if (state === 'offline') allowed = (prevState !== 'offline');
    else if (state === 'away') allowed = (prevState !== 'away');
    else if (state === 'back') allowed = (prevState === 'away');
    if (!allowed) {
      console.log(`[presence:${this.network.id}] markPeerEvent ${canonical} → ${state} SKIP (prev=${prevState})`);
      return;
    }
    const stateAt = new Date().toISOString();
    const message = state === 'away' ? (awayMessage || null) : null;
    const next = writePeerState(this.network.id, canonical, state, stateAt, message);
    console.log(`[presence:${this.network.id}] markPeerEvent ${canonical} ${prevState || 'null'} → ${state}${message ? ` (${message})` : ''}`);
    this._publishPeerPresence(canonical, next);
  }

  // Bulk-seed the MONITOR watch list from the tracked DM peers set. Called
  // once per connection from the 'server options' handler, after ISUPPORT
  // confirms MONITOR is supported. Batches nicks into 'MONITOR + n1,n2,…'
  // lines under the 512-byte IRC wire limit so a 100-peer seed doesn't
  // trip "Excess Flood" on Libera (same pattern used for channel JOIN
  // batching in ircManager.startNetwork). Any nicks beyond monitorLimit
  // are kept in the in-memory set but skipped on the wire; we surface a
  // notice so the user knows live presence is degraded for the overflow.
  _seedMonitorWatch() {
    const peers = Array.from(this.trackedDmPeers);
    if (peers.length === 0) return;
    const cap = this.monitorLimit > 0 ? this.monitorLimit : peers.length;
    const watched = peers.slice(0, cap);
    const overflow = peers.length - watched.length;
    console.log(`[presence:${this.network.id}] seeding MONITOR for ${watched.length} peer(s): [${watched.join(', ')}]${overflow ? ` (+${overflow} overflow)` : ''}`);
    if (overflow > 0) {
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'lurker',
        text: `MONITOR limit (${this.monitorLimit}) reached; live presence skipped for ${overflow} DM peer${overflow === 1 ? '' : 's'}.`,
      });
    }
    // "MONITOR + " prefix is 11 bytes; leave headroom for trailing \r\n
    // and the comma separators. Cap line content at 400 bytes (matches the
    // channel-JOIN batcher).
    const MAX = 400;
    let chunk = [];
    let len = 0;
    let batches = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const line = 'MONITOR + ' + chunk.join(',');
      console.log(`[presence:${this.network.id}] → ${line}`);
      try { this.client.raw(line); } catch (_) { /* ignore */ }
      batches += 1;
      chunk = [];
      len = 0;
    };
    for (const nick of watched) {
      const add = chunk.length === 0 ? nick.length : nick.length + 1;
      if (len + add > MAX) flush();
      chunk.push(nick);
      len += add;
    }
    flush();
    // Belt-and-suspenders: per IRCv3 spec the server SHOULD reply to each
    // MONITOR + with the current state of each added nick, but the wording
    // is "advised" not "required". MONITOR S explicitly asks for the
    // current state of every monitored nick, so it backfills anyone the
    // initial + didn't volunteer state for. markPeerEvent's idempotency
    // gate eats duplicate replies, so this is safe to send unconditionally.
    console.log(`[presence:${this.network.id}] → MONITOR S (status refresh after ${batches} seed batch(es))`);
    try { this.client.raw('MONITOR S'); } catch (_) { /* ignore */ }
  }

  // Add a peer to the tracking set and to the MONITOR watch in one shot.
  // Idempotent on the set; the MONITOR + line is cheap to re-send on the
  // wire (server accepts duplicates), but skip when we know the peer is
  // already tracked to avoid noise. Returns true if this was a fresh add.
  // When `useMonitor` is false (server doesn't support it), we still grow
  // the tracking set so other event handlers (no_such_nick routing, etc.)
  // still recognize the nick as a DM peer — they just won't get live
  // presence updates.
  trackDmPeer(nick) {
    if (!nick) return false;
    const me = this.client.user?.nick;
    if (me && nick.toLowerCase() === me.toLowerCase()) return false;
    const lower = nick.toLowerCase();
    if (this.trackedDmPeers.has(lower)) return false;
    this.trackedDmPeers.add(lower);
    console.log(`[presence:${this.network.id}] trackDmPeer ${nick} (useMonitor=${this.useMonitor}, size=${this.trackedDmPeers.size})`);
    if (this.useMonitor && this.state === 'connected') {
      if (this.trackedDmPeers.size > this.monitorLimit) {
        // Over-limit add: keep the in-memory tracking but skip MONITOR.
        // We surface this once per overflow so the user knows live updates
        // are degraded for the overflow nicks.
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          text: `MONITOR limit (${this.monitorLimit}) reached; live presence skipped for ${nick}.`,
        });
        return true;
      }
      try { this.client.raw('MONITOR + ' + nick); } catch (_) { /* ignore */ }
    }
    return true;
  }

  // Drop a peer from the tracking set, the MONITOR watch, and the DB row.
  // Called when the user closes the DM buffer — we don't want stale state
  // lingering for a peer the user has explicitly dismissed.
  untrackDmPeer(nick) {
    if (!nick) return;
    const lower = nick.toLowerCase();
    const wasTracked = this.trackedDmPeers.delete(lower);
    if (wasTracked && this.useMonitor && this.state === 'connected') {
      try { this.client.raw('MONITOR - ' + nick); } catch (_) { /* ignore */ }
    }
    try { deletePeerPresence(this.network.id, nick); }
    catch (e) { console.warn('[presence] untrack failed:', e?.message || e); }
  }

  // DM activate triggers this via the `probe-presence` ws message. With
  // MONITOR, adding to the watch elicits an immediate RPL_MONONLINE or
  // RPL_MONOFFLINE from the server — no separate WHOIS probe needed.
  probePresence(nick) {
    if (!nick || !isDmTargetName(nick)) return;
    this.trackDmPeer(nick);
  }

  // Update the away flag for `nick` across every channel they're in and
  // re-broadcast names for each affected channel so clients re-render the
  // nicklist. Silent if the nick isn't tracked anywhere.
  applyMemberAway(nick, away) {
    const lower = nick.toLowerCase();
    const next = !!away;
    for (const ch of this.channels.values()) {
      const m = ch.members.get(lower);
      if (!m) continue;
      if (m.away === next) continue;
      m.away = next;
      this.publish({
        type: 'names',
        target: ch.name,
        members: Array.from(ch.members.values()).map(memberSnapshot),
      });
    }
  }

  upsertChannel(name) {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Map(), modes: new Set() };
      this.channels.set(key, ch);
    }
    if (!ch.modes) ch.modes = new Set();
    return ch;
  }

  publishChannelModes(ch) {
    this.publish({
      type: 'channel-modes',
      target: ch.name,
      modes: [...ch.modes].join(''),
    });
  }

  publishLag() {
    this.publish({
      type: 'lag',
      target: this.serverTarget(),
      lagMs: this.lagMs,
    });
  }

  // Periodic PING with a `lurker-lag-<sent>` token. PONG echoes the token back
  // so the matching pong handler can compute roundtrip even when the server
  // is also ponging unrelated PINGs we didn't send. Cleared on disconnect.
  startLagPinger() {
    this.stopLagPinger();
    const sendOne = () => {
      if (this.disposed || this.state !== 'connected') return;
      // If a previous ping hasn't been answered after 30s, declare lag stale
      // so the client stops showing an old number.
      if (this.lagPendingToken && Date.now() - this.lagPendingSentAt > 30_000) {
        this.lagMs = null;
        this.publishLag();
        this.lagPendingToken = null;
      }
      const token = `lurker-lag-${Date.now()}`;
      this.lagPendingToken = token;
      this.lagPendingSentAt = Date.now();
      try { this.client.ping(token); } catch (_) { /* ignore */ }
    };
    sendOne();
    this.lagPingTimer = setInterval(sendOne, 30_000);
  }

  stopLagPinger() {
    if (this.lagPingTimer) {
      clearInterval(this.lagPingTimer);
      this.lagPingTimer = null;
    }
    this.lagPendingToken = null;
    this.lagPendingSentAt = 0;
  }

  connect() {
    const { sasl_password, sasl_account, nick } = this.network;
    const account = sasl_password
      ? { account: sasl_account || nick, password: sasl_password }
      : undefined;
    const proto = this.network.tls ? ' (TLS)' : '';
    this.publish({
      type: 'notice',
      target: this.serverTarget(),
      nick: 'lurker',
      text: `Connecting to ${this.network.host}:${this.network.port}${proto}…`,
    });
    this.client.connect({
      host: this.network.host,
      port: this.network.port,
      tls: !!this.network.tls,
      nick,
      username: this.network.username || nick,
      gecos: this.network.realname || nick,
      password: this.network.server_password || undefined,
      account,
      auto_reconnect: true,
      auto_reconnect_max_retries: 0,
      // Request the `chghost` cap so SASL-cloaked vhost changes (Libera et al.)
      // arrive as CHGHOST events instead of silently. Must go through connect()
      // — irc-framework overwrites client.options with this dict, so passing
      // it to the constructor doesn't survive. See client.js:202.
      enable_chghost: true,
    });
  }

  join(channel) { this.client.join(channel); }
  part(channel, reason) { this.client.part(channel, reason); }
  say(target, text) {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.client.say(target, text);
  }
  action(target, text) {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.client.action(target, text);
  }
  raw(line) { this.client.raw(line); }
  sendTyping(target, state) {
    // Suppress typing TAGMSGs to peers we know are offline — otherwise each
    // keystroke generates an ERR_NOSUCHNICK reply that lands as a persisted
    // error in the DM buffer (and pings push subscribers). The user finds
    // out the peer is unreachable the moment they hit send; their typing
    // doesn't need to keep re-confirming it.
    if (isDmTargetName(target)) {
      const peer = getPeerPresence(this.network.id, target);
      if (peer?.state === 'offline') return;
    }
    this.client.tagmsg(target, { '+typing': state });
  }

  // Mirror the user-level self-presence state onto this connection. Called by
  // ircManager after it persists and is responsible for any guard logic — this
  // method is a dumb applier. Emits AWAY to the IRC server when the new state
  // disagrees with what the network already thinks (active flip), and always
  // publishes the away-state event so clients refresh their dividers.
  applyAwayState(next) {
    const prev = this.awayState;
    this.awayState = {
      active: !!next.active,
      message: next.message ?? null,
      since: next.since ?? null,
      autoSet: !!next.autoSet,
      backAt: next.backAt ?? null,
    };
    if (this.state === 'connected') {
      if (next.active && next.message && !prev.active) {
        try { this.client.raw('AWAY :' + next.message); } catch (_) { /* ignore */ }
      } else if (!next.active && prev.active) {
        try { this.client.raw('AWAY'); } catch (_) { /* ignore */ }
      }
    }
    this.publishAwayState();
  }

  disconnect(reason = DEFAULT_QUIT_MESSAGE) {
    this.client.quit(reason);
  }

  dispose(reason = 'network removed') {
    this.disposed = true;
    this.stopLagPinger();
    try { this.client.quit(reason); } catch (_) { /* ignore */ }
  }

  snapshot() {
    const a = this.awayState;
    return {
      networkId: this.network.id,
      state: this.state,
      nick: this.client.user?.nick || this.network.nick,
      userModes: [...this.userModes].join(''),
      lagMs: this.lagMs,
      away: a.since
        ? { active: a.active, since: a.since, message: a.message, autoSet: a.autoSet, backAt: a.backAt }
        : null,
      channels: Array.from(this.channels.values()).map((ch) => ({
        name: ch.name,
        topic: ch.topic,
        modes: [...(ch.modes || [])].join(''),
        members: Array.from(ch.members.values()).map(memberSnapshot),
      })),
      // Object keyed by lowercase nick → { nick, state, stateAt }. Lands
      // directly on states[networkId].peerPresence on snapshot apply, same
      // shape used by the live peer-presence event handler in the networks
      // store. Filtered to tracked peers so closed-DM rows don't leak.
      peerPresence: Object.fromEntries(
        listPeerPresenceForNetwork(this.network.id)
          .filter((row) => this.trackedDmPeers.has(row.nick.toLowerCase()))
          .map((row) => [row.nick.toLowerCase(), row])
      ),
    };
  }
}

const PREFIX_MODES = new Set(['q', 'a', 'o', 'h', 'v']);
function isPrefixMode(letter) { return PREFIX_MODES.has(letter); }

// Pure helper for the pre-registration nick-fallback ladder. The configured
// nick is attempt -1 (already tried by `connect()` itself); on each subsequent
// ERR_NICKNAMEINUSE we ask for index 0..N-1 here. Digits-only, no underscore
// dance — modern ircds allow long nicks so the legacy 9-char cap is moot, and
// `bob1` reads more clearly than `bob___`. Returns null once exhausted so the
// caller can give up and notify the user.
const NICK_FALLBACK_MAX = 9;
export function computeFallbackNick(base, attemptIndex) {
  if (!base) return null;
  if (attemptIndex < 0 || attemptIndex >= NICK_FALLBACK_MAX) return null;
  return `${base}${attemptIndex + 1}`;
}

// Render irc-framework's aggregated `whois` event into a small block of
// human-readable lines. Order roughly mirrors what other IRC clients show:
// identity → realname → host/ip → connection security → server → channels →
// modes → idle/signon → registered/account/oper/bot → secure/certfp.
function formatWhoisLines(w) {
  const lines = [];
  if (w.error === 'not_found') {
    lines.push(`whois: no such nick ${w.nick}`);
    return lines;
  }
  const userhost = [w.ident, w.hostname].filter(Boolean).join('@');
  lines.push(`whois ${w.nick}${userhost ? ` (${userhost})` : ''}`);
  if (w.real_name) lines.push(`  realname: ${w.real_name}`);
  if (w.actual_hostname || w.actual_ip) {
    const parts = [w.actual_hostname, w.actual_ip].filter(Boolean).join(' ');
    lines.push(`  host: ${parts}`);
  }
  if (w.server) {
    const info = w.server_info ? ` (${w.server_info})` : '';
    lines.push(`  server: ${w.server}${info}`);
  }
  if (w.channels) lines.push(`  channels: ${w.channels}`);
  if (w.modes) lines.push(`  modes: ${w.modes}`);
  if (w.account) lines.push(`  account: ${w.account}`);
  if (w.registered_nick) lines.push(`  registered: ${w.registered_nick}`);
  if (w.operator) lines.push(`  oper: ${w.operator}`);
  if (w.helpop) lines.push(`  helpop: ${w.helpop}`);
  if (w.bot) lines.push(`  bot: ${w.bot}`);
  if (w.secure) lines.push('  secure: yes');
  if (w.certfp) lines.push(`  certfp: ${w.certfp}`);
  if (w.away) lines.push(`  away: ${w.away}`);
  if (w.idle != null) {
    const idleSec = Number(w.idle);
    const signonStr = w.logon ? ` (signon ${new Date(Number(w.logon) * 1000).toISOString()})` : '';
    lines.push(`  idle: ${Number.isFinite(idleSec) ? `${idleSec}s` : w.idle}${signonStr}`);
  }
  return lines;
}

// Convert a server-sourced numeric reply (parsed IrcMessage) into a single
// line of human-readable text for the server buffer. Returns null for any
// numeric we deliberately don't surface (e.g. 005 ISUPPORT, which spans many
// lines and is consumed for internal state) and for non-numerics.
//
// irc-framework's command handlers consume these numerics into structured
// state (network.options, network.server, network.ircd, …) and emit
// higher-level events like 'registered', but the original wire text is not
// re-emitted — so without this pass the server buffer jumps straight from
// the pre-registration NOTICE * Auth lines to the MOTD, hiding the welcome
// banner, lusers info, SASL confirmation, umode and hostmask.
//
// The first param on every server numeric is the target nick; the rest is
// what we want to render. Most replies put the human-readable form in the
// trailing param (last element), so a default of "use the last param" gets
// us most of the way; the exceptions (004 MYINFO, 221 UMODEIS, 252-254
// LUSER counts, 396 HOSTCLOAKING) have explicit branches.
export function formatServerNumeric(msg) {
  if (!msg) return null;
  const cmd = (msg.command || '').toUpperCase();
  const p = msg.params || [];
  switch (cmd) {
    case '001': // RPL_WELCOME — "Welcome to the X Network nick"
    case '002': // RPL_YOURHOST — "Your host is X, running version Y"
    case '003': // RPL_CREATED — "This server was created X"
    case '250': // RPL_STATSCONN — "Highest connection count: …"
    case '251': // RPL_LUSERCLIENT — "There are N users…"
    case '255': // RPL_LUSERME — "I have N clients…"
    case '265': // RPL_LOCALUSERS — "Current local users N, max M"
    case '266': // RPL_GLOBALUSERS — "Current global users N, max M"
    case '900': // RPL_LOGGEDIN — "You are now logged in as X"
    case '903': // RPL_SASLLOGGEDIN — "SASL authentication successful"
      return p[p.length - 1] || null;
    case '004': { // RPL_MYINFO — [nick, server, ircd, umodes, chmodes, paramch]
      const [, server, ircd, umodes, chmodes, paramch] = p;
      const parts = [];
      if (server) parts.push(`Host: ${server}`);
      if (ircd) parts.push(`IRCd: ${ircd}`);
      if (umodes) parts.push(`user modes: ${umodes}`);
      if (chmodes) parts.push(`channel modes: ${chmodes}`);
      if (paramch) parts.push(`parametric channel modes: ${paramch}`);
      return parts.length ? parts.join(', ') : null;
    }
    case '221': // RPL_UMODEIS — [nick, "+iw"]
      return p[1] ? `Your user mode: ${p[1]}` : null;
    case '252': // RPL_LUSEROP — [nick, count, "IRC Operators online"]
    case '253': // RPL_LUSERUNKNOWN — [nick, count, "unknown connection(s)"]
    case '254': // RPL_LUSERCHANNELS — [nick, count, "channels formed"]
      if (!p[1] && !p[2]) return null;
      return `${p[1] || ''} ${p[2] || ''}`.trim();
    case '396': // RPL_HOSTCLOAKING — [nick, hostmask, "is now your displayed host"]
      return p[1] ? `Your hostmask: ${p[1]}` : null;
    default:
      return null;
  }
}
