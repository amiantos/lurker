// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import IRC, { ircLineParser } from 'irc-framework';
import type { Client as IrcClient } from 'irc-framework';
import { insertMessage, hasMessageForTarget, hasConversationForTarget } from '../db/messages.js';
import type { Network } from '../db/networks.js';
import {
  isClosed as isBufferClosed,
  getBuffer,
  ensureExists as ensureBufferExists,
  setAutojoin as setBufferAutojoin,
  setChannelKey as setBufferChannelKey,
  deleteBuffer,
  listOpenDms,
} from '../db/buffers.js';
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
import ignoreRulesService from './ignoreRulesService.js';
import { decideStamp } from './insertDecisions.js';
import * as systemLog from './systemLog.js';
import { effectiveSetting, effectiveSettings } from './settingsService.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import { findUserById } from '../db/users.js';
import { isNodeMode } from '../utils/edition.js';
import { deriveIdent } from '../utils/ident.js';
import { registerIdent, unregisterIdent, isIdentdEnabled, isOidentdFileEnabled } from './identd.js';
import { MESSAGE_MAX_BYTES, partitionMultiline, reassembleMultiline } from './messageSplit.js';
import type { MultilineLimits } from './messageSplit.js';
import { e2eManager } from './e2e/manager.js';
import type { UserNotice } from './e2e/manager.js';
import { contextKey, isChannelContext } from './e2e/context.js';
import { CTCP_TAG, WIRE_PREFIX } from './e2e/constants.js';
import { e2eDbg } from './e2e/debug.js';
import { RateLimiter } from './e2e/rateLimiter.js';
import {
  buildCtcpReply,
  CTCP_SOURCE,
  enabledCtcpTypes,
  formatCtcpReplyLine,
  formatCtcpRequestLine,
  formatCtcpTime,
  parseCtcp,
  type CtcpReplyConfig,
} from './ctcp.js';
import fs from 'fs';
import path from 'path';
import {
  crc32Hex,
  formatBytes,
  formatDccOfferLine,
  isBlockedDccHost,
  parseCrcFromFilename,
  parseDcc,
} from './dcc.js';
import type { DccAccept, DccSend } from './dcc.js';
import { dccAllowPrivateHosts, dccEnabledForUser, dccMaxFileBytes } from './dccConfig.js';
import { hasFreeSpaceFor, resolveDccDestination } from './dccPaths.js';
import { DccReceiver } from './dccReceiver.js';
import {
  type DccTransferRow,
  DCC_ACTIVE_STATES,
  findArmedRequest,
  findResumableTransfer,
  getDccTransfer,
  insertDccTransfer,
  markDccCompleted,
  markDccFailed,
  markDccReceiving,
  updateDccReceivedBytes,
  updateDccTransferState,
} from '../db/dccTransfers.js';
import { getChannelConfig as getE2eChannelConfig } from '../db/e2e.js';
import type { ChannelMode } from '../db/e2e.js';
import { randomBytes } from 'node:crypto';

// Optional source address for outbound IRC connections (LURKER_OUTGOING_ADDR),
// passed to irc-framework as `outgoing_addr` → the socket's localAddress. Lets a
// multi-homed host choose which local IP (and therefore which identd) a
// connection originates from. Unset = kernel default source. Mirrors the
// identdBindHost() helper in identd.ts.
export function outgoingAddr(): string | undefined {
  const addr = (process.env.LURKER_OUTGOING_ADDR || '').trim();
  return addr || undefined;
}

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
  // RPE2E status lines are transient echoes (like /help output), surfaced via
  // publishEphemeral — never write them to history (#382).
  'e2e',
  // CTCP request/reply notices are transient status, surfaced via
  // publishEphemeral — never persisted (#263).
  'ctcp',
  // Incremental nicklist patch (host/account). Like 'names' it describes
  // current membership state, not history — a replayed one would be wrong.
  'member-update',
]);

// Diagnostic: a single synchronous IRC-event handler (NAMES/WHO member-list
// rebuild + serialize + fan-out) slower than this is logged. On a reconnect the
// server replays NAMES/WHO for every auto-rejoined channel; on big channels each
// is O(members), and the burst is what shows up as an [event-loop] stall with no
// [wsHub] snapshot line. Console-only. Env-tunable / 0 disables.
const IRC_HANDLER_WARN_MS = (() => {
  const raw = Number(process.env.LURKER_IRC_HANDLER_WARN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 50;
})();

// Forget an outbound CTCP request we never got a reply to after a minute, so the
// routing map can't grow unbounded.
const CTCP_OUTSTANDING_TTL_MS = 60_000;
// Cap distinct outstanding (nick,type) keys; evict the oldest when exceeded.
const CTCP_OUTSTANDING_MAX_KEYS = 200;

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
  // Services account, from extended-join / account-notify. Three states:
  // a string = logged in as that account; null = server told us they're logged
  // out (the `*` sentinel); undefined = we never learned (no cap, or they were
  // already here when we joined — NAMES carries no account). Unknown and
  // logged-out both render as nothing today, but keeping them distinct is what
  // lets a future WHOX backfill (#508 follow-up) write a correct merge rule
  // instead of clobbering fresher data — see irssi's nickrec->account guard.
  account?: string | null;
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
  // Server-buffer notability (#470). Pass false on Lurker's own status notices
  // so they render but don't mark the server buffer unread; omitted = notable.
  notable?: boolean;
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
  // Hide-level ignore verdict, stamped at persist time. Callers that surface a
  // secondary copy of the event (e.g. the closed-buffer NOTICE mirror) read this
  // so they don't leak an ignored sender's text past the ignore filter (#439).
  fromIgnored?: boolean;
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function isDmTargetName(target: string | undefined | null): boolean {
  if (!target) return false;
  return !target.startsWith('#') && !target.startsWith(':server:');
}

function extractExtras(event: IrcEvent): Record<string, unknown> | null {
  let extras: Record<string, unknown> | null = null;
  switch (event.type) {
    case 'kick':
      extras = { kicked: event.kicked };
      break;
    case 'invite':
      // The invited nick — `nick` (the standard actor column) holds the
      // inviter. Persisted so the "X invited Y" channel line round-trips (#261).
      extras = { invited: event.invited };
      break;
    case 'nick':
      extras = { newNick: event.newNick };
      break;
    case 'mode':
      extras = { modes: event.modes };
      break;
    case 'chghost':
      // Without this the new mask survives the live fan-out but vanishes from
      // backlog, so the line reads "X changed host to @" after a reload.
      extras = { newIdent: event.newIdent, newHost: event.newHost };
      break;
    case 'join':
      // extended-join account, so the join line still shows it after a reload
      // (#508). Absent on networks without the cap and for logged-out users.
      if (event.account) extras = { account: event.account };
      break;
  }
  // RPE2E: persist the lock flag for message/action/notice so the indicator
  // survives a reload and reaches late-attaching clients (round-trips through the
  // `extra` JSON column → rowToEvent's Object.assign).
  if (event.e2e) extras = { ...extras, e2e: true };
  return extras;
}

// The peer's server-stamped `ident@host` — the stable identity RPE2E keys
// sessions/peers by (never the nick, which a peer can change at will). Returns
// null when the event lacks an ident/host (server messages), in which case the
// peer can't be matched to a keyring session.
function buildE2eHandle(event: Record<string, unknown>): string | null {
  const ident = ((event.ident as string) || '').trim();
  const host = ((event.hostname as string) || '').trim();
  if (!ident || !host) return null;
  return `${ident}@${host}`;
}

// Map a `/e2e on` mode token to a keyring ChannelMode. `auto` auto-accepts
// inbound handshakes; `quiet` ignores unsolicited ones; the safe default is
// `normal` (prompt the user to /e2e accept). Unknown tokens fall back to normal.
function parseE2eMode(token: string | undefined): ChannelMode {
  switch ((token || '').toLowerCase()) {
    case 'auto':
    case 'auto-accept':
      return 'auto-accept';
    case 'quiet':
      return 'quiet';
    default:
      return 'normal';
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
    account: m.account,
  };
}

// Normalize a services account off the wire into ChannelMember.account's
// tristate. There are TWO logged-out sentinels: `*` on JOIN/ACCOUNT, and `0` on
// a WHOX 354 reply — normalize both here, at the parse boundary, so exactly one
// representation reaches the member map. irc-framework hands us `false` for `*`
// on the events it parses, and omits the key entirely when the cap is off.
function normalizeAccount(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined; // cap not enabled — we know nothing
  if (raw === false || raw === null) return null; // framework's `*` sentinel
  const s = String(raw).trim();
  if (!s || s === '*' || s === '0') return null;
  return s;
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
  // Join keys awaiting their echo, keyed by lowercased channel. Nothing is
  // persisted on a join REQUEST (the buffers row is echo-written), so the key
  // rides here until the join lands; a forward (470) discards it. Lost on a
  // process restart mid-join — the user just re-/joins with the key.
  private pendingJoinKeys = new Map<string, string>();
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
  // Last time we surfaced an undecryptable-E2E hint per (channel,peer,kind), to
  // collapse a multi-chunk message's per-chunk hints into one (#382). epoch ms.
  private readonly e2eHintAt = new Map<string, number>();
  // Active DCC downloads (#270), keyed by dcc_transfers.id, so their sockets
  // aren't GC'd mid-transfer and can be cancelled on dispose.
  private readonly dccReceivers = new Map<number, DccReceiver>();
  // Resumes awaiting the sender's DCC ACCEPT, keyed by nick|filename. Each holds
  // a timeout so a bot that never accepts fails the transfer cleanly.
  private readonly dccPendingResume = new Map<
    string,
    {
      transferId: number;
      nick: string;
      offer: DccSend;
      destPath: string;
      startOffset: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
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
  // Our live nick on this network, tracked independently of irc-framework's
  // c.user.nick. The framework updates c.user.nick from its OWN 'registered'
  // listener, which runs AFTER the 'all' proxy that drives our handler — so
  // during the 'connected' dispatch (and the snapshot it triggers) c.user.nick
  // is still the stale configured primary. We set this from the reliable
  // RPL_WELCOME nick / NICK-event new nick so snapshot() can't ship a stale
  // nick that clobbers the input bar after a taken-nick fallback (#362).
  currentNick: string;
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
  // Channels we auto-issued a WHO for on join (lowercase). The auto-WHO learns
  // away/ident state and would flood the server buffer if echoed per-member, so
  // the 'wholist' handler consumes these silently. Any wholist NOT in this set
  // is a user-typed /who and gets rendered to the server buffer (#342).
  autoWhoTargets: Set<string>;
  // In-flight inbound `draft/multiline` batches, keyed by batch reference. Each
  // entry holds the first fragment's event envelope plus the text accumulated
  // so far; flushed as one reassembled message on 'batch end draft/multiline'
  // and cleared on socket close so a never-closed batch can't leak. (#381)
  multilineBatches: Map<string, { event: Record<string, unknown>; text: string }>;
  // Per-peer rate limiter for inbound CTCP (requests AND replies). Being
  // per-peer, one flooding peer can't make the cell spew NOTICEs, spam the
  // buffer, OR suppress CTCP from everyone else — it only exhausts its own
  // bucket. Reuses the same limiter the E2E handshake path uses for the
  // identical inbound-flood threat.
  ctcpLimiter: RateLimiter;
  // Outstanding outbound CTCP requests we sent, so a reply routes back to the
  // buffer the /ctcp was issued from. Key = `${nick-lc} ${TYPE}` → a FIFO queue
  // of issuing buffers, so two concurrent same-type queries to one nick route
  // their replies back in order. Bounded + TTL-pruned on access.
  ctcpOutstanding: Map<string, Array<{ issuingTarget: string; sentAt: number }>>;
  // The raw 001–005 registration burst as the server sent it, captured by the
  // 'raw' handler (reset on each 001). The bouncer replays these verbatim
  // (nick-rewritten) to IRC clients that attach mid-session, so they see the
  // network's real ISUPPORT tokens instead of a synthesized approximation.
  registrationLines: string[];

  constructor({ network, onEvent }: { network: Network; onEvent: (event: EnrichedEvent) => void }) {
    this.network = network;
    this.onEvent = onEvent;
    // ALL CTCP handling lives in our 'ctcp request' handler (VERSION/PING/TIME/
    // SOURCE/CLIENTINFO, rate-limited + surfaced), so irc-framework's built-in
    // VERSION auto-reply is disabled with `version: false`. That MUST go in the
    // connect() dict, NOT here: connect() overwrites client.options with its dict
    // (client.js:202), so a constructor `version` doesn't survive — exactly the
    // pitfall the enable_chghost note on the connect() call documents. Mirrors
    // The Lounge, which uses the same library the same way. See services/ctcp.ts.
    this.client = new IRC.Client();
    this.client.requestCap('message-tags');
    // extended-monitor (IRCv3): asks the server to relay away-notify (and the
    // other notify caps irc-framework already negotiates) for nicks on our
    // MONITOR list even when we share no channel with them. That gives our DM
    // peers and friends away/back tracking, not just online/offline — the
    // 'away'/'back' handlers below already feed markPeerEvent regardless of how
    // the AWAY arrived. requestCap is a no-op on networks that don't advertise
    // the cap — irc-framework only emits a CAP REQ for caps the server lists in
    // CAP LS. (#310)
    this.client.requestCap('extended-monitor');
    // batch + draft/multiline (IRCv3): lets a multi-line compose travel as one
    // logical message instead of N fragmented PRIVMSGs, and lets us reassemble
    // the same from peers (e.g. Ergo). requestCap is a no-op where the server
    // doesn't advertise them; draft/multiline also rides message-tags (above)
    // and batch, so all three are requested. (#381)
    this.client.requestCap('batch');
    this.client.requestCap('draft/multiline');
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
    // Seed with the configured nick; the registration/NICK handlers replace it
    // with the live value once the server confirms one.
    this.currentNick = network.nick;
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
    this.autoWhoTargets = new Set();
    this.multilineBatches = new Map();
    this.ctcpLimiter = new RateLimiter();
    this.ctcpOutstanding = new Map();
    this.registrationLines = [];
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

  // Patch one member's attributes on the client's nicklist. The pre-existing
  // way to push a member change was to republish the whole `names` array (see
  // the WHO ident/host backfill), which is O(members) for a one-nick edit —
  // fine once per join, wasteful for a chghost storm after a netsplit, and no
  // use at all for the silent account-notify path.
  private publishMemberUpdate(target: string, member: ChannelMember): void {
    this.publish({ type: 'member-update', target, member: memberSnapshot(member) });
  }

  // Returns the enriched, persisted event so callers can read server-stamped
  // fields (e.g. the `fromIgnored` verdict the closed-buffer NOTICE mirror needs).
  // Typed `| void` rather than `| undefined` so the many `() => void` test spies
  // that stand in for publish stay assignable.
  publish(event: IrcEvent): EnrichedEvent | void {
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
      // Decide both per-message stamps before persisting, off cached compiled
      // rule sets (no per-message DB scan): the highlight match (matched_rule_id)
      // and the ignore verdict. A NOHIGHLIGHT ignore nulls the highlight while
      // leaving the message visible; a hide-level ignore sets from_ignored so
      // unread/highlight/search counts skip it. decideStamp gates on self/nick
      // and runs the level test first, so high-churn JOIN/PART/QUIT with no
      // matching-level rule stay cheap. See insertDecisions.ts.
      let matchedRuleId: number | null = null;
      let fromIgnored = false;
      try {
        const decided = decideStamp(
          {
            type: event.type,
            nick: event.nick as string | null | undefined,
            userhost: event.userhost as string | null | undefined,
            target: event.target as string,
            text: event.text as string | null | undefined,
            self: event.self as boolean | undefined,
          },
          highlightRulesService.getCompiled(this.network.user_id, this.network.id),
          ignoreRulesService.getCompiled(this.network.user_id, this.network.id),
          isDmTargetName(event.target as string),
        );
        matchedRuleId = decided.matchedRuleId;
        fromIgnored = decided.fromIgnored;
      } catch (e) {
        console.warn('[ignore/highlight] match-on-insert failed:', (e as Error)?.message || e);
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
        mirrored: event.mirrored as boolean | undefined,
        notable: event.notable as boolean | undefined,
      });
      enriched.id = id;
      enriched.alt = alt;
      enriched.matched = matchedRuleId != null;
      enriched.matchedRuleId = matchedRuleId;
      enriched.fromIgnored = fromIgnored;
    }

    this.onEvent(enriched);
    return enriched;
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
    const changed = this.state !== state;
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
    // Only log on a real transition. A disconnect fires both 'socket close' and
    // 'close', each calling setState('disconnected'); without this guard the
    // system buffer gets two "Disconnected" lines per network (#355). The state
    // publish stays unconditional — re-asserting the same dot is harmless and
    // keeps a late-attaching client in sync.
    if (changed) this.logState(state, extra);
  }

  logScope(): string {
    return `net:${this.network.name}`;
  }

  // System-buffer log line tied to this network. The human-readable scope keeps
  // the network's *current* name for the raw log, but `fields.networkId` carries
  // the stable id so the client can resolve the live name at render time — the
  // scope string is frozen at write time and goes stale after a rename (#355).
  logNet(text: string, level?: string): void {
    systemLog.log({
      userId: this.network.user_id,
      scope: this.logScope(),
      fields: { networkId: this.network.id },
      level,
      text,
    });
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
    this.logNet(text, state === 'disconnected' ? 'warn' : 'info');
  }

  bind(): void {
    const c = this.client;

    // The server buffer is the authentic log of everything the server sends:
    // we default to surfacing every numeric here (welcome banner, lusers, SASL
    // confirmation, /who, /whois, /oper, /time, …) and only suppress a small
    // denylist (see isServerBufferDeniedNumeric). This is the single place that
    // sees every numeric — the 'raw' event fires for each wire line regardless
    // of whether irc-framework modeled it, so nothing vanishes the way it did
    // under the old curated allowlist (#342). Pretty surfaces (nicklist, topic
    // bar, whois modal) are rendered additively by their structured handlers;
    // they never replace the raw line here.
    c.on('raw', (event: { from_server: boolean; line: string }) => {
      if (!event?.from_server || typeof event.line !== 'string') return;
      let msg;
      try {
        msg = ircLineParser(event.line);
      } catch (_) {
        return;
      }
      const rawCommand = (msg?.command || '').toString();
      // Capture the registration burst for bouncer attach-time replay. 001
      // starts a fresh burst (each (re)registration replaces the last), and
      // the follow-on 002–005 lines are only appended once a burst has begun
      // so a stray mid-session numeric can't graft onto a stale burst. The
      // raw line keeps its trailing CR; strip it so replay consumers get a
      // clean single-line payload.
      const burstLine = event.line.replace(/[\r\n]+$/, '');
      if (rawCommand === '001') this.registrationLines = [burstLine];
      else if (
        this.registrationLines.length > 0 &&
        (rawCommand === '002' ||
          rawCommand === '003' ||
          rawCommand === '004' ||
          rawCommand === '005')
      ) {
        this.registrationLines.push(burstLine);
      }
      if (isServerBufferDeniedNumeric(rawCommand)) return;
      // formatUnknownNumeric only renders 3-digit numerics (it strips the
      // leading recipient-nick param), so PRIVMSG/JOIN/NOTICE/etc. naturally
      // fall through and never pollute the server buffer.
      const text = formatUnknownNumeric(msg);
      if (!text) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    // Special-case routing for two overloaded rejection numerics. The generic
    // display of unmodeled numerics now happens on the 'raw' handler above
    // (#342) — this handler only intercepts cases that belong on a channel/DM
    // surface instead of (or in addition to) the server buffer.
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
      // so this is toast-only — the raw line is still logged to the server buffer
      // by the 'raw' handler, which is the additive authentic record.
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
      // Record the live nick BEFORE setState below — that publish triggers a
      // synchronous snapshot (wsHub re-snapshots on 'connected'), and snapshot()
      // must report the registered nick, not the stale c.user.nick (#362).
      this.currentNick = registeredNick;
      const fallbackUsed = this.nickAttempt > 0 && registeredNick !== this.network.nick;
      this.startLagPinger();
      // Hydrate the DM-peer tracking set from open DM buffer rows. Closed DMs
      // explicitly opted out, so we don't track them until the user reopens.
      // Filtering here (not later) means we never write peer_presence_state
      // rows for closed buffers in the first place.
      this.trackedPeers.clear();
      try {
        for (const buf of listOpenDms(this.network.id)) {
          // A notice-only buffer (NickServ/ChanServ, #439) is not a real DM —
          // don't seed it into MONITOR or it consumes presence slots and shows a
          // bogus presence dot for a service. Track only actual conversations.
          if (!hasConversationForTarget(this.network.id, buf.target)) continue;
          this.addPeerReason(buf.target.toLowerCase(), 'dm', null);
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
          notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
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
      this.autoWhoTargets.clear();
      this.multilineBatches.clear();
      // CTCP routing/limit state is per-socket: a stale outstanding entry would
      // mis-route a same-type reply on the new socket, and a drained limiter
      // would drop the new socket's first probes. Reset both (#263).
      this.ctcpOutstanding.clear();
      this.ctcpLimiter = new RateLimiter();
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
      // Safety-net presence sweep. The primary one runs in 'socket close',
      // which fires on every disconnect (including auto-reconnect blips), so it
      // has almost always swept already by the time this terminal 'close'
      // fires. This covers any clean-close path that somehow skipped it;
      // markAllPeersOffline is idempotent and disposed-guarded, so the double
      // call is a no-op.
      this.markAllPeersOffline();
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
          notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
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
      this.logNet(`MONITOR (IRCv3 presence) supported, watch limit ${limit}`);
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
          this.logNet(
            `Seeding MONITOR with ${seedCount} nick${seedCount === 1 ? '' : 's'} (DM peers + friends)`,
          );
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
        this.logNet(`Presence: ${nicks.join(', ')} online`);
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
        this.logNet(`Presence: ${nicks.join(', ')} offline`);
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
      // Our socket to this network just dropped — from our vantage point every
      // peer we track here is now unreachable, so mark them all offline. This is
      // the fix for the "stuck online" gap on networks without MONITOR: if a
      // peer quit while we were disconnected we never saw their QUIT, but our own
      // disconnect is a discontinuity we DO observe, so we stop asserting a stale
      // 'online'. 'socket close' (not 'close') is the hook: irc-framework
      // auto-reconnects a blip internally and emits only 'socket close' +
      // 'reconnecting' — it reserves 'close' for a terminal give-up/dispose
      // (connection.js:111 always fires 'socket close'; :141 fires 'close' only
      // when it won't retry), so sweeping in 'close' alone would miss the common
      // reconnect. On reconnect the peers we can still observe are re-lit
      // (MONITOR re-seed + WHO-on-join); the rest stay honestly offline. No
      // came-online suppression — a reconnect re-firing "came online" for peers
      // still around is the honest signal, and toasts are already rate-limited.
      this.markAllPeersOffline();
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
        this.logNet(text, 'error');
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
        notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
        text,
      });
    });
    c.on('connecting', () => this.setState('connecting'));

    // Diagnostic: irc-framework fires 'ping timeout' when it hasn't seen data
    // from the server for `ping_timeout` seconds (120s default) — then it QUITs
    // and auto-reconnects with NO socket error, so the disconnect otherwise
    // surfaces as a bare "Disconnected" with no cause. A ping timeout on a
    // healthy network usually means WE stopped reading the socket, i.e. the
    // event loop was starved by synchronous work (see eventLoopMonitor); when
    // every network times out together on a client connect, that's the tell.
    // Surface it so the cause isn't invisible. Deliberately does NOT publish() a
    // notice (which inserts a message row + fanOuts to every socket): a
    // loop-stall trips this on EVERY live network at once, so a publish per
    // network would be a synchronous DB-write + fan-out burst on the recovery
    // ticks — exactly the write amplification we're trying to avoid on the stall
    // path. logNet is a single lightweight systemLog line (visible in the app's
    // system buffer), and console.warn lands in `docker logs` next to the
    // [event-loop] stall line for correlation.
    c.on('ping timeout', () => {
      const text = `Ping timeout — no data from ${this.network.host} for the timeout window; reconnecting. If every network did this at once, the server event loop stalled (check logs for [event-loop]).`;
      this.logNet(text, 'warn');
      console.warn(`[irc] ping timeout on network ${this.network.id} (${this.network.host})`);
    });

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
        // Register whenever EITHER ident mode is active: the in-process identd
        // answers :113 from this map, and the oidentd shared-daemon mode renders
        // the same map to a config file. Skip only when neither is on.
        if (!isIdentdEnabled() && !isOidentdFileEnabled()) return;
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
    // cap (see the client constructor).
    //
    // Requesting that cap makes the server STOP sending the fake QUIT/rejoin
    // pair it uses to describe a host change to clients that lack it. So until
    // #591 this handler's self-only guard meant third-party host changes
    // rendered as literally nothing — strictly less than a client with no
    // IRCv3 support at all. CHGHOST arrives once, globally; every reference
    // client (weechat irc-protocol.c, irssi massjoin.c, halloy, thelounge)
    // fans it out to each channel the user shares with you, updates the
    // nicklist host there, and renders ONE native line. No client synthesizes
    // the fake QUIT/rejoin — that's a server/bouncer compat shim (znc does it
    // only when relaying to a downstream that didn't negotiate the cap).
    c.on('user updated', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      if (!event.new_hostname && !event.new_ident) return; // SETNAME — not ours
      const eventNick = event.nick as string;
      const lower = eventNick.toLowerCase();
      const isSelf = !!c.user.nick && c.user.nick.toLowerCase() === lower;
      // CHGHOST only carries the half that changed on some ircds; fall back to
      // the previous value so the mask we store and show is always complete.
      const newIdent = (event.new_ident as string) || (event.ident as string) || '';
      const newHost = (event.new_hostname as string) || (event.hostname as string) || '';
      const mask = newIdent ? `${newIdent}@${newHost}` : newHost;
      if (!mask) return;

      if (isSelf) {
        // Keep the long-standing server-buffer line for your own host change —
        // it's the SASL-cloak confirmation, and it belongs where you'll see it
        // even when you share no channels yet.
        this.publish({
          type: 'motd',
          target: this.serverTarget(),
          text: `Your hostmask: ${mask}`,
        });
      }

      const oldUserhost = buildUserhost(event);
      for (const ch of this.channels.values()) {
        const member = ch.members.get(lower);
        if (!member) continue;
        // Update the stored mask, not just the rendered line. thelounge is the
        // cautionary case here: it prints the line but has no host field on its
        // user model, so its nicklist stays stale — the exact complaint in #591.
        member.user = newIdent || member.user;
        member.host = newHost || member.host;
        this.publish({
          type: 'chghost',
          target: ch.name,
          nick: eventNick,
          userhost: oldUserhost,
          newIdent,
          newHost,
        });
        this.publishMemberUpdate(ch.name, member);
      }
    });

    // account-notify. Deliberately silent: no channel line, nicklist/hover
    // only. On Libera (and most Atheme networks) identifying to services fires
    // ACCOUNT and CHGHOST back to back, so rendering both would mean two lines
    // per identify in every shared channel. chghost earns its line because it
    // regressed against the no-cap baseline (#591); this never showed anything.
    // halloy and gamja both treat ACCOUNT as a pure state update too.
    c.on('account', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      const eventNick = event.nick as string;
      const lower = eventNick.toLowerCase();
      const account = normalizeAccount(event.account);
      for (const ch of this.channels.values()) {
        const member = ch.members.get(lower);
        if (!member) continue;
        member.account = account;
        this.publishMemberUpdate(ch.name, member);
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
      // A `draft/multiline` batch is one logical message fragmented across N
      // PRIVMSGs (#381). Buffer the fragments and flush a single reassembled
      // message on 'batch end draft/multiline' instead of rendering N lines.
      if (batchType === 'draft/multiline') {
        this.accumulateMultiline(event);
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
        // A NOTICE addressed to us persists to the sender's buffer (its natural
        // home), like a PRIVMSG — so the buffer surfaces on first notice and the
        // history lives in the right place. Open/closed is a client display
        // concern: the wsHub fan-out drops live delivery to a buffer the user has
        // closed (closed stays closed — a notice never reopens it, see
        // DM_ELIGIBLE_TYPES), and the closed-buffer mirror below persists a
        // durable copy in the server buffer so the notice isn't lost.
        //   - EXCEPTION 1: a channel-context hint (the IRCv3 +draft/channel-context
        //     tag, or a leading "[#chan]" body prefix) for a channel we're in
        //     routes the notice to that channel.
        //   - EXCEPTION 2: a notice NOT addressed to our nick (e.g. to an `&`/`!`/`+`
        //     local channel, which Lurker routes as a non-channel, or a STATUSMSG
        //     target) has no DM home — surface it in the server buffer rather than
        //     fabricating a bogus DM with the sender.
        const ctx = resolveChannelContext(
          event.tags as Record<string, string> | undefined,
          eventMessage,
          this.channels,
        );
        if (ctx) {
          target = ctx;
        } else if (
          eventTarget &&
          this.currentNick &&
          eventTarget.toLowerCase() === this.currentNick.toLowerCase()
        ) {
          // Fold to the existing buffer row's casing so a reply sourced as
          // "ChanServ" doesn't fork history from a "chanserv" buffer the user
          // started (#289).
          target =
            getBuffer(this.network.user_id, this.network.id, eventNick as string)?.target ??
            (eventNick as string);
        } else {
          target = `:server:${this.network.id}`;
        }
      } else target = eventNick as string;

      const type =
        eventType === 'action' ? 'action' : eventType === 'notice' ? 'notice' : 'message';
      const nick = eventNick || eventHostname || 'server';

      // RPE2E: a `+RPE2E01` chunk on an encryption channel is decrypted to its
      // plaintext (rendered with the flag) before persistence. A
      // missing-key/rejected/replay outcome means we can't read it — never
      // persist the raw ciphertext as a message; surface a transient hint
      // instead, then fall through to presence tracking only.
      let bodyText = eventMessage;
      let e2eFlag = false;
      // Only attempt decryption on a `+RPE2E01` line for a channel we've actually
      // enabled E2E on. Without the `isChannelEnabled` gate, ANY peer (or griefer)
      // sending `+RPE2E01 …` on any channel would make us drop the message and
      // render a "could not decrypt" hint — and legit cleartext that happens to
      // start with the magic prefix would be lost (#1). Off-channel + non-enabled
      // lines fall through and publish as ordinary cleartext.
      if (
        typeof eventMessage === 'string' &&
        eventMessage.startsWith(WIRE_PREFIX) &&
        isChannelContext(eventTarget ?? '') &&
        e2eManager.isChannelEnabled(
          this.network.user_id,
          this.network.id,
          contextKey(eventTarget as string, ''),
        )
      ) {
        const handle = buildE2eHandle(event);
        const outcome = handle
          ? e2eManager.decryptIncoming(
              this.network.user_id,
              this.network.id,
              handle,
              contextKey(eventTarget as string, handle),
              eventMessage,
            )
          : ({ kind: 'missing-key' } as const);
        e2eDbg(
          () => `inbound +RPE2E01 on ${eventTarget} from ${eventNick} (${handle}): ${outcome.kind}`,
        );
        if (outcome.kind === 'plaintext') {
          bodyText = outcome.text;
          e2eFlag = true;
        } else {
          // A peer is talking to us encrypted on a channel we've enabled but have
          // no session for yet — auto-initiate the handshake (rate-limited),
          // matching repartee, so an encrypted channel "just works" once both
          // sides turn it on, with no manual /e2e handshake. The KEYREQ goes back
          // to the sender's nick as a CTCP NOTICE.
          let handshaking = false;
          if (outcome.kind === 'missing-key' && handle && eventNick) {
            const body = e2eManager.autoHandshakeBody(
              this.network.user_id,
              this.network.id,
              contextKey(eventTarget as string, handle),
              handle,
            );
            if (body) {
              this.sendHandshakeReply(eventNick, body);
              handshaking = true;
            }
          }
          this.surfaceE2eDecryptIssue(eventTarget as string, eventNick, outcome.kind, handshaking);
          if (eventNick) this.markPeerEvent(eventNick, 'online');
          return;
        }
      }

      const published = this.publish({
        type,
        target,
        nick,
        text: bodyText,
        kind: eventType,
        self: false,
        userhost: buildUserhost(event),
        ...(e2eFlag ? { e2e: true } : {}),
      }) as EnrichedEvent | undefined;
      // If a notice's home buffer is one the user has closed, the wsHub fan-out
      // drops its live delivery — so without this the notice would be invisible
      // until the buffer is reopened. Persist a SECOND copy in the server buffer
      // (a durable mirror, not a transient emit) so it's visible there for every
      // client, including one that was offline when it arrived — an ephemeral copy
      // would never reach a reconnecting or mobile client. The real copy still
      // lives in the closed home buffer for when it's reopened; `:server:` targets
      // bypass the closed-buffer fan-out guard and are excluded from search, so the
      // duplicate doesn't double up search results. Skip ignored senders
      // (`fromIgnored`): the home copy is ignore-flagged and client-filtered, so
      // mirroring the raw text would bypass the ignore list (a harassment vector).
      if (
        isNotice &&
        !isServer &&
        target !== this.serverTarget() &&
        !published?.fromIgnored &&
        isBufferClosed(this.network.user_id, this.network.id, target)
      ) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick,
          text: bodyText,
          kind: eventType,
          self: false,
          mirrored: true,
        });
      }
      // An incoming PRIVMSG (not NOTICE) is the moment this nick becomes a
      // tracked DM peer — add them via trackDmPeer so MONITOR + fires too.
      // A NOTICE now opens a buffer under the sender's nick too, but we
      // deliberately don't start presence-tracking for notice senders: they're
      // overwhelmingly services/bots (NickServ, ChanServ, oper notices) that
      // shouldn't consume MONITOR slots or show a presence dot. Channel chatter
      // still flips presence only for peers we already track.
      if (eventNick && !isServer && !targetIsChannel && !isNotice) {
        this.trackDmPeer(eventNick);
      }
      if (eventNick) this.markPeerEvent(eventNick, 'online');
    });

    c.on('batch end draft/multiline', (info: Record<string, unknown>) => {
      // irc-framework buffers a batch's PRIVMSGs and replays them (each firing
      // the 'message' handler above with event.batch set) before emitting this
      // close event — so accumulateMultiline already holds every fragment. (#381)
      const id = info?.id as string | undefined;
      if (id) this.flushMultiline(id);
    });

    // RPE2E handshake transport (#382). irc-framework routes a NOTICE whose body
    // is CTCP-framed (`\x01…\x01`) to 'ctcp response' with the inner body in
    // `.message` (framing stripped) and the first word in `.type`. We claim only
    // RPEE2E and hand the body to the manager, which returns the bodies to NOTICE
    // straight back to the sender's nick (re-framed) plus an optional user notice.
    c.on('ctcp response', (event: Record<string, unknown>) => {
      e2eDbg(
        () =>
          `ctcp-response from ${event.nick}!${event.ident}@${event.hostname} type=${event.type} body=${String(event.message).slice(0, 140)}`,
      );
      // Response `event.type` is raw-case (the library uppercases request types
      // but not response types), so compare case-insensitively — otherwise a
      // lowercase `rpee2e` NOTICE would slip past and surface as a bogus CTCP
      // reply line instead of routing to the E2E path.
      if (String(event.type).toUpperCase() !== CTCP_TAG) {
        // A standard CTCP reply (VERSION/PING/TIME/…) — someone answered a query
        // we sent. Surface it; RPE2E claims only the RPEE2E tag.
        this.handleInboundCtcpReply(event);
        return;
      }
      const senderNick = (event.nick as string) || null;
      const senderHandle = buildE2eHandle(event);
      const body = event.message as string | undefined;
      // A stable ident@host is the keyring identity, and we reply to the nick;
      // without either we can't complete a handshake, so drop quietly.
      if (!senderHandle || !senderNick || typeof body !== 'string') {
        e2eDbg(() => `  dropped pre-dispatch: handle=${senderHandle} nick=${senderNick}`);
        return;
      }
      const outcome = e2eManager.handleHandshakeBody(
        this.network.user_id,
        this.network.id,
        senderHandle,
        senderNick,
        body,
      );
      e2eDbg(() =>
        outcome
          ? `  outcome: replies=${outcome.replies.length} notice=${outcome.notice?.text ?? '-'} channel=${outcome.channel ?? '-'}`
          : `  outcome: null (parseHandshake returned not-RPEE2E)`,
      );
      if (!outcome) return; // not an RPEE2E message after all
      for (const reply of outcome.replies) this.sendHandshakeReply(senderNick, reply);
      if (outcome.notice) this.surfaceE2eNotice(outcome.notice, outcome.channel);
    });

    // Inbound CTCP request (a peer probed us over PRIVMSG, e.g. VERSION/PING).
    // ACTION never reaches here — irc-framework emits it as an 'action' message.
    c.on('ctcp request', (event: Record<string, unknown>) => {
      if (event.type === CTCP_TAG) {
        // RPE2E rides NOTICE; an RPEE2E PRIVMSG is a misconfigured peer, not a
        // real CTCP query. Log it for interop debugging and don't auto-answer.
        e2eDbg(
          () =>
            `ctcp-REQUEST (PRIVMSG, not NOTICE!) from ${event.nick}!${event.ident}@${event.hostname} body=${String(event.message).slice(0, 140)}`,
        );
        return;
      }
      this.handleInboundCtcpRequest(event);
    });

    c.on('join', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventNick = event.nick as string;
      const ch = this.upsertChannel(eventChannel);
      // extended-join: irc-framework parses the account param when the cap is
      // enabled, and omits the key when it isn't (#508).
      const joinAccount = normalizeAccount(event.account);
      ch.members.set(eventNick.toLowerCase(), {
        nick: eventNick,
        modes: [],
        away: false,
        user: (event.ident as string) || null,
        host: (event.hostname as string) || null,
        account: joinAccount,
      });
      this.publish({
        type: 'join',
        target: eventChannel,
        nick: eventNick,
        userhost: buildUserhost(event),
        // Only when we actually know an account — a logged-out `null` renders
        // as nothing anyway, and omitting it keeps the persisted `extra` JSON
        // off every join row on networks without the cap.
        ...(joinAccount ? { account: joinAccount } : {}),
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
        // The ECHO is the only signal the join actually landed on the channel
        // we asked for, so this is where the buffers row is written: creation,
        // autojoin, and the key stashed at request time. A forwarded (470) or
        // refused join therefore leaves no row and no rejoin entry behind.
        // The open/closed flip is deliberately NOT done here — wsHub's live
        // filter owns it (reopensClosedBuffer) and fans out buffer-reopened;
        // flipping state first would hide the reopen from it.
        const stashedKey = this.takeStashedJoinKey(eventChannel);
        try {
          const { record } = ensureBufferExists(
            this.network.user_id,
            this.network.id,
            eventChannel,
            { kind: 'channel' },
          );
          // Skip the no-op UPDATE on the steady-state reconnect burst, where
          // every rejoined channel already carries autojoin=1.
          if (!record.autojoin) {
            setBufferAutojoin(this.network.user_id, this.network.id, eventChannel, true);
          }
          if (stashedKey !== undefined) {
            setBufferChannelKey(this.network.user_id, this.network.id, eventChannel, stashedKey);
          }
        } catch (_) {
          /* ignore */
        }
        this.publish({ type: 'channel-joined', target: eventChannel });
        // Re-joining is a clean "try again" gesture: drop any stale
        // can't-speak-here mark so typing notifications resume. If we still
        // can't speak, the next attempt re-learns it from the bounce (#283).
        this.unsendableTargets.delete(eventChannel.toLowerCase());
        // No system-buffer "Joined #x" line — the channel buffer already shows
        // the join event, so logging it here too is just noise (#355).
        // Most servers volunteer 324 on join, but a few don't. Request it so
        // the channel's mode flags reach the status bar consistently.
        try {
          c.raw('MODE', eventChannel);
        } catch (_) {
          /* ignore */
        }
      }
    });

    // ERR_LINKCHANNEL (470): the server forwarded our JOIN somewhere else
    // (Libera forwards #apple → ##apple). irc-framework models this as its own
    // event with from/to — it never reaches the 'unknown command' handler.
    //
    // Under echo-written buffers the request persisted nothing, so there is
    // usually nothing to undo — but a row for `from` can pre-exist (stale
    // history, or a configured default channel the server now forwards), and
    // its autojoin would replay the forwarded JOIN on every reconnect. Evict
    // corrects that; the stashed join key is discarded since no echo for
    // `from` will ever consume it. The forward itself is still logged to the
    // server buffer verbatim by the 'raw' handler.
    c.on('channel_redirect', (event: Record<string, unknown>) => {
      const from = event?.from as string | undefined;
      if (!from) return;
      this.takeStashedJoinKey(from);
      // forget: a channel we were never in must not keep an autojoin or a row
      // with nothing to show.
      this.evictChannel(from, { forget: true });
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
        // No system-buffer "Parted #x" line — symmetric with the join above; the
        // part already shows in the channel buffer (#355).
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
      // Lowering autojoin also prevents the reconnect replay — rejoining a
      // channel that just kicked you reads as ban evasion to ops.
      if (eventKicked && c.user.nick && eventKicked.toLowerCase() === c.user.nick.toLowerCase()) {
        this.channels.delete(eventChannel.toLowerCase());
        try {
          setBufferAutojoin(this.network.user_id, this.network.id, channel, false);
        } catch (_) {
          /* ignore */
        }
        this.publish({ type: 'channel-parted', target: channel });
      }
    });

    c.on('invite', (event: Record<string, unknown>) => {
      // irc-framework parses an inbound INVITE as { nick: inviter, invited:
      // target nick, channel }. Three cases land here (#261):
      const inviter = event.nick as string | undefined;
      const invited = event.invited as string | undefined;
      const rawChannel = event.channel as string | undefined;
      if (!inviter || !rawChannel || !invited) return;
      const me = c.user?.nick;
      const meLower = me?.toLowerCase();
      const channel = canonicalChannelTarget(rawChannel, this.channels) ?? rawChannel;

      // (1) Someone invited US → actionable toast + durable system line. Routed
      // through the server pseudo-buffer, not the channel: we're not in the
      // channel (that's the point of an invite), and if we'd previously closed
      // its buffer the wsHub closed-buffer guard would drop an ephemeral
      // targeted at it. The client toast reads `channel`/`from`, never `target`.
      if (meLower && invited.toLowerCase() === meLower) {
        this.publishEphemeral({
          type: 'invite',
          target: this.serverTarget(),
          channel,
          from: inviter,
          userhost: buildUserhost(event),
        });
        this.logNet(`${inviter} invited you to ${channel}`);
        return;
      }

      // (2) Our OWN invite, echoed back to us via the invite-notify cap. The
      // RPL_INVITING (341) 'invited' handler already renders the channel line,
      // so drop the echo to avoid a duplicate.
      if (meLower && inviter.toLowerCase() === meLower) return;

      // (3) invite-notify op-visibility: a third party invited someone to a
      // channel we're in → persisted channel line "inviter invited invited".
      this.publish({ type: 'invite', target: channel, nick: inviter, invited });
    });

    c.on('invited', (event: Record<string, unknown>) => {
      // RPL_INVITING (341): the server confirms OUR /invite was relayed.
      // irc-framework gives { nick: the invited nick, channel }. Render the same
      // persisted channel line as the op-visibility path, attributed to us — so
      // the confirmation shows up in the channel rather than the server buffer,
      // and the invite-notify self-echo above is deduped against it (#261).
      const invited = event.nick as string | undefined;
      const rawChannel = event.channel as string | undefined;
      const me = c.user?.nick;
      if (!invited || !rawChannel || !me) return;
      const channel = canonicalChannelTarget(rawChannel, this.channels) ?? rawChannel;
      this.publish({ type: 'invite', target: channel, nick: me, invited });
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
          // Only tear down a watch we could actually have placed. The regain
          // `MONITOR +` is gated on `useMonitor` (set from ISUPPORT), so on a
          // server without MONITOR — or before ISUPPORT lands — nothing was
          // ever watched and a blind `MONITOR -` here just draws a 421
          // "MONITOR Unknown command" (#384). Skipping it is a true no-op.
          if (this.useMonitor) {
            try {
              this.client.removeMonitor(this.regainNick);
            } catch (_) {
              /* ignore */
            }
          }
          if (reclaimed) {
            this.publish({
              type: 'notice',
              target: this.serverTarget(),
              nick: 'lurker',
              notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
              text: `Reclaimed nick ${this.regainNick}.`,
            });
          }
          this.regainNick = null;
          this.pendingRegainSetup = false;
        }
        this.currentNick = eventNewNick;
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
            // A nick change doesn't log you out — carry the account across, or
            // it's lost for good (account-notify only fires when the account
            // itself changes, which it hasn't) (#508).
            account: member.account,
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
      const listModes = this.listModes();
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
          // Channel-level flag mode (or parameter mode like +k/+l). We track
          // them to surface them in the status bar, but exclude list-type modes
          // (bans/exceptions/quiets) so their masks don't pollute the display.
          if (!listModes.has(letter)) {
            if (sign === '+' && !ch.modes.has(letter)) {
              ch.modes.add(letter);
              chanModesChanged = true;
            } else if (sign === '-' && ch.modes.delete(letter)) {
              chanModesChanged = true;
            }
          }
          // Keep the persisted +k key current so a live key change survives a
          // reconnect (see resolveKeyModeChange for the value-less / masked-key
          // guards that stop an on-join mode burst from wiping the real key).
          if (letter === 'k') {
            const change = resolveKeyModeChange(sign, m.param);
            if (change) {
              setBufferChannelKey(this.network.user_id, this.network.id, ch.name, change.key);
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
      const listModes = this.listModes();
      const next = new Set<string>();
      for (const m of eventModes) {
        if (!m || !m.mode) continue;
        const letter = m.mode.replace(/^[+-]/, '');
        if (!letter || listModes.has(letter)) continue;
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
      const tHandler = Date.now();
      const eventChannel = event.channel as string;
      const eventUsers = (event.users as Record<string, unknown>[]) || [];
      const ch = this.upsertChannel(eventChannel);
      // Preserve known away flags AND user/host across re-issued NAMES
      // (e.g. on /NAMES or a fresh join). NAMES doesn't carry ident/host on
      // most ircds — the JOIN event and WHO reply do — so we hold onto
      // whatever we already learned.
      const prev = new Map<
        string,
        { away: boolean; user: string | null; host: string | null; account?: string | null }
      >();
      for (const [k, v] of ch.members)
        prev.set(k, {
          away: !!v.away,
          user: v.user || null,
          host: v.host || null,
          account: v.account,
        });
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
          // NAMES never carries an account, so this is carry-forward only —
          // same reasoning as user/host above (#508).
          account: carry.account,
        });
      }
      this.publish({
        type: 'names',
        target: eventChannel,
        members: Array.from(ch.members.values()).map(memberSnapshot),
      });
      // Issue a WHO so we learn the current away state for everyone in the
      // channel. away-notify keeps it live after this initial sync. Mark it so
      // the 'wholist' handler consumes the reply silently instead of echoing
      // every member to the server buffer (#342).
      try {
        c.who(eventChannel);
        // Mark only after a successful send: if c.who() throws, a stale flag
        // would silently suppress a later user-typed /who for this channel.
        this.autoWhoTargets.add(eventChannel.toLowerCase());
      } catch (_) {
        /* ignore */
      }
      const ms = Date.now() - tHandler;
      if (IRC_HANDLER_WARN_MS > 0 && ms >= IRC_HANDLER_WARN_MS) {
        console.warn(
          `[irc] NAMES(userlist) for ${eventChannel} took ${ms}ms (${ch.members.size} members) ` +
            `on network ${this.network.id} — synchronous member rebuild + fan-out; a burst of ` +
            `these across auto-rejoined channels is the reconnect [event-loop] stall`,
        );
      }
    });

    c.on('wholist', (event: Record<string, unknown>) => {
      const tHandler = Date.now();
      const eventTarget = event.target as string | undefined;
      const targetKey = eventTarget?.toLowerCase() ?? '';
      const users = (event.users as Record<string, unknown>[]) || [];

      // Render a user-typed /who to the server buffer. The auto-WHO we fire on
      // join is flagged in autoWhoTargets and consumed silently (echoing one
      // line per member would flood the buffer); anything else is the user
      // asking, so surface it like any other server response (#342). This runs
      // before the channel lookup below so /who <nick> and /who <unjoined-chan>
      // — where we have no tracked channel — still render.
      if (this.autoWhoTargets.has(targetKey)) {
        this.autoWhoTargets.delete(targetKey);
      } else {
        for (const u of users) {
          const text = formatWhoReplyLine(u);
          if (text) this.publish({ type: 'motd', target: this.serverTarget(), text });
        }
        this.publish({
          type: 'motd',
          target: this.serverTarget(),
          text: `End of /WHO list${eventTarget ? ` for ${eventTarget}` : ''}.`,
        });
      }

      const ch = this.channels.get(targetKey);
      if (!ch) return;
      let changed = false;
      for (const u of users) {
        if (!u || !u.nick) continue;
        const m = ch.members.get((u.nick as string).toLowerCase());
        if (!m) continue;
        const next = !!u.away;
        // Bridge the WHO snapshot to the DM/friend presence rail for tracked
        // peers. away-notify doesn't fire on join, so this is where a peer we
        // share a channel with gets (re-)established — critically on reconnect,
        // where markAllPeersOffline has just forced every tracked peer offline
        // and a friend still sitting in a channel we rejoin must be promoted
        // back to online here (the server sends existing occupants via NAMES,
        // not JOIN, so the 'join' handler never fires for them). 'away' sets
        // away; for a present, non-away member 'online' promotes an
        // offline/unknown row while 'back' clears a stale away. Each call is
        // gated to its valid prior state, so at most one writes and an
        // already-online peer is left untouched.
        if (next) {
          this.markPeerEvent(u.nick as string, 'away');
        } else {
          this.markPeerEvent(u.nick as string, 'online');
          this.markPeerEvent(u.nick as string, 'back');
        }
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
      if (changed) {
        this.publish({
          type: 'names',
          target: ch.name,
          members: Array.from(ch.members.values()).map(memberSnapshot),
        });
      }
      const ms = Date.now() - tHandler;
      if (IRC_HANDLER_WARN_MS > 0 && ms >= IRC_HANDLER_WARN_MS) {
        console.warn(
          `[irc] WHO(wholist) for ${ch.name} took ${ms}ms (${ch.members.size} members) ` +
            `on network ${this.network.id} — synchronous away/host backfill${changed ? ' + fan-out' : ''}; ` +
            `part of the reconnect burst`,
        );
      }
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
    // The server buffer gets the *raw* whois lines instead — every numeric is
    // rendered straight off the wire by the default-show 'raw' handler (#281,
    // #342), not the parsed JSON this event carries — so nothing whois-related
    // is published here beyond the modal payload.
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
      // ERR_NOTONCHANNEL (442) is authoritative: the server says we are not on
      // that channel, so the PART echo that normally evicts it from
      // this.channels is never coming. Evict here instead. Without this, any
      // channel the server refuses to part stays in the joined set for the life
      // of the connection, and join-precedence (eachUserBufferTarget) lets that
      // stale entry outrank the user's closed flag — an un-closable buffer.
      if (tag === 'not_on_channel' && rejectChannel) {
        this.evictChannel(rejectChannel);
        // Falls through to the generic server-buffer line below: 442 is rare
        // and worth showing, and the eviction above is silent on its own.
      }
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
    // away/back arrive via away-notify (+extended-monitor), not the MONITOR
    // numerics, so the 'users online/offline' handlers never log them. Mirror
    // their 'Presence:' line here — already gated to tracked peers (eligiblePeer)
    // and to real transitions (the allowed check above), so a busy channel's
    // /away traffic stays out of the system log. (#310)
    if (state === 'away') {
      this.logNet(`Presence: ${canonical} away${message ? ` (${message})` : ''}`);
    } else if (state === 'back') {
      this.logNet(`Presence: ${canonical} back`);
    }
    // A genuine offline→online transition (not first-sight null→online, which
    // covers a freshly-added watch / the MONITOR seed) is the only one that
    // drives the "friend came online" notification. Flag it so wsHub can fire a
    // push when no client is visible — mirrors the client-side toast gate.
    const cameOnline = state === 'online' && prevState === 'offline';
    this.publishPeerPresence(canonical, next, cameOnline);
  }

  // Mark every tracked peer on this network offline — called when our own
  // socket drops (see the 'socket close' handler). trackedPeers is still
  // populated at close time (it's only cleared/re-hydrated on the next
  // 'registered'), so we can walk it directly. markPeerEvent's per-state gate
  // keeps this a no-op for peers already offline, so a flap doesn't churn
  // timestamps.
  markAllPeersOffline(): void {
    // Skip during dispose. dispose() sets disposed=true right before tearing the
    // socket down, and on a *deletion* dispose the network row — and its
    // peer_presence_state rows, via ON DELETE CASCADE — can already be gone by
    // the time the async socket close fires. A writePeerState here would then
    // hit a foreign-key violation and throw inside the close listener. This is
    // the same reason publish()/publishEphemeral() gate on disposed; see
    // ircManager.disposeNetwork/disposeUser (and the note at ircManager.ts:679).
    if (this.disposed) return;
    for (const nick of this.trackedPeers.keys()) {
      this.markPeerEvent(nick, 'offline');
    }
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
        notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
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
        notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
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
    // Opening a notice-only buffer (a service like NickServ, #439) must not start
    // MONITOR tracking — only probe presence for targets we have a real
    // conversation with. Friends are tracked separately at hydrate time.
    if (!hasConversationForTarget(this.network.id, nick)) return;
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

  // Forget a channel the server has told us we are not on, outside the normal
  // PART echo: a forward (470) or a refused part (442). Drops it from the
  // joined set, corrects the buffers row, and announces the part so the
  // buffer stops rendering as joined.
  //
  // The DB write is deliberately NOT gated on the channel being in
  // this.channels — a stale autojoin row can outlive the in-memory entry (e.g.
  // across a restart, where the auto-JOIN was forwarded away), and that row is
  // what auto-rejoins on every reconnect. The two states are corrected
  // independently because they answer different questions: this.channels is
  // live membership, the row's autojoin drives the reconnect rejoin.
  //
  // `forget` (the 470 forward): a channel we were never in. With history the
  // buffer must survive (the user can read and now close it — the old
  // un-closable-#apple case); it just loses autojoin and any stored key.
  // Without history there is nothing to show, so any row (a configured
  // default channel the server now forwards) goes entirely. All three writes
  // are update-or-delete only — a 442 for a channel with no row conjures
  // nothing.
  private evictChannel(name: string, { forget = false }: { forget?: boolean } = {}): void {
    const canonical = canonicalChannelTarget(name, this.channels) ?? name;
    this.channels.delete(name.toLowerCase());
    try {
      if (forget && !hasMessageForTarget(this.network.id, canonical)) {
        deleteBuffer(this.network.user_id, this.network.id, canonical);
      } else {
        setBufferAutojoin(this.network.user_id, this.network.id, canonical, false);
        if (forget) {
          setBufferChannelKey(this.network.user_id, this.network.id, canonical, null);
        }
      }
    } catch (_) {
      /* ignore */
    }
    this.publish({ type: 'channel-parted', target: canonical });
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

  /** Hold a join key until its echo (see pendingJoinKeys). */
  stashJoinKey(channel: string, key: string): void {
    this.pendingJoinKeys.set(channel.toLowerCase(), key);
  }

  /** Consume the stashed key for a landed (or forwarded-away) join. */
  takeStashedJoinKey(channel: string): string | undefined {
    const lower = channel.toLowerCase();
    const key = this.pendingJoinKeys.get(lower);
    this.pendingJoinKeys.delete(lower);
    return key;
  }

  publishChannelModes(ch: ChannelState): void {
    this.publish({
      type: 'channel-modes',
      target: ch.name,
      modes: [...ch.modes].join(''),
    });
  }

  // List-type channel modes (CHANMODES group A) carry a mask param — bans,
  // ban/invite exceptions, and quiets on ircds that model them as a list — that
  // we don't surface in the status bar. We read the set from the server's
  // ISUPPORT CHANMODES so it's correct per-ircd, falling back to the RFC
  // defaults before 005 has been parsed (`??`, so a server that legitimately
  // declares an empty group A keeps its empty set rather than the default).
  // This is the same categorisation weechat/irssi/gamja use. Parameter modes
  // like +k/+l are NOT list modes, so they still land in the (+...) display.
  // Member-prefix modes (o/v/h, plus q/a where an ircd uses them as prefixes)
  // are filtered earlier by isPrefixMode(), so they never reach this set.
  private listModes(): Set<string> {
    const chanmodes = this.client.network?.options?.CHANMODES as string[] | undefined;
    return new Set((chanmodes?.[0] ?? 'beI').split(''));
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
      notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
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
      // Disable irc-framework's built-in CTCP VERSION auto-reply so our own
      // handler owns VERSION (#263). Like enable_chghost below, this MUST ride
      // the connect() dict — connect() overwrites client.options, so a
      // constructor value is lost and `version` falls back to the truthy default
      // 'node.js irc-framework'. See client.js:202 + _applyDefaultOptions.
      version: false,
      // Request the `chghost` cap so SASL-cloaked vhost changes (Libera et al.)
      // arrive as CHGHOST events instead of silently. Must go through connect()
      // — irc-framework overwrites client.options with this dict, so passing
      // it to the constructor doesn't survive. See client.js:202.
      enable_chghost: true,
      // Source-bind outbound IRC when LURKER_OUTGOING_ADDR is set, so the
      // network's RFC 1413 callback lands on the built-in identd rather than the
      // host's (outgoingAddr → irc-framework outgoing_addr → socket localAddress).
      outgoing_addr: outgoingAddr(),
    });
  }

  join(channel: string, key?: string): void {
    // Only a string is a valid channel key. Guard against a non-string sneaking
    // in from an untrusted ws/HTTP join payload — irc-framework's raw serialiser
    // calls .match() on the last arg, so a numeric key throws a TypeError that,
    // with no global uncaught handler (see wsHub sendSnapshot backstop), would
    // drop the whole (shared, on hosted) process.
    this.client.join(channel, typeof key === 'string' ? key : undefined);
  }
  part(channel: string, reason?: string): void {
    this.client.part(channel, reason);
  }
  say(target: string, text: string): void {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.noteUserSend(target);
    this.client.say(target, text);
    // Arm AFTER the send, and never let a DB hiccup in arming break delivery of
    // the user's actual message.
    try {
      this.maybeArmDcc(target, text);
    } catch {
      /* arming is best-effort */
    }
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

  // --- CTCP (#263) -----------------------------------------------------------

  // Map key for an outstanding outbound CTCP request, so its reply routes back
  // to the buffer it was issued from.
  private ctcpKey(nick: string, type: string): string {
    return `${nick.toLowerCase()} ${type.toUpperCase()}`;
  }

  private isSelfNick(nick: string | undefined): boolean {
    return !!nick && !!this.currentNick && nick.toLowerCase() === this.currentNick.toLowerCase();
  }

  // A stable per-peer key for rate limiting inbound CTCP: the sender's
  // ident@host when known, else the nick (lowercased). Mirrors how the E2E path
  // keys peers, so a nick-churning flooder still maps to bounded state.
  private ctcpPeerKey(event: Record<string, unknown>): string {
    const ident = (event.ident as string) || '';
    const host = (event.hostname as string) || '';
    const nick = (event.nick as string) || '';
    return (ident && host ? `${ident}@${host}` : nick).toLowerCase();
  }

  // The user's CTCP auto-reply preferences (settings registry, per-user). Read
  // fresh per inbound request — they're rare + rate-limited, so a /set takes
  // effect immediately with no cache to invalidate. A missing key resolves to
  // the registry default (all on), so out of the box behavior is unchanged.
  private ctcpReplyConfig(): CtcpReplyConfig {
    // One settings read for the whole cluster (not one per key) — this runs on
    // every inbound probe.
    const s = effectiveSettings(this.network.user_id, [
      'ctcp.replies',
      'ctcp.version',
      'ctcp.time',
      'ctcp.source',
      'ctcp.clientinfo',
    ]);
    const tmpl = (key: string): string => (typeof s[key] === 'string' ? (s[key] as string) : '');
    return {
      enabled: s['ctcp.replies'] !== false,
      version: tmpl('ctcp.version'),
      time: tmpl('ctcp.time'),
      source: tmpl('ctcp.source'),
      clientinfo: tmpl('ctcp.clientinfo'),
    };
  }

  // Live values for the `${...}` placeholders a CTCP reply template can use.
  private ctcpTemplateVars(config: CtcpReplyConfig): Record<string, string> {
    return {
      name: APP_NAME,
      version: APP_VERSION,
      source: CTCP_SOURCE,
      clientinfo: enabledCtcpTypes(config).join(' '),
      time: formatCtcpTime(new Date()),
      nick: this.currentNick,
    };
  }

  private pruneCtcpOutstanding(now: number): void {
    for (const [k, queue] of this.ctcpOutstanding) {
      const live = queue.filter((e) => now - e.sentAt <= CTCP_OUTSTANDING_TTL_MS);
      if (live.length === 0) this.ctcpOutstanding.delete(k);
      else if (live.length !== queue.length) this.ctcpOutstanding.set(k, live);
    }
    // Backstop: evict the OLDEST keys (Map preserves insertion order) rather than
    // flushing everything, so a burst past the cap doesn't lose ALL routing.
    while (this.ctcpOutstanding.size > CTCP_OUTSTANDING_MAX_KEYS) {
      const oldest = this.ctcpOutstanding.keys().next().value;
      if (oldest === undefined) break;
      this.ctcpOutstanding.delete(oldest);
    }
  }

  // A CTCP status line (request probe, reply, or outbound echo). Transient
  // status like /help output — never persisted (NON_PERSISTED_TYPES).
  surfaceCtcp(target: string, text: string): void {
    this.publishEphemeral({ type: 'ctcp', level: 'info', target, text });
  }

  // Route an INCOMING CTCP status line (a probe, or an unsolicited reply) per
  // the user's ctcp.msgbuffer setting — WeeChat's irc.msgbuffer.ctcp:
  //   server  → this network's server buffer (default)
  //   system  → the durable app-wide system buffer (persists, like other logs)
  //   private → the DM with the sender, or the channel for a channel CTCP
  // (A reply to a /ctcp the USER sent is routed to its issuing buffer by the
  // caller, not here — this governs unsolicited CTCP only.)
  private routeCtcpStatus(event: Record<string, unknown>, text: string): void {
    const mode = effectiveSetting(this.network.user_id, 'ctcp.msgbuffer');
    if (mode === 'system') {
      this.logNet(text);
      return;
    }
    if (mode === 'private') {
      const evTarget = (event.target as string) || '';
      if (isChannelContext(evTarget)) {
        this.surfaceCtcp(evTarget, text);
        return;
      }
      const nick = (event.nick as string) || '';
      this.surfaceCtcp(nick || this.serverTarget(), text);
      return;
    }
    this.surfaceCtcp(this.serverTarget(), text); // 'server' (default)
  }

  // Auto-answer an inbound CTCP request (VERSION/PING/TIME/CLIENTINFO/SOURCE)
  // and show the user they were probed. Self-echoes ignored; rate-limited
  // per-peer so a flood from one nick can't spew NOTICEs, spam the buffer, or
  // starve replies to other peers.
  handleInboundCtcpRequest(event: Record<string, unknown>): void {
    if (this.disposed) return;
    const nick = event.nick as string | undefined;
    // Our own outbound CTCP echoed back by an echo-message server — not a probe.
    if (!nick || this.isSelfNick(nick)) return;
    const { type, args } = parseCtcp(String(event.message ?? ''));
    // Parse + validate BEFORE the rate-limit check so a malformed/empty CTCP
    // can't burn a peer's budget and suppress its legitimate probes.
    if (!type) return;
    if (!this.ctcpLimiter.allowIncoming(this.ctcpPeerKey(event))) return;
    // DCC rides CTCP but is never an auto-reply type. When DCC is enabled for
    // this user, hand the offer to the download manager instead of the generic
    // probe path; when disabled, fall through so it surfaces as an ordinary
    // unsupported CTCP ("requested CTCP DCC (no reply)"), unchanged from today.
    if (type === 'DCC' && dccEnabledForUser(this.network.user_id)) {
      // DCC handling (parse + DB writes + socket setup) must never throw out of
      // the CTCP event path and disrupt the connection.
      try {
        this.handleInboundDccRequest(nick, args, event);
      } catch {
        /* malformed offer / transient DB error — drop it, keep the connection */
      }
      return;
    }
    const config = this.ctcpReplyConfig();
    const reply = buildCtcpReply(type, args, config, this.ctcpTemplateVars(config));
    if (reply !== null) this.client.ctcpResponse(nick, type, reply);
    this.routeCtcpStatus(event, formatCtcpRequestLine(nick, type, reply));
  }

  // Arm-on-trigger (#270): when the user sends an `XDCC SEND #n` to a bot (a DM
  // target), record a `requested` row so the bot's eventual DCC SEND offer is
  // matched + auto-accepted (findArmedRequest). The row survives a slow bot queue
  // — it just waits. A trigger typed in a channel doesn't arm (you message the
  // bot directly). Gated like every DCC entry point.
  private maybeArmDcc(target: string, text: string): void {
    if (this.disposed || !isDmTargetName(target)) return;
    // Anchored at the start (after optional whitespace) so an `xdcc send #n`
    // mentioned mid-sentence in ordinary conversation doesn't arm an auto-accept.
    const m = /^\s*xdcc\s+(?:send|get)\s+(#?\d+)/i.exec(text);
    if (!m) return;
    if (!dccEnabledForUser(this.network.user_id)) return;
    const pack = m[1].startsWith('#') ? m[1] : `#${m[1]}`;
    insertDccTransfer(this.network.user_id, {
      network_id: this.network.id,
      peer_nick: target,
      filename: `XDCC ${pack}`, // placeholder until the real offer arrives
      advertised_size: 0,
      state: 'requested',
      trigger_text: text,
    });
  }

  // Route an inbound DCC SEND offer (#270): if it matches a request the user
  // armed, auto-accept and start the download; otherwise record it as
  // `pending_approval` for the (phase 2) Accept/Reject UI. Non-SEND subtypes
  // (CHAT/ACCEPT/RESUME) and malformed bodies surface the generic probe line so
  // the user still sees something arrived. Rate-limited upstream by the shared
  // CTCP per-peer limiter.
  private handleInboundDccRequest(
    nick: string,
    args: string,
    event: Record<string, unknown>,
  ): void {
    const parsed = parseDcc(args);
    if (parsed.kind === 'accept') {
      this.handleDccAccept(nick, parsed);
      return;
    }
    if (parsed.kind !== 'send') {
      this.routeCtcpStatus(event, formatCtcpRequestLine(nick, 'DCC', null));
      return;
    }
    const offer = parsed;
    const armed = findArmedRequest(this.network.user_id, this.network.id, nick);
    if (armed) {
      this.acceptDccOffer(armed.id, nick, offer);
      return;
    }
    // Unsolicited: nothing auto-lands. Record for the Accept/Reject UI, keeping
    // the offer's host/port so the user can accept (dial it) later.
    const id = insertDccTransfer(this.network.user_id, {
      network_id: this.network.id,
      peer_nick: nick,
      filename: offer.filename,
      advertised_size: offer.size,
      state: 'pending_approval',
      passive: offer.passive,
      token: offer.token,
      peer_host: offer.host,
      peer_port: offer.port,
    });
    this.routeCtcpStatus(event, formatDccOfferLine(nick, offer));
    this.publishDcc(id);
  }

  // Accept an armed offer and stream it to disk via the receive engine. Active
  // DCC only for now (the cell dials the bot); passive/reverse is a follow-up.
  // DB progress writes + status lines are throttled so neither the single SQLite
  // connection nor the buffer gets hammered on a fast/large transfer.
  private acceptDccOffer(transferId: number, nick: string, offer: DccSend): void {
    if (offer.passive) {
      updateDccTransferState(transferId, 'failed', 'passive DCC not yet supported');
      this.surfaceCtcp(nick, `DCC: passive transfer from ${nick} not yet supported`);
      return;
    }
    // SSRF guard: the host is attacker-controlled and the cell dials it directly,
    // so refuse loopback/link-local/private/reserved addresses (a self-hoster can
    // opt back in for a LAN bot via LURKER_DCC_ALLOW_PRIVATE_HOSTS).
    if (!dccAllowPrivateHosts() && isBlockedDccHost(offer.host)) {
      updateDccTransferState(transferId, 'failed', `blocked address ${offer.host}`);
      this.surfaceCtcp(
        nick,
        `DCC: refusing "${offer.filename}" — sender address ${offer.host} is private/reserved`,
      );
      return;
    }
    // Require a real advertised size (so the receiver can bound the write) and
    // honor an operator per-file cap.
    if (offer.size <= 0) {
      updateDccTransferState(transferId, 'failed', 'offer has no advertised size');
      this.surfaceCtcp(nick, `DCC: refusing "${offer.filename}" — no advertised file size`);
      return;
    }
    const cap = dccMaxFileBytes();
    if (cap > 0 && offer.size > cap) {
      updateDccTransferState(transferId, 'failed', `exceeds ${formatBytes(cap)} limit`);
      this.surfaceCtcp(
        nick,
        `DCC: refusing "${offer.filename}" (${formatBytes(offer.size)}) — over the ${formatBytes(cap)} limit`,
      );
      return;
    }
    // Resume only continues OUR OWN tracked incomplete transfer of this file (a
    // prior failed/stalled/orphaned-receiving row whose partial is still on disk
    // and shorter than the offer) — never an arbitrary same-named leftover, which
    // could otherwise get this bot's bytes appended onto an unrelated prefix.
    let destPath: string;
    let startOffset = 0;
    const prior = findResumableTransfer(this.network.user_id, this.network.id, offer.filename);
    const partialSize =
      prior?.destination_path && fs.existsSync(prior.destination_path)
        ? fs.statSync(prior.destination_path).size
        : 0;
    if (prior?.destination_path && partialSize > 0 && partialSize < offer.size) {
      destPath = prior.destination_path;
      startOffset = partialSize;
    } else {
      try {
        const username = findUserById(this.network.user_id)?.username || 'user';
        destPath = resolveDccDestination(username, offer.filename);
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        updateDccTransferState(transferId, 'failed', reason);
        this.surfaceCtcp(nick, `DCC: cannot start "${offer.filename}" — ${reason}`);
        return;
      }
    }
    // Disk check is on the REMAINING bytes (a resume only fetches size - partial);
    // the receiver also caps writes at the advertised size, so it's the ceiling.
    if (!hasFreeSpaceFor(path.dirname(destPath), offer.size - startOffset)) {
      updateDccTransferState(transferId, 'failed', 'insufficient disk space');
      this.surfaceCtcp(
        nick,
        `DCC: refusing "${offer.filename}" (${formatBytes(offer.size)}) — not enough free disk space`,
      );
      return;
    }
    const expectedCrc = parseCrcFromFilename(offer.filename);
    markDccReceiving(transferId, {
      filename: offer.filename,
      advertised_size: offer.size,
      destination_path: destPath,
      passive: offer.passive,
      token: offer.token,
      crc_expected: expectedCrc,
      received_bytes: startOffset,
    });
    this.publishDcc(transferId);
    if (startOffset > 0) {
      // A partial exists — ask the bot to resume from there and wait for its
      // DCC ACCEPT before connecting (handleDccAccept starts the receiver).
      this.surfaceCtcp(
        nick,
        `DCC: resuming "${offer.filename}" from ${formatBytes(startOffset)} / ${formatBytes(offer.size)}…`,
      );
      this.requestDccResume(transferId, nick, offer, destPath, startOffset);
    } else {
      this.surfaceCtcp(
        nick,
        `DCC: downloading "${offer.filename}" (${formatBytes(offer.size)}) from ${nick}…`,
      );
      this.startDccReceiver(transferId, nick, offer, destPath, 0, expectedCrc);
    }
  }

  private dccResumeKey(nick: string, filename: string): string {
    // Fold case on both halves: a bot may echo the filename in different case in
    // its DCC ACCEPT than the SEND offer used, and the ACCEPT lookup must match.
    return `${nick.toLowerCase()}|${filename.toLowerCase()}`;
  }

  // Send DCC RESUME for a partial and arm a timeout; the receiver isn't started
  // until the sender's DCC ACCEPT arrives (handleDccAccept).
  private requestDccResume(
    transferId: number,
    nick: string,
    offer: DccSend,
    destPath: string,
    startOffset: number,
  ): void {
    const key = this.dccResumeKey(nick, offer.filename);
    const prior = this.dccPendingResume.get(key);
    if (prior) {
      // A newer resume for the same file supersedes the prior one — leave its row
      // resumable (stalled) rather than orphaning it forever in 'receiving'.
      clearTimeout(prior.timer);
      updateDccTransferState(prior.transferId, 'stalled', 'superseded by a newer resume');
    }
    const timer = setTimeout(() => {
      this.dccPendingResume.delete(key);
      markDccFailed(transferId, startOffset, 'resume not accepted by sender');
      this.surfaceCtcp(nick, `DCC: "${offer.filename}" — sender did not accept resume`);
      this.publishDcc(transferId);
    }, 15_000);
    this.dccPendingResume.set(key, { transferId, nick, offer, destPath, startOffset, timer });
    // Mirror the offer's filename quoting so the bot matches it.
    const fn = offer.filename.includes(' ') ? `"${offer.filename}"` : offer.filename;
    this.client.ctcpRequest(nick, 'DCC', 'RESUME', fn, String(offer.port), String(startOffset));
  }

  // The sender accepted our resume: start receiving (appending) from our partial.
  private handleDccAccept(nick: string, accept: DccAccept): void {
    const key = this.dccResumeKey(nick, accept.filename);
    const pending = this.dccPendingResume.get(key);
    if (!pending) return; // unsolicited / stale ACCEPT
    // Confirm the ACCEPT is for our pending offer (the port it echoes must match)
    // BEFORE consuming the pending entry — a stray/mismatched ACCEPT must not clear
    // the timer or fail a still-valid pending resume.
    if (accept.port !== pending.offer.port) return;
    clearTimeout(pending.timer);
    this.dccPendingResume.delete(key);
    // We asked to resume from exactly our partial's size; the sender must echo it.
    // Any other position (a buggy or malicious ACCEPT) would mean appending at the
    // wrong offset — and the position is attacker-controlled — so refuse it rather
    // than truncate/extend the file to match.
    if (accept.position !== pending.startOffset) {
      markDccFailed(
        pending.transferId,
        pending.startOffset,
        `sender accepted an unexpected resume position (${accept.position})`,
      );
      this.surfaceCtcp(nick, `DCC: "${accept.filename}" — sender accepted a bad resume position`);
      return;
    }
    this.startDccReceiver(
      pending.transferId,
      pending.nick,
      pending.offer,
      pending.destPath,
      pending.startOffset,
      parseCrcFromFilename(pending.offer.filename),
    );
  }

  // Build + start the receive engine for a transfer (fresh: startOffset 0;
  // resume: startOffset > 0, appending). Wires throttled progress, completion
  // (with CRC verdict), and failure back to the row + status buffer.
  private startDccReceiver(
    transferId: number,
    nick: string,
    offer: DccSend,
    destPath: string,
    startOffset: number,
    expectedCrc: string | null,
  ): void {
    const resumed = startOffset > 0;
    let lastDbAt = 0;
    let lastLineAt = Date.now();
    const receiver = new DccReceiver({
      host: offer.host,
      port: offer.port,
      size: offer.size,
      destPath,
      startOffset,
      onProgress: (received) => {
        const now = Date.now();
        if (now - lastDbAt >= 3000) {
          lastDbAt = now;
          updateDccReceivedBytes(transferId, received);
          this.publishDcc(transferId); // live progress to the Transfers view
        }
        if (offer.size > 0 && now - lastLineAt >= 8000) {
          lastLineAt = now;
          this.surfaceCtcp(
            nick,
            `DCC: "${offer.filename}" ${formatBytes(received)} / ${formatBytes(offer.size)}`,
          );
        }
      },
      onDone: (received, crc) => {
        this.dccReceivers.delete(transferId);
        // A resume only re-checksummed the tail, so we don't claim ok/mismatch on
        // the whole file — completion already verified the size. A fresh transfer
        // checks the filename CRC.
        const actual = crc32Hex(crc);
        const status = resumed
          ? 'unverified'
          : expectedCrc == null
            ? 'absent'
            : actual === expectedCrc
              ? 'ok'
              : 'mismatch';
        markDccCompleted(transferId, received, resumed ? null : actual, status);
        const badge =
          status === 'ok'
            ? ' ✓ CRC verified'
            : status === 'mismatch'
              ? ` ⚠ CRC MISMATCH (got ${actual}, expected ${expectedCrc})`
              : status === 'unverified'
                ? ' (resumed — size verified)'
                : '';
        this.surfaceCtcp(
          nick,
          `DCC: completed "${offer.filename}" (${formatBytes(received)}) → ${destPath}${badge}`,
        );
        this.publishDcc(transferId);
      },
      onError: (err, received) => {
        this.dccReceivers.delete(transferId);
        // A user-initiated cancel surfaces as a distinct 'cancelled' state, not a
        // failure (cancel() settles with this exact message).
        if (err.message === 'cancelled') {
          updateDccTransferState(transferId, 'cancelled');
          this.surfaceCtcp(nick, `DCC: cancelled "${offer.filename}"`);
        } else {
          markDccFailed(transferId, received, err.message);
          this.surfaceCtcp(nick, `DCC: failed "${offer.filename}" — ${err.message}`);
        }
        this.publishDcc(transferId);
      },
    });
    this.dccReceivers.set(transferId, receiver);
    receiver.start();
  }

  // Push a transfer row to ALL the user's clients (user-scoped, not buffer-scoped)
  // so the Transfers view updates live. wsHub forwards a type:'dcc-transfer' event
  // as a { kind: 'dcc-transfer' } frame (#270 phase 2).
  private publishDcc(transferId: number): void {
    if (this.disposed) return;
    const transfer = getDccTransfer(this.network.user_id, transferId);
    if (!transfer) return;
    this.onEvent({
      type: 'dcc-transfer',
      userId: this.network.user_id,
      networkId: this.network.id,
      time: new Date().toISOString(),
      transfer,
    } as unknown as EnrichedEvent);
  }

  // Accept a previously-recorded unsolicited offer (pending_approval): rebuild the
  // offer from the stored row and run the normal accept path. The offer may be
  // stale (the bot stopped listening) — that surfaces as a connect failure.
  acceptPendingDcc(row: DccTransferRow): void {
    if (this.disposed) return;
    // Only an unsolicited offer still awaiting a decision can be accepted; a row
    // that already moved on (receiving/terminal) is a no-op.
    if (row.state !== 'pending_approval') return;
    // A pending row recorded before the peer_host/peer_port columns existed (or
    // whose address didn't decode) can't be dialed. Fail it VISIBLY rather than
    // silently no-op — otherwise the API returns 200 and the UI shows the Accept
    // doing nothing, with the row stuck pending forever.
    if (row.peer_host == null || row.peer_port == null) {
      updateDccTransferState(row.id, 'failed', 'offer is missing its address — cannot reconnect');
      this.publishDcc(row.id);
      return;
    }
    this.acceptDccOffer(row.id, row.peer_nick, {
      kind: 'send',
      filename: row.filename,
      host: row.peer_host,
      port: row.peer_port,
      size: row.advertised_size,
      token: row.token,
      passive: row.passive === 1,
    });
  }

  // Reject a pending offer (no download). Guarded to the offer states so a late
  // /dcc reject can't clobber a row that already completed/failed/cancelled.
  rejectDcc(transferId: number): void {
    const row = getDccTransfer(this.network.user_id, transferId);
    if (!row || (row.state !== 'pending_approval' && row.state !== 'requested')) return;
    updateDccTransferState(transferId, 'rejected');
    this.publishDcc(transferId);
  }

  // Cancel a transfer: abort the live receiver if one is running (its onError
  // marks 'cancelled'), otherwise flip a still-active row to 'cancelled'.
  cancelDcc(transferId: number): void {
    const receiver = this.dccReceivers.get(transferId);
    if (receiver) {
      receiver.cancel();
      return; // onError → 'cancelled' + publishDcc
    }
    // No live receiver yet — but the transfer may be in the RESUME wait window
    // (requestDccResume armed a timer and a pending entry, with the receiver only
    // starting on the bot's DCC ACCEPT). Tear that down, or the timer would fire
    // markDccFailed over our 'cancelled', or a late ACCEPT would start the
    // download after the user cancelled it.
    this.clearPendingResume(transferId);
    const row = getDccTransfer(this.network.user_id, transferId);
    if (!row || !DCC_ACTIVE_STATES.has(row.state)) return; // don't clobber a terminal row
    updateDccTransferState(transferId, 'cancelled');
    this.publishDcc(transferId);
  }

  // Drop any armed DCC RESUME wait for this transfer (clear its timeout + pending
  // entry). The map is keyed by nick|filename, so find the entry by transferId.
  private clearPendingResume(transferId: number): void {
    for (const [key, pending] of this.dccPendingResume) {
      if (pending.transferId !== transferId) continue;
      clearTimeout(pending.timer);
      this.dccPendingResume.delete(key);
      return;
    }
  }

  // Surface an inbound CTCP reply (a peer answered a query we sent), routed back
  // to the buffer the /ctcp was issued from. A SOLICITED reply (matches an
  // outstanding request) always shows; an UNSOLICITED one is rate-limited
  // per-peer so a NOTICE flood can't spam the buffer.
  handleInboundCtcpReply(event: Record<string, unknown>): void {
    if (this.disposed) return;
    const nick = event.nick as string | undefined;
    if (!nick || this.isSelfNick(nick)) return;
    const { type, args } = parseCtcp(String(event.message ?? ''));
    if (!type) return;
    const now = Date.now();
    this.pruneCtcpOutstanding(now);
    const key = this.ctcpKey(nick, type);
    const queue = this.ctcpOutstanding.get(key);
    const pending = queue?.shift(); // FIFO: the oldest matching query
    if (queue && queue.length === 0) this.ctcpOutstanding.delete(key);
    const line = formatCtcpReplyLine(nick, type, args, now);
    if (pending) {
      // Solicited: route back to the buffer the /ctcp was issued from (server
      // buffer if it has since been closed — a wsHub guard would otherwise drop
      // an ephemeral event to a closed buffer). ctcp.msgbuffer governs only
      // UNSOLICITED CTCP, never a reply the user explicitly asked for.
      const target = isBufferClosed(this.network.user_id, this.network.id, pending.issuingTarget)
        ? this.serverTarget()
        : pending.issuingTarget;
      this.surfaceCtcp(target, line);
      return;
    }
    // Unsolicited reply: rate-limit per-peer, then route per ctcp.msgbuffer.
    if (!this.ctcpLimiter.allowIncoming(this.ctcpPeerKey(event))) return;
    this.routeCtcpStatus(event, line);
  }

  // Send an outbound CTCP request (/ctcp, /ping). `issuingTarget` is the buffer
  // the command was typed in: the local echo lands there and the reply routes
  // back to it. A bare PING gets an epoch-ms payload so the reply yields a
  // round-trip latency.
  sendCtcpRequest(issuingTarget: string, target: string, type: string, args: string): void {
    if (this.disposed) return;
    const issuing = issuingTarget || this.serverTarget();
    const t = type.toUpperCase();
    const now = Date.now();
    let payload = args.trim();
    if (t === 'PING' && !payload) payload = String(now);
    this.noteUserSend(target);
    if (payload) this.client.ctcpRequest(target, t, payload);
    else this.client.ctcpRequest(target, t);
    this.pruneCtcpOutstanding(now);
    const key = this.ctcpKey(target, t);
    const queue = this.ctcpOutstanding.get(key) ?? [];
    queue.push({ issuingTarget: issuing, sentAt: now });
    this.ctcpOutstanding.set(key, queue);
    this.surfaceCtcp(issuing, `→ CTCP ${t} to ${target}`);
  }

  // --- RPE2E (#382) ----------------------------------------------------------

  // A handshake reply (KEYRSP/reciprocal KEYREQ) goes back to the initiator as a
  // CTCP-framed NOTICE. It's protocol noise, so unlike notice() it never echoes
  // into a buffer or touches presence/idle tracking.
  sendHandshakeReply(nick: string, body: string): void {
    if (this.disposed) return;
    e2eDbg(() => `→ NOTICE ${nick}: ${body.slice(0, 140)}`);
    this.client.notice(nick, `\x01${body}\x01`);
  }

  // Surface a manager-emitted handshake notice (session established, TOFU
  // warning, accept/enable prompt). Routed to the channel buffer it's about (so
  // the prompt appears where the user is actually typing) when we're in that
  // channel, else the server buffer. Ephemeral: status, not history.
  surfaceE2eNotice(notice: UserNotice, channel?: string): void {
    const inChannel = !!channel && this.channels.has(channel.toLowerCase());
    this.publishEphemeral({
      type: 'e2e',
      level: notice.level,
      target: inChannel ? (channel as string) : this.serverTarget(),
      text: notice.text,
    });
  }

  // An inbound `+RPE2E01` chunk we couldn't read. We never persist ciphertext as
  // a message; instead drop a transient hint on the channel (silent for replays,
  // which are just duplicates). A logical message over ~180 bytes arrives as N
  // chunks, each its own undecryptable event — collapse the burst to ONE hint
  // per (channel,peer,kind) within a short window so a long message can't spam N
  // identical lines (#382, review #3).
  surfaceE2eDecryptIssue(
    channel: string,
    nick: string | undefined,
    kind: 'missing-key' | 'rejected' | 'replay' | 'cleartext',
    handshaking = false,
  ): void {
    if (kind === 'replay' || kind === 'cleartext') return;
    const who = nick || 'peer';
    const key = `${channel.toLowerCase()}:${who.toLowerCase()}:${kind}`;
    const now = Date.now();
    if (now - (this.e2eHintAt.get(key) ?? 0) < 5000) return;
    // Bound the map (a churn of distinct peers shouldn't grow it forever).
    if (this.e2eHintAt.size > 500) this.e2eHintAt.clear();
    this.e2eHintAt.set(key, now);
    const text =
      kind === 'missing-key'
        ? handshaking
          ? `establishing an encrypted session with ${who}…`
          : `encrypted message from ${who} — no session key yet (try /e2e handshake ${who})`
        : `could not decrypt a message from ${who}`;
    this.publishEphemeral({
      type: 'e2e',
      level: kind === 'missing-key' ? 'info' : 'warn',
      target: channel,
      text,
    });
  }

  // The peer's `ident@host` from current channel membership (the JOIN/NAMES
  // record), or null if they aren't a visible member or their host isn't known.
  // This is how a user-typed nick maps to the stable keyring identity for
  // /e2e accept|verify|revoke|reverify.
  resolvePeerHandle(channel: string, nick: string): string | null {
    const ch = this.channels.get(channel.toLowerCase());
    const m = ch?.members.get(nick.toLowerCase());
    if (!m || !m.user || !m.host) return null;
    return `${m.user}@${m.host}`;
  }

  // The reverse of resolvePeerHandle: a peer's keyring handle (ident@host) → their
  // CURRENT nick on `channel`, via channel membership. Needed because a REKEY is
  // addressed to a handle but a NOTICE is sent to a nick. Null if they aren't a
  // visible member (e.g. they left between handshake and rotation).
  nickForHandle(channel: string, handle: string): string | null {
    const ch = this.channels.get(channel.toLowerCase());
    if (!ch) return null;
    const want = handle.toLowerCase();
    for (const m of ch.members.values()) {
      if (m.user && m.host && `${m.user}@${m.host}`.toLowerCase() === want) return m.nick;
    }
    return null;
  }

  // Ship any REKEY CTCPs a lazy rotation queued during the just-completed send
  // (see E2eManager.getOrGenerateOutgoingKey). Each goes out as a framed NOTICE to
  // the recipient's current nick on the rotated channel; a recipient who has left
  // is dropped (they re-handshake on next ciphertext if they return).
  flushE2eRekeys(): void {
    if (this.disposed) return;
    const sends = e2eManager.takePendingRekeySends(this.network.user_id, this.network.id);
    for (const s of sends) {
      const nick = this.nickForHandle(s.channel, s.targetHandle);
      if (!nick) {
        e2eDbg(() => `rekey drop: no nick for ${s.targetHandle} on ${s.channel}`);
        continue;
      }
      this.sendHandshakeReply(nick, s.body);
    }
  }

  // Dispatch a `/e2e …` subcommand. All output is ephemeral status routed to the
  // issuing buffer; handshake/accept put real CTCP NOTICEs on the wire. Channels
  // only this phase (#382) — DM contexts are rejected with a hint.
  runE2eCommand(issuingTarget: string, argLine: string): void {
    const uid = this.network.user_id;
    const nid = this.network.id;
    const info = (text: string, level: 'info' | 'warn' = 'info') =>
      this.publishEphemeral({ type: 'e2e', level, target: issuingTarget, text });

    const tokens = argLine
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const sub = (tokens.shift() || 'help').toLowerCase();
    // `#`-prefixed channels only — INCLUDING double-hash names like `##anime`
    // (the `length > 1` guard rejects only a bare lone `#`, which would otherwise
    // persist a junk config row; #382 review #6). This is intentionally narrower
    // than isChannelContext's `# & ! +`: Lurker's message routing treats `&`/`!`/
    // `+` targets as DMs (see `targetIsChannel` in the message handler), so they
    // can never be E2E channels here — accepting them would only enable a config
    // whose inbound ciphertext would mis-route to a DM buffer (review #1 on #407).
    const channelToken = tokens.find((t) => t.startsWith('#') && t.length > 1);
    const nonChannel = tokens.filter((t) => !t.startsWith('#'));
    // The channel an op targets: an explicit #arg wins, else the issuing buffer
    // if it's a channel. null when neither is a channel.
    const channel = channelToken ?? (issuingTarget.startsWith('#') ? issuingTarget : null);
    const needChannel = (): string | null => {
      if (!channel) {
        info('/e2e: run this from a channel, or name one (e.g. /e2e on #chan)', 'warn');
        return null;
      }
      return channel;
    };
    const peer = nonChannel[0];
    const needPeer = (): string | null => {
      if (!peer) {
        info(`/e2e ${sub}: needs a nick (e.g. /e2e ${sub} alice)`, 'warn');
        return null;
      }
      return peer;
    };
    const resolveOrWarn = (chan: string, nickOrHandle: string): string | null => {
      // A literal ident@host (from a TOFU warning or /e2e list) is the keyring
      // identity itself — use it as-is so you can act on a peer who has LEFT the
      // channel (and so nick→handle resolution isn't required). A bare nick is
      // still resolved against current channel membership.
      if (nickOrHandle.includes('@')) return nickOrHandle;
      const handle = this.resolvePeerHandle(chan, nickOrHandle);
      if (!handle) {
        info(
          `couldn't resolve ${nickOrHandle} on ${chan} — pass their ident@host instead (see /e2e list -all)`,
          'warn',
        );
      }
      return handle;
    };
    // The accept/verify/revoke/reverify subcommands all need the same triple:
    // a channel, a peer nick, and that nick resolved to its keyring handle. One
    // helper collapses the repeated needChannel→needPeer→resolveOrWarn ladder
    // (#382, review #12) — each warns + returns null on the first missing piece.
    const chanNickHandle = (): { chan: string; nick: string; handle: string } | null => {
      const chan = needChannel();
      if (!chan) return null;
      const nick = needPeer();
      if (!nick) return null;
      const handle = resolveOrWarn(chan, nick);
      if (!handle) return null;
      return { chan, nick, handle };
    };

    switch (sub) {
      case 'on':
      case 'enable': {
        const chan = needChannel();
        if (!chan) return;
        const modeToken = nonChannel[0];
        // A present-but-unknown mode token is a typo (e.g. `quite`) — reject it
        // instead of silently falling back to `normal` and reporting success
        // (parity with the validated `/e2e mode`). Absent token → default normal.
        if (
          modeToken !== undefined &&
          !['auto', 'auto-accept', 'normal', 'quiet'].includes(modeToken.toLowerCase())
        ) {
          info(`/e2e on: unknown mode '${modeToken}' — use auto | normal | quiet`, 'warn');
          return;
        }
        const mode = parseE2eMode(modeToken);
        if (e2eManager.setChannelConfig(uid, nid, chan, true, mode)) {
          info(
            `encryption enabled on ${chan} (mode: ${mode}). Start a session: /e2e handshake <nick>`,
          );
        } else {
          info(`failed to enable encryption on ${chan}`, 'warn');
        }
        return;
      }
      case 'off':
      case 'disable': {
        const chan = needChannel();
        if (!chan) return;
        const existing = getE2eChannelConfig(uid, nid, chan);
        const mode: ChannelMode = existing?.mode ?? 'normal';
        if (e2eManager.setChannelConfig(uid, nid, chan, false, mode)) {
          info(`encryption disabled on ${chan}`);
        } else {
          info(`failed to disable encryption on ${chan}`, 'warn');
        }
        return;
      }
      case 'handshake':
      case 'hs': {
        const chan = needChannel();
        if (!chan) return;
        const nick = needPeer();
        if (!nick) return;
        const peerHandle = this.resolvePeerHandle(chan, nick) ?? undefined;
        const body = e2eManager.buildKeyReq(uid, nid, chan, peerHandle);
        if (!body) {
          info(`couldn't build a handshake (is your identity available?)`, 'warn');
          return;
        }
        this.sendHandshakeReply(nick, body);
        info(`handshake sent to ${nick} on ${chan} — waiting for their key…`);
        return;
      }
      case 'accept': {
        const r = chanNickHandle();
        if (!r) return;
        const outcome = e2eManager.acceptPending(uid, nid, r.handle, r.chan);
        for (const reply of outcome.replies) this.sendHandshakeReply(r.nick, reply);
        if (outcome.notice) info(outcome.notice.text, outcome.notice.level);
        else info(`accepted ${r.nick} — encrypted session set up on ${r.chan}`);
        return;
      }
      case 'fingerprint':
      case 'fp': {
        const id = e2eManager.getIdentity(uid);
        if (!id) {
          info('your encryption identity is unavailable', 'warn');
          return;
        }
        info(`your fingerprint: ${id.fingerprintHex}`);
        info(`   verify words: ${id.sas}`);
        return;
      }
      case 'verify': {
        const r = chanNickHandle();
        if (!r) return;
        const me = e2eManager.getIdentity(uid);
        const v = e2eManager.verifyInfo(uid, nid, r.handle);
        if (!v) {
          info(`no known encryption key for ${r.nick}`, 'warn');
          return;
        }
        // Side-by-side so the user can read both out-of-band and compare, with the
        // MitM remediation spelled out (mirrors repartee's verify block).
        info(`verify ${r.nick} — compare BOTH out-of-band (call/Signal), then trust:`);
        if (me) info(`   you:  ${me.fingerprintHex.slice(0, 16)}…  ${me.sas}`);
        info(`   ${r.nick}:  ${v.fingerprintHex.slice(0, 16)}…  ${v.sas}  (${v.status})`);
        info(
          `   if they DON'T match, a MitM may be in progress — /e2e forget -all ${r.nick}`,
          'warn',
        );
        return;
      }
      case 'revoke': {
        const r = chanNickHandle();
        if (!r) return;
        const ok = e2eManager.revokePeer(uid, nid, r.handle);
        info(
          ok
            ? `revoked ${r.nick} — they can't read your future messages`
            : `nothing to revoke for ${r.nick}`,
        );
        return;
      }
      case 'unrevoke': {
        const r = chanNickHandle();
        if (!r) return;
        const ok = e2eManager.unrevokePeer(uid, nid, r.handle);
        info(ok ? `unrevoked ${r.nick} — trust restored` : `${r.nick} isn't revoked`);
        return;
      }
      case 'rotate': {
        const chan = needChannel();
        if (!chan) return;
        const ok = e2eManager.rotateChannel(uid, nid, chan);
        info(
          ok
            ? `rotating ${chan}'s key — your trusted peers get the fresh key on your next message`
            : `nothing to rotate on ${chan} (no encrypted session yet)`,
        );
        return;
      }
      case 'decline': {
        const r = chanNickHandle();
        if (!r) return;
        const ok = e2eManager.declinePeer(uid, nid, r.handle, r.chan);
        info(ok ? `declined ${r.nick} on ${r.chan}` : `nothing pending from ${r.nick}`);
        return;
      }
      case 'reverify': {
        const r = chanNickHandle();
        if (!r) return;
        const outcome = e2eManager.reverifyPeer(uid, nid, r.handle);
        if (outcome.kind === 'applied') {
          info(
            outcome.change === 'fingerprint-changed'
              ? `reverified ${r.nick}: key changed ${outcome.oldFpHex.slice(0, 16)}… → ${outcome.newFpHex.slice(0, 16)}…, now trusted`
              : `reverified ${r.nick}: re-pinned their key under the new handle, now trusted`,
          );
        } else if (outcome.kind === 'cleared') {
          info(`forgot ${outcome.cleared} record(s) for ${r.nick} — re-handshake to re-pin`);
        } else {
          info(`nothing to reverify for ${r.nick}`);
        }
        return;
      }
      case 'forget': {
        // Accepts a nick OR a literal ident@host, so you can clear a peer who has
        // LEFT the channel (the case nick→handle resolution can't reach). `-all`
        // forgets them everywhere (drops the identity pin); without it, just this
        // channel's session. Mirrors repartee's /e2e forget [-all].
        const all = nonChannel.some((t) => t.toLowerCase() === '-all');
        const target = nonChannel.find((t) => t.toLowerCase() !== '-all');
        if (!target) {
          info(
            '/e2e forget [-all] <nick|handle> — pass the ident@host for a peer who left; -all clears every channel',
            'warn',
          );
          return;
        }
        const handle = resolveOrWarn(channel ?? '', target);
        if (!handle) return;
        if (all) {
          const cleared = e2eManager.forgetPeer(uid, nid, handle);
          info(
            cleared > 0
              ? `forgot ${handle} everywhere — cleared ${cleared} record(s); re-handshake to start fresh`
              : `nothing remembered for ${handle}`,
          );
        } else {
          const chan = needChannel();
          if (!chan) return;
          const had = e2eManager.forgetPeerOnChannel(uid, nid, handle, chan);
          info(
            had
              ? `forgot ${handle} on ${chan} — re-handshake to start fresh`
              : `nothing remembered for ${handle} on ${chan} (try -all for the identity pin)`,
          );
        }
        return;
      }
      case 'mode': {
        const chan = needChannel();
        if (!chan) return;
        const token = (nonChannel[0] || '').toLowerCase();
        if (!['auto', 'auto-accept', 'normal', 'quiet'].includes(token)) {
          info(`/e2e mode <auto|normal|quiet>`, 'warn');
          return;
        }
        const mode = parseE2eMode(token);
        if (e2eManager.setChannelMode(uid, nid, chan, mode)) {
          info(`${chan} mode set to ${mode}`);
        } else {
          info(`failed to set mode on ${chan}`, 'warn');
        }
        return;
      }
      case 'list': {
        if (nonChannel.some((t) => t.toLowerCase() === '-all')) {
          const { peers, sessions } = e2eManager.listKeyring(uid, nid);
          info(`E2E keyring — ${peers.length} peer(s), ${sessions.length} session(s)`);
          if (!peers.length) info('   (no remembered peers)');
          for (const p of peers) {
            info(`   ${p.handle}  [${p.status}]  ${p.fingerprintHex.slice(0, 16)}…`);
          }
          for (const s of sessions) info(`   ${s.channel}  ${s.handle}  [${s.status}]`);
          return;
        }
        const chan = needChannel();
        if (!chan) return;
        const peers = e2eManager.listChannelPeers(uid, nid, chan);
        if (!peers.length) {
          info(`${chan}: no trusted peers yet — /e2e accept <nick> after a handshake`);
          return;
        }
        info(`${chan}: ${peers.length} trusted peer(s)`);
        for (const p of peers) {
          info(`   ${p.handle}  [${p.status}]  ${p.fingerprintHex.slice(0, 16)}…`);
        }
        return;
      }
      case 'autotrust': {
        const op = (tokens[0] || '').toLowerCase();
        if (op === 'list') {
          const rules = e2eManager.listAutotrust(uid, nid);
          if (!rules.length) {
            info('no autotrust rules');
            return;
          }
          info(`autotrust rules (${rules.length}):`);
          for (const ru of rules) info(`   ${ru.scope}  ${ru.handlePattern}`);
          return;
        }
        if (op === 'add') {
          const scope = tokens[1];
          const pattern = tokens[2];
          if (!scope || !pattern) {
            info('/e2e autotrust add <scope> <pattern>  (scope = global or #chan)', 'warn');
            return;
          }
          // The matcher only honors scope='global' or scope=<#channel>
          // (db/e2e.ts matchAutotrustStmt), so reject anything else up front
          // rather than storing a rule that can never match (a dead rule the
          // user is told was "added").
          if (scope.toLowerCase() !== 'global' && !(scope.startsWith('#') && scope.length > 1)) {
            info(
              `/e2e autotrust add: scope must be 'global' or a #channel (got '${scope}')`,
              'warn',
            );
            return;
          }
          info(
            e2eManager.addAutotrust(uid, nid, scope, pattern)
              ? `autotrust added: ${scope} ${pattern}`
              : 'failed to add autotrust rule',
            'info',
          );
          return;
        }
        if (op === 'remove') {
          const pattern = tokens[1];
          if (!pattern) {
            info('/e2e autotrust remove <pattern>', 'warn');
            return;
          }
          const removed = e2eManager.removeAutotrust(uid, nid, pattern);
          info(
            removed > 0
              ? `removed ${removed} autotrust rule(s) matching ${pattern}`
              : `no autotrust rule matching ${pattern}`,
          );
          return;
        }
        info('/e2e autotrust <list|add|remove>', 'warn');
        return;
      }
      case 'status': {
        const id = e2eManager.getIdentity(uid);
        if (id) {
          info(`your fingerprint: ${id.fingerprintHex}`);
          info(`   verify words: ${id.sas}`);
        } else {
          info('encryption identity unavailable', 'warn');
        }
        if (channel) {
          const st = e2eManager.channelStatus(uid, nid, channel);
          info(
            st?.enabled
              ? `${channel}: encryption ON (mode: ${st.mode}, peers: ${st.peers})`
              : `${channel}: encryption off`,
          );
        }
        return;
      }
      case 'help':
      case '?': {
        for (const line of [
          '/e2e commands:',
          '   on [#chan] [auto|normal|quiet] · off [#chan] · mode <auto|normal|quiet>',
          '   handshake <nick> · accept <nick> · decline <nick>',
          '   revoke <nick> · unrevoke <nick> · reverify <nick> · rotate [#chan]',
          '   forget [-all] <nick|handle> · verify <nick> · fingerprint',
          '   status · list [-all]',
          '   autotrust <list | add <scope> <pattern> | remove <pattern>>',
          '   export (download keyring) · import (upload + replace keyring)',
        ]) {
          info(line);
        }
        return;
      }
      default:
        info(`/e2e: unknown subcommand '${sub}' — try /e2e help`, 'warn');
    }
  }

  // --- IRCv3 draft/multiline (#381) ------------------------------------------
  // Send a multi-line compose as one logical message on servers that support
  // the cap pair (e.g. Ergo), and reassemble the same from peers, with a clean
  // fallback to per-line splitting everywhere else.

  // The server's advertised limits for a multiline batch, or null when multiline
  // isn't usable here: the cap trio (batch + draft/multiline + message-tags —
  // the batch reference rides a message tag, so framing is impossible without
  // it) wasn't negotiated, or the advertised max-bytes is below one full wire
  // line (MESSAGE_MAX_BYTES) and so can't carry a single PRIVMSG inside a batch.
  // In either case the send path falls back to the legacy splitter rather than
  // framing batches the server would FAIL+drop. An omitted dimension defaults
  // conservatively; once non-null, the body always rides batches (spanning as
  // many as the limits require), never the legacy path.
  multilineLimits(): MultilineLimits | null {
    const cap = this.client.network?.cap as
      | { enabled?: string[]; available?: Map<string, string> }
      | undefined;
    const enabled = cap?.enabled ?? [];
    if (
      !enabled.includes('batch') ||
      !enabled.includes('draft/multiline') ||
      !enabled.includes('message-tags')
    ) {
      return null;
    }
    let maxBytes = 4096;
    let maxLines = 24;
    const advertised = cap?.available?.get('draft/multiline') ?? '';
    for (const part of advertised.split(',')) {
      const [key, val] = part.split('=');
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (key === 'max-bytes') maxBytes = n;
      else if (key === 'max-lines') maxLines = n;
    }
    if (maxBytes < MESSAGE_MAX_BYTES) return null;
    return { maxBytes, maxLines };
  }

  // Whether this connection negotiated the draft/multiline cap pair. The caller
  // gates multi-line plain sends on this; over-budget bodies don't fall back to
  // raw splitting, they just span multiple batches (see sendMultiline).
  supportsMultiline(): boolean {
    return this.multilineLimits() != null;
  }

  // Send `text` as one-or-more draft/multiline batches: each is BATCH +ref …
  // one tagged PRIVMSG per line … BATCH -ref. The body is partitioned to the
  // server's max-lines / max-bytes, so a big paste lands as N logical messages
  // rather than N raw lines. Blank lines are preserved (an empty trailing param
  // round-trips as a blank line); an over-long single line is byte-split with
  // draft/multiline-concat on the continuations so the receiver rejoins it with
  // no spurious newline. Returns the per-batch display text so the caller can
  // echo one self bubble per batch, matching what the channel sees. All lines
  // go through raw() so embedded CR/LF/NUL is stripped. (#381)
  sendMultiline(target: string, text: string): string[] {
    if (isDmTargetName(target)) this.trackDmPeer(target);
    this.noteUserSend(target);
    const limits = this.multilineLimits();
    if (!limits) return [];
    const echoes: string[] = [];
    for (const batch of partitionMultiline(text, limits)) {
      const ref = randomBytes(8).toString('hex');
      this.raw(`BATCH +${ref} draft/multiline ${target}`);
      for (const line of batch) {
        const tag = line.concat ? `batch=${ref};draft/multiline-concat` : `batch=${ref}`;
        this.raw(`@${tag} PRIVMSG ${target} :${line.content}`);
      }
      this.raw(`BATCH -${ref}`);
      echoes.push(reassembleMultiline(batch));
    }
    return echoes;
  }

  // Buffer one PRIVMSG of an inbound draft/multiline batch, keyed by its batch
  // reference. Lines join with '\n' except where draft/multiline-concat says to
  // glue with none. flushMultiline emits the reassembled message on batch end.
  accumulateMultiline(event: Record<string, unknown>): void {
    const id = (event.batch as { id?: string } | undefined)?.id;
    // irc-framework always sets batch.id alongside batch.type, so a multiline
    // event without an id can't occur; guard rather than re-dispatch (which
    // would be 'message' re-entrancy) and move on.
    if (!id) return;
    const line = (event.message as string | undefined) ?? '';
    const existing = this.multilineBatches.get(id);
    if (!existing) {
      this.multilineBatches.set(id, { event, text: line });
      return;
    }
    const tags = event.tags as Record<string, string> | undefined;
    const concat = !!tags && 'draft/multiline-concat' in tags;
    existing.text += concat ? line : `\n${line}`;
  }

  // Emit the reassembled multiline message through the normal 'message' path
  // with the batch stripped, so it flows through self-echo, routing and
  // presence exactly like a standalone PRIVMSG. (WeeChat takes the same
  // reconstruct-then-redispatch approach.) (#381)
  flushMultiline(id: string): void {
    const buf = this.multilineBatches.get(id);
    if (!buf) return;
    this.multilineBatches.delete(id);
    this.client.emit('message', { ...buf.event, message: buf.text, batch: undefined });
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
  // Whether the network negotiated IRCv3 message-tags. Client-only tags
  // (+typing, +draft/react, …) and TAGMSG only mean anything to a server that
  // speaks it; forwarding them to one that doesn't yields ERR_UNKNOWNCOMMAND.
  supportsMessageTags(): boolean {
    return (this.client.network?.cap?.enabled || []).includes('message-tags');
  }
  sendTyping(target: string, state: string): void {
    // +typing is a client-only tag carried over TAGMSG, which only exists when
    // the server negotiated the message-tags capability. Networks that don't
    // speak it (DALnet and other non-IRCv3 servers) answer every TAGMSG with
    // ERR_UNKNOWNCOMMAND, which our 'irc error' handler surfaces as a toast —
    // so an ungated send spams an error on each keystroke. Typing indicators
    // are a best-effort nicety; no cap, no send.
    if (!this.supportsMessageTags()) return;
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

  disconnect(reason?: string): void {
    this.client.quit(reason ?? this.defaultQuitMessage());
  }

  // The QUIT reason for a clean disconnect when the caller gave none (the bare
  // /quit command, auto-disconnect, shutdown): the user's configured
  // chat.quit_message, or the built-in Lurker default when blank. The built-in
  // default stays a single source of truth here (DEFAULT_QUIT_MESSAGE, composed
  // with APP_VERSION) instead of being duplicated as a static string in the
  // registry — which is why the registry default is '' rather than the version line.
  private defaultQuitMessage(): string {
    const custom = effectiveSetting(this.network.user_id, 'chat.quit_message');
    return typeof custom === 'string' && custom.trim() ? custom : DEFAULT_QUIT_MESSAGE;
  }

  dispose(reason: string = 'network removed'): void {
    this.disposed = true;
    this.stopLagPinger();
    this.cancelPendingConnectCommands();
    // Abort any in-flight DCC downloads (their sockets are independent of the IRC
    // socket, so they'd otherwise outlive this connection) and drop resume timers.
    for (const receiver of this.dccReceivers.values()) receiver.cancel();
    this.dccReceivers.clear();
    for (const pending of this.dccPendingResume.values()) {
      clearTimeout(pending.timer);
      // The row is mid-resume ('receiving') with no receiver to fail it — mark it
      // stalled so it isn't orphaned and can be resumed on reconnect.
      updateDccTransferState(pending.transferId, 'stalled', 'interrupted while awaiting resume');
    }
    this.dccPendingResume.clear();
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
      // this.currentNick (server-tracked) not c.user.nick — the framework lags
      // updating c.user.nick during the 'connected' dispatch that triggers this
      // snapshot, which would otherwise ship a stale nick and clobber the input
      // bar after a taken-nick fallback (#362).
      nick: this.currentNick || this.network.nick,
      userModes: [...this.userModes].join(''),
      lagMs: this.lagMs,
      // Negotiated draft/multiline limits (or null) so the composer can gate its
      // split/flood hint and upload-as-.txt prompt on what will actually go on
      // the wire. Computed post-registration, which is when this snapshot is
      // pushed (setState('connected') fires after CAP). (#381)
      multilineLimits: this.multilineLimits(),
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

// Decide how a channel +k / -k MODE change should update the persisted key.
// Returns null for "leave the stored key alone" — the two cases that must NOT
// touch it are (a) a +k echoed WITHOUT its value (common in the on-join mode
// burst) and (b) a masked +k where the server sends the key as `*` to hide it
// from non-ops. Either would otherwise clobber the real key we stored at join
// time, so the channel would fail to auto-rejoin on the next reconnect. -k
// clears; +k with a real value sets. Pure + exported so the guard is unit-tested.
export function resolveKeyModeChange(
  sign: string,
  param: string | undefined,
): { key: string | null } | null {
  if (sign === '-') return { key: null };
  if (sign === '+' && param && param !== '*') return { key: param };
  return null;
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

// Numerics we suppress from the server buffer. Everything else is rendered
// verbatim by the 'raw' handler — default-show, so a numeric never silently
// vanishes the way it did under the old curated allowlist (#342). This set is
// only (a) numerics another handler already writes to the *same* server buffer
// (echoing the raw line would duplicate it) and (b) high-volume or
// Lurker-initiated floods. It grows only when we add a new server-buffer
// renderer (a deliberate act), and a miss shows a benign duplicate line, never
// a silent drop. Note: 005 ISUPPORT is intentionally NOT here — the connect
// burst is part of the authentic server log.
const SERVER_BUFFER_DENIED_NUMERICS = new Set<string>([
  // RPL_LISTSTART/RPL_LIST/RPL_LISTEND — /LIST can be thousands of rows; cached
  // off-wire for the chanlist search (see the 'channel list' handlers).
  '321',
  '323',
  '322',
  // RPL_WHOREPLY/RPL_ENDOFWHO/RPL_WHOSPCRPL — Lurker auto-issues WHO on every
  // join; user-typed /who is rendered from the aggregated 'wholist' event.
  '352',
  '315',
  '354',
  // RPL_NAMREPLY/RPL_ENDOFNAMES — the server sends NAMES on every join; the
  // nicklist is the pretty surface (rebuilt from the parsed 'userlist' event),
  // so the raw per-batch lines are a redundant flood in the server buffer.
  '353',
  '366',
  // RPL_MON* — MONITOR presence, surfaced by the presence rail, not the buffer.
  '730',
  '731',
  '732',
  '733',
  // RPL_MOTDSTART/RPL_MOTD/RPL_ENDOFMOTD/ERR_NOMOTD — shown as a single block by
  // the 'motd' handler.
  '375',
  '372',
  '376',
  '422',
  // ERR_ERRONEUSNICKNAME/ERR_NICKNAMEINUSE — driven by the fallback ladder and
  // surfaced by the 'nick in use' handler.
  '432',
  '433',
]);

// True for numerics another handler already surfaces (or that would flood), so
// the 'raw' handler skips them. See SERVER_BUFFER_DENIED_NUMERICS.
export function isServerBufferDeniedNumeric(command: string): boolean {
  return SERVER_BUFFER_DENIED_NUMERICS.has(command);
}

// Format one user from a parsed 'wholist' event into a /who line for the server
// buffer. The event carries parsed fields, not the raw 352 wire line (which we
// denylist to avoid the auto-WHO flood), so we reconstruct a readable line
// here. Returns null for a malformed entry.
export function formatWhoReplyLine(u: Record<string, unknown> | null | undefined): string | null {
  if (!u || !u.nick) return null;
  const nick = String(u.nick);
  const ident = u.ident ? String(u.ident) : '';
  const host = u.hostname ? String(u.hostname) : '';
  const mask =
    ident && host ? ` (${ident}@${host})` : host ? ` (${host})` : ident ? ` (${ident})` : '';
  const server = u.server ? ` ${String(u.server)}` : '';
  const flags = u.away ? ' away' : '';
  const real = u.real_name ? ` — ${String(u.real_name)}` : '';
  const chan = u.channel ? `${String(u.channel)} ` : '';
  return `${chan}${nick}${mask}${server}${flags}${real}`.trim();
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

// Matches a conventional "[#chan] …" channel-context body prefix, also tolerating
// (#chan), <#chan>, {#chan}. Restricted to `#` to match Lurker's routing, which
// treats only `#` as a channel (`&`/`!`/`+` are routed as non-channels); the
// captured name is validated against the joined set before use, and brackets
// aren't required to pair since the joined-channel check is the real gate.
const CHANNEL_CONTEXT_PREFIX = /^\s*[[(<{]\s*(#[^\])>}\s]+)\s*[\])>}]/;

// A nick-addressed NOTICE sometimes belongs in a channel rather than a DM with
// the sender: services announce per-channel info to your nick (Atheme ENTRYMSG,
// ChanServ welcome) either via the IRCv3 +draft/channel-context client tag or a
// conventional "[#chan] …" body prefix. Mirrors weechat's notice_welcome_redirect
// and irssi's notice_channel_context: redirect to the referenced channel, but ONLY
// when it's a `#` channel we're currently joined to (so a stray tag/prefix can't
// fabricate a buffer), returning its canonical (joined) casing. The tag wins over
// the body prefix. Returns null when there's no usable, joined `#`-channel context.
export function resolveChannelContext(
  tags: Record<string, string> | undefined,
  body: string | undefined,
  channels: Map<string, { name: string }>,
): string | null {
  const joinedChannel = (name: string | undefined): string | null => {
    if (!name || !name.startsWith('#')) return null;
    const known = channels.get(name.toLowerCase());
    return known ? known.name : null;
  };
  const tagged = joinedChannel(tags?.['+draft/channel-context']);
  if (tagged) return tagged;
  const match = typeof body === 'string' ? body.match(CHANNEL_CONTEXT_PREFIX) : null;
  return match ? joinedChannel(match[1]) : null;
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
