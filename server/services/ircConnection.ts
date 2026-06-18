// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import IRC, { ircLineParser } from 'irc-framework';
import type { Client as IrcClient } from 'irc-framework';
import {
  insertMessage,
  hasMessageForTarget,
  listBufferTargets,
  COUNTABLE_TYPES,
} from '../db/messages.js';
import type { Network } from '../db/networks.js';
import { upsertChannel } from '../db/networks.js';
import { isClosed as isBufferClosed } from '../db/closedBuffers.js';
import { listTargetsForNetwork as listFriendTargetsForNetwork } from '../db/contacts.js';
import * as chanlistDb from '../db/chanlist.js';
import type { PeerPresence, PeerState } from '../db/peerPresence.js';
import {
  getPeerPresence,
  listPeerPresenceForNetwork,
  writePeerState,
  deletePeerPresence,
} from '../db/peerPresence.js';
import highlightRulesService from './highlightRulesService.js';
import { matchEvent } from './highlightEngine.js';
import { matchesAny as matchesIgnoreMask } from './maskMatch.js';
import { listMasks as listIgnoredMasks } from '../db/ignoredMasks.js';
import * as systemLog from './systemLog.js';
import { IRC_VERSION, APP_VERSION } from '../utils/userAgent.js';
import { findUserById } from '../db/users.js';
import { isNodeMode } from '../utils/edition.js';
import { deriveIdent } from '../utils/ident.js';
import { registerIdent, unregisterIdent, isIdentdEnabled } from './identd.js';

// Shown to peers as the QUIT reason on a clean disconnect. Most IRC clients
// surface this in JOIN/PART messages, so it doubles as a Lurker
// announcement — gives operators a quick read on what client + version is
// being used. Per-disconnect overrides (network removal, no-nick failure,
// etc.) pass their own reason and bypass this default.
const DEFAULT_QUIT_MESSAGE = `Lurker ${APP_VERSION} (the truth is out there) https://lurker.chat`;

const NON_PERSISTED_TYPES = new Set([
  'state',
  'names',
  'channel-joined',
  'channel-parted',
  'typing',
  'away-state',
  'channel-modes',
  'lag',
  'peer-presence',
]);

// How recently the user must have sent a real message to a target for a send
// rejection (404/477/531) to be attributed to that message and surfaced inline.
// Beyond this window the bounce is treated as an automated TAGMSG/typing reply
// and swallowed. Generous — IRC error numerics come back in well under a second.
const SEND_REJECTION_ATTRIBUTION_MS = 15000;

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

interface ChannelMember {
  nick: string;
  modes: string[];
  away: boolean;
  user: string | null;
  host: string | null;
}

interface ChannelState {
  name: string;
  topic: string | null;
  members: Map<string, ChannelMember>;
  modes: Set<string>;
}

interface ModeEntry {
  mode: string;
  param?: string;
}

interface AwayState {
  active: boolean;
  message: string | null;
  since: string | null;
  autoSet: boolean;
  backAt: string | null;
}

// Events emitted internally toward wsHub. The shape is open-ended because
// different event types carry very different fields. We keep `type` and the
// common fields typed; the rest is spread dynamically.
interface IrcEvent {
  type: string;
  target?: string;
  [key: string]: unknown;
}

// Enriched event with server-stamped fields added by publish().
interface EnrichedEvent extends IrcEvent {
  userId: number;
  networkId: number;
  time: string;
  id?: number | bigint;
  alt?: boolean;
  matched?: boolean;
  matchedRuleId?: number | null;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function isDmTargetName(target: string | undefined | null): boolean {
  if (!target) return false;
  return !target.startsWith('#') && !target.startsWith(':server:');
}

function extractExtras(event: IrcEvent): Record<string, unknown> | null {
  switch (event.type) {
    case 'kick':
      return { kicked: event.kicked };
    case 'nick':
      return { newNick: event.newNick };
    case 'mode':
      return { modes: event.modes };
    default:
      return null;
  }
}

// Canonical nick!ident@hostname string used for client-side hostmask ignore
// matching. Missing parts are left empty rather than starred — the client's
// glob matcher handles either form, and storing the literal observed value
// keeps the data honest. Returns null when there's no nick (server events).
function buildUserhost(event: Record<string, unknown>): string | null {
  if (!event || !event.nick) return null;
  const ident = (event.ident as string) || '';
  const host = (event.hostname as string) || '';
  if (!ident && !host) return null;
  return `${event.nick}!${ident}@${host}`;
}

function memberSnapshot(m: ChannelMember): ChannelMember {
  return {
    nick: m.nick,
    modes: m.modes,
    away: !!m.away,
    user: m.user || null,
    host: m.host || null,
  };
}

// Why a nick is on the presence watch list: an active DM peer, a friend/contact
// target, or both. The MONITOR watch + peer_presence_state row are shared, so
// these are reference-counted (see IrcConnection.trackedPeers).
type TrackReason = 'dm' | 'friend';

interface PeerWatch {
  reasons: Set<TrackReason>;
  // The contact id when this nick is watched as a friend (informational —
  // the came-online toast is gated client-side); null for a DM-only peer.
  contactId: number | null;
}

export class IrcConnection {
  network: Network;
  onEvent: (event: EnrichedEvent) => void;
  client: IrcClient;
  state: string;
  channels: Map<string, ChannelState>;
  userModes: Set<string>;
  awayState: AwayState;
  // One presence watch list keyed by lowercased nick. Each entry records WHY
  // we're watching it (DM peer, friend, or both). The MONITOR watch and the
  // shared peer_presence_state row are reference-counted against those reasons —
  // added when the first reason appears, torn down only when the last one is
  // released — so a nick that is both a DM peer and a friend is watched once and
  // survives losing either role. Hydrated on 'registered' and kept live via
  // trackDmPeer/trackFriend + untrackDmPeer/untrackFriend.
  trackedPeers: Map<string, PeerWatch>;
  useMonitor: boolean;
  monitorLimit: number;
  pendingMonitorSeed: boolean;
  disposed: boolean;
  connectCommandTimer: ReturnType<typeof setTimeout> | null;
  lagMs: number | null;
  lagPingTimer: ReturnType<typeof setInterval> | null;
  lagPendingToken: string | null;
  lagPendingSentAt: number;
  preRegistered: boolean;
  nickAttempt: number;
  regainNick: string | null;
  pendingRegainSetup: boolean;
  // Handle for this connection's entry in the identd map, while identd is
  // enabled — so we can unregister exactly this connection's ident (not whatever
  // else might share its local port) when it closes.
  identdId: number | null;
  // Targets (channels or nicks) the server has refused our outgoing messages
  // to — a +R/+M channel that needs a registered nick to speak, a +R user, etc.
  // Learned from the first send rejection and used to stop firing typing
  // TAGMSGs that would each bounce back as another rejection (#283). Lowercase
  // keys. This never blocks the user's actual messages (those always go out and
  // surface the error); it only gates typing notifications. Cleared when speak
  // permission may have changed: on RPL_LOGGEDIN, on (re)registration, and when
  // we (re)join the channel — so a /part + /join or a reconnect resumes typing.
  unsendableTargets: Set<string>;
  // Last time the user sent a real PRIVMSG/NOTICE/ACTION to a target (lowercase
  // key → epoch ms). Lets the send-rejection handler tell an actual failed
  // message (surface it inline) from an automated TAGMSG/typing bounce (stay
  // silent) — the rejection numeric doesn't say which command it refused (#283).
  lastUserSendAt: Map<string, number>;

  constructor({ network, onEvent }: { network: Network; onEvent: (event: EnrichedEvent) => void }) {
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
    // Lowercase nicks we watch for presence, each tagged with why (DM peer
    // and/or friend). Gates the per-peer presence writes so we don't churn the
    // DB (and the WS broadcast stream) on every JOIN/QUIT for an unrelated user
    // on a busy network. Hydrated on 'registered' from message history + the
    // friend watch list, and grown as new DM activity arrives.
    this.trackedPeers = new Map();
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
    // Pending timer for the next WAIT-delayed connect command. Cleared on
    // close/dispose so we never call client.raw() after the socket is gone.
    this.connectCommandTimer = null;
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
    this.identdId = null;
    this.unsendableTargets = new Set();
    this.lastUserSendAt = new Map();
    this.bind();
  }

  publishUserModes(): void {
    this.publish({
      type: 'usermode',
      target: this.serverTarget(),
      modes: [...this.userModes].join(''),
    });
  }

  publishAwayState(): void {
    const a = this.awayState;
    // Emit the full pair whenever we have ANY away history (since set). The
    // client uses active+since to anchor the "you went away" divider and
    // backAt to anchor the "you came back" divider, so both timestamps must
    // ship even after the user returns.
    const away = a.since
      ? {
          active: a.active,
          since: a.since,
          message: a.message,
          autoSet: a.autoSet,
          backAt: a.backAt,
        }
      : null;
    this.publish({ type: 'away-state', target: this.serverTarget(), away });
  }

  shouldPersist(event: IrcEvent): boolean {
    if (!event.target) return false;
    return !NON_PERSISTED_TYPES.has(event.type);
  }

  // Channels are case-insensitive on IRC, but servers can relay events for the
  // same channel with different casing than we joined with — DALnet echoes your
  // own JOIN as #christian (the case you sent) yet relays everyone else's
  // messages/joins/modes as the registered #Christian. The client keys buffers
  // by exact target string, so a stray case spawns a second, metadata-less
  // buffer (#268). Normalize every channel-scoped target to the case we know
  // the channel by (this.channels is keyed lowercase; .name holds the
  // first-seen/joined case) so all of a channel's events land in one buffer.
  normalizeChannelTarget(event: IrcEvent): IrcEvent {
    const target = canonicalChannelTarget(event.target, this.channels);
    if (target === event.target) return event;
    return { ...event, target };
  }

  publish(event: IrcEvent): void {
    if (this.disposed) return;
    event = this.normalizeChannelTarget(event);
    const time = (event.time as string | undefined) || new Date().toISOString();
    const enriched: EnrichedEvent = {
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time,
    };

    if (this.shouldPersist(event)) {
      // Run the highlight engine before persisting so the match decision is
      // stored on the row. The cheap path (engine gates on type & self) keeps
      // this off the hot path for non-highlightable events.
      let matchedRuleId: number | null = null;
      try {
        const compiled = highlightRulesService.getCompiled(this.network.user_id);
        const { matched, ruleId } = matchEvent(event, compiled);
        if (matched) matchedRuleId = ruleId;
      } catch (e) {
        console.warn('[highlight] match-on-insert failed:', (e as Error)?.message || e);
      }
      // Stamp from_ignored at insert time so unread/highlight counts can
      // exclude ignored senders without a per-query mask scan. Only the
      // countable chat types ever read this column — gating to COUNTABLE_TYPES
      // skips the DB lookup on high-churn JOIN/PART/QUIT/NICK/KICK/etc.
      // Self messages can't be ignored; nick-less system rows have no sender.
      let fromIgnored = false;
      const nick = event.nick as string | null | undefined;
      if (COUNTABLE_TYPES.has(event.type) && nick && !event.self) {
        try {
          const masks = listIgnoredMasks({
            userId: this.network.user_id,
            networkId: this.network.id,
          });
          if (masks.length) {
            fromIgnored = matchesIgnoreMask(
              masks,
              nick,
              (event.userhost as string | null | undefined) ?? null,
            );
          }
        } catch (e) {
          console.warn('[ignore] match-on-insert failed:', (e as Error)?.message || e);
        }
      }
      const { id, alt } = insertMessage({
        networkId: this.network.id,
        target: event.target as string,
        time,
        type: event.type,
        nick: event.nick as string | undefined,
        text: event.text as string | undefined,
        kind: event.kind as string | undefined,
        self: event.self as boolean | undefined,
        extra: extractExtras(event),
        matchedRuleId,
        userhost: (event.userhost as string | null | undefined) ?? null,
        fromIgnored,
      });
      enriched.id = id;
      enriched.alt = alt;
      enriched.matched = matchedRuleId != null;
      enriched.matchedRuleId = matchedRuleId;
    }

    this.onEvent(enriched);
  }

  publishEphemeral(event: IrcEvent): void {
    if (this.disposed) return;
    event = this.normalizeChannelTarget(event);
    this.onEvent({
      ...event,
      userId: this.network.user_id,
      networkId: this.network.id,
      time: (event.time as string | undefined) || new Date().toISOString(),
    });
  }

  setState(state: string, extra: Record<string, unknown> = {}): void {
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
    this.logState(state, extra);
  }

  logScope(): string {
    return `net:${this.network.name}`;
  }

  logState(state: string, extra: Record<string, unknown>): void {
    let text;
    switch (state) {
      case 'connecting':
        text = 'Connecting…';
        break;
      case 'connected':
        text = extra?.nick ? `Connected as ${extra.nick}` : 'Connected';
        break;
      case 'reconnecting':
        text = 'Reconnecting';
        break;
      case 'disconnected':
        text = 'Disconnected';
        break;
      default:
        text = `State: ${state}`;
    }
    systemLog.log({
      userId: this.network.user_id,
      scope: this.logScope(),
      level: state === 'disconnected' ? 'warn' : 'info',
      text,
    });
  }

  bind(): void {
    const c = this.client;

    // Surface server numerics (welcome banner, lusers, SASL confirmation,
    // umode, hostmask) into the server buffer. irc-framework consumes these
    // for internal state and emits structured events ('registered', 'server
    // options', …) without re-emitting the original text, so the raw stream
    // is the only place the wire text is still visible. See
    // formatServerNumeric() for the per-command rendering and the deliberate
    // exclusions (005/ISUPPORT, etc.).
    c.on('raw', (event: { from_server: boolean; line: string }) => {
      if (!event?.from_server || typeof event.line !== 'string') return;
      let msg;
      try {
        msg = ircLineParser(event.line);
      } catch (_) {
        return;
      }
      const text = formatServerNumeric(msg);
      if (!text) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    // Catch-all for inbound server numerics/commands irc-framework has no
    // handler for (391 RPL_TIME, 351 RPL_VERSION, 477 ERR_NEEDREGGEDNICK, plus
    // any server-specific numeric). Without this they surface only as the
    // 'unknown command' event — which nothing listened to — and were dropped on
    // the floor (#262). The 'raw' handler above renders only the curated
    // allowlist in formatServerNumeric, so everything else vanished silently.
    c.on('unknown command', (cmd: { command?: string; params?: string[] }) => {
      const command = (cmd?.command || '').toString();
      const params = Array.isArray(cmd?.params) ? (cmd.params as string[]) : [];
      // These numerics arrive as [nick, #channel, reason].
      const channel = typeof params[1] === 'string' ? params[1] : '';
      const reason = params[params.length - 1] || null;
      // ERR_NEEDREGGEDNICK (477) to a channel we're already in is a speak
      // rejection, not a join failure — surface it inline in that channel so
      // the user sees why their message didn't land, instead of a misleading
      // "Couldn't join" toast (#283). publish() canonicalizes the channel case.
      if (
        channel &&
        isOverloadedSpeakRejection(command, this.channels.has(channel.toLowerCase()))
      ) {
        this.handleSendRejection(channel, reason, { command, params });
        return;
      }
      // Channel-join rejections irc-framework doesn't model (476/477) arrive
      // here too. Route them to the channel as an ephemeral toast so the failure
      // surfaces where the user tried to join, not buried in the server buffer
      // (#260). The client never opened the buffer (it waits for channel-joined),
      // so this is toast-only.
      const joinMsg = joinRejectionMessage(command);
      if (joinMsg && channel) {
        this.publishEphemeral({
          type: 'join-error',
          target: channel,
          text: joinMsg,
          reason,
        });
        return;
      }
      // Dedup guard: if formatServerNumeric already renders this numeric, the
      // 'raw' handler above produced the line — don't double-render. Only
      // genuinely unclaimed numerics fall through to the catch-all. Pass the
      // sanitized {command, params} (not the raw cmd) so a malformed params
      // value can't throw inside the formatters and crash the connection.
      if (formatServerNumeric({ command, params })) return;
      const text = formatUnknownNumeric({ command, params });
      if (!text) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    // RPL_LOGGEDIN (900): the user identified to services mid-session (NickServ
    // or SASL). That's exactly what +R/+M channels were waiting on, so drop the
    // unsendable set and let the next message re-probe — typing resumes too (#283).
    c.on('loggedin', () => {
      this.unsendableTargets.clear();
    });

    c.on('registered', (event: Record<string, unknown>) => {
      this.userModes.clear();
      this.lagMs = null;
      // Fresh registration means a new socket — forget per-connection send
      // state so speak permission is re-probed and stale attribution can't leak
      // across the reconnect (#283).
      this.resetSendState();
      // From here on, 'nick in use' is the user's /nick attempt — not us racing
      // to register. Freeze the fallback ladder.
      this.preRegistered = false;
      // irc-framework's command-handler fires its 'all' proxy (which routes
      // events to us via the client) BEFORE its own specific-event listener
      // that updates `c.user.nick` to the registered nick. So at this moment
      // `c.user.nick` is still the configured primary — useless for detecting
      // fallback. Take the confirmed nick straight from the RPL_WELCOME payload.
      const registeredNick = (event?.nick as string | undefined) || c.user.nick;
      const fallbackUsed = this.nickAttempt > 0 && registeredNick !== this.network.nick;
      this.startLagPinger();
      // Hydrate the DM-peer tracking set from open DM buffers — the union
      // of (a) targets we have any persisted history with and (b) targets
      // not in closed_buffers for this user. Closed DMs explicitly opted
      // out, so we don't track them until the user reopens. Filtering here
      // (not later) means we never write peer_presence_state rows for
      // closed buffers in the first place.
      this.trackedPeers.clear();
      try {
        for (const target of listBufferTargets(this.network.id)) {
          if (!isDmTargetName(target)) continue;
          if (isBufferClosed(this.network.user_id, this.network.id, target)) continue;
          this.addPeerReason(target.toLowerCase(), 'dm', null);
        }
      } catch (e) {
        console.warn('[presence] hydrate failed:', (e as Error)?.message || e);
      }
      // Hydrate the friend watch list before the MONITOR seed runs, so
      // seedMonitorWatch watches friends too and presence rows are populated for
      // any backlog that arrives. Same map as the DM peers — a nick that is both
      // just gains the 'friend' reason on top of 'dm'.
      try {
        for (const { contactId, nick } of listFriendTargetsForNetwork(this.network.id)) {
          this.addPeerReason(nick.toLowerCase(), 'friend', contactId);
        }
      } catch (e) {
        console.warn('[friends] hydrate failed:', (e as Error)?.message || e);
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
        const enabled = (c.network?.cap?.enabled || []).toSorted();
        if (enabled.length > 0) {
          this.publish({
            type: 'motd',
            target: this.serverTarget(),
            text: `Negotiated capabilities: ${enabled.join(' ')}`,
          });
        }
      } catch (_) {
        /* ignore */
      }
      try {
        highlightRulesService.upsertAutoNickRule(
          this.network.user_id,
          this.network.id,
          registeredNick,
        );
      } catch (e) {
        console.warn('[highlight] failed to upsert auto nick rule:', (e as Error)?.message || e);
      }
      // Re-assert /away on reconnect so the IRC server keeps showing us as
      // away — both manual and auto-away. For auto, if a client returns soon
      // after, the socket-reconnect path runs clearAwayAll({autoSet:true}) and
      // clears it cleanly; if not, staying away across an IRC blip is the
      // correct behavior.
      if (this.awayState.active && this.awayState.message) {
        try {
          this.client.raw('AWAY :' + this.awayState.message);
        } catch (_) {
          /* ignore */
        }
      }
      // IRCCloud-style "commands to run on connect" — newline-delimited raw
      // IRC lines fired after 001. `WAIT <seconds>` pauses before the next
      // command (e.g. waiting for NickServ identify to take effect before
      // joining +r channels). Re-runs on every reconnect by design.
      this.runConnectCommands();
    });
    c.on('close', () => {
      // Final safety net (clean disconnect/dispose may not always emit
      // 'socket close'); unregisterIdent is idempotent.
      unregisterIdent(this.identdId);
      this.identdId = null;
      this.userModes.clear();
      this.stopLagPinger();
      this.cancelPendingConnectCommands();
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
    c.on('nick in use', (event: Record<string, unknown>) => {
      const requested = (event?.nick as string) || '';
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
        try {
          this.client.quit('No available nickname');
        } catch (_) {
          /* ignore */
        }
        return;
      }
      try {
        this.client.changeNick(next);
      } catch (_) {
        /* ignore */
      }
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
      systemLog.log({
        userId: this.network.user_id,
        scope: this.logScope(),
        text: `MONITOR (IRCv3 presence) supported, watch limit ${limit}`,
      });
      if (this.pendingRegainSetup && this.regainNick) {
        this.pendingRegainSetup = false;
        try {
          this.client.addMonitor(this.regainNick);
        } catch (_) {
          /* ignore */
        }
      }
      if (this.pendingMonitorSeed) {
        this.pendingMonitorSeed = false;
        const seedCount = this.monitoredNicks().length;
        if (seedCount > 0) {
          systemLog.log({
            userId: this.network.user_id,
            scope: this.logScope(),
            text: `Seeding MONITOR with ${seedCount} nick${seedCount === 1 ? '' : 's'} (DM peers + friends)`,
          });
          this.seedMonitorWatch();
        }
      }
    });

    // RPL_MONONLINE — peers in our MONITOR watch list that are currently
    // online. Fires both on initial seed (server replies with the current
    // state of each newly-added nick) and live when a watched peer
    // connects. The regain handler doesn't react to online events, so
    // there's no conflict to filter.
    c.on('users online', (event: Record<string, unknown>) => {
      const nicks: string[] = Array.isArray(event?.nicks) ? (event.nicks as string[]) : [];
      if (nicks.length > 0) {
        systemLog.log({
          userId: this.network.user_id,
          scope: this.logScope(),
          text: `Presence: ${nicks.join(', ')} online`,
        });
      }
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
    c.on('users offline', (event: Record<string, unknown>) => {
      const nicks: string[] = Array.isArray(event?.nicks) ? (event.nicks as string[]) : [];
      if (nicks.length > 0) {
        systemLog.log({
          userId: this.network.user_id,
          scope: this.logScope(),
          text: `Presence: ${nicks.join(', ')} offline`,
        });
      }
      if (this.regainNick) {
        const target = this.regainNick.toLowerCase();
        if (nicks.some((n) => typeof n === 'string' && n.toLowerCase() === target)) {
          try {
            this.client.changeNick(this.regainNick);
          } catch (_) {
            /* ignore */
          }
        }
      }
      for (const nick of nicks) {
        if (typeof nick === 'string') this.markPeerEvent(nick, 'offline');
      }
    });

    c.on('pong', (event: Record<string, unknown>) => {
      const token = event?.message as string | undefined;
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
    c.on('socket close', (err: Record<string, unknown>) => {
      this.setState('disconnected');
      // Release this socket's identd mapping (a reconnect re-registers via the
      // 'raw socket connected' handler above and gets a fresh handle).
      unregisterIdent(this.identdId);
      this.identdId = null;
      if (err && (err.message || err.code)) {
        const where = `${this.network.host}:${this.network.port}`;
        const text = formatSocketCloseErrorMessage(
          err,
          where,
          this.network.trusted_certificates !== 0,
        );
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text,
        });
        systemLog.log({
          userId: this.network.user_id,
          scope: this.logScope(),
          level: 'error',
          text,
        });
      }
    });
    c.on('reconnecting', (event: Record<string, unknown>) => {
      this.setState('reconnecting');
      const wait =
        event && event.wait ? Math.max(1, Math.round((event.wait as number) / 1000)) : null;
      const attempt = event && event.attempt;
      const text =
        wait != null && attempt
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

    // Built-in identd: the moment the raw socket connects, register this
    // connection's full 4-tuple (both addresses + both ports) → this user's ident
    // so the identd server (services/identd.ts) can answer the IRC server's :113
    // callback. Without it a multi-user gateway's users are indistinguishable
    // (and unverified) behind one shared IP.
    //
    // This MUST run on 'raw socket connected' (the bare TCP connect, before any
    // TLS handshake) and not 'socket connected' (which irc-framework emits from
    // the transport's 'open'/'secureConnect' — i.e. AFTER the handshake). The
    // IRC server fires its ident query the instant it accepts our TCP
    // connection, concurrently with the TLS handshake, so a post-handshake
    // registration races the callback: on TLS networks the query frequently
    // arrives first and identd answers NO-USER. irc-framework hands us the
    // underlying socket here for exactly this purpose (its own comment:
    // "ideal to read socket pairs for identd"); localPort is already populated
    // at TCP-connect time on both plaintext and TLS sockets.
    c.on(
      'raw socket connected',
      (socket?: {
        localAddress?: string;
        localPort?: number;
        remoteAddress?: string;
        remotePort?: number;
      }) => {
        if (!isIdentdEnabled()) return;
        // The full 4-tuple identifies the connection to the identd server; the
        // ports alone are ambiguous (see identd.ts). Both addresses and ports
        // are already populated at TCP connect.
        const localPort = socket?.localPort;
        const remotePort = socket?.remotePort;
        if (!localPort || !remotePort) return;
        this.identdId = registerIdent({
          localAddress: socket.localAddress || '',
          localPort,
          remoteAddress: socket.remoteAddress || '',
          remotePort,
          ident: deriveIdent({
            nodeMode: isNodeMode(),
            accountUsername: findUserById(this.network.user_id)?.username || '',
            networkUsername: this.network.username,
            nick: this.network.nick,
          }),
        });
      },
    );

    // RPL_UMODEIS arrives when the server sends our current umode (e.g. on
    // login or in response to /MODE <self>). irc-framework normalises it to
    // 'user info' with the raw mode string ('+iwx').
    c.on('user info', (event: Record<string, unknown>) => {
      if (!c.user.nick || (event.nick as string).toLowerCase() !== c.user.nick.toLowerCase())
        return;
      this.userModes = new Set(((event.raw_modes as string) || '').replace(/^[+-]/, '').split(''));
      this.publishUserModes();
    });

    // irc-framework fires 'user updated' for both CHGHOST (ident/host change)
    // and SETNAME (realname change). The cloaked-vhost case after SASL on
    // Libera arrives as a CHGHOST, but only when we've requested the chghost
    // cap (see the client constructor). Surface self changes in the server
    // buffer so users see "your host became X" the way other clients do.
    c.on('user updated', (event: Record<string, unknown>) => {
      if (
        !event ||
        !c.user.nick ||
        (event.nick as string | undefined)?.toLowerCase() !== c.user.nick.toLowerCase()
      )
        return;
      if (event.new_hostname || event.new_ident) {
        const ident = (event.new_ident as string) || (event.ident as string) || '';
        const host = (event.new_hostname as string) || (event.hostname as string) || '';
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

    c.on('motd', (event: Record<string, unknown>) => {
      // irc-framework also fires 'motd' for ERR_NOMOTD (no MOTD configured)
      // with `error` instead of `motd`, and for servers with an empty MOTD
      // file `motd` is just ''. Skip the blank-line publish either way.
      const text = (event.motd as string) || (event.error as string) || '';
      if (!text.trim()) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    c.on('message', (event: Record<string, unknown>) => {
      // Drop server-pushed history replays. Some networks (e.g. Ergo with
      // `relaymsg`/replay enabled, mansionNET) blindly resend recent messages
      // inside a CHATHISTORY (or ZNC playback) BATCH on every reconnect.
      // We don't request the CHATHISTORY cap or command anywhere, so anything
      // arriving in one of these batches is unsolicited replay — and without
      // a dedupe path it inserts duplicates carrying the original (past)
      // server-time. Ignoring the whole batch is the right call.
      const batch = event.batch as { type?: string } | undefined;
      const batchType = batch?.type;
      if (
        batchType === 'chathistory' ||
        batchType === 'draft/chathistory' ||
        batchType === 'znc.in/playback'
      ) {
        return;
      }
      const me = c.user?.nick;
      const eventNick = event.nick as string | undefined;
      const eventTarget = event.target as string | undefined;
      const eventHostname = event.hostname as string | undefined;
      const eventMessage = event.message as string | undefined;
      const eventType = event.type as string | undefined;
      // Skip self-echoes. ircManager.send/.action already publishes a local
      // copy of every outgoing PRIVMSG/ACTION, so when the IRC server reflects
      // it back to us (echo-message cap, ergo's always-on relay, some
      // bouncers) the second copy would land in the database with a fresh id
      // and surface as a duplicate in the buffer. The local publish is the
      // source of truth for anything this backend sent.
      if (eventNick && me && eventNick.toLowerCase() === me.toLowerCase()) return;
      const isServer = !eventNick;
      const targetIsChannel = eventTarget && eventTarget.startsWith('#');
      const isNotice = eventType === 'notice';

      let target: string;
      if (isServer) target = `:server:${this.network.id}`;
      else if (targetIsChannel) target = eventTarget;
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
        const dmLower = (eventNick as string).toLowerCase();
        const existingTarget = listBufferTargets(this.network.id).find(
          (t) => t.toLowerCase() === dmLower,
        );
        const hasOpenDm =
          existingTarget && !isBufferClosed(this.network.user_id, this.network.id, existingTarget);
        target = hasOpenDm ? existingTarget : `:server:${this.network.id}`;
      } else target = eventNick as string;

      const type =
        eventType === 'action' ? 'action' : eventType === 'notice' ? 'notice' : 'message';
      const nick = eventNick || eventHostname || 'server';

      this.publish({
        type,
        target,
        nick,
        text: eventMessage,
        kind: eventType,
        self: false,
        userhost: buildUserhost(event),
      });
      // An incoming PRIVMSG (not NOTICE) is the moment this nick becomes a
      // tracked DM peer — add them via trackDmPeer so MONITOR + fires too.
      // NOTICEs go to the server buffer above, so there's no DM peer to
      // track for them. Channel chatter still flips presence only for peers
      // we already track.
      if (eventNick && !isServer && !targetIsChannel && !isNotice) {
        this.trackDmPeer(eventNick);
      }
      if (eventNick) this.markPeerEvent(eventNick, 'online');
    });

    c.on('join', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventNick = event.nick as string;
      const ch = this.upsertChannel(eventChannel);
      ch.members.set(eventNick.toLowerCase(), {
        nick: eventNick,
        modes: [],
        away: false,
        user: (event.ident as string) || null,
        host: (event.hostname as string) || null,
      });
      this.publish({
        type: 'join',
        target: eventChannel,
        nick: eventNick,
        userhost: buildUserhost(event),
      });
      if (eventNick !== c.user.nick) {
        // JOIN means they're online. If they were marked away and JOIN fires,
        // the away marker stays — markPeerEvent is idempotent against the
        // current state, and 'online' from JOIN doesn't fire if state is
        // already 'online'. (It WILL fire if state is 'offline' or null.)
        // The away-notify 'back' event is the authoritative back signal.
        this.markPeerEvent(eventNick, 'online');
      }
      if (eventNick === c.user.nick) {
        this.publish({ type: 'channel-joined', target: eventChannel });
        // Re-joining is a clean "try again" gesture: drop any stale
        // can't-speak-here mark so typing notifications resume. If we still
        // can't speak, the next attempt re-learns it from the bounce (#283).
        this.unsendableTargets.delete(eventChannel.toLowerCase());
        systemLog.log({
          userId: this.network.user_id,
          scope: this.logScope(),
          text: `Joined ${eventChannel}`,
        });
        // Most servers volunteer 324 on join, but a few don't. Request it so
        // the channel's mode flags reach the status bar consistently.
        try {
          c.raw('MODE', eventChannel);
        } catch (_) {
          /* ignore */
        }
      }
    });

    c.on('part', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventNick = event.nick as string;
      // Resolve the canonical (joined-case) channel name *before* the self-part
      // deletes it from this.channels below — the post-delete channel-parted
      // publish can't normalize once the entry is gone, and would otherwise leak
      // the server's relayed case (#268).
      const channel = canonicalChannelTarget(eventChannel, this.channels) ?? eventChannel;
      const ch = this.channels.get(eventChannel.toLowerCase());
      if (ch) ch.members.delete(eventNick.toLowerCase());
      this.publish({
        type: 'part',
        target: channel,
        nick: eventNick,
        text: event.message as string | undefined,
        userhost: buildUserhost(event),
      });
      if (eventNick === c.user.nick) {
        this.channels.delete(eventChannel.toLowerCase());
        this.publish({ type: 'channel-parted', target: channel });
        systemLog.log({
          userId: this.network.user_id,
          scope: this.logScope(),
          text: event.message
            ? `Parted ${channel}: ${event.message as string}`
            : `Parted ${channel}`,
        });
      }
    });

    c.on('kick', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventNick = event.nick as string;
      const eventKicked = event.kicked as string;
      // Canonical (joined-case) name, resolved before the self-kick deletes the
      // channel from this.channels — so the persisted channels row and the
      // channel-parted publish use our case, not the server's relayed case. A
      // kick relayed as #Christian was how a stray-case channels row got written
      // and then auto-rejoined verbatim (#268).
      const channel = canonicalChannelTarget(eventChannel, this.channels) ?? eventChannel;
      const ch = this.channels.get(eventChannel.toLowerCase());
      if (ch) ch.members.delete(eventKicked.toLowerCase());
      this.publish({
        type: 'kick',
        target: channel,
        nick: eventNick,
        kicked: eventKicked,
        text: event.message as string | undefined,
        userhost: buildUserhost(event),
      });
      // Mirror the self-PART path when we ourselves are the one kicked, so
      // the buffer dims in the sidebar instead of staying styled as joined.
      // Persisting joined=false here also prevents auto-rejoin on reconnect.
      if (eventKicked && c.user.nick && eventKicked.toLowerCase() === c.user.nick.toLowerCase()) {
        this.channels.delete(eventChannel.toLowerCase());
        try {
          upsertChannel(this.network.id, channel, false);
        } catch (_) {
          /* ignore */
        }
        this.publish({ type: 'channel-parted', target: channel });
      }
    });

    c.on('quit', (event: Record<string, unknown>) => {
      const eventNick = event.nick as string;
      const lower = eventNick.toLowerCase();
      const userhost = buildUserhost(event);
      for (const ch of this.channels.values()) {
        if (ch.members.delete(lower)) {
          this.publish({
            type: 'quit',
            target: ch.name,
            nick: eventNick,
            text: event.message as string | undefined,
            userhost,
          });
        }
      }
      // QUIT means they've left the network entirely, not just a channel —
      // any DM with this nick is now into-the-void territory.
      this.markPeerEvent(eventNick, 'offline');
    });

    c.on('nick', (event: Record<string, unknown>) => {
      const eventNick = event.nick as string;
      const eventNewNick = event.new_nick as string;
      const oldLower = eventNick.toLowerCase();
      const newLower = eventNewNick.toLowerCase();
      // irc-framework's command-handler runs the 'all' proxy (which routes
      // events to us) BEFORE its specific-event listeners. So when we receive
      // this event, `c.user.nick` is still the OLD nick — not the new one.
      // Detect self by matching the event's old nick against the current
      // tracked nick, mirroring what the framework's own listener does at
      // client.js:265 before it updates user.nick.
      const isSelfNick = !!c.user.nick && c.user.nick.toLowerCase() === oldLower;
      if (isSelfNick) {
        try {
          highlightRulesService.upsertAutoNickRule(
            this.network.user_id,
            this.network.id,
            eventNewNick,
          );
        } catch (e) {
          console.warn('[highlight] failed to update auto nick rule:', (e as Error)?.message || e);
        }
        // If a regain watch is active, tear it down on any self-nick change:
        // either we just reclaimed the primary (publish a notice), or the user
        // manually picked a different nick (their choice, drop the watch
        // silently). Either way the watch is now stale.
        if (this.regainNick) {
          const reclaimed = newLower === this.regainNick.toLowerCase();
          try {
            this.client.removeMonitor(this.regainNick);
          } catch (_) {
            /* ignore */
          }
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
        this.publish({ type: 'own-nick', nick: eventNewNick });
      }
      const userhost = buildUserhost(event);
      for (const ch of this.channels.values()) {
        const member = ch.members.get(oldLower);
        if (member) {
          ch.members.delete(oldLower);
          ch.members.set(newLower, {
            nick: eventNewNick,
            modes: member.modes,
            away: !!member.away,
            user: (event.ident as string) || member.user || null,
            host: (event.hostname as string) || member.host || null,
          });
          this.publish({
            type: 'nick',
            target: ch.name,
            nick: eventNick,
            newNick: eventNewNick,
            userhost,
          });
        }
      }
      // From a DM-buffer perspective: the old name is no longer reachable
      // (sending to it would 401), and the new name is reachable (if we have
      // a DM with them, or now). Don't fire either side for our own /nick.
      if (!isSelfNick) {
        this.markPeerEvent(eventNick, 'offline');
        this.markPeerEvent(eventNewNick, 'online');
      }
    });

    c.on('topic', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventTopic = event.topic as string | undefined;
      const ch = this.upsertChannel(eventChannel);
      ch.topic = eventTopic ?? null;
      if (event.nick) {
        // Live TOPIC change — persist + render in the message list.
        this.publish({
          type: 'topic',
          target: eventChannel,
          nick: event.nick as string,
          text: eventTopic,
        });
      } else {
        // RPL_TOPIC on join — sync the topic bar without printing a row, so
        // rejoining an already-open buffer doesn't repeat the same topic line
        // every time.
        this.publishEphemeral({ type: 'channel-topic', target: eventChannel, topic: eventTopic });
      }
    });

    c.on('mode', (event: Record<string, unknown>) => {
      const target = event.target as string | undefined;

      const eventModes = (event.modes as ModeEntry[] | undefined) || [];
      const eventRawModes = event.raw_modes as string | undefined;
      const eventRawParams = (event.raw_params as string[] | undefined) || [];
      const eventNick = event.nick as string | undefined;

      // Self user-mode change (e.g. server sets +i on connect, /OPER yields +o, etc.)
      if (target && c.user.nick && target.toLowerCase() === c.user.nick.toLowerCase()) {
        let changed = false;
        for (const m of eventModes) {
          if (!m || !m.mode) continue;
          const sign = m.mode[0];
          const letter = m.mode.slice(1);
          if (sign === '+' && !this.userModes.has(letter)) {
            this.userModes.add(letter);
            changed = true;
          } else if (sign === '-' && this.userModes.delete(letter)) {
            changed = true;
          }
        }
        if (changed) this.publishUserModes();
        // Solanum-style servers (Libera) send self-modes as a MODE command
        // after MOTD instead of RPL_UMODEIS (221). The raw-numeric forwarder
        // catches 221; this surfaces the MODE path so the user mode lands in
        // the server buffer either way.
        if (eventRawModes) {
          this.publish({
            type: 'motd',
            target: this.serverTarget(),
            text: `Your user mode: ${eventRawModes}`,
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
        for (const m of eventModes) {
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
            if (sign === '+' && !ch.modes.has(letter)) {
              ch.modes.add(letter);
              chanModesChanged = true;
            } else if (sign === '-' && ch.modes.delete(letter)) {
              chanModesChanged = true;
            }
          }
        }
      }
      const text = [eventRawModes, ...eventRawParams].filter(Boolean).join(' ');
      this.publish({
        type: 'mode',
        target,
        nick: eventNick,
        text,
        modes: eventModes,
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
    c.on('channel info', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string | undefined;
      const eventModes = event.modes as ModeEntry[] | undefined;
      if (!eventChannel || !eventModes) return;
      const ch = this.channels.get(eventChannel.toLowerCase());
      if (!ch) return;
      const next = new Set<string>();
      for (const m of eventModes) {
        if (!m || !m.mode || m.param) continue;
        const letter = m.mode.replace(/^[+-]/, '');
        if (!letter) continue;
        next.add(letter);
      }
      const before = [...ch.modes].toSorted().join('');
      const after = [...next].toSorted().join('');
      if (before !== after) {
        ch.modes = next;
        this.publishChannelModes(ch);
      }
    });

    c.on('userlist', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventUsers = (event.users as Record<string, unknown>[]) || [];
      const ch = this.upsertChannel(eventChannel);
      // Preserve known away flags AND user/host across re-issued NAMES
      // (e.g. on /NAMES or a fresh join). NAMES doesn't carry ident/host on
      // most ircds — the JOIN event and WHO reply do — so we hold onto
      // whatever we already learned.
      const prev = new Map<string, { away: boolean; user: string | null; host: string | null }>();
      for (const [k, v] of ch.members)
        prev.set(k, { away: !!v.away, user: v.user || null, host: v.host || null });
      ch.members.clear();
      for (const u of eventUsers) {
        const nick = u.nick as string;
        const lc = nick.toLowerCase();
        const carry = prev.get(lc) || { away: false, user: null, host: null };
        ch.members.set(lc, {
          nick,
          modes: (u.modes as string[]) || [],
          away: carry.away || false,
          user: (u.ident as string) || carry.user || null,
          host: (u.hostname as string) || carry.host || null,
        });
      }
      this.publish({
        type: 'names',
        target: eventChannel,
        members: Array.from(ch.members.values()).map(memberSnapshot),
      });
      // Issue a WHO so we learn the current away state for everyone in the
      // channel. away-notify keeps it live after this initial sync.
      try {
        c.who(eventChannel);
      } catch (_) {
        /* ignore */
      }
    });

    c.on('wholist', (event: Record<string, unknown>) => {
      const eventTarget = event.target as string | undefined;
      const ch = this.channels.get(eventTarget?.toLowerCase() ?? '');
      if (!ch) return;
      let changed = false;
      for (const u of (event.users as Record<string, unknown>[]) || []) {
        if (!u || !u.nick) continue;
        const m = ch.members.get((u.nick as string).toLowerCase());
        if (!m) continue;
        const next = !!u.away;
        // Bridge the WHO away flag to the DM/friend presence rail for tracked
        // peers. away-notify keeps presence live, but it doesn't fire on join —
        // so without this a friend who's away when we (re)connect and share a
        // channel would read as online. The transition gates in markPeerEvent
        // make this idempotent: 'away' sets away; 'back' only clears a stale
        // away and otherwise no-ops, so it never disturbs online/offline.
        this.markPeerEvent(u.nick as string, next ? 'away' : 'back');
        if (m.away !== next) {
          m.away = next;
          changed = true;
        }
        // WHO carries ident/host (RPL_WHOREPLY 352) — backfill so the
        // nicklist's right-click "Ignore…" modal has a hostmask to suggest
        // even for members whose join we never observed (e.g. they were
        // already in the channel when we joined).
        if (u.ident && m.user !== (u.ident as string)) {
          m.user = u.ident as string;
          changed = true;
        }
        if (u.hostname && m.host !== (u.hostname as string)) {
          m.host = u.hostname as string;
          changed = true;
        }
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
    c.on('away', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick as string, true);
      this.markPeerEvent(event.nick as string, 'away', (event.message as string | null) || null);
    });
    c.on('back', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick as string, false);
      this.markPeerEvent(event.nick as string, 'back');
    });

    // irc-framework aggregates RPL_WHOIS* (311/312/317/319/330/...) into a
    // single 'whois' event when RPL_ENDOFWHOIS arrives. We fan it out as a
    // structured `whois_result` event so the client can render it in the
    // user-profile modal (issue #92). `error: 'not_found'` surfaces here too
    // (irc-framework synthesizes a whois event with that shape on
    // ERR_NOSUCHNICK) so the modal can flip to its empty state.
    //
    // The server buffer gets the *raw* whois lines instead — rendered straight
    // off the wire by formatServerNumeric on the 'raw' path (#281), not the
    // parsed JSON this event carries — so nothing whois-related is published
    // here beyond the modal payload.
    c.on('whois', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      this.publishEphemeral({ type: 'whois_result', whois: event });
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
        console.warn(`[chanlist:${nid}] start failed:`, (e as Error)?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-start' });
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c.on('channel list', (channels: any) => {
      const nid = this.network.id;
      try {
        chanlistDb.upsertChannels(nid, channels || []);
        const total = chanlistDb.countChannels(nid);
        chanlistDb.setMeta(nid, { totalCount: total, inProgress: true });
        this.publishEphemeral({ type: 'chanlist-progress', total });
      } catch (e) {
        console.warn(`[chanlist:${nid}] batch failed:`, (e as Error)?.message || e);
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
        console.warn(`[chanlist:${nid}] end failed:`, (e as Error)?.message || e);
      }
      this.publishEphemeral({ type: 'chanlist-end', total });
    });

    c.on('irc error', (event: Record<string, unknown>) => {
      // irc-framework maps the IRC ERROR command (sent right before the
      // server drops you) and ERR_* numerics to this event. `error` is a
      // short tag like 'irc' / 'no_such_nick' / 'password_mismatch';
      // `reason` is the human-readable trailing param from the server
      // ("Closing Link: foo[u@h] (G-Lined)", etc.). The earlier handler
      // returned the first truthy of (error, reason), so an ERROR command
      // with both fields collapsed to the literal string "irc" and the
      // actual disconnect reason was thrown away.
      const tag = (event?.error as string) || 'irc error';
      const reason = event?.reason as string | undefined;
      const eventNick = event?.nick as string | undefined;
      const isDmMiss = tag === 'no_such_nick' && eventNick && isDmTargetName(eventNick);
      // For ERR_NOSUCHNICK against a nick the user has any DM history with,
      // route the error into that DM buffer so the failure surfaces where
      // they sent the message instead of getting lost in the server buffer.
      // Presence is no longer driven from here — MONITOR is the authority
      // for online/offline state.
      if (isDmMiss && hasMessageForTarget(this.network.id, eventNick as string)) {
        const message = reason || 'No such nick — they may be offline.';
        this.publish({
          type: 'error',
          target: eventNick,
          text: message,
          raw: event,
        });
        return;
      }
      // Channel-join rejections (full / invite-only / banned / bad key / too
      // many channels) carry the target in event.channel. Route them to that
      // channel as an ephemeral toast so the failure surfaces where the user
      // tried to join instead of in the server buffer (#260). Toast-only: the
      // client waits for channel-joined before opening the buffer, so on
      // failure there is no buffer to render into.
      const rejectChannel = event?.channel as string | undefined;
      const rejectMsg = rejectChannel ? joinRejectionMessageByTag(tag) : null;
      if (rejectChannel && rejectMsg) {
        this.publishEphemeral({
          type: 'join-error',
          target: rejectChannel,
          text: rejectMsg,
          reason,
        });
        return;
      }
      // Send rejections (ERR_CANNOTSENDTOCHAN 404 / ERR_CANNOTSENDTOUSER 531):
      // the message we just optimistically echoed never landed. Surface an
      // inline error in the buffer the user sent to — the channel (event.channel)
      // or the DM peer (event.nick) — instead of letting it fall through to the
      // server buffer, where the optimistic echo makes the send look fine (#283).
      const sendRejectKind = sendRejectionTargetKind(tag);
      const sendRejectTarget =
        sendRejectKind === 'channel' ? rejectChannel : sendRejectKind === 'nick' ? eventNick : null;
      if (sendRejectKind && sendRejectTarget) {
        this.handleSendRejection(sendRejectTarget, reason, event);
        return;
      }
      // ERR_UNKNOWNCOMMAND (421) carries the rejected command name in
      // event.command (irc-framework parses it from the numeric's params).
      // Include it so the buffer line names the offending command —
      // "unknown_command FOO — Unknown command" — instead of just the tag.
      const ctx = [eventNick, event?.channel, event?.command, event?.server]
        .filter(Boolean)
        .join(' ');
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
        // Unknown slash commands are forwarded verbatim as raw IRC (see
        // MessageInput's default case), so this 421 is the first sign the
        // command was bad — and it lands in the server buffer, easy to miss
        // when you typed in a channel. Tag it so the client can also raise a
        // toast where the user is actually looking. Scoped to
        // ERR_UNKNOWNCOMMAND with a known command name; other server errors
        // stay buffer-only to keep toast noise down.
        ...(tag === 'unknown_command' && event?.command
          ? { unknownCommand: event.command as string }
          : {}),
      });
    });

    c.on('tagmsg', (event: Record<string, unknown>) => {
      const me = c.user?.nick;
      const eventNick = event.nick as string | undefined;
      const isSelf = !!eventNick && eventNick === me;
      if (isSelf) return;
      const tags = event.tags as Record<string, string> | undefined;
      const typing = tags && tags['+typing'];
      if (!typing) return;
      const eventTarget = event.target as string | undefined;
      const targetIsChannel = eventTarget && eventTarget.startsWith('#');
      const target = targetIsChannel ? eventTarget : eventNick;
      this.publishEphemeral({
        type: 'typing',
        target,
        nick: eventNick,
        state: typing,
        userhost: buildUserhost(event),
      });
    });
  }

  serverTarget(): string {
    return `:server:${this.network.id}`;
  }

  // Bail-out for transition writes: gate by tracked-peer set and self-nick.
  // Returns the eligible canonical nick (preserving the case as sent),
  // or null when the caller should no-op.
  eligiblePeer(nick: string | undefined | null): string | null {
    if (!nick) return null;
    const me = this.client.user?.nick;
    if (me && nick.toLowerCase() === me.toLowerCase()) return null;
    const lower = nick.toLowerCase();
    // Presence fires for DM peers AND friends — both live in trackedPeers.
    if (!this.trackedPeers.has(lower)) return null;
    return nick;
  }

  // Emit the current row to clients. Peer presence is network-level state
  // on the client (mirroring self away/back), so target is the server
  // pseudo-buffer — that way the wsHub closed-buffer guard doesn't drop
  // updates for DMs the user dismissed (state still flows to
  // networks.states[networkId].peerPresence). The `nick` field carries the
  // routing key the client uses for its peerPresence map.
  publishPeerPresence(nick: string, row: PeerPresence | null, cameOnline = false): void {
    this.publishEphemeral({
      type: 'peer-presence',
      target: this.serverTarget(),
      nick,
      state: row?.state || null,
      stateAt: row?.stateAt || null,
      awayMessage: row?.awayMessage || null,
      // True only on a real offline→online transition (see markPeerEvent).
      // wsHub reads this to fire the came-online push; the client ignores it.
      cameOnline,
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
  markPeerEvent(nick: string, state: PeerState, awayMessage: string | null = null): void {
    const canonical = this.eligiblePeer(nick);
    if (!canonical) {
      return;
    }
    const prev = getPeerPresence(this.network.id, canonical);
    const prevState = prev?.state || null;
    let allowed = false;
    if (state === 'online') allowed = prevState === null || prevState === 'offline';
    else if (state === 'offline') allowed = prevState !== 'offline';
    else if (state === 'away') allowed = prevState !== 'away';
    else if (state === 'back') allowed = prevState === 'away';
    if (!allowed) {
      return;
    }
    const stateAt = new Date().toISOString();
    const message = state === 'away' ? awayMessage || null : null;
    const next = writePeerState(this.network.id, canonical, state, stateAt, message);
    // A genuine offline→online transition (not first-sight null→online, which
    // covers a freshly-added watch / the MONITOR seed) is the only one that
    // drives the "friend came online" notification. Flag it so wsHub can fire a
    // push when no client is visible — mirrors the client-side toast gate.
    const cameOnline = state === 'online' && prevState === 'offline';
    this.publishPeerPresence(canonical, next, cameOnline);
  }

  // Bulk-seed the MONITOR watch list from the tracked DM peers set. Called
  // once per connection from the 'server options' handler, after ISUPPORT
  // confirms MONITOR is supported. Batches nicks into 'MONITOR + n1,n2,…'
  // lines under the 512-byte IRC wire limit so a 100-peer seed doesn't
  // trip "Excess Flood" on Libera (same pattern used for channel JOIN
  // batching in ircManager.startNetwork). Any nicks beyond monitorLimit
  // are kept in the in-memory set but skipped on the wire; we surface a
  // notice so the user knows live presence is degraded for the overflow.
  // Deduped union of the nicks we want MONITORed: DM peers and friends share
  // the one per-connection MONITOR budget.
  monitoredNicks(): string[] {
    // The map keys are already the deduped union of DM peers and friends.
    return Array.from(this.trackedPeers.keys());
  }

  seedMonitorWatch(): void {
    const peers = this.monitoredNicks();
    if (peers.length === 0) return;
    const cap = this.monitorLimit > 0 ? this.monitorLimit : peers.length;
    const watched = peers.slice(0, cap);
    const overflow = peers.length - watched.length;
    if (overflow > 0) {
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'lurker',
        text: `MONITOR limit (${this.monitorLimit}) reached; live presence skipped for ${overflow} nick${overflow === 1 ? '' : 's'}.`,
      });
    }
    // "MONITOR + " prefix is 11 bytes; leave headroom for trailing \r\n
    // and the comma separators. Cap line content at 400 bytes (matches the
    // channel-JOIN batcher).
    const MAX = 400;
    let chunk: string[] = [];
    let len = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const line = 'MONITOR + ' + chunk.join(',');
      try {
        this.client.raw(line);
      } catch (_) {
        /* ignore */
      }
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
    try {
      this.client.raw('MONITOR S');
    } catch (_) {
      /* ignore */
    }
  }

  // ---- presence watch list (shared MONITOR + peer_presence_state rails) ----
  // trackDmPeer/trackFriend (and their untrackers) are thin wrappers over the
  // reference-counted helpers below: the wire watch and the DB row are added on
  // the first reason and removed on the last, so a nick held by both roles is
  // watched once and survives losing either.

  // In-memory only: record that `lower` is watched for `reason`, merging with
  // any existing entry. Does NOT touch the wire — hydration uses this and the
  // MONITOR seed sends the batched `MONITOR +` afterward.
  private addPeerReason(lower: string, reason: TrackReason, contactId: number | null): void {
    const w = this.trackedPeers.get(lower);
    if (w) {
      w.reasons.add(reason);
      if (reason === 'friend') w.contactId = contactId;
    } else {
      this.trackedPeers.set(lower, {
        reasons: new Set([reason]),
        contactId: reason === 'friend' ? contactId : null,
      });
    }
  }

  // Add a live watch reason for `nick`. Issues `MONITOR +` (subject to the
  // shared cap) the first time the nick becomes tracked for any reason; if it's
  // already watched (for this or the other role) only the reason is recorded, so
  // we never re-send a redundant line. Self/blank nicks are ignored. Returns
  // true if `reason` was newly added. With `useMonitor` false we still grow the
  // set so other handlers recognize the nick — they just get no live presence.
  private addPeerWatch(
    nick: string | undefined | null,
    reason: TrackReason,
    contactId: number | null,
  ): boolean {
    if (!nick) return false;
    const me = this.client.user?.nick;
    if (me && nick.toLowerCase() === me.toLowerCase()) return false;
    const lower = nick.toLowerCase();
    const existing = this.trackedPeers.get(lower);
    if (existing) {
      if (existing.reasons.has(reason)) {
        if (reason === 'friend') existing.contactId = contactId;
        return false;
      }
      // Already on the wire for the other role — just record the new reason.
      this.addPeerReason(lower, reason, contactId);
      return true;
    }
    this.addPeerReason(lower, reason, contactId);
    if (!this.useMonitor || this.state !== 'connected') return true;
    if (this.monitoredNicks().length > this.monitorLimit) {
      // Over-limit add: keep the in-memory tracking but skip MONITOR. Surface
      // once so the user knows live presence is degraded for this nick.
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'lurker',
        text: `MONITOR limit (${this.monitorLimit}) reached; live presence skipped for ${nick}.`,
      });
      return true;
    }
    try {
      this.client.raw('MONITOR + ' + nick);
      // Same belt-and-suspenders as seedMonitorWatch: per IRCv3 the server only
      // SHOULD (not MUST) volunteer the nick's current state in reply to
      // MONITOR +, so a freshly-added watch can land with no state. That leaves
      // the peer at 'unknown' on the client, which the friends list renders
      // undimmed — i.e. indistinguishable from online — until a reconnect
      // re-seeds. MONITOR S asks for every monitored nick's state explicitly;
      // markPeerEvent's idempotency gate eats the duplicate replies for nicks we
      // already had state for, so it's safe to send on every add. (#302)
      this.client.raw('MONITOR S');
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  // Tear down the shared MONITOR watch + peer_presence_state row for a nick we
  // no longer watch for any reason. Safe on an untracked nick (clears a stale
  // row); the MONITOR - is a harmless no-op server-side if it was never watched.
  private teardownPeerWatch(nick: string): void {
    if (this.useMonitor && this.state === 'connected') {
      try {
        this.client.raw('MONITOR - ' + nick);
      } catch (_) {
        /* ignore */
      }
    }
    try {
      deletePeerPresence(this.network.id, nick);
    } catch (e) {
      console.warn('[presence] untrack failed:', (e as Error)?.message || e);
    }
  }

  // An incoming DM (or DM activate) makes this nick a tracked DM peer; presence
  // then rides MONITOR. Returns true on a fresh add.
  trackDmPeer(nick: string | undefined | null): boolean {
    return this.addPeerWatch(nick, 'dm', null);
  }

  // User closed the DM buffer: drop the 'dm' reason. If the nick is still a
  // friend the shared watch + presence row stay; otherwise both are cleared —
  // even when it wasn't actively tracked, so a stale row from history is swept.
  untrackDmPeer(nick: string | undefined | null): void {
    if (!nick) return;
    const lower = nick.toLowerCase();
    const existing = this.trackedPeers.get(lower);
    existing?.reasons.delete('dm');
    if (existing && existing.reasons.size > 0) return; // still a friend → keep
    this.trackedPeers.delete(lower);
    this.teardownPeerWatch(nick);
  }

  // A contact target makes this nick a tracked friend, sharing the DM peer's
  // MONITOR watch + presence row, so the wire only fires when it isn't already
  // a DM peer.
  trackFriend(nick: string | undefined | null, contactId: number): void {
    this.addPeerWatch(nick, 'friend', contactId);
  }

  // Drop the 'friend' reason. No-op if it wasn't a friend. If the nick is still
  // a DM peer the shared watch + row stay; otherwise both are cleared.
  untrackFriend(nick: string | undefined | null): void {
    if (!nick) return;
    const lower = nick.toLowerCase();
    const existing = this.trackedPeers.get(lower);
    if (!existing || !existing.reasons.delete('friend')) return; // wasn't a friend
    if (existing.reasons.size > 0) return; // still a DM peer → keep
    this.trackedPeers.delete(lower);
    this.teardownPeerWatch(nick);
  }

  // DM activate triggers this via the `probe-presence` ws message. With
  // MONITOR, adding to the watch elicits an immediate RPL_MONONLINE or
  // RPL_MONOFFLINE from the server — no separate WHOIS probe needed.
  probePresence(nick: string | undefined | null): void {
    if (!nick || !isDmTargetName(nick)) return;
    this.trackDmPeer(nick);
  }

  // Update the away flag for `nick` across every channel they're in and
  // re-broadcast names for each affected channel so clients re-render the
  // nicklist. Silent if the nick isn't tracked anywhere.
  applyMemberAway(nick: string, away: boolean): void {
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

  upsertChannel(name: string): ChannelState {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Map(), modes: new Set() };
      this.channels.set(key, ch);
    }
    if (!ch.modes) ch.modes = new Set();
    return ch;
  }

  publishChannelModes(ch: ChannelState): void {
    this.publish({
      type: 'channel-modes',
      target: ch.name,
      modes: [...ch.modes].join(''),
    });
  }

  publishLag(): void {
    this.publish({
      type: 'lag',
      target: this.serverTarget(),
      lagMs: this.lagMs,
    });
  }

  // Periodic PING with a `lurker-lag-<sent>` token. PONG echoes the token back
  // so the matching pong handler can compute roundtrip even when the server
  // is also ponging unrelated PINGs we didn't send. Cleared on disconnect.
  startLagPinger(): void {
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
      try {
        this.client.ping(token);
      } catch (_) {
        /* ignore */
      }
    };
    sendOne();
    this.lagPingTimer = setInterval(sendOne, 30_000);
  }

  stopLagPinger(): void {
    if (this.lagPingTimer) {
      clearInterval(this.lagPingTimer);
      this.lagPingTimer = null;
    }
    this.lagPendingToken = null;
    this.lagPendingSentAt = 0;
  }

  connect(): void {
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
      rejectUnauthorized: this.network.trusted_certificates !== 0,
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

  join(channel: string): void {
    this.client.join(channel);
  }
  part(channel: string, reason?: string): void {
    this.client.part(channel, reason);
  }
  say(target: string, text: string): void {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.noteUserSend(target);
    this.client.say(target, text);
  }
  action(target: string, text: string): void {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.noteUserSend(target);
    this.client.action(target, text);
  }
  notice(target: string, text: string): void {
    // Unlike say/action we don't trackDmPeer here: outgoing NOTICEs mirror the
    // inbound rule (NOTICEs don't establish a tracked DM peer), so notice-ing a
    // service or bot doesn't spin up presence tracking for it.
    this.noteUserSend(target);
    this.client.notice(target, text);
  }

  // Record that the user just sent a real message to `target`. handleSendRejection
  // reads this to tell an actual failed message from an automated TAGMSG/typing
  // bounce — the rejection numeric alone doesn't say which command it refused.
  noteUserSend(target: string): void {
    const now = Date.now();
    // Prune entries past the attribution window before adding. They can never
    // satisfy recentUserSend again, so keeping them would let the map grow
    // unbounded as the user messages more one-off DM targets over a long-lived
    // connection. The live set is tiny — only targets messaged in the last few
    // seconds — so this stays cheap.
    for (const [key, at] of this.lastUserSendAt) {
      if (now - at > SEND_REJECTION_ATTRIBUTION_MS) this.lastUserSendAt.delete(key);
    }
    this.lastUserSendAt.set(target.toLowerCase(), now);
  }

  recentUserSend(target: string): boolean {
    const at = this.lastUserSendAt.get(target.toLowerCase());
    return at != null && Date.now() - at <= SEND_REJECTION_ATTRIBUTION_MS;
  }

  // The server refused an outgoing message to `target` (ERR_CANNOTSENDTOCHAN
  // 404 / ERR_CANNOTSENDTOUSER 531 / ERR_NEEDREGGEDNICK 477 while joined).
  // Remember the target is unsendable so we stop firing typing TAGMSGs that
  // would each bounce (#283), then surface the failure inline — but only when
  // the user actually just sent a message there. Typing notifications and other
  // automated sends bounce too; those fail silently instead of spamming the
  // buffer with "Message not delivered".
  handleSendRejection(target: string, reason: string | null | undefined, raw: unknown): void {
    this.unsendableTargets.add(target.toLowerCase());
    if (!this.recentUserSend(target)) return;
    this.publish({ type: 'error', target, text: sendRejectionText(reason), raw });
  }

  // Forget per-connection send state: the speak-permission marks and the send-
  // attribution timestamps. Both are tied to the live socket, so a reconnect
  // must start clean — otherwise a pre-reconnect send could mis-attribute the
  // first refused bounce on the new socket as a message the user just sent (and
  // a stale unsendable mark could suppress typing the user can now do) (#283).
  resetSendState(): void {
    this.unsendableTargets.clear();
    this.lastUserSendAt.clear();
  }
  raw(line: string): void {
    // Strip CR/LF/NUL before the line hits the socket. irc-framework's
    // writeLine appends its own \r\n and writes verbatim, so any embedded
    // newline in a caller-built line (a kick reason, topic, ban host, etc.)
    // would split into a second injected IRC command. Sanitizing here covers
    // every raw call site — slash commands and the member-menu op actions
    // alike — rather than scrubbing each interpolated string at its source.
    // Matching control chars is the whole point, so the lint rule is moot here.
    // eslint-disable-next-line no-control-regex
    this.client.raw(line.replace(/[\u000d\u000a\u0000]/g, ''));
  }
  sendTyping(target: string, state: string): void {
    // +typing is a client-only tag carried over TAGMSG, which only exists when
    // the server negotiated the message-tags capability. Networks that don't
    // speak it (DALnet and other non-IRCv3 servers) answer every TAGMSG with
    // ERR_UNKNOWNCOMMAND, which our 'irc error' handler surfaces as a toast —
    // so an ungated send spams an error on each keystroke. Typing indicators
    // are a best-effort nicety; no cap, no send.
    if (!(this.client.network?.cap?.enabled || []).includes('message-tags')) return;
    // Suppress typing TAGMSGs to a target the server has refused our messages to
    // (a +R/+M channel needing a registered nick to speak, a +R user, ...).
    // Every typing TAGMSG to it bounces as another send rejection; we learned it
    // can't be spoken to from the first bounce, so stop pinging it until that
    // clears on (re)login (#283). Same spirit as the offline-peer guard below.
    if (this.unsendableTargets.has(target.toLowerCase())) return;
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
  applyAwayState(next: AwayState): void {
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
        try {
          this.client.raw('AWAY :' + next.message);
        } catch (_) {
          /* ignore */
        }
      } else if (!next.active && prev.active) {
        try {
          this.client.raw('AWAY');
        } catch (_) {
          /* ignore */
        }
      }
    }
    this.publishAwayState();
  }

  disconnect(reason: string = DEFAULT_QUIT_MESSAGE): void {
    this.client.quit(reason);
  }

  dispose(reason: string = 'network removed'): void {
    this.disposed = true;
    this.stopLagPinger();
    this.cancelPendingConnectCommands();
    try {
      this.client.quit(reason);
    } catch (_) {
      /* ignore */
    }
  }

  cancelPendingConnectCommands(): void {
    if (this.connectCommandTimer) {
      clearTimeout(this.connectCommandTimer);
      this.connectCommandTimer = null;
    }
  }

  // Parse and execute connect_commands sequentially. Lines matching
  // `WAIT <seconds>` (case-insensitive, integer seconds, 1–600) schedule a
  // delay before the next line; everything else is sent verbatim via raw().
  // Cancels itself if the socket drops mid-sequence.
  runConnectCommands(): void {
    this.cancelPendingConnectCommands();
    const raw = this.network.connect_commands;
    if (!raw || typeof raw !== 'string') return;
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (!lines.length) return;
    let index = 0;
    const runNext = () => {
      this.connectCommandTimer = null;
      if (this.disposed || this.state !== 'connected') return;
      while (index < lines.length) {
        const line = lines[index++];
        const waitMatch = /^WAIT\s+(\d+)\s*$/i.exec(line);
        if (waitMatch) {
          const seconds = Math.max(1, Math.min(600, parseInt(waitMatch[1], 10)));
          this.connectCommandTimer = setTimeout(runNext, seconds * 1000);
          return;
        }
        try {
          this.client.raw(line);
        } catch (_) {
          /* ignore */
        }
      }
    };
    runNext();
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
        ? {
            active: a.active,
            since: a.since,
            message: a.message,
            autoSet: a.autoSet,
            backAt: a.backAt,
          }
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
          .filter((row): row is PeerPresence => {
            if (row == null) return false;
            const lower = row.nick.toLowerCase();
            // DM peers AND friends — both render presence on the client.
            return this.trackedPeers.has(lower);
          })
          .map((row) => [row.nick.toLowerCase(), row]),
      ),
    };
  }
}

const PREFIX_MODES = new Set(['q', 'a', 'o', 'h', 'v']);
function isPrefixMode(letter: string): boolean {
  return PREFIX_MODES.has(letter);
}

// Pure helper for the pre-registration nick-fallback ladder. The configured
// nick is attempt -1 (already tried by `connect()` itself); on each subsequent
// ERR_NICKNAMEINUSE we ask for index 0..N-1 here. Digits-only, no underscore
// dance — modern ircds allow long nicks so the legacy 9-char cap is moot, and
// `bob1` reads more clearly than `bob___`. Returns null once exhausted so the
// caller can give up and notify the user.
const NICK_FALLBACK_MAX = 9;
export function computeFallbackNick(
  base: string | undefined | null,
  attemptIndex: number,
): string | null {
  if (!base) return null;
  if (attemptIndex < 0 || attemptIndex >= NICK_FALLBACK_MAX) return null;
  return `${base}${attemptIndex + 1}`;
}

const TLS_CERTIFICATE_VERIFY_HINT_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const TLS_CERTIFICATE_VERIFY_HINT_PATTERNS = [
  /self-signed certificate/i,
  /certificate has expired/i,
  /certificate/i,
  /unable to verify/i,
  /hostname\/ip does not match certificate/i,
];

function isCertificateVerificationTlsError(code: string, message: string): boolean {
  if (TLS_CERTIFICATE_VERIFY_HINT_CODES.has(code)) return true;
  if (code.includes('CERT') || code.startsWith('ERR_TLS_')) return true;
  return TLS_CERTIFICATE_VERIFY_HINT_PATTERNS.some((pattern) => pattern.test(message));
}

export function formatSocketCloseErrorMessage(
  err: Record<string, unknown>,
  where: string,
  onlyTrustedCertificates: boolean,
): string {
  const code = typeof err.code === 'string' ? err.code : '';
  const message =
    typeof err.message === 'string' && err.message.length > 0 ? err.message : 'unknown error';
  if (onlyTrustedCertificates && isCertificateVerificationTlsError(code, message)) {
    return `Connection failed (${where}): The server certificate could not be verified. To connect anyway, uncheck "Only allow trusted certificates" in this network's settings and reconnect.`;
  }
  const codePrefix = code ? `${code}: ` : '';
  return `Connection failed (${where}): ${codePrefix}${message}`;
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
export function formatServerNumeric(
  msg: { command?: string; params?: string[] } | null | undefined,
): string | null {
  if (!msg) return null;
  const cmd = (msg.command || '').toUpperCase();
  const p: string[] = msg.params || [];
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
    case '004': {
      // RPL_MYINFO — [nick, server, ircd, umodes, chmodes, paramch]
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
    case '364': {
      // RPL_LINKS — [nick, server, access_via, "<hops> <server info>"] — one
      // line per server on the network, used to spot netsplits (#312). Note
      // irc-framework *claims* 364/365 (it caches them and emits a 'server
      // links' event), so they never reach the 'unknown command' catch-all that
      // surfaces other unmodelled numerics (#262). We render them here on the
      // 'raw' path instead — which fires for every line regardless of whether
      // irc-framework has a handler — so /links output isn't silently dropped.
      const parts = [p[1], p[2], p[3]].filter((s): s is string => !!s);
      return parts.length ? parts.join(' ') : null;
    }
    case '365': // RPL_ENDOFLINKS — [nick, mask, ":End of /LINKS list."]
    case '371': // RPL_INFO — [nick, ":<info text>"]
    case '374': // RPL_ENDOFINFO — [nick, ":End of /INFO list."]
    case '704': // RPL_HELPSTART — [nick, subject, ":<help text>"]
    case '705': // RPL_HELPTXT — [nick, subject, ":<help text>"]
    case '706': // RPL_ENDOFHELP — [nick, subject, ":End of /HELP."]
      // Trailing-text replies for /links (terminator), /info and /help. Like
      // LINKS (364) above, irc-framework claims all of these (it emits 'server
      // links' / 'info' / 'help' events that nothing subscribes to), so they
      // skip the 'unknown command' catch-all and have to be rendered here on
      // the 'raw' path (#312). The length guard stops a bare "<numeric> nick"
      // with no trailing param from echoing the nick back as content.
      return p.length > 1 ? p[p.length - 1] || null : null;
    case '276': // RPL_WHOISCERTFP
    case '307': // RPL_WHOISREGNICK
    case '310': // RPL_WHOISHELPOP
    case '311': // RPL_WHOISUSER
    case '312': // RPL_WHOISSERVER
    case '313': // RPL_WHOISOPERATOR
    case '317': // RPL_WHOISIDLE
    case '318': // RPL_ENDOFWHOIS
    case '319': // RPL_WHOISCHANNELS
    case '320': // RPL_WHOISSPECIAL
    case '330': // RPL_WHOISACCOUNT
    case '335': // RPL_WHOISBOT
    case '338': // RPL_WHOISACTUALLY
    case '344': // RPL_WHOISCOUNTRY
    case '378': // RPL_WHOISHOST
    case '379': // RPL_WHOISMODES
    case '569': // RPL_WHOISASN
    case '671': // RPL_WHOISSECURE
    case '314': // RPL_WHOWASUSER  — [nick, was-nick, ident, host, *, ":real name"]
    case '369': // RPL_ENDOFWHOWAS — [nick, was-nick, ":End of WHOWAS"]
    case '406': // ERR_WASNOSUCHNICK — [nick, was-nick, ":There was no such nickname"]
      // WHOIS/WHOWAS family. irc-framework consumes all of these into its
      // aggregated 'whois'/'whowas' events (the 'whois' one drives the profile
      // modal, #92) without re-emitting the wire text — so /whois and /whowas
      // showed nothing in the server buffer, and #281's first pass dumped our
      // parsed-JSON payload there instead. Render the server's own line here,
      // stripping the routing nick exactly like the catch-all does for
      // unmodelled numerics (#281). WHOWAS reuses the WHOIS server (312) and
      // account (330) numerics, so rendering both families on this one raw path
      // is what keeps /whowas from double-printing them. Server-specific whois
      // numerics irc-framework doesn't model already surface via the 'unknown
      // command' catch-all, so this list only needs the modeled ones. 301
      // RPL_AWAY is deliberately excluded — it's dual-use (a bare away reply
      // when you message an away user) and is already handled as the 'away'
      // presence event.
      return formatUnknownNumeric({ command: cmd, params: p });
    default:
      return null;
  }
}

// Friendly, user-facing messages for channel-join rejections, keyed by the raw
// IRC numeric. irc-framework models 405/471/473/474/475 as 'irc error' events
// (use joinRejectionMessageByTag for those); 476/477 it doesn't map at all and
// they arrive via the 'unknown command' event. Both paths funnel into the same
// client `join-error` toast so the failure shows up on the channel the user
// tried to join (#260).
const JOIN_REJECTION_MESSAGES: Record<string, string> = {
  '405': 'You have joined too many channels.', // ERR_TOOMANYCHANNELS
  '471': 'This channel is full.', // ERR_CHANNELISFULL (+l)
  '473': 'This channel is invite-only.', // ERR_INVITEONLYCHAN (+i)
  '474': 'You are banned from this channel.', // ERR_BANNEDFROMCHAN (+b)
  '475': 'This channel requires a key (password).', // ERR_BADCHANNELKEY (+k)
  '476': 'Bad channel mask.', // ERR_BADCHANMASK
  '477': 'This channel requires a registered nickname.', // ERR_NEEDREGGEDNICK
};

// irc-framework's 'irc error' event reports a short string tag instead of the
// numeric; map the channel-join rejection tags onto the same messages.
const JOIN_REJECTION_TAGS: Record<string, string> = {
  too_many_channels: JOIN_REJECTION_MESSAGES['405'],
  channel_is_full: JOIN_REJECTION_MESSAGES['471'],
  invite_only_channel: JOIN_REJECTION_MESSAGES['473'],
  banned_from_channel: JOIN_REJECTION_MESSAGES['474'],
  bad_channel_key: JOIN_REJECTION_MESSAGES['475'],
};

// Resolve a published event's channel target to the case we know the channel
// by. IRC channels are case-insensitive, so an event the server relays with a
// different case (DALnet's registered #Christian vs. the #christian you joined)
// must map onto the same buffer instead of forking a new one (#268). Returns
// the input unchanged for non-channel targets and channels we don't track.
export function canonicalChannelTarget(
  target: string | undefined,
  channels: Map<string, { name: string }>,
): string | undefined {
  if (typeof target !== 'string' || !target.startsWith('#')) return target;
  const known = channels.get(target.toLowerCase());
  return known ? known.name : target;
}

export function joinRejectionMessage(numeric: string): string | null {
  return JOIN_REJECTION_MESSAGES[numeric] || null;
}

export function joinRejectionMessageByTag(tag: string): string | null {
  return JOIN_REJECTION_TAGS[tag] || null;
}

// Send rejections (an outgoing PRIVMSG/NOTICE the server refused) differ from
// join rejections: the user is sitting in the buffer they sent to, having
// already seen the message optimistically echoed (ircManager.send). So we
// surface these as an inline error line in that buffer — not a "Couldn't join"
// toast and not the easy-to-miss server buffer (#283). irc-framework models
// ERR_CANNOTSENDTOCHAN (404) and ERR_CANNOTSENDTOUSER (531) as 'irc error'
// events with these tags; the value says which buffer the failure belongs in.
const SEND_REJECTION_TAGS: Record<string, 'channel' | 'nick'> = {
  cannot_send_to_channel: 'channel',
  cannot_send_to_user: 'nick',
};

export function sendRejectionTargetKind(tag: string): 'channel' | 'nick' | null {
  return SEND_REJECTION_TAGS[tag] || null;
}

// ERR_NEEDREGGEDNICK (477) is overloaded: a server sends it both to refuse a
// JOIN (the channel requires a registered nick, +R) and to refuse a PRIVMSG to
// a channel you are already in (you must identify to speak). irc-framework
// doesn't model 477 at all, so both arrive via the 'unknown command' event with
// no way to tell them apart from the numeric alone. The reliable signal is
// whether we're currently in the channel — if we are, it cannot be a join
// failure, so it's a speak rejection and belongs inline in that channel rather
// than as a misleading "Couldn't join" toast (#283).
export function isOverloadedSpeakRejection(numeric: string, joinedToChannel: boolean): boolean {
  return numeric === '477' && joinedToChannel;
}

// User-facing line for a refused outgoing message. The buffer it lands in makes
// the target obvious, so we lead with the server's own reason (which usually
// names the requirement, e.g. "you need to be identified to a registered
// account to speak") and fall back to a generic hint when the server omits one.
export function sendRejectionText(reason: string | null | undefined): string {
  const r = (reason || '').trim();
  return r
    ? `Message not delivered — ${r}`
    : 'Message not delivered — the server rejected it (you may need to register or identify your nick).';
}

// Render an unhandled server numeric into a single server-buffer line. Only
// 3-digit numerics are surfaced (the catch-all should stay quiet on stray
// command words); the first param is always the recipient nick and is dropped,
// and the remaining params — where the human-readable content lives — are
// joined. Returns null for non-numerics and empty bodies.
export function formatUnknownNumeric(
  msg: { command?: string; params?: string[] } | null | undefined,
): string | null {
  if (!msg) return null;
  const command = (msg.command || '').toString();
  if (!/^\d{3}$/.test(command)) return null;
  const params = msg.params || [];
  const body = params
    .slice(1)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .trim();
  return body || null;
}
