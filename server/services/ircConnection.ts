// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import IRC, { ircLineParser } from 'irc-framework';
import type { Client as IrcClient, ConnectOptions } from 'irc-framework';
import {
  insertMessage,
  hasMessageForTarget,
  hasConversationForTarget,
  hasMessageWithMsgid,
  hasRecentMessageLike,
} from '../db/messages.js';
import { renameBuffer as renameDmBuffer } from '../db/renameBuffer.js';
import { refoldNetworkBuffers } from '../db/refoldBuffers.js';
import { normalizeCasemapping } from '../db/casemapping.js';
import type { Network } from '../db/networks.js';
import {
  isClosed as isBufferClosed,
  getBuffer,
  ensureExists as ensureBufferExists,
  setAutojoin as setBufferAutojoin,
  isAutojoin as isBufferAutojoin,
  setChannelKey as setBufferChannelKey,
  deleteBuffer,
  listOpenDms,
  networkCasemapping,
  foldTarget,
  foldTargetFor,
  kindForTarget,
} from '../db/buffers.js';
import { unfavoriteBuffer } from '../db/favoriteBuffers.js';
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
import connectScheduler from './connectScheduler.js';
import restoreGate from './restoreGate.js';
import type { RestoreSlot } from './restoreGate.js';
import { envInt as reconnectEnvInt } from '../utils/envInt.js';
import { decideStamp } from './insertDecisions.js';
import * as systemLog from './systemLog.js';
import { effectiveSetting, effectiveSettings } from './settingsService.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import { findUserById } from '../db/users.js';
import { isNodeMode } from '../utils/edition.js';
import { deriveIdent } from '../../shared/ident.js';
import { classifyModeChange, modeLetter } from '../../shared/modes.js';
import type { ModeChange } from '../../shared/modes.js';
import { registerIdent, unregisterIdent, isIdentdEnabled, isOidentdFileEnabled } from './identd.js';
import { EngineLink, engineConfigured, engineConnectionId } from './engineLink.js';
import { ENGINE_CLOSE, EngineTransport, engineCloseCode } from './engineTransport.js';
import type { EnginePhase, EnginePhaseInfo } from './engineTransport.js';
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
import { isChannelTarget, CHANNEL_PREFIX_CLASS } from '../../shared/channels.js';

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

/**
 * The manager's policy check, asked before an auto-reconnect opens a socket (#616).
 *
 * Auto-reconnect used to call connect() directly, which walked straight past the
 * two gates every OTHER connect path clears in ircManager.startNetwork: the
 * paused-account check (the linchpin billing hooks into) and the instance network
 * lockdown (#298). It wasn't actively exploitable — suspendUser happens to
 * disconnect() first, which cancels the pending backoff — but that is a
 * coincidence of ordering, not a guarantee, and any future pause path that
 * forgot to disconnect a live connection would have let a transient drop
 * resurrect a connection policy forbids.
 *
 * A callback rather than a manager back-reference: the connection needs to ASK
 * the policy question, not gain the ability to start networks.
 */
export type ReconnectGate = () => { ok: true } | { ok: false; reason: string };

// How many SASL rejections in a row, with no successful registration in
// between, before auto-reconnect gives up (#617).
//
// A COUNT rather than a timer. The obvious discriminator — "did the socket die
// right after the rejection?" — can't actually separate the two cases it needs
// to: #617's scenario (optional SASL, registration stalls, socket times out
// minutes later) and a required-SASL server that holds the socket open and lets
// it time out are the same shape on the wire, so any wall-clock window
// misclassifies one of them. Worse, a window that decides "transient" reproduces
// its own timing on the next attempt, so it re-decides "transient" forever —
// an unbounded failed-login ladder, which is precisely what the give-up flag
// exists to prevent.
//
// A streak has no such failure mode. On an optional-SASL network the retry
// registers unauthenticated and 'registered' resets the count, so #617's
// transient drop recovers; on a network that genuinely refuses the credentials
// nothing ever registers and the count runs out. Worst case is a bounded 3
// attempts spread over the backoff ladder, which is not a hammer.
const MAX_CONSECUTIVE_SASL_FAILURES = 3;

// Replies to the state requests a restore makes for each channel (MODE → 324
// (+329), TOPIC → 331 or 332 (+333)). A real join is volunteered these; a
// synthesised one has to ask, and the server-buffer renderer would print each
// answer as a line of history on every app restart. Kept quiet per channel for a
// short window after the restore — see RESTORE_QUIET_MS.
const RESTORE_QUIET_NUMERICS = new Set(['221', '324', '329', '331', '332', '333']);
const RESTORE_QUIET_MS = 10_000;
// The per-channel state requests after a restore go out one channel at a time,
// and the next channel waits for this one's replies (drainRestoreQueue). This
// deadline is the fallback for a reply that never comes — a server that skips
// a numeric, or a channel the engine still counts us in and the server does
// not — so one silent channel costs one wait, not the whole restore.
// LURKER_RESTORE_STEP_DEADLINE_MS overrides it, read per step, so a test of the
// fallback does not have to sit through it.
const RESTORE_STEP_DEADLINE_MS = 10_000;
// The terminal reply of each request a restore step makes. Indexed by an
// arbitrary numeric, so the value is `| undefined` — that is what makes the
// `if (!reply) return` guard in noteRestoreReply type-honest for the numerics
// that are not in the map (e.g. the 329 that follows 324).
type RestoreReply = 'names' | 'topic' | 'mode';
const RESTORE_REPLY_OF: Record<string, RestoreReply | undefined> = {
  '366': 'names', // RPL_ENDOFNAMES
  '331': 'topic', // RPL_NOTOPIC
  '332': 'topic', // RPL_TOPIC
  '324': 'mode', // RPL_CHANNELMODEIS
};
// On a restore, a channel with MORE than this many members does not get the
// eager away-sync WHO (see the 'userlist' handler). That WHO's reply is one
// verbose 352 line PER MEMBER — the heaviest thing a restore does, and what a
// big-channel reconnect turns into an [event-loop] stall — while NAMES packs
// many nicks per 353 line. In a channel this large per-member away dots matter
// least, and away-notify keeps active members' state live regardless; the only
// loss is that a member who was silently away before the reconnect reads as
// present until they next move. Read live (LURKER_RESTORE_WHO_MAX_MEMBERS; 0
// disables the restore WHO entirely). NOT a functional cap — a user /who and
// every fresh interactive join still WHO in full; this only trims the eager
// sync on the reconnect burst.
const RESTORE_WHO_MAX_MEMBERS = 500;
// How long a link-loss re-attach waits for the engine to say what it holds
// before treating the session as gone and taking the ordinary reconnect ladder.
const ENGINE_REATTACH_WAIT_MS = 10_000;
// System-buffer line for a shutdown detach, in place of "Disconnected" — which
// is exactly what did not happen.
const DETACHED_LOG = 'Detached — the engine is keeping this connection open for the next start';

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
// Auto-reconnect policy (see IrcConnection.scheduleReconnectIfWarranted)
// ---------------------------------------------------------------------------
// We own the reconnect policy rather than irc-framework's built-in, which only
// retries a connection that was healthy for >5s AND died cleanly, ~3 times —
// so an initial-connect failure, a registration timeout, or a sustained outage
// each got zero or near-zero retries and left the user silently offline until a
// manual reconnect (#236's connectScheduler comment flagged exactly this gap).
// The policy here: retry indefinitely with exponential backoff for ANY drop,
// EXCEPT a confidently-classified terminal reason (a detected ban or a hard SASL
// auth failure), where retrying can't help and hammering an actively-rejecting
// server is antisocial — those stop and require a manual reconnect.

// First-retry delay; each subsequent attempt doubles up to the cap.
const RECONNECT_BASE_MS = reconnectEnvInt('LURKER_RECONNECT_BASE_MS', 2000);
// Ceiling on the backoff interval — a long outage keeps retrying at this cadence
// forever rather than giving up (5 min mirrors irc-framework's own max_wait).
const RECONNECT_MAX_MS = reconnectEnvInt('LURKER_RECONNECT_MAX_MS', 300_000);
// Random extra wait added to each backoff so a fleet-wide outage recovery doesn't
// reconverge every connection on the same instant (the connectScheduler spaces
// same-host launches on top of this, but the jitter de-syncs the herd first).
const RECONNECT_JITTER_MS = reconnectEnvInt('LURKER_RECONNECT_JITTER_MS', 3000);

// Floor for the computed backoff. reconnectEnvInt accepts 0 (a legit "disable
// jitter" value), so a misconfigured base of 0 with jitter off would otherwise
// yield a 0ms delay — a tight reconnect loop that hammers the server and spins
// the event loop. 1s is also the smallest interval the "Reconnecting in Ns"
// notice can honestly display (it rounds to whole seconds, min 1).
const RECONNECT_MIN_MS = 1000;

// Exponential backoff for the Nth reconnect attempt (0-indexed): base·2^n,
// capped, plus jitter, then floored. attempt is clamped so 2^n can't overflow on
// a very long outage — past the cap the doubling is moot anyway.
function reconnectBackoffMs(attempt: number): number {
  const capped = Math.min(attempt, 20);
  const grown = RECONNECT_BASE_MS * Math.pow(2, capped);
  const jitter = RECONNECT_JITTER_MS > 0 ? Math.floor(Math.random() * RECONNECT_JITTER_MS) : 0;
  return Math.max(RECONNECT_MIN_MS, Math.min(grown, RECONNECT_MAX_MS) + jitter);
}

// Conservative, high-confidence match for a server disconnect that won't heal on
// retry: an oper/server ban (K/G/Z/D-line) or an explicit "you are banned". Kept
// narrow on purpose — anything NOT matched here (timeouts, refused, TLS blips,
// netsplits, generic drops) is treated as transient and retried forever. The
// text is the trailing param of a server ERROR / "Closing Link" line. Channel-
// scoped bans (474 ERR_BANNEDFROMCHAN) never reach this — they carry a channel
// and are routed inline, not treated as a connection-terminal event.
function classifyServerBan(reason: string | undefined): string | null {
  if (!reason) return null;
  if (/\b[kgzd][-\s]?lined?\b/i.test(reason)) return reason;
  if (/\byou(?:'re| are)\s+banned\b/i.test(reason)) return reason;
  if (/\bbanned\s+from\s+(?:this\s+)?(?:server|network)\b/i.test(reason)) return reason;
  return null;
}

// SASL failure reasons that mean the credentials themselves are wrong or the
// account is locked — a retry with the same stored password is pointless. Other
// SASL reasons (unsupported_mechanism, capability_missing) are server/config
// mismatches that also won't self-heal, so they're terminal too; only a clean
// abort is left to the normal transient path. irc-framework's reasons:
// fail | nick_locked | unsupported_mechanism | capability_missing | too_long | aborted.
function isTerminalSaslFailure(reason: string | undefined): boolean {
  return reason != null && reason !== 'aborted';
}

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

// irc-framework hands us `{mode, param}`; we add `kind` before publishing (see
// the `mode` handler), so the stored row carries the classification the clients
// can't compute for themselves.
type ModeEntry = ModeChange;

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
  /** buffers(id) the persisted row landed in — the wire's stable buffer key. */
  bufferId?: number;
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
  return !isChannelTarget(target) && !target.startsWith(':server:');
}

// Persisted timestamps prefer IRCv3 server-time (#450): irc-framework parses
// the @time= tag into an epoch-ms NUMBER on the raw event; handlers thread it
// through as `time` and this normalizes to canonical ISO-Z. Only that form may
// ever be stored — loadHistoryWindow / listBuffersForNetwork compare the TEXT
// column lexicographically, so a raw number (or an offset-timezone string)
// would corrupt window selection and buffer ordering. Missing/unparseable
// falls back to receive time. Far-FUTURE stamps also fall back (a skewed
// server must not pin MAX(time) buffer ordering); far-past stamps are kept —
// that's legitimate bouncer/ZNC replay. References mostly trust the tag
// as-is; the clamp is a deliberate Lurker deviation and degrades gracefully
// (a wholly-skewed server just gets receive time, i.e. pre-#450 behavior).
const MAX_FUTURE_TIME_SKEW_MS = 2 * 60_000;

// Echo-correlation bounds for sentCiphertext (see noteSentCiphertext): 30s
// mirrors the bouncer's pendingEcho prune window — an echo slower than that
// is pathological — and the cap bounds a hostile/broken flood.
const SENT_CIPHERTEXT_TTL_MS = 30_000;
const SENT_CIPHERTEXT_MAX = 500;
function normalizeEventTime(t: unknown): string {
  let ms: number | undefined;
  if (typeof t === 'number' && Number.isFinite(t)) ms = t;
  else if (typeof t === 'string' && t) {
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  if (ms === undefined || ms - Date.now() > MAX_FUTURE_TIME_SKEW_MS) {
    return new Date().toISOString();
  }
  return new Date(ms).toISOString();
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

// Why a nick is on the presence watch list. Only 'dm' today; the reason set is
// reference-counted (see IrcConnection.trackedPeers) so a future second reason
// (e.g. favorites) shares the MONITOR watch + peer_presence_state row.
type TrackReason = 'dm';

interface PeerWatch {
  reasons: Set<TrackReason>;
}

export class IrcConnection {
  network: Network;
  onEvent: (event: EnrichedEvent) => void;
  client: IrcClient;
  state: string;
  channels: Map<string, ChannelState>;
  /** Lazily-built per-network-folded index over `channels` for
   *  isChannelJoined. null = rebuild on next probe. MUST be nulled by every
   *  channels-map mutation and by a CASEMAPPING change (the folds move). */
  joinedFoldedCache: Set<string> | null;
  // Join keys awaiting their echo, keyed by lowercased channel. Nothing is
  // persisted on a join REQUEST (the buffers row is echo-written), so the key
  // rides here until the join lands; a forward (470) discards it. Lost on a
  // process restart mid-join — the user just re-/joins with the key.
  private pendingJoinKeys = new Map<string, string>();
  userModes: Set<string>;
  awayState: AwayState;
  // One presence watch list keyed by lowercased nick. Each entry records WHY
  // we're watching it. The MONITOR watch and the shared peer_presence_state row
  // are reference-counted against those reasons — added when the first reason
  // appears, torn down only when the last one is released. Hydrated on
  // 'registered' and kept live via trackDmPeer + untrackDmPeer.
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
  // RPL_LOGGEDIN (900) seen on this connection — the server considers us
  // identified to services. Only used to decide whether a join rejection is
  // durable (see stopAutojoining); the send-permission logic re-probes instead
  // of consulting a flag.
  identifiedToServices: boolean;
  // Last time the user sent a real PRIVMSG/NOTICE/ACTION to a target (lowercase
  // key → epoch ms). Lets the send-rejection handler tell an actual failed
  // message (surface it inline) from an automated TAGMSG/typing bounce (stay
  // silent) — the rejection numeric doesn't say which command it refused (#283).
  //
  // `conversational` separates the sends that ARE a conversation with the
  // target from a CTCP probe, which is also a real user-initiated PRIVMSG but
  // reports its outcome back to the buffer it was issued from. Both count for
  // the rejection handler; only the former may open a DM buffer (#817).
  lastUserSendAt: Map<string, { at: number; conversational: boolean }>;
  // nick → the user's last raw COMMAND naming them, for placing a 401 (#434):
  // what went out through raw() — /whois, /kick #c nick, and a /raw PRIVMSG or
  // NOTICE counts too. A null channel means the command was a direct one (a
  // whois), or a channel command that a later DM send superseded: noteUserSend
  // nulls the channel here but records nothing of its own, because the say /
  // notice / ctcp verbs never pass through raw(). `seq` orders the command
  // against outstanding CTCP requests, see takeCtcpIssuer.
  lastNickIntent = new Map<string, { channel: string | null; at: number; seq: number }>();
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
  // Tags from a `draft/multiline` BATCH *start* line, keyed by batch reference.
  // The spec puts the logical message's msgid/@time on the BATCH +ref line, but
  // irc-framework reduces the batch to {id,type,params} and DISCARDS the start
  // line's tags — so the raw handler stashes them here and accumulateMultiline
  // grafts them onto the first fragment. Consumed on first fragment; cleared on
  // socket close with multilineBatches so an unopened batch can't leak.
  multilineBatchTags: Map<string, { time?: string; msgid?: string }>;
  // Exact ciphertext lines we recently put on the wire for E2E sends, so the
  // echo-message reflection of our OWN ciphertext is recognized by content —
  // not by re-checking channel E2E state at echo time, which races /e2e off
  // (state can flip in the send→echo RTT window and the optimistic plaintext
  // row already exists either way). TTL-pruned; consumed on match.
  sentCiphertext: Array<{ line: string; at: number }>;
  // Consecutive-adoption dedupe for our own msgid: a PRIVMSG to your OWN nick
  // arrives twice under echo-message (delivery copy + echo copy — ergo and
  // solanum both send both, with the same msgid), and both pass the self
  // check. The msgid index is deliberately non-unique, so dedupe here.
  lastAdoptedSelfMsgid: string | null;
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
  ctcpOutstanding: Map<string, Array<{ issuingTarget: string; sentAt: number; seq: number }>>;
  // One counter orders every move on a nick — CTCP requests and raw commands —
  // for takeCtcpIssuer's "which came last" rule. A sequence, not the wall
  // clock: two moves can share a millisecond (a scripted client's frames land
  // in one chunk and wsHub dispatches them in one tick), and a clock can step
  // backwards. It fixes ORDER only. `sentAt`/`at` stay for the attribution and
  // TTL windows, which are still Date.now() deltas — a backward step stretches
  // those, as it always did; it just can no longer reorder anything.
  moveSeq = 0;
  // The raw 001–005 registration burst as the server sent it, captured by the
  // 'raw' handler (reset on each 001). The bouncer replays these verbatim
  // (nick-rewritten) to IRC clients that attach mid-session, so they see the
  // network's real ISUPPORT tokens instead of a synthesized approximation.
  registrationLines: string[];
  // Auto-reconnect controller (we own the policy; irc-framework's auto_reconnect
  // is disabled in connect()). See scheduleReconnectIfWarranted.
  //
  // reconnectTimer: pending backoff timer, cleared on connect/dispose/intentional
  //   stop so we never re-open a socket the caller just tore down.
  // reconnectAttempt: monotonic backoff counter, reset to 0 on 'registered'.
  // intentionalDisconnect: the user/system asked us to disconnect (stopNetwork,
  //   dispose, pause) — the 'close' handler must NOT reconnect over their intent.
  // terminalDisconnect: a classified give-up reason (detected ban / hard SASL
  //   auth failure). Non-null = stop retrying and require a manual reconnect; the
  //   string is the human-readable cause shown in the "not reconnecting" notice.
  // pendingSaslFailure: a SASL rejection that has NOT yet been proven fatal (#617).
  //   See the 'sasl failed' handler for why it can't be terminal on sight.
  // pendingServerBan: a ban-classified ERROR that has NOT yet been proven fatal
  //   (#651) — see maybePromoteServerBan for the promote/discard rule.
  // reconnectGate: the manager's policy check, consulted before each retry opens a
  //   socket (#616). Absent = no gate (tests, and any caller that builds a
  //   connection directly).
  private reconnectTimer: ReturnType<typeof setTimeout> | null;
  private reconnectAttempt: number;
  private intentionalDisconnect: boolean;
  private terminalDisconnect: string | null;
  private pendingSaslFailure: string | null;
  private pendingServerBan: string | null;
  // Consecutive SASL rejections with no successful registration between them.
  // Deliberately NOT reset by connect(): it has to survive the retry ladder, or
  // it could never run out. Only 'registered' clears it.
  private saslFailureStreak: number;
  private readonly reconnectGate: ReconnectGate | undefined;
  // Engine mode: a newer process took this connection over. The manager drops
  // us from its map so a later /connect builds a fresh IrcConnection instead of
  // finding this corpse and doing nothing.
  private readonly onTakenOver: (() => void) | undefined;
  // Engine mode (services/engineTransport.ts): the IRC socket lives in the
  // engine process and this Client is attached to it over a link.
  //
  // restoring: true while a re-attach replays the recorded session into this
  //   fresh Client. publish() drops anything that would persist (the burst's
  //   MOTD, the "Connected as" notice, the synthesised own-JOIN rows), and the
  //   'registered' handler skips the side effects only a real connect wants.
  // engineTransport: the live transport, for detach() at shutdown.
  // engineSocketAlive: set by 'socket close' when what closed was the LINK
  //   (or a takeover), not the IRC socket — 'close' then re-attaches instead of
  //   running the disconnect path.
  restoring: boolean;
  // True from the engine's `attached` until its `live`: the backlog it held
  // while we were away is being delivered. Hand-over is at-least-once — a line
  // the previous process persisted but had not acked comes again — so in this
  // window a msgid we already have is skipped rather than written twice.
  catchingUp: boolean;
  // The engine finished registering this socket with no app attached (the
  // previous one died between NICK/USER and 001): nothing ever ran the
  // post-registration steps, so the restore runs them.
  restoreUnattended: boolean;
  private restoredCallbacks: Array<() => void>;
  private restoreQueue: string[];
  private restoreTimer: ReturnType<typeof setTimeout> | null;
  // The restore step in flight: the folded channel and which of its replies
  // are still owed. Null between steps and outside a restore.
  private restoreStep: { key: string; owed: Set<RestoreReply> } | null;
  // The step's turn at the process-wide cap (restoreGate): reserved when the
  // step is queued, held while its requests are out, given back with the step.
  // Null between steps and outside a restore, like restoreStep.
  private restoreSlot: RestoreSlot | null;
  private engineTransport: EngineTransport | null;
  private engineSocketAlive: boolean;
  // folded channel → the state replies still owed from the restore's own
  // requests (MODE → 324/329, TOPIC → 331/332/333; '*' → our umode 221), kept
  // out of the server buffer until they arrive or the deadline passes.
  private restoreQuiet: Map<string, { until: number; mode: boolean; topic: boolean }>;
  // Folded channel keys whose NAMES this connection has heard since it last
  // connected or attached — the one fact membersPending reads.
  private namesHeard: Set<string>;

  constructor({
    network,
    onEvent,
    reconnectGate,
    onTakenOver,
  }: {
    network: Network;
    onEvent: (event: EnrichedEvent) => void;
    reconnectGate?: ReconnectGate;
    onTakenOver?: () => void;
  }) {
    this.network = network;
    this.onEvent = onEvent;
    this.reconnectGate = reconnectGate;
    this.onTakenOver = onTakenOver;
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
    // peers away/back tracking, not just online/offline — the
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
    this.joinedFoldedCache = null;
    this.userModes = new Set();
    this.awayState = { active: false, message: null, since: null, autoSet: false, backAt: null };
    // Lowercase nicks we watch for presence, each tagged with why. Gates the
    // per-peer presence writes so we don't churn the DB (and the WS broadcast
    // stream) on every JOIN/QUIT for an unrelated user on a busy network.
    // Hydrated on 'registered' from open DM buffers, and grown as new DM
    // activity arrives.
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
    this.identifiedToServices = false;
    this.unsendableTargets = new Set();
    this.lastUserSendAt = new Map();
    this.autoWhoTargets = new Set();
    this.multilineBatches = new Map();
    this.multilineBatchTags = new Map();
    this.sentCiphertext = [];
    this.lastAdoptedSelfMsgid = null;
    this.ctcpLimiter = new RateLimiter();
    this.ctcpOutstanding = new Map();
    this.registrationLines = [];
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.intentionalDisconnect = false;
    this.terminalDisconnect = null;
    this.pendingSaslFailure = null;
    this.pendingServerBan = null;
    this.saslFailureStreak = 0;
    this.restoring = false;
    this.catchingUp = false;
    this.restoreUnattended = false;
    this.restoredCallbacks = [];
    this.restoreQueue = [];
    this.restoreTimer = null;
    this.restoreStep = null;
    this.restoreSlot = null;
    this.engineTransport = null;
    this.engineSocketAlive = false;
    this.restoreQuiet = new Map();
    this.namesHeard = new Set();
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
    // A replayed session is not new history: nothing it would persist is
    // wanted, while the control events (state, channel-joined, own-nick) are
    // exactly what a re-attached process needs.
    if (this.restoring && this.shouldPersist(event)) return;
    if (this.catchingUp && this.shouldPersist(event) && this.alreadyPersisted(event)) return;
    event = this.normalizeChannelTarget(event);
    const time = normalizeEventTime(event.time);
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
      const { id, alt, bufferId } = insertMessage({
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
        msgid: event.msgid as string | undefined,
      });
      enriched.id = id;
      enriched.alt = alt;
      // The buffer the row landed in — the wire's stable identity for the
      // buffer (schema 17); rides every persisted `irc` frame.
      enriched.bufferId = bufferId;
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
      time: normalizeEventTime(event.time),
    });
  }

  // `opts.log`: false skips the system-buffer line for this transition (the
  // state event still goes to clients); a string replaces its text. Neither
  // reaches the wire.
  setState(
    state: string,
    extra: Record<string, unknown> = {},
    opts: { log?: boolean | string } = {},
  ): void {
    const changed = this.state !== state;
    this.state = state;
    this.publish({ type: 'state', state, ...extra });
    if (opts.log === false) return;
    if (typeof opts.log === 'string') {
      if (changed) this.logNet(opts.log, 'info');
      return;
    }
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
      // A ban-classified ERROR is only believed if it's the link's LAST line
      // (#651). Every server line passes through here, and for the ban line
      // itself raw fires BEFORE the parsed 'irc error' sets the flag
      // (connection.js emits raw, then message) — so a set flag seen here
      // means a LATER line arrived, the link survived, and the "ban" was
      // noise. Ordering-based, so it needs no freshness window and is immune
      // to event-loop stalls and wall-clock steps.
      if (this.pendingServerBan != null) this.pendingServerBan = null;
      let msg;
      try {
        msg = ircLineParser(event.line);
      } catch (_) {
        return;
      }
      const rawCommand = (msg?.command || '').toString();
      // draft/multiline BATCH start: the logical message's msgid/@time ride
      // THIS line per the spec, and irc-framework drops them when it reduces
      // the batch to {id,type,params} — stash them for accumulateMultiline.
      // Bounded: consumed by the first fragment, cleared on socket close, and
      // capped so a server opening batches it never populates can't grow it.
      if (rawCommand === 'BATCH' && msg?.params?.[0]?.startsWith('+')) {
        if (msg.params[1] === 'draft/multiline') {
          const tags = (msg.tags ?? {}) as Record<string, string>;
          const time = tags.time || undefined;
          const msgid = tags.msgid || tags['draft/msgid'] || undefined;
          if (time || msgid) {
            if (this.multilineBatchTags.size >= 100) this.multilineBatchTags.clear();
            this.multilineBatchTags.set(msg.params[0].slice(1), { time, msgid });
          }
        }
      }
      // Capture the registration burst for bouncer attach-time replay. 001
      // starts a fresh burst (each (re)registration replaces the last), and
      // the follow-on 002–005 lines are only appended once a burst has begun
      // so a stray mid-session numeric can't graft onto a stale burst. The
      // raw line keeps its trailing CR; strip it so replay consumers get a
      // clean single-line payload.
      // CASEMAPPING capture (#707) reads the RAW 005 tokens, NOT
      // client.network.options: irc-framework pre-seeds options.CASEMAPPING
      // to 'rfc1459' in its NetworkInfo constructor, so through the options
      // bag "the server declared rfc1459" and "the server declared nothing"
      // are indistinguishable — and storing the framework default would
      // trigger a destructive registry merge on servers that declared
      // something else on a later 005 line, or nothing at all. A token seen
      // here is a declaration by construction.
      if (rawCommand === '005') {
        for (const param of msg?.params ?? []) {
          if (typeof param === 'string' && param.startsWith('CASEMAPPING=')) {
            this.adoptDeclaredCasemapping(param.slice('CASEMAPPING='.length));
          }
        }
      }
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
      // Command-result errors (a failed kick / invite / mode / topic) name the
      // channel they concern, so surface them in that buffer instead of leaving
      // the user to find them in the server buffer (#434). Read off the raw
      // params rather than the parsed 'irc error' event, which mis-maps some of
      // these — see COMMAND_RESULT_ERRORS. Additive: the raw line still goes to
      // the server buffer below, the same way a join rejection does.
      //
      // channelState answers both questions at once — are we in it, and what do
      // we call it — through ONE equivalence relation. Asking isChannelJoined
      // and then letting publish() canonicalize would use two: membership folds
      // through the server's CASEMAPPING, publish()'s canonicalizer is a plain
      // toLowerCase. On an rfc1459 network (where [ \ ] ^ fold to { | } ~) a 482
      // naming #news{dev} while we're joined as #news[dev] would pass the
      // membership test and then publish a target no buffer is keyed by.
      const cmdError = commandResultError(rawCommand, msg?.params ?? []);
      const cmdErrorChannel = cmdError ? this.channelState(cmdError.channel) : undefined;
      if (cmdError && cmdErrorChannel) {
        this.publish({
          type: 'error',
          target: cmdErrorChannel.name,
          text: cmdError.text,
          raw: { command: rawCommand, params: msg?.params ?? [] },
        });
      }
      // A reply to the restore step in flight is what releases the next
      // channel's requests. Before the denylist: 366 is exactly the kind of
      // line the server buffer never shows.
      this.noteRestoreReply(rawCommand, msg?.params?.[1]);
      if (isServerBufferDeniedNumeric(rawCommand)) return;
      if (
        RESTORE_QUIET_NUMERICS.has(rawCommand) &&
        this.isRestoreQuiet(rawCommand, rawCommand === '221' ? '*' : msg?.params?.[1])
      ) {
        return;
      }
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
      // These numerics arrive as [nick, <target>, reason] — usually a channel,
      // but see the nick case below.
      const channel = typeof params[1] === 'string' ? params[1] : '';
      const reason = params[params.length - 1] || null;
      // ERR_NEEDREGGEDNICK (477) to a channel we're already in is a speak
      // rejection, not a join failure — surface it inline in that channel so
      // the user sees why their message didn't land, instead of a misleading
      // "Couldn't join" toast (#283). publish() canonicalizes the channel case.
      if (channel && isOverloadedSpeakRejection(command, this.isChannelJoined(channel))) {
        this.handleSendRejection(channel, reason, { command, params });
        return;
      }
      // ⚠ 477 has a THIRD meaning, found by QA against ergo 2.18 (#821): a DM
      // refused because the recipient takes messages only from registered users
      // (+R) answers 477 naming the NICK, where 531 might be expected. Nothing
      // can be joined that isn't a channel, so a 477 whose target is a nick
      // cannot be a join failure at all — it is a send rejection, and routing it
      // as one is what puts it in the DM (or, for a /ctcp, back in the buffer the
      // command came from) instead of raising "This channel requires a registered
      // nickname" as a join toast against a person.
      if (channel && !isChannelTarget(channel) && joinRejectionMessage(command)) {
        this.handleSendRejection(channel, reason, { command, params });
        return;
      }
      // Channel-join rejections irc-framework doesn't model (476/477) arrive
      // here too. Route them to the channel as an ephemeral toast so the failure
      // surfaces where the user tried to join, not buried in the server buffer
      // (#260). The client never opened the buffer (it waits for channel-joined),
      // so this is toast-only — the raw line is still logged to the server buffer
      // by the 'raw' handler, which is the additive authentic record.
      // Gated on the target really being a channel: a join rejection names one by
      // definition, and the branch above has already claimed the nick-targeted
      // 477. Without the gate this is what aimed a "couldn't join" toast at a DM.
      const joinMsg = joinRejectionMessage(command);
      if (joinMsg && channel && isChannelTarget(channel)) {
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
      // Also the gate stopAutojoining waits on: account-based channel access
      // (+I/+e $a:) only starts matching once the server considers us
      // identified, so a join rejection before this point says nothing durable.
      this.identifiedToServices = true;
      this.unsendableTargets.clear();
    });

    // SASL authentication failed (ERR_SASLFAIL 904 / 905, or a mechanism/account
    // problem). The stored credentials won't start working on their own, and a
    // network that requires SASL then drops the connection — so classify this as
    // terminal (unless it's a clean abort). The flag is CONSUMED at 'close':
    // whether it actually causes a disconnect is up to the server, but if the
    // socket does die we must not reconnect-loop into the same rejection (which
    // on a server that requires auth is a fast failed-login hammer). We don't
    // publish here — the server's own error/ERROR line surfaces the cause.
    c.on('sasl failed', (event: Record<string, unknown>) => {
      const reason = (event?.reason as string | undefined) || undefined;
      if (isTerminalSaslFailure(reason)) {
        // PENDING, not terminal on sight (#617). On a network where SASL is
        // optional the server does not drop us for a failed auth, so the flag
        // used to sit there until 'registered' cleared it — and if registration
        // then stalled and the socket timed out FIRST, that unrelated transient
        // drop inherited the flag and killed auto-reconnect permanently.
        // Promoted to terminal at 'close' once the streak runs out; see
        // maybePromoteSaslFailure.
        this.saslFailureStreak += 1;
        // Which credential to go and look at depends on which one was offered:
        // under EXTERNAL there is no password to check, and the fix is at
        // NickServ, where the fingerprint has to be registered before the
        // network will recognise it. (#459)
        const usingCert = !!this.network.client_cert && !this.network.sasl_password;
        const advice = usingCert
          ? " — the network didn't recognise your client certificate. Register its fingerprint with /msg NickServ CERT ADD while connected"
          : " — check the network's account credentials";
        this.pendingSaslFailure = `SASL authentication failed${
          reason && reason !== 'fail' ? ` (${reason})` : ''
        }${advice}`;
      }
    });

    c.on('registered', (event: Record<string, unknown>) => {
      this.userModes.clear();
      this.lagMs = null;
      // A full, registered connection is the only signal that the network is
      // genuinely reachable again — reset the backoff so a later drop starts a
      // fresh, fast retry ladder instead of inheriting a long prior interval.
      this.reconnectAttempt = 0;
      // Clear any terminal classification too: if a SASL failure or a ban-looking
      // error was flagged but we registered anyway (e.g. the server didn't drop
      // us for it), it clearly wasn't fatal — a later transient drop must still
      // auto-reconnect rather than inherit a stale give-up flag.
      this.terminalDisconnect = null;
      this.pendingSaslFailure = null;
      this.pendingServerBan = null;
      // Registering is the proof the credentials aren't fatal here (the network's
      // SASL is optional, or they started working) — so the streak starts over.
      this.saslFailureStreak = 0;
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
          // don't seed it into MONITOR or it consumes presence slots and shows
          // a bogus presence dot for a service. Seed actual conversations AND
          // empty just-opened DMs (same intent test as probePresence), so a
          // reconnect doesn't strand a fresh query's presence dot.
          if (
            !hasConversationForTarget(this.network.id, buf.target) &&
            hasMessageForTarget(this.network.id, buf.target)
          ) {
            continue;
          }
          this.addPeerReason(buf.target.toLowerCase(), 'dm');
        }
        this.sweepUntrackedPresenceRows();
      } catch (e) {
        console.warn('[presence] hydrate failed:', (e as Error)?.message || e);
      }
      // On a restore the 001 being replayed carries the nick the socket
      // REGISTERED with, which the NICK line right behind it may change; the
      // engine hook already logged "Re-attached … as <live nick>", so this
      // transition goes to clients only.
      this.setState('connected', { nick: registeredNick }, { log: !this.restoring });
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
      // Not on a restore: the socket already carries the away state (this
      // process set it before it went away), and the 306 the re-assert draws
      // would land as a server-buffer row on every restart.
      if (this.awayState.active && this.awayState.message && !this.restoring) {
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
      // Not on a re-attach: the socket already ran them (NickServ is already
      // satisfied, and a WAIT-delayed JOIN would join what we are in).
      if (!this.restoring) this.runConnectCommands();
    });
    c.on('close', () => {
      // Final safety net (clean disconnect/dispose may not always emit
      // 'socket close'); unregisterIdent is idempotent.
      unregisterIdent(this.identdId);
      this.identdId = null;
      this.userModes.clear();
      this.autoWhoTargets.clear();
      this.multilineBatches.clear();
      this.multilineBatchTags.clear();
      // Echo-correlation state is per-socket: no echo can arrive for a line
      // sent on the dead socket.
      this.sentCiphertext.length = 0;
      this.lastAdoptedSelfMsgid = null;
      // CTCP routing/limit state is per-socket: a stale outstanding entry would
      // mis-route a same-type reply on the new socket, and a drained limiter
      // would drop the new socket's first probes. Reset both (#263).
      this.ctcpOutstanding.clear();
      this.ctcpLimiter = new RateLimiter();
      this.stopLagPinger();
      this.cancelPendingConnectCommands();
      this.resetRestoreState();
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
      if (this.engineSocketAlive) {
        // The IRC socket is alive in the engine; only our side ended. Go
        // straight back to CONNECT (the engine answers ATTACH if it still holds
        // the socket, and dials if it doesn't — the normal handlers take either)
        // unless this was a takeover, which is someone else's connection now.
        this.engineSocketAlive = false;
        this.reattachSoon();
        return;
      }
      this.markAllPeersOffline();
      this.setState('disconnected');
      // Decide, now that we know WHEN the socket died, whether a SASL rejection
      // (#617) or a ban-classified ERROR (#651) earlier in this connection is
      // what killed it.
      this.maybePromoteSaslFailure();
      this.maybePromoteServerBan();
      // 'close' is now the single terminal socket-death event (irc-framework's
      // auto_reconnect is disabled, so it no longer retries internally): decide
      // here whether to schedule our own backoff retry. Runs after the state/
      // presence cleanup above so a reconnect starts from a swept slate.
      this.scheduleReconnectIfWarranted();
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
      if (!this.restoring) {
        this.logNet(`MONITOR (IRCv3 presence) supported, watch limit ${limit}`);
      }
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
            `Seeding MONITOR with ${seedCount} nick${seedCount === 1 ? '' : 's'} (DM peers)`,
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
      const engineCode = engineCloseCode(err);
      if (
        engineCode === ENGINE_CLOSE.LINK_LOST ||
        engineCode === ENGINE_CLOSE.TAKEN_OVER ||
        engineCode === ENGINE_CLOSE.DETACHED
      ) {
        // Not the IRC socket. Our link to the engine dropped (the socket is
        // still held; 'close' re-attaches), a newer app process claimed the
        // connection (it lives on, elsewhere), or we let go on purpose at
        // shutdown (the next process picks it up). Nothing about the network
        // changed: no presence sweep — which would fire a "came online" push
        // for every favorited peer on the next attach — and no error row.
        this.engineSocketAlive = true;
        if (engineCode === ENGINE_CLOSE.TAKEN_OVER) {
          this.intentionalDisconnect = true;
          this.setState('disconnected');
          this.logNet('Another Lurker process took over this connection', 'warn');
          this.onTakenOver?.();
        } else if (engineCode === ENGINE_CLOSE.DETACHED) {
          this.setState('disconnected', {}, { log: DETACHED_LOG });
        } else {
          this.setState('reconnecting');
        }
        return;
      }
      this.setState('disconnected');
      // Our socket to this network just dropped — from our vantage point every
      // peer we track here is now unreachable, so mark them all offline. This is
      // the fix for the "stuck online" gap on networks without MONITOR: if a
      // peer quit while we were disconnected we never saw their QUIT, but our own
      // disconnect is a discontinuity we DO observe, so we stop asserting a stale
      // 'online'. 'socket close' is the hook because it fires first and carries
      // the socket-level error. (Historically it also mattered that 'socket
      // close' fired on auto-reconnect blips while 'close' was terminal; now that
      // Lurker owns reconnect and irc-framework's auto_reconnect is off, BOTH
      // fire on every drop — but 'socket close' remains the right sweep point.)
      // On reconnect the peers we can still observe are re-lit (MONITOR re-seed +
      // WHO-on-join); the rest stay honestly offline. No came-online suppression
      // — a reconnect re-firing "came online" for peers still around is the honest
      // signal, and toasts are already rate-limited.
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
    // The 'reconnecting' state + notice are now emitted by our own controller
    // (scheduleReconnectIfWarranted), not the library: irc-framework's
    // auto_reconnect is disabled, so it never fires a 'reconnecting' event.
    // On an attach the state still transitions (clients need the dot), but
    // "Connecting…" in the system buffer would describe a connect that isn't
    // happening; the manager already said "Attaching…" and the engine hook
    // says "Re-attached" when it lands.
    c.on('connecting', () => this.setState('connecting', {}, { log: !this.engineHoldsUs() }));

    // Diagnostic: irc-framework fires 'ping timeout' when it hasn't seen data
    // from the server for `ping_timeout` seconds (120s default) — then it QUITs
    // (ending the socket with NO socket error, so the disconnect otherwise
    // surfaces as a bare "Disconnected" with no cause) and our controller
    // schedules the reconnect from 'close'. A ping timeout on a
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
        // In engine mode the engine holds the socket and registered the ident
        // when it dialed; this process serves no identd.
        if (engineConfigured()) return;
        // The full 4-tuple identifies the connection to the identd server; the
        // ports alone are ambiguous (see identd.ts). Both addresses and ports
        // are already populated at TCP connect.
        const localPort = socket?.localPort;
        const remotePort = socket?.remotePort;
        if (!localPort || !remotePort) return;
        // The ident comes from the ACCOUNT, not from this network's username or
        // nick — those are the user's to retype at will, and an ident a user can
        // choose can't attribute anything (#643). See shared/ident.ts.
        const account = findUserById(this.network.user_id);
        this.identdId = registerIdent({
          localAddress: socket.localAddress || '',
          localPort,
          remoteAddress: socket.remoteAddress || '',
          remotePort,
          ident: deriveIdent({
            nodeMode: isNodeMode(),
            accountUsername: account?.username || '',
            accountIdent: account?.ident || null,
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
          time: event.time,
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
      const tags = event.tags as Record<string, string> | undefined;
      // IRCv3 server message id (#450) — the future react/reply anchor. Tag
      // keys arrive lowercased; draft/msgid covers pre-ratification servers.
      const msgid = tags?.msgid || tags?.['draft/msgid'] || undefined;
      const targetIsChannel = isChannelTarget(eventTarget);
      const type =
        eventType === 'action' ? 'action' : eventType === 'notice' ? 'notice' : 'message';

      // Self-echoes. Without echo-message, ircManager.send/.action already
      // published the local copy, so a reflection (ergo's always-on relay, some
      // bouncers) would land as a duplicate — drop it, as ever. With the cap
      // ACKed the roles flip: the send path SKIPPED its optimistic publish and
      // this echo IS the message — adopt it as the persisted self row, carrying
      // the server's msgid + @time (the only way our own sends learn their
      // msgid, #450).
      if (eventNick && me && eventNick.toLowerCase() === me.toLowerCase()) {
        if (!this.echoActive()) return;
        if (!eventTarget || typeof eventMessage !== 'string') return;
        // Our own E2E ciphertext coming back: the optimistic PLAINTEXT row
        // (self, e2e) was already published at send time. Recognized by
        // CONTENT (the exact lines ircManager's E2E branch registered when it
        // wired them), not by re-checking channel E2E state — which races
        // /e2e off inside the send→echo RTT window. A literal "+RPE2E01…" the
        // user actually typed was never registered, so it still adopts as
        // ordinary cleartext.
        if (eventMessage.startsWith(WIRE_PREFIX) && this.consumeSentCiphertext(eventMessage)) {
          return;
        }
        // A PRIVMSG to your OWN nick arrives twice under echo-message (the
        // delivery copy AND the echo — ergo and solanum both send both, same
        // msgid). Adopt the first copy, drop the twin.
        if (msgid && msgid === this.lastAdoptedSelfMsgid) return;
        if (msgid) this.lastAdoptedSelfMsgid = msgid;
        // Route by RECIPIENT (event.target), never nick — the echo's nick is
        // us, and keying off it would file every DM under our own nick. DMs
        // fold to the existing buffer row's casing (#289); channel case is
        // normalized inside publish().
        const selfTarget = targetIsChannel ? eventTarget : this.canonicalDmTarget(eventTarget);
        this.publish({
          type,
          target: selfTarget,
          nick: eventNick,
          text: eventMessage,
          kind: eventType,
          self: true,
          userhost: buildUserhost(event),
          time: event.time,
          msgid,
        });
        // Parity with the optimistic path it replaces: no closed-buffer notice
        // mirror, no trackDmPeer/markPeerEvent for ourselves.
        return;
      }
      const isServer = !eventNick;
      const isNotice = eventType === 'notice';

      let target: string;
      if (isServer) target = `:server:${this.network.id}`;
      else if (eventTarget && targetIsChannel) target = eventTarget;
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
        //   - EXCEPTION 2: a notice NOT addressed to our nick and not placeable in a
        //     channel — an oper broadcast (`$$*`), a mask target, a STATUSMSG whose
        //     channel we aren't in — has no DM home, so surface it in the server
        //     buffer rather than fabricating a bogus DM with the sender.
        //     (This used to name `&`/`!`/`+` channels as the example; since #724 they
        //     route as the channels they are and never reach here.)
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
          target = this.canonicalDmTarget(eventNick as string);
        } else {
          target = `:server:${this.network.id}`;
        }
      } else target = eventNick as string;

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
        time: event.time,
        msgid,
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
          // Server time yes, msgid no — the msgid names the REAL copy in the
          // home buffer; a react/reply lookup must never resolve to the mirror.
          time: event.time,
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
      // Under echo-message the server reflects our own CTCP-framed NOTICEs
      // (RPE2E handshake replies, standard CTCP answers) back to us — without
      // this guard our own KEYREQ/KEYRSP would re-enter handleHandshakeBody
      // under our own handle. handleInboundCtcpReply has its own self guard,
      // but the RPE2E branch below ran unguarded.
      if (this.isSelfNick(event.nick as string | undefined)) return;
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
        time: event.time,
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
      if (eventNick === c.user.nick && this.restoring) {
        // A synthesised JOIN from the engine's replay. autojoin is lowered only
        // by a part, a kick or a close (db/buffers.ts) — so a channel the socket
        // is still in whose row says autojoin=0 means the user left it while
        // the app (or its link) was away and the PART never went out. This is
        // that PART, late. Otherwise it is state, not intent: the row's flag
        // stays whatever it was.
        const row = getBuffer(this.network.user_id, this.network.id, eventChannel);
        if (
          row &&
          (!row.autojoin || isBufferClosed(this.network.user_id, this.network.id, eventChannel))
        ) {
          this.channels.delete(eventChannel.toLowerCase());
          try {
            c.raw('PART', eventChannel);
          } catch (_) {
            /* ignore */
          }
          return;
        }
        this.publish({ type: 'channel-joined', target: eventChannel });
        return;
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
          // #707: adopt the WIRE spelling when the row's display name
          // diverges beyond ASCII case — the state a refold merge leaves
          // behind when the surviving twin wasn't the joined spelling
          // ('#chat{dev}' survived on recency, the ircd echoes
          // '#chat[dev]'). Left alone, the id-less control frames
          // (channel-joined, names) fork a message-less ghost buffer
          // client-side, since clients fold without the network rule. Both
          // spellings resolve to this row, so this is renameBuffer's
          // casing-only path: one UPDATE, one announce, clients rekey — and
          // it converges permanently. Plain ASCII case differences (legacy
          // folds equal) keep first-writer-wins display casing, as ever.
          if (
            record.target !== eventChannel &&
            foldTarget(record.target) !== foldTarget(eventChannel)
          ) {
            const adopted = renameDmBuffer(
              this.network.user_id,
              this.network.id,
              record.target,
              eventChannel,
            );
            if (adopted?.renamed && adopted.open) this.announceBufferRenamed(adopted);
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
        time: event.time,
      });
      if (eventNick === c.user.nick) {
        this.channels.delete(eventChannel.toLowerCase());
        this.joinedFoldedCache = null;
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
        time: event.time,
      });
      // Mirror the self-PART path when we ourselves are the one kicked, so
      // the buffer dims in the sidebar instead of staying styled as joined.
      // Lowering autojoin also prevents the reconnect replay — rejoining a
      // channel that just kicked you reads as ban evasion to ops.
      if (eventKicked && c.user.nick && eventKicked.toLowerCase() === c.user.nick.toLowerCase()) {
        this.channels.delete(eventChannel.toLowerCase());
        this.joinedFoldedCache = null;
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
      this.publish({ type: 'invite', target: channel, nick: inviter, invited, time: event.time });
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
      this.publish({ type: 'invite', target: channel, nick: me, invited, time: event.time });
    });

    c.on('quit', (event: Record<string, unknown>) => {
      const eventNick = event.nick as string;
      const lower = eventNick.toLowerCase();
      const userhost = buildUserhost(event);
      const time = event.time;
      for (const ch of this.channels.values()) {
        if (ch.members.delete(lower)) {
          this.publish({
            type: 'quit',
            target: ch.name,
            nick: eventNick,
            text: event.message as string | undefined,
            userhost,
            time,
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
            time: event.time,
          });
        }
      }
      // From a DM-buffer perspective: the old name is no longer reachable
      // (sending to it would 401), and the new name is reachable (if we have
      // a DM with them, or now). Don't fire either side for our own /nick.
      if (!isSelfNick) {
        this.markPeerEvent(eventNick, 'offline');
        this.markPeerEvent(eventNewNick, 'online');
        this.rekeyCtcpOutstanding(eventNick, eventNewNick);
        this.renameDmForNickChange(eventNick, eventNewNick, userhost, event.time);
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
          time: event.time,
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

      if (!target || !isChannelTarget(target)) return;
      const ch = this.channels.get(target.toLowerCase());
      // Apply per-user prefix modes (+o/-o, +v/-v, etc.) to the member map so
      // the snapshot keeps current modes after page reload.
      let memberModesChanged = false;
      let chanModesChanged = false;
      const listModes = this.listModes();
      const prefixModes = this.prefixModes();
      // Classify each change once, up front, and carry the class onto the row we
      // publish. The clients never see ISUPPORT, so this stamp is the only way
      // they can tell op/voice churn from a ban — which is what the event
      // filters need in order to hide the first without hiding the second.
      //
      // Stamped unconditionally, before the `ch` guard: the class is a property
      // of the letters and the server's 005, not of whether we happen to be
      // tracking this channel's members. And it is the SAME call the member
      // branch below now switches on, so a change can never be filtered as one
      // thing and applied as another.
      const stampedModes: ModeEntry[] = eventModes
        .filter((m) => m && m.mode)
        .map((m) => ({ ...m, kind: classifyModeChange(m, prefixModes, listModes) }));
      if (ch) {
        for (const m of stampedModes) {
          const sign = m.mode[0];
          const letter = modeLetter(m.mode);
          // Per-user prefix mode: lands on the member, not on the channel.
          if (m.kind === 'prefix') {
            // classifyModeChange only returns 'prefix' for a change that has a
            // param, so this is a narrowing rather than a second condition.
            const member = ch.members.get(m.param!.toLowerCase());
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
          // (bans/exceptions/quiets) so their masks don't pollute the display —
          // which is exactly what `kind` already says, so read it rather than
          // re-testing listModes and giving the two a chance to drift.
          if (m.kind === 'chan') {
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
        modes: stampedModes,
        time: event.time,
      });
      if (memberModesChanged && ch) {
        this.publishNames(ch);
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
      this.namesHeard.add(foldTargetFor(this.network.id, eventChannel));
      this.publishNames(ch);
      // Issue a WHO so we learn the current away state for everyone in the
      // channel. away-notify keeps it live after this initial sync. Mark it so
      // the 'wholist' handler consumes the reply silently instead of echoing
      // every member to the server buffer (#342).
      //
      // Exception: on a RESTORE, a very large channel's away-sync WHO is skipped
      // (RESTORE_WHO_MAX_MEMBERS) — its 352-per-member reply is the heaviest part
      // of the reconnect burst. restoreQuiet marks exactly the channels
      // drainRestoreQueue just requested, so this never touches a fresh
      // interactive join (which WHOs in full, any size).
      const rq = this.restoreQuiet.get(eventChannel.toLowerCase());
      const inRestore = !!rq && Date.now() < rq.until;
      const whoMax = reconnectEnvInt('LURKER_RESTORE_WHO_MAX_MEMBERS', RESTORE_WHO_MAX_MEMBERS);
      if (inRestore && ch.members.size > whoMax) {
        // Diagnostic only (docker logs), never a server-buffer row: on a big
        // multi-network restore this can fire per channel.
        console.log(
          `[irc] restore: skipped away-sync WHO for ${eventChannel} (${ch.members.size} members > ${whoMax}) ` +
            `on network ${this.network.id}; away-notify keeps it live`,
        );
      } else {
        try {
          c.who(eventChannel);
          // Mark only after a successful send: if c.who() throws, a stale flag
          // would silently suppress a later user-typed /who for this channel.
          this.autoWhoTargets.add(eventChannel.toLowerCase());
        } catch (_) {
          /* ignore */
        }
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
        // Bridge the WHO snapshot to the DM presence rail for tracked peers.
        // away-notify doesn't fire on join, so this is where a peer we
        // share a channel with gets (re-)established — critically on reconnect,
        // where markAllPeersOffline has just forced every tracked peer offline
        // and a DM peer still sitting in a channel we rejoin must be promoted
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
        this.publishNames(ch);
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
    // user-profile modal (issue #92). `error: 'not_found'` surfaces here too so
    // the modal can flip to its empty state.
    //
    // ⚠ It is synthesized at RPL_ENDOFWHOIS when the preceding numerics filled
    // nothing in (irc-framework `handlers/user.js`), NOT at ERR_NOSUCHNICK —
    // that numeric is mapped to a different event entirely (`irc error`, with
    // `error: 'no_such_nick'`) and never touches the whois reply. The two look
    // identical in practice, because a conforming server sends the 401 and then
    // the 318. They differ for anything that waits: a 401 with no 318 following
    // it produces no signal at all. (This comment said ERR_NOSUCHNICK for a
    // year and misled a reviewer into reading the protocol docs as wrong.)
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
      // Classify an oper/server ban (K/G/Z/D-line) so the auto-reconnect
      // controller stops instead of hammering a server that's actively refusing
      // us. Only server-scoped bans qualify: a channel-scoped ban (474) carries a
      // channel param and is routed inline below, so gate on its absence.
      //
      // PENDING, not terminal on sight — the same treatment SASL got in #617
      // (#651). A real ban ERROR is the last thing the server says before it
      // closes the link, so 'close' promotes this; any LATER server line
      // discards it first (the 'raw' handler), because a line after the ERROR
      // proves the link survived whatever the classifier matched — that
      // ban-shaped noise must not lie in wait to be blamed for an unrelated
      // transient drop later. See maybePromoteServerBan.
      const banChannel = event?.channel as string | undefined;
      if (!banChannel) {
        const banned = classifyServerBan(reason);
        if (banned) this.pendingServerBan = `banned by the server (${banned})`;
      }
      // A 401 for a nick we just named in a channel command belongs in that
      // channel, not the server buffer (#434). Checked before the DM fallback
      // below because it is the more specific signal: an explicit command,
      // aimed at a named channel, seconds ago — against "we have DM history
      // with this nick at some point in the past".
      if (tag === 'no_such_nick' && eventNick) {
        // The command's `seq` rides along for the CTCP bucket below: a nick-only
        // command (/whois, /whowas) is not a SEND, so takeCtcpIssuer's "is the
        // CTCP still the last move here" gate — which reads lastUserSendAt —
        // cannot see it on its own. Both maps record moves on a nick; the rule
        // is only true to its own statement if it consults both (Copilot, PR
        // #823).
        const command = this.takeCommandIntent(eventNick);
        const joined = command?.channel ? this.channelState(command.channel) : undefined;
        if (joined) {
          this.publish({
            type: 'error',
            target: joined.name,
            text: `${eventNick} isn't on this network.`,
            raw: event,
          });
          return;
        }
        // A /ctcp to this nick is outstanding, so the failure belongs where the
        // attempt was announced — the exchange already put "→ CTCP VERSION to
        // bob" there, and the reply would have landed there too (#821). Ahead of
        // the DM-miss bucket below on purpose: with DM history the failure used
        // to land in that query instead, splitting one command's visible attempt
        // from its outcome.
        //
        // Ephemeral, via surfaceCtcp, because the rest of the exchange is: the
        // echo and the reply are both transient status. A persisted error row
        // would outlive the echo that gives it meaning and strand "bob isn't on
        // this network." in a channel after a reload.
        const ctcpIssuer = this.takeCtcpIssuer(eventNick, command?.seq ?? null);
        if (ctcpIssuer) {
          this.surfaceCtcp(ctcpIssuer, `${eventNick} isn't on this network.`);
          return;
        }
      }
      const isDmMiss = tag === 'no_such_nick' && eventNick && isDmTargetName(eventNick);
      // For ERR_NOSUCHNICK against a nick the user just messaged, or has any DM
      // history with, route the error into that DM buffer so the failure
      // surfaces where they sent the message instead of getting lost in the
      // server buffer. Presence is no longer driven from here — MONITOR is the
      // authority for online/offline state.
      //
      // recentUserSend is checked first, and not just because it's a map read
      // against a DB one. Under echo-message the FIRST message to a nick that
      // doesn't exist has no history to find, by construction: the optimistic
      // publish is skipped (ircManager waits for the server to echo) and the
      // server answers 401 instead of echoing, so no row is ever written. So
      // history alone is blind to precisely the case that needs this most —
      // the first thing you ever say to someone (#817). handleSendRejection
      // already gates the sibling numeric (531) on recentUserSend for the same
      // reason; this brings the two into line.
      //
      // The publish below is what leaves a buffer behind, too: an 'error' row
      // persists, so the query survives a reload instead of vanishing with the
      // optimistic one the client opened.
      //
      // The signal has to stay narrower than "any recent interest in this
      // nick": neither a /whois nor a /ctcp may CONJURE a DM buffer — a whois
      // isn't a message at all, and a ctcp already reports into the buffer it
      // was issued from. So this reads recentConversationalSend (say / action /
      // notice / multiline) rather than recentUserSend, and not lastNickIntent,
      // which a whois writes to.
      //
      // ⚠ "Conjure" is the exact scope. A CTCP miss no longer reaches here at
      // all — the bucket above claims it first and routes it to the buffer the
      // /ctcp was issued from, 401 and 531 alike (#821). What this gate still
      // decides is whether a 401 with no outstanding CTCP may open a NEW query,
      // and the hasMessageForTarget fallback below stays the wider signal for a
      // nick the user already has history with.
      if (
        isDmMiss &&
        (this.recentConversationalSend(eventNick as string) ||
          hasMessageForTarget(this.network.id, eventNick as string))
      ) {
        // Same sentence the channel-routed 401 uses (#815) and the profile
        // modal now uses (#818). It replaces the server's raw `reason`, which
        // on almost every ircd is the literal "No such nick/channel" — one
        // failure the user can meet in three places shouldn't speak ircd in
        // one of them and English in the other two.
        this.publish({
          type: 'error',
          target: eventNick,
          text: `${eventNick} isn't on this network.`,
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
      // A rejection the server will keep giving us: stop replaying the join on
      // every reconnect. Without this an auto-rejoin the ircd always refuses
      // retries forever, and for a channel whose buffer is closed (or was
      // never surfaced — a config-seeded default channel that has not had its
      // first join echo) there is nothing on screen to cancel it: the user
      // sees a rejection scroll past on every connect with no affordance
      // attached to it.
      //
      // ONLY the durable three. 471 (+l full) and 405 (too many channels) are
      // states of the moment, and 477 (needs a registered nick) is the classic
      // race where the rejoin fires before SASL/NickServ identification lands
      // — dropping autojoin on those would quietly unsubscribe people from
      // channels they are perfectly able to join. (477 arrives on a different
      // event entirely, so it is excluded structurally, not just by this map.)
      //
      // Lowering is not destructive: autojoin is raised again by the next join
      // ECHO, so a channel that becomes joinable again is one /join away from
      // being restored. That is what makes acting on a single rejection safe.
      if (rejectChannel && PERMANENT_JOIN_REJECTION_TAGS.has(tag)) {
        this.stopAutojoining(rejectChannel, tag);
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
      // Command-result errors are routed to their channel off the raw line (see
      // the 'raw' handler). The generic line below would be a second copy in the
      // server buffer of what the raw handler already logged verbatim there, so
      // it goes — whether or not the routing found a buffer to use (#434).
      if (isCommandResultErrorTag(tag)) return;
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
      // Case-folded, matching the message handler's self check — under
      // echo-message our own TAGMSGs reflect back, and a server relaying a
      // case-variant nick must not show us our own typing indicator.
      const isSelf = !!eventNick && !!me && eventNick.toLowerCase() === me.toLowerCase();
      if (isSelf) return;
      const tags = event.tags as Record<string, string> | undefined;
      const typing = tags && tags['+typing'];
      if (!typing) return;
      const eventTarget = event.target as string | undefined;
      const targetIsChannel = isChannelTarget(eventTarget);
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
      // wsHub reads this to fire the favorited-DM came-online push; the
      // client computes its own transition for the toast and ignores it.
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
    // should drive a "came online" notification. Kept computed so the
    // favorites-based friend-online push can consume it without re-plumbing.
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
  // Deduped union of the nicks we want MONITORed — every tracked reason shares
  // the one per-connection MONITOR budget.
  monitoredNicks(): string[] {
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

  // A CASEMAPPING token seen on a raw 005 line (#707) — a declaration by
  // construction, never irc-framework's default (see the 'raw' handler). The
  // declared fold is a property of the network ROW, not the socket: stored
  // once, compared per token, and only a CHANGE does real work — a reconnect
  // that re-declares the stored value is one cached compare and out. No
  // latch, deliberately: the stored===declared compare is already idempotent,
  // and a latch would freeze the first token of a burst against a correction
  // on a later line. Unknown values store nothing: the network keeps the
  // legacy fold rather than adopting a rule we can't implement.
  //
  // On a change, db/refoldBuffers stores the mapping and rewrites the
  // registry in ONE transaction (a failed refold leaves the mapping unstored,
  // so the next 005 retries) — drifted folds rewrite silently, rows that now
  // fold together (`#foo[bar]`/`#foo{bar}` under rfc1459) merge, each merge
  // announced like a DM nick-collision. In-memory per-target maps
  // (unsendableTargets & co.) are keyed by the wire name, which a re-fold
  // doesn't change, so they're left alone.
  private adoptDeclaredCasemapping(rawValue: string): void {
    const declared = normalizeCasemapping(rawValue);
    if (!declared) return;
    try {
      const stored = networkCasemapping(this.network.id);
      if (stored === declared) return;
      // Synchronous by design (better-sqlite3), and bounded by the absorbed
      // rows' history sizes: a merge repoints messages wholesale, so a
      // case-twin with a very large history blocks the loop for the
      // duration. Accepted with eyes open — it runs ONCE per network, on the
      // first connect that declares the mapping — and the duration is logged
      // so a slow one is visible rather than a mystery stall.
      const startedAt = Date.now();
      const merges = refoldNetworkBuffers(this.network.user_id, this.network.id, declared);
      this.logNet(
        `CASEMAPPING ${declared}${stored ? ` (was ${stored})` : ''}` +
          (merges.length
            ? `; merged ${merges.length} case-colliding buffer${merges.length === 1 ? '' : 's'}`
            : '') +
          ` (refold ${Date.now() - startedAt}ms)`,
      );
      for (const m of merges) {
        // A closed survivor (both twins were closed) is never announced:
        // clients hold no state for closed buffers, so there is nothing to
        // correct — and a merged frame would make them materialize a sidebar
        // row for a conversation closed everywhere.
        if (m.survivorOpen) {
          this.announceBufferRenamed({
            from: m.absorbedTarget,
            to: m.survivorTarget,
            bufferId: m.survivorId,
            merged: true,
            mergedFromBufferId: m.absorbedId,
            draftChanged: m.draftChanged,
          });
        }
        // A merged DM must hand over its presence watch: the hydration seed
        // ran at 001 (before this 005) against pre-refold rows, so the
        // absorbed spelling holds a MONITOR slot for a registry row that no
        // longer exists — stranded until reconnect, consuming the shared cap.
        // The surviving spelling may never have been seeded at all (a closed
        // survivor absorbed an open twin). Tracked-implies-open: a closed
        // survivor gets no watch — the seed skips closed DMs, and a stray
        // watch here would strand a capped slot on a hidden conversation.
        // Both trackers refcount, so this is safe when the survivor was
        // already watched. Per-target maps (unsendableTargets & co.) are
        // left alone deliberately: they key by wire name, sends go out under
        // the surviving buffer's name from here on, and the dead spelling's
        // entries are inert residue until the socket closes.
        if (kindForTarget(m.absorbedTarget) === 'dm') {
          this.untrackDmPeer(m.absorbedTarget);
          if (m.survivorOpen) this.trackDmPeer(m.survivorTarget);
        }
      }
      // The folds themselves moved; any membership index built on the old
      // rule is stale.
      this.joinedFoldedCache = null;
    } catch (e) {
      console.warn('[casemapping] capture/refold failed:', (e as Error)?.message || e);
    }
  }

  /** The one builder for the buffer-renamed announcement, shared by the DM
   *  nick-follow and the casemapping refold so the frame shape cannot drift
   *  between its two producers. `to` is ALWAYS the surviving buffer's final
   *  name and `mergedFromBufferId` the absorbed row — clients identify the
   *  absorbed side by that id, never by which of from/to it sat under
   *  (docs §9.7: the two producers orient from/to differently). */
  private announceBufferRenamed(r: {
    from: string;
    to: string;
    bufferId: number;
    merged: boolean;
    mergedFromBufferId?: number;
    draftChanged: boolean;
  }): void {
    this.publishEphemeral({
      type: 'buffer-renamed',
      target: r.to,
      from: r.from,
      to: r.to,
      bufferId: r.bufferId,
      merged: r.merged,
      ...(r.mergedFromBufferId != null ? { mergedFromBufferId: r.mergedFromBufferId } : {}),
      draftChanged: r.draftChanged,
    });
  }

  // ---- presence watch list (shared MONITOR + peer_presence_state rails) ----
  // weechat/irssi parity (#695): the DM buffer follows the person through a
  // /nick. The rename itself is one registry UPDATE (db/renameBuffer);
  // in-memory per-target state and the MONITOR watch re-key alongside; the
  // announcement rides publishEphemeral to wsHub, which fans the
  // buffer-renamed frame (plus merge follow-ups) to every device. The
  // "is now known as" row is persisted AFTER the rename so it lands under
  // the buffer's new name — both clients already render type:'nick' rows,
  // so the DM shows the same line a shared channel does.
  //
  // Closed DMs rename too: their history should follow the person, and a
  // rename never reopens (state carries over; a merge takes the open state
  // if EITHER side was open — see renameBuffer).
  //
  // Deliberately unconditional (no setting): weechat and irssi both do this
  // without asking. irssi's user@host re-identification (renaming when the
  // peer RECONNECTS under a new nick, no NICK seen) is out of scope — see #695.
  private renameDmForNickChange(
    oldNick: string,
    newNick: string,
    userhost: string | null,
    time: unknown,
  ): void {
    let result: ReturnType<typeof renameDmBuffer>;
    try {
      const row = getBuffer(this.network.user_id, this.network.id, oldNick);
      if (!row || row.kind !== 'dm') return;
      result = renameDmBuffer(this.network.user_id, this.network.id, oldNick, newNick);
    } catch (e) {
      console.warn('[nick] DM rename failed:', (e as Error)?.message || e);
      return;
    }
    if (!result?.renamed) return;
    const oldLower = oldNick.toLowerCase();
    const newLower = newNick.toLowerCase();
    if (oldLower !== newLower) {
      // Per-target in-memory state follows the buffer. Each map is keyed by
      // the folded target; leaving an entry behind resurrects the exact bug
      // class renameChannel's comment catalogues (a stale can't-speak-here
      // flag, a leaked one-shot WHO suppression).
      //
      // ⚠ The outstanding-CTCP queue is NOT one of these, though it used to be
      // listed here. It keys on the nick as ADDRESSED, not on a buffer, and a
      // /ctcp can be issued from a channel with no DM at all — so it re-keys
      // from the 'nick' handler, which fires for every peer rename rather than
      // only the ones that rename a DM. See rekeyCtcpOutstanding.
      if (this.unsendableTargets.delete(oldLower)) this.unsendableTargets.add(newLower);
      const lastSend = this.lastUserSendAt.get(oldLower);
      if (lastSend !== undefined) {
        this.lastUserSendAt.delete(oldLower);
        this.lastUserSendAt.set(newLower, lastSend);
      }
      if (this.autoWhoTargets.delete(oldLower)) this.autoWhoTargets.add(newLower);
      // lastNickIntent is deliberately NOT re-keyed, though it looks like it
      // belongs here. The maps above are keyed by the TARGET, which follows the
      // buffer through a rename; that one is keyed by the nick as we addressed
      // it on the wire, because that is the nick a 401 will name back at us.
      // Moving it to the new nick would break the lookup rather than fix it,
      // and the stale entry it leaves can only ever suppress a channel
      // attribution, which is the safe direction. It expires on its own window
      // and is cleared wholesale by resetSendState.
      const hint = this.e2eHintAt.get(oldLower);
      if (hint !== undefined) {
        this.e2eHintAt.delete(oldLower);
        this.e2eHintAt.set(newLower, hint);
      }
      // MONITOR follows the person: untrack first so the shared-watch
      // refcount can't strand the old nick, then watch the new one — the
      // renamed DM's presence dot stays live instead of going stale until
      // the next reconnect.
      this.untrackDmPeer(oldNick);
      this.trackDmPeer(newNick);
    }
    // A closed DM renames silently: clients hold no state for closed buffers,
    // so there is nothing to rekey — and a MERGED frame for one would make
    // them materialize a sidebar row for a conversation closed everywhere.
    if (result.open) this.announceBufferRenamed(result);
    // The DM's own "x is now known as y" line — same row shape the channel
    // loop above persists, no new renderer work anywhere.
    this.publish({
      type: 'nick',
      target: result.to,
      nick: oldNick,
      newNick,
      userhost,
      time,
    });
  }

  // trackDmPeer/untrackDmPeer are thin wrappers over the reference-counted
  // helpers below: the wire watch and the DB row are added on the first reason
  // and removed on the last.

  // In-memory only: record that `lower` is watched for `reason`, merging with
  // any existing entry. Does NOT touch the wire — hydration uses this and the
  // MONITOR seed sends the batched `MONITOR +` afterward.
  private addPeerReason(lower: string, reason: TrackReason): void {
    const w = this.trackedPeers.get(lower);
    if (w) {
      w.reasons.add(reason);
    } else {
      this.trackedPeers.set(lower, { reasons: new Set([reason]) });
    }
  }

  // Add a live watch reason for `nick`. Issues `MONITOR +` (subject to the
  // shared cap) the first time the nick becomes tracked for any reason; if it's
  // already watched only the reason is recorded, so we never re-send a
  // redundant line. Self/blank nicks are ignored. Returns true if `reason` was
  // newly added. With `useMonitor` false we still grow the set so other
  // handlers recognize the nick — they just get no live presence.
  private addPeerWatch(nick: string | undefined | null, reason: TrackReason): boolean {
    if (!nick) return false;
    const me = this.client.user?.nick;
    if (me && nick.toLowerCase() === me.toLowerCase()) return false;
    const lower = nick.toLowerCase();
    const existing = this.trackedPeers.get(lower);
    if (existing) {
      if (existing.reasons.has(reason)) {
        return false;
      }
      // Already on the wire for another reason — just record the new one.
      this.addPeerReason(lower, reason);
      return true;
    }
    this.addPeerReason(lower, reason);
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
      // the peer at 'unknown' on the client, which presence dots render
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

  // Restore the invariant that presence rows ⊆ tracked peers. Run right after
  // hydration: any row whose nick isn't tracked can never be refreshed (nothing
  // watches it) but WOULD be served as live state the moment the nick re-enters
  // trackedPeers — on a no-MONITOR network probePresence has no wire follow-up,
  // so a frozen 'online' from weeks ago would render as current. The friends
  // system used to keep such nicks tracked (its hydrate pass re-adopted them,
  // so every disconnect swept them offline); with that gone, rows it left
  // behind are permanent orphans unless swept here.
  sweepUntrackedPresenceRows(): void {
    for (const row of listPeerPresenceForNetwork(this.network.id)) {
      if (!row) continue;
      if (this.trackedPeers.has(row.nick.toLowerCase())) continue;
      try {
        deletePeerPresence(this.network.id, row.nick);
      } catch (e) {
        console.warn('[presence] orphan sweep failed:', (e as Error)?.message || e);
      }
    }
  }

  // An incoming DM (or DM activate) makes this nick a tracked DM peer; presence
  // then rides MONITOR. Returns true on a fresh add.
  trackDmPeer(nick: string | undefined | null): boolean {
    return this.addPeerWatch(nick, 'dm');
  }

  // User closed the DM buffer: drop the 'dm' reason. If another reason still
  // holds the nick the shared watch + presence row stay; otherwise both are
  // cleared — even when it wasn't actively tracked, so a stale row from
  // history is swept.
  untrackDmPeer(nick: string | undefined | null): void {
    if (!nick) return;
    const lower = nick.toLowerCase();
    const existing = this.trackedPeers.get(lower);
    existing?.reasons.delete('dm');
    if (existing && existing.reasons.size > 0) return; // still held → keep
    this.trackedPeers.delete(lower);
    this.teardownPeerWatch(nick);
  }

  // DM activate triggers this via the `probe-presence` ws message. With
  // MONITOR, adding to the watch elicits an immediate RPL_MONONLINE or
  // RPL_MONOFFLINE from the server — no separate WHOIS probe needed.
  probePresence(nick: string | undefined | null): void {
    if (!nick || !isDmTargetName(nick)) return;
    // Opening a notice-only buffer (a service like NickServ, #439) must not
    // start MONITOR tracking. But an EMPTY buffer is different from a
    // notice-only one: zero rows means the user just deliberately opened a
    // DM (nicklist → "open query") and is about to talk — showing the peer
    // as offline until the first message lands reads as a bug (QA on #716
    // hit exactly this). Probe for real conversations AND for brand-new
    // empty DMs; only the notice-only service shape stays blocked.
    if (
      !hasConversationForTarget(this.network.id, nick) &&
      hasMessageForTarget(this.network.id, nick)
    ) {
      return;
    }
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
      this.publishNames(ch);
    }
  }

  /** Cancel the reconnect rejoin for a channel the server durably refuses, and
   *  say so where the user is already watching the refusal (#868).
   *
   *  Gated on the row ALREADY being an autojoin: a manual `/join #private` that
   *  gets a 473 persisted nothing in the first place (joinChannel writes on the
   *  echo, never the request), so there is no subscription to cancel and no
   *  reason to announce one. Only a row that claims we belong here — a real
   *  membership the ircd has now locked us out of, or a config-seeded default
   *  channel that has never managed its first join — reaches the write.
   *
   *  Deliberately does NOT touch the buffer's open/closed state or its history.
   *  The channel may well become joinable again; what stops is the retrying. */
  private stopAutojoining(name: string, tag: string): void {
    // The identification race, which is the same one 477 is excluded for.
    // Account-based channel access is the NORMAL way it is granted — +i with
    // an invex `+I $a:account`, +b with an exempt `+e $a:account` — and both
    // only start matching once the server considers us identified. Our
    // connect_commands (the NickServ IDENTIFY) and the autojoin batch both
    // fire on 'registered', in the same tick; the WAIT verb exists precisely
    // because services lag that. So a 473/474 arriving before RPL_LOGGEDIN
    // may just be "NickServ hasn't caught up", and acting on it would
    // unsubscribe someone from a channel they belong to.
    //
    // SASL completes before 001, so a SASL network is already identified by
    // the time the rejoin goes out and this costs it nothing. A network with
    // no credentials configured has nothing to wait for, so a rejection there
    // is as durable as it will ever be. The one deliberately conservative case
    // is a NickServ network whose server never sends 900: we simply never act,
    // which is the right way to be wrong.
    if (!this.identifiedToServices && this.awaitingIdentification()) return;
    const canonical = canonicalChannelTarget(name, this.channels) ?? name;
    try {
      if (!isBufferAutojoin(this.network.user_id, this.network.id, canonical)) return;
      setBufferAutojoin(this.network.user_id, this.network.id, canonical, false);
    } catch (_) {
      return;
    }
    const why = PERMANENT_JOIN_REJECTION_REASONS[tag] ?? 'the server refused the join';
    // The retry has to name a key for +k: joinChannel coerces an absent key to
    // undefined and passes that straight to client.join, so a bare `/join #x`
    // does NOT resend the stored one. Telling a user to run the command that
    // reproduces their failure is worse than saying nothing.
    const retry = tag === 'bad_channel_key' ? `/join ${canonical} <key>` : `/join ${canonical}`;
    this.publish({
      type: 'notice',
      target: this.serverTarget(),
      nick: 'lurker',
      notable: false, // a status line, not unread-worthy — same as the nick-fallback notice
      text: `Stopped auto-joining ${canonical} because ${why}. Use ${retry} to try again.`,
    });
  }

  /** Whether this connection is configured to identify to services but hasn't
   *  been confirmed yet. SASL lands before 001; NickServ via connect_commands
   *  lands whenever it lands.
   *
   *  connect_commands is a general-purpose script (people put `JOIN #foo` and
   *  `MODE me +x` in it), so its mere presence says nothing — gating on that
   *  would disable this feature outright for anyone using it for ordinary
   *  things on a server that never sends 900. Look for identification
   *  vocabulary instead.
   *
   *  A heuristic, and deliberately a generous one: a false positive costs a
   *  channel that keeps retrying (the status quo), while a false negative
   *  un-subscribes someone mid-race. When in doubt, wait. */
  private awaitingIdentification(): boolean {
    if (this.network.sasl_account) return true;
    // A CertFP network identifies on the certificate, which means SASL EXTERNAL
    // leaves sasl_account empty — and a NickServ that recognises the fingerprint
    // passively needs no account field at all. Either way identification is
    // pending, and a +R channel's rejoin must wait for it. (#459)
    if (this.network.client_cert) return true;
    const commands = this.network.connect_commands;
    return !!commands && SERVICES_IDENTIFY_HINT.test(commands);
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
    this.joinedFoldedCache = null;
    let favoritesChanged = false;
    try {
      if (forget && !hasMessageForTarget(this.network.id, canonical)) {
        // Unfavorite BEFORE the hard delete: letting the FK cascade take the
        // favorite row would skip the renumber and leave every connected
        // client holding a ghost favorites entry for the dead buffer id. The
        // flag rides the channel-parted event so wsHub re-publishes the
        // authoritative list.
        favoritesChanged = unfavoriteBuffer(this.network.user_id, this.network.id, canonical);
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
    this.publish({
      type: 'channel-parted',
      target: canonical,
      ...(favoritesChanged ? { favoritesChanged: true } : {}),
    });
  }

  /** Fold-aware live membership (#707): is `name` one of this connection's
   *  joined channels under the network's declared CASEMAPPING? The channels
   *  map is keyed by the legacy-lowercased WIRE name, so a raw
   *  `.has(x.toLowerCase())` probe has two failure modes on a declared
   *  network — it misses a fold-variant spelling (`#foo{bar}` asked, joined
   *  as `#foo[bar]`), and it over-folds Unicode (on an ascii network
   *  `#Ärger` must NOT read joined via its distinct case-twin `#ärger`).
   *  Folding BOTH sides with the network's rule is the one comparison that's
   *  right everywhere; on an undeclared network it reduces to exactly the
   *  old map probe. One fold + one Set probe per call — the folded index is
   *  rebuilt lazily after any channels-map mutation or a mapping change,
   *  because this backs per-buffer loops (snapshot shells, mark-all-read)
   *  where a per-call scan would be O(buffers × channels) on the same
   *  event-loop-sensitive path the snapshot-starvation fixes targeted. It is
   *  the single definition every consumer must use instead of the
   *  idiomatic-looking raw probe. */
  isChannelJoined(name: string): boolean {
    if (!this.joinedFoldedCache) {
      const set = new Set<string>();
      for (const ch of this.channels.values()) set.add(foldTargetFor(this.network.id, ch.name));
      this.joinedFoldedCache = set;
    }
    return this.joinedFoldedCache.has(foldTargetFor(this.network.id, name));
  }

  /** The live ChannelState for `name`, resolved the same fold-aware way
   *  isChannelJoined resolves membership (#707). Callers that need the
   *  channel's CONTENTS (topic, members) rather than a yes/no must come
   *  through here rather than the idiomatic-looking
   *  `channels.get(name.toLowerCase())`, which has both of that probe's
   *  failure modes: it misses a fold-variant spelling of a channel we are in
   *  (`#foo{bar}` asked, joined as `#foo[bar]`), and it over-folds Unicode
   *  (`#Ärger` resolving to its distinct rfc1459 twin `#ärger`). Folding both
   *  sides is the comparison that's right everywhere, so this agrees with
   *  isChannelJoined by construction — same fold, same set — which a raw-probe
   *  fast path would silently break in exactly the over-folding case.
   *
   *  Deliberately a scan, not an index: it walks the JOINED channels (a
   *  handful) and backs one-shot lookups, not the per-buffer loops
   *  isChannelJoined's cached index exists for. */
  channelState(name: string): ChannelState | undefined {
    const folded = foldTargetFor(this.network.id, name);
    for (const ch of this.channels.values()) {
      if (foldTargetFor(this.network.id, ch.name) === folded) return ch;
    }
    return undefined;
  }

  upsertChannel(name: string): ChannelState {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = { name, topic: null, members: new Map(), modes: new Set() };
      this.channels.set(key, ch);
      this.joinedFoldedCache = null;
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
  // are filtered earlier by prefixModes(), so they never reach this set.
  private listModes(): Set<string> {
    const chanmodes = this.client.network?.options?.CHANMODES as string[] | undefined;
    return new Set((chanmodes?.[0] ?? 'beI').split(''));
  }

  // Member-prefix (membership) modes, from the server's ISUPPORT PREFIX token —
  // the same 005 origin listModes() reads CHANMODES from, so the two agree
  // per-ircd. irc-framework parses `PREFIX=(ov)@+` into {symbol, mode} pairs
  // (registration.js), and leaves the RAW STRING in place when the token is
  // malformed — hence the Array.isArray check rather than a truthiness test.
  //
  // This used to be a hardcoded q/a/o/h/v set, which disagreed with solanum:
  // there +q is a quiet LIST mode, not an owner prefix, so a live
  // `MODE #chan +q <mask>` was routed into the member-prefix branch and dropped
  // before listModes() was ever consulted — making listModes effectively dead
  // code for `q`. It only ever LOOKED right because quiet masks (!/@/*) never
  // match a member nick; a bare-nick quiet on a joined member would have minted
  // a phantom owner badge.
  //
  // A server that declares an empty PREFIX genuinely has no membership modes,
  // so an empty array is honoured rather than falling back (same intent as
  // listModes' `??`). The fallback covers pre-005 and malformed tokens only.
  private prefixModes(): Set<string> {
    const prefix = this.client.network?.options?.PREFIX as
      | { symbol: string; mode: string }[]
      | undefined;
    // A FRESH Set on the fallback path too, matching listModes(). Handing out the shared
    // module-level constant would let one connection's accidental mutation reach every other
    // connection that ever fell back.
    if (!Array.isArray(prefix)) return new Set(DEFAULT_PREFIX_MODES);
    return new Set(prefix.map((p) => p.mode).filter(Boolean));
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
    // A deliberate (re)connect: cancel any pending backoff and clear the flags
    // that would suppress a future auto-reconnect. This runs for both the initial
    // connect and each backoff-driven retry, so a socket that opens starts from a
    // clean slate; the attempt counter is NOT reset here (only a successful
    // 'registered' resets it) so backoff keeps growing across failed retries.
    this.clearReconnectTimer();
    this.intentionalDisconnect = false;
    this.terminalDisconnect = null;
    this.pendingSaslFailure = null;
    this.pendingServerBan = null;
    const { sasl_password, sasl_account, nick } = this.network;
    const account = sasl_password
      ? { account: sasl_account || nick, password: sasl_password }
      : undefined;
    // CertFP (#459). The certificate is presented whenever one is attached: a
    // network may recognise it passively (NickServ identifies you on the spot),
    // which works alongside a SASL password rather than instead of it. The
    // MECHANISM is what the password decides — PLAIN when there is one,
    // EXTERNAL when the certificate is the only credential there is. EXTERNAL
    // carries no account name: the fingerprint is the identity, and the network
    // maps it to whichever account it was registered on.
    const clientCert = this.clientCertificate();
    const saslMechanism = clientCert && !sasl_password ? ('EXTERNAL' as const) : undefined;
    // In engine mode the notice waits for the engine to say it is dialing — a
    // CONNECT it answers with ATTACH connects nothing (see onEnginePhase).
    if (!engineConfigured()) this.announceConnecting();
    this.resetRestoreState();
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
      client_certificate: clientCert,
      sasl_mechanism: saslMechanism,
      // Lurker owns the reconnect policy (scheduleReconnectIfWarranted), so
      // irc-framework's built-in is disabled outright. Its heuristic only retries
      // a connection that was healthy for >5s and died cleanly, ~3 times — which
      // never retries an initial-connect failure or a registration timeout and
      // gives up on a sustained outage. (Note its default is auto_reconnect:true /
      // max_retries:3; passing 0 for max_retries is a no-op — `options.x || 3`
      // coerces 0 back to 3 — which is the bug this replaces.) With this off,
      // every socket death funnels to our 'close' handler, which decides.
      auto_reconnect: false,
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
      // Request echo-message (#450): the server reflects our own sends back
      // with their msgid + @time, and the message handler adopts that echo as
      // the persisted self row (see echoActive). Same connect()-dict rule as
      // enable_chghost. Harmless where unsupported — irc-framework only CAP
      // REQs caps the server advertises, and the send path keeps the
      // optimistic publish until the cap is actually ACKed.
      enable_echomessage: true,
      // Source-bind outbound IRC when LURKER_OUTGOING_ADDR is set, so the
      // network's RFC 1413 callback lands on the built-in identd rather than the
      // host's (outgoingAddr → irc-framework outgoing_addr → socket localAddress).
      outgoing_addr: outgoingAddr(),
      ...this.engineConnectOptions(),
    });
  }

  /** The attached CertFP pair in irc-framework's shape, or undefined. Both
   *  halves or neither: a certificate without its key cannot complete a
   *  handshake, and passing one alone makes tls.connect throw. */
  private clientCertificate(): { certificate: string; private_key: string } | undefined {
    const { client_cert, client_key } = this.network;
    if (!client_cert || !client_key) return undefined;
    return { certificate: client_cert, private_key: client_key };
  }

  private announceConnecting(): void {
    const proto = this.network.tls ? ' (TLS)' : '';
    const connectingNotice: IrcEvent = {
      type: 'notice',
      target: this.serverTarget(),
      nick: 'lurker',
      notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
      text: `Connecting to ${this.network.host}:${this.network.port}${proto}…`,
    };
    // On an auto-reconnect attempt (reconnectAttempt has advanced past 0), don't
    // persist this per-attempt status line — a long outage would otherwise write
    // one row per retry forever (see scheduleReconnectIfWarranted). The initial
    // and manual connects (attempt 0) still persist their one "Connecting…" line.
    if (this.reconnectAttempt > 0) this.publishEphemeral(connectingNotice);
    else this.publish(connectingNotice);
  }

  // Engine mode: route this Client through the engine-backed transport. The id
  // is what the engine knows the socket by across app restarts; the ident rides
  // along because identd is answered where the socket is, and the ident comes
  // from the account (#643), which the engine never sees.
  private engineConnectOptions(): Partial<ConnectOptions> {
    if (!engineConfigured()) return {};
    const account = findUserById(this.network.user_id);
    return {
      transport: EngineTransport,
      engineConnId: engineConnectionId(this.network.user_id, this.network.id),
      engineIdent: deriveIdent({
        nodeMode: isNodeMode(),
        accountUsername: account?.username || '',
        accountIdent: account?.ident || null,
      }),
      engineHooks: {
        onTransport: (t) => {
          this.engineTransport = t as EngineTransport;
        },
        onPhase: (phase, info) => this.onEnginePhase(phase as EnginePhase, info as EnginePhaseInfo),
      },
    };
  }

  private onEnginePhase(phase: EnginePhase, info: EnginePhaseInfo): void {
    switch (phase) {
      case 'dialing':
        this.resetRestoreState();
        this.announceConnecting();
        break;
      case 'attached': {
        this.resetRestoreState();
        this.restoring = true;
        this.catchingUp = true;
        this.restoreUnattended = !!info.unattended;
        // The engine's channel set is the truth about the socket. Anything we
        // still think we are in but the engine doesn't (kicked or parted while
        // this process was cut off) is gone — and must not get NAMES/TOPIC
        // requests whose replies would resurrect it.
        const live = new Set((info.channels ?? []).map((c) => c.toLowerCase()));
        for (const [key, ch] of this.channels) {
          if (live.has(key)) continue;
          this.channels.delete(key);
          this.joinedFoldedCache = null;
          this.publish({ type: 'channel-parted', target: ch.name });
        }
        const away = info.detachedForMs
          ? ` (app was away ${Math.round(info.detachedForMs / 1000)}s)`
          : '';
        const how = info.unattended ? ' — it registered on its own while no app was attached' : '';
        this.logNet(
          `Re-attached to the engine-held connection as ${info.nick ?? '?'}${away}${how}`,
        );
        break;
      }
      case 'restored': {
        this.restoring = false;
        // A synthesised JOIN gets none of what a real one is volunteered — no
        // 353/366, no 332, and the join handler's MODE is skipped on a restore —
        // so ask, one channel at a time, each waiting for the last one's
        // replies (drainRestoreQueue), keeping each channel's replies out of
        // the server buffer until they arrive. Across connections each step
        // also takes a turn at the process-wide cap (see drainRestoreQueue).
        // Our umodes were set after the burst ended (the post-MOTD `MODE nick
        // +i`), so they are not in the replay either; one line, asked at once
        // — it is the per-channel replies the cap bounds, not this.
        this.restoreQuiet.set('*', {
          until: Date.now() + RESTORE_QUIET_MS,
          mode: true,
          topic: false,
        });
        this.rawQuiet('MODE', this.currentNick);
        this.restoreQueue = [...this.channels.values()].map((ch) => ch.name);
        // Every queued channel is marked quiet now, not when its own step goes
        // out: the LAST process may have let go with a step in flight, and
        // that step's replies sit in the engine backlog, delivered right after
        // this phase — the size gate on the WHO and the server-buffer filter
        // must read them as the restore's. With the cap full, even the first
        // channel's step can still be queued when they land. Each step re-marks
        // its channel as it goes out, so a long wait cannot outlive the window.
        for (const name of this.restoreQueue) {
          this.restoreQuiet.set(name.toLowerCase(), {
            until: Date.now() + RESTORE_QUIET_MS,
            mode: true,
            topic: true,
          });
        }
        this.drainRestoreQueue();
        // A socket the engine registered on its own never had its
        // post-registration steps: the connect commands run now, and the
        // manager's rejoin (onceRestored, at `live`) covers the autojoin list.
        if (this.restoreUnattended) this.runConnectCommands();
        break;
      }
      case 'gap': {
        const g = info.gap;
        if (!g) break;
        const dropped = g.lastDroppedSeq - g.firstDroppedSeq + 1;
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          notable: false, // status line, like the reconnect notices
          text: `Lurker was away longer than the engine's buffer covers — ${dropped} line${dropped === 1 ? '' : 's'} received before ${new Date(g.at).toISOString()} could not be kept.`,
        });
        break;
      }
      case 'live':
        this.catchingUp = false;
        // Only now is the picture complete: the replay said which channels the
        // socket is in, and the backlog said why (a KICK from one of them is a
        // backlog line, and it is what lowers that channel's autojoin).
        for (const cb of this.restoredCallbacks.splice(0)) {
          try {
            cb();
          } catch (e) {
            console.warn('[engine] restored callback failed:', (e as Error)?.message || e);
          }
        }
        break;
    }
  }

  // Run once the current restore has finished — replay AND backlog — or at
  // once if none is in progress. The manager's rejoin pass hangs off this.
  onceRestored(cb: () => void): void {
    if (this.restoring || this.catchingUp) this.restoredCallbacks.push(cb);
    else cb();
  }

  private resetRestoreState(): void {
    this.restoring = false;
    this.catchingUp = false;
    this.restoreUnattended = false;
    this.restoredCallbacks = [];
    this.restoreQueue = [];
    this.endRestoreStep();
    this.restoreQuiet.clear();
    this.namesHeard.clear();
  }

  // The step is over — answered, timed out, or abandoned (resetRestoreState
  // on close / connect / dial / attach). Its turn at the cap goes back with
  // it, whether it was held or still queued.
  private endRestoreStep(): void {
    if (this.restoreTimer) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = null;
    }
    this.restoreStep = null;
    const slot = this.restoreSlot;
    this.restoreSlot = null;
    slot?.release();
  }

  // True while this connection has not heard NAMES for the channel since it
  // last connected or attached (#863). After an engine re-attach every channel
  // starts that way: the replay's JOINs rebuild it with ourselves and whatever
  // has landed since, and the members arrive with the restore's own NAMES, one
  // channel at a time — or with a real 353/366 replayed from the engine's
  // backlog, which counts the moment it lands. Read from that one fact rather
  // than from the restore queue's position: a channel waiting its turn at the
  // restoreGate cap is in neither the queue nor the in-flight step, and a
  // step the deadline ended without a reply has still not heard anything.
  private membersPending(name: string): boolean {
    return !this.namesHeard.has(foldTargetFor(this.network.id, name));
  }

  // The one `names` publish — a full nicklist replace — flagged while the
  // channel's NAMES is still unheard: a mode on ourselves, our own away flip
  // or a WHO backfill can republish the incomplete list in that window, and a
  // client keeping the real list must not take it for the truth. The userlist
  // handler records the NAMES before it publishes, so that one is never
  // flagged.
  private publishNames(ch: ChannelState): void {
    this.publish({
      type: 'names',
      target: ch.name,
      members: Array.from(ch.members.values()).map(memberSnapshot),
      ...(this.membersPending(ch.name) ? { membersPending: true } : {}),
    });
  }

  // One channel in flight. The next channel's three requests go out when this
  // one's replies are all in — NAMES → 366, TOPIC → 331/332, MODE → 324 — or
  // when the step deadline passes. Closed-loop rather than a fixed interval
  // because the interval was a guess at one ircd's flood budget, and wrong:
  // solanum (Libera) lets a registered client past its grace period send 5
  // lines and then 2 per second, and kills at 20 unprocessed — so 4 lines per
  // channel every 400 ms was "Excess Flood" by the seventh channel on every
  // restart. Gated on replies, the server's queue never holds more than four
  // lines of ours on any ircd — these three plus the WHO the NAMES reply
  // triggers ('userlist'), which irc-framework already serialises behind its
  // 315 (`who_queue`) — and a server that throttles simply sets the pace. The
  // WHO is deliberately NOT part of the gate: irc-framework's queue never
  // recovers from a 315 that does not come, and a step waiting on it would
  // turn that one lost reply into a deadline wait for every channel after it.
  //
  // Across connections each step is also a turn at the process-wide cap
  // (restoreGate, #842). A re-attach brings every held connection back in the
  // same tick — on purpose, the attach registers nothing on the ircd — and
  // with nothing spreading the refreshes out, N first replies (member rebuild
  // + WS fan-out, all synchronous) land together: the [event-loop] stall a
  // busy instance sees after a restart. Each step is its own reservation at
  // the back of the gate's FIFO, so a connection with more channels than there
  // are free slots queues its next step behind everyone already waiting —
  // round-robin, every session's first member list early, rather than one
  // connection's whole walk at a time. Under the cap the step goes out
  // synchronously, so a small instance sees no change. The turn ends with the
  // step's replies, so the WHO those trigger is outside the cap too — one in
  // flight per connection (the framework's queue), size-gated, but across
  // connections as parallel as before.
  private drainRestoreQueue(): void {
    this.endRestoreStep();
    // Skip what we are no longer in (a backlog KICK may have arrived in
    // between). isChannelJoined, not a raw toLowerCase probe — membership folds
    // through the network's CASEMAPPING (this file's #707 rule).
    let name = this.restoreQueue.shift();
    while (name !== undefined && !this.isChannelJoined(name)) {
      name = this.restoreQueue.shift();
    }
    if (name === undefined) return;
    const channel = name;
    const slot = restoreGate.reserve(() => `net ${this.network.id} ${channel}`);
    this.restoreSlot = slot;
    slot.start(() => this.sendRestoreStep(channel));
  }

  // The step itself, once it has its turn. Membership is checked again here:
  // a backlog KICK may have landed while the turn was queued, and a request
  // for a channel we are no longer in would resurrect it with the replies.
  // A throw anywhere in here moves on to the next channel rather than ending
  // the walk: the gate would drop the slot and log, but nothing else would
  // ever call back for this connection — no reply can retire a step that was
  // never set, and no deadline was armed.
  private sendRestoreStep(name: string): void {
    if (!this.isChannelJoined(name)) {
      this.drainRestoreQueue();
      return;
    }
    try {
      this.restoreQuiet.set(name.toLowerCase(), {
        until: Date.now() + RESTORE_QUIET_MS,
        mode: true,
        topic: true,
      });
      // Keyed by the network's own fold: the replies echo the channel as the
      // server spells it, which on an rfc1459 network is not a toLowerCase
      // away.
      this.restoreStep = {
        key: foldTargetFor(this.network.id, name),
        owed: new Set(['names', 'topic', 'mode']),
      };
      this.rawQuiet('NAMES', name);
      this.rawQuiet('TOPIC', name);
      this.rawQuiet('MODE', name);
      this.restoreTimer = setTimeout(
        () => {
          this.restoreTimer = null;
          if (!this.disposed && this.state === 'connected') this.drainRestoreQueue();
        },
        Math.max(1, reconnectEnvInt('LURKER_RESTORE_STEP_DEADLINE_MS', RESTORE_STEP_DEADLINE_MS)),
      );
    } catch (err) {
      console.warn(
        `[irc] restore: step for ${name} on network ${this.network.id} threw; skipping it:`,
        (err as Error)?.message || err,
      );
      this.drainRestoreQueue();
    }
  }

  // A server line naming the in-flight step's channel: retire the reply it is,
  // and when nothing is owed, move on. 403/442 mean the channel will answer
  // nothing at all.
  private noteRestoreReply(numeric: string, channel: unknown): void {
    const step = this.restoreStep;
    if (!step || typeof channel !== 'string') return;
    if (foldTargetFor(this.network.id, channel) !== step.key) return;
    if (numeric === '403' || numeric === '442') {
      step.owed.clear();
    } else {
      const reply = RESTORE_REPLY_OF[numeric];
      if (!reply) return;
      step.owed.delete(reply);
    }
    if (step.owed.size === 0 && !this.disposed && this.state === 'connected') {
      this.drainRestoreQueue();
    }
  }

  private rawQuiet(command: string, arg: string): void {
    try {
      this.client.raw(command, arg);
    } catch (_) {
      /* ignore */
    }
  }

  // Is this numeric the reply to a request the restore made for this channel
  // (or, for 221, for us)? If so it is not history. Each reply retires its
  // half of the entry, so a user's own /topic or /mode a moment later renders.
  private isRestoreQuiet(numeric: string, channel: unknown): boolean {
    if (typeof channel !== 'string' || this.restoreQuiet.size === 0) return false;
    const key = channel.toLowerCase();
    const entry = this.restoreQuiet.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      this.restoreQuiet.delete(key);
      return false;
    }
    const isMode = numeric === '324' || numeric === '329' || numeric === '221';
    const isTopic = numeric === '331' || numeric === '332' || numeric === '333';
    if (isMode && entry.mode) {
      // 324 is followed by 329 on most servers; 221 stands alone.
      if (numeric === '329' || numeric === '221') entry.mode = false;
      return true;
    }
    if (isTopic && entry.topic) {
      // 332 is followed by 333; 331 stands alone.
      if (numeric === '331' || numeric === '333') entry.topic = false;
      return true;
    }
    if (!entry.mode && !entry.topic) this.restoreQuiet.delete(key);
    return false;
  }

  // Catch-up dedupe: has this line already been written by the process that
  // was attached before us? By msgid where the network provides one; otherwise
  // by the same target/kind/sender/text within a few seconds of the same time.
  private alreadyPersisted(event: IrcEvent): boolean {
    if (typeof event.msgid === 'string') {
      return hasMessageWithMsgid(this.network.id, event.msgid);
    }
    const target = event.target as string;
    const type = event.type;
    if (!target || !type) return false;
    const time = normalizeEventTime(event.time);
    return hasRecentMessageLike(
      this.network.id,
      target,
      type,
      (event.nick as string | undefined) ?? null,
      (event.text as string | undefined) ?? null,
      time,
    );
  }

  // Engine mode shutdown: leave the IRC socket in the engine for the next app
  // process and end only our side. QUIT is deliberately NOT sent.
  detach(): void {
    this.intentionalDisconnect = true;
    this.clearReconnectTimer();
    const t = this.engineTransport;
    if (t && t.isConnected()) t.detach();
    else this.setState('disconnected', {}, { log: DETACHED_LOG });
  }

  // Engine mode: does the engine currently report holding this connection? True
  // means a CONNECT will be an attach, not a dial.
  private engineHoldsUs(): boolean {
    if (!engineConfigured()) return false;
    return EngineLink.shared().holds(engineConnectionId(this.network.user_id, this.network.id));
  }

  // After an engine-link loss. Wait for the link to say what it holds: held →
  // CONNECT now, which the engine answers with ATTACH (not a dial, so not
  // throttled). Not held — the engine itself restarted and the session really is
  // gone — → this is a real reconnect and takes the ordinary ladder: backoff,
  // the per-host stagger (#236), the policy gate (#616), and its persisted
  // "Reconnecting…" row. A link that never comes back ends up there too.
  private reattachSoon(): void {
    if (this.disposed || this.intentionalDisconnect || this.reconnectTimer != null) return;
    const link = EngineLink.shared();
    const id = engineConnectionId(this.network.user_id, this.network.id);
    void link.whenReady(ENGINE_REATTACH_WAIT_MS).then((r) => {
      if (this.disposed || this.intentionalDisconnect || this.reconnectTimer != null) return;
      if (r === 'ready' && link.holds(id)) this.connect();
      else this.scheduleReconnectIfWarranted();
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

  // Where an outcome for a /ctcp issued in `issuingTarget` can actually be
  // shown. The buffer may have been closed since the request went out, and
  // wsHub drops an ephemeral event aimed at a closed buffer — so the exchange
  // would end in silence rather than in the server buffer.
  private ctcpIssuingBuffer(issuingTarget: string): string {
    return isBufferClosed(this.network.user_id, this.network.id, issuingTarget)
      ? this.serverTarget()
      : issuingTarget;
  }

  // The buffer a FAILED /ctcp to `nick` belongs in — the one it was issued from,
  // the same place its echo and its reply go (#821). Returns null when no
  // request to that nick is outstanding, which is what keeps this off every
  // unrelated 401.
  //
  // ⚠ CONSUMES the entry, on the "one command, one bounce" discipline
  // takeCommandIntent had to learn in #815: a spent CTCP left lying around is
  // exactly the shape that lies in wait and claims a later unrelated failure.
  //
  // ⚠ ctcpOutstanding is keyed by nick AND type, but a 401 names only the nick,
  // so this scans every type for that nick and takes the OLDEST outstanding
  // request. Each CTCP is its own PRIVMSG and draws its own numeric back, so
  // oldest-first pairs a burst of failures with the requests in the order they
  // were sent — the same FIFO discipline handleInboundCtcpReply uses per type.
  // Follow a renamed peer, so a request we sent to their old nick still matches
  // the reply that comes back from the new one — and so a failure naming them
  // still finds the buffer it was issued from.
  //
  // ⚠ Keys are `<nick-lc> <TYPE>`, not the bare nick. The re-key this replaces
  // read `ctcpOutstanding.get(oldNick)`, a key that cannot exist, so the queue
  // never followed a rename at all. A rename ONTO a nick we already have
  // requests out to merges rather than clobbers, re-sorted by move sequence so
  // the FIFO pairing both consumers rely on still holds.
  rekeyCtcpOutstanding(oldNick: string, newNick: string): void {
    const oldLower = oldNick.toLowerCase();
    const newLower = newNick.toLowerCase();
    if (oldLower === newLower) return;
    // Collected before mutating: the loop below both deletes and inserts keys,
    // and a Map iterator walks entries added mid-iteration.
    const moving: string[] = [];
    for (const key of this.ctcpOutstanding.keys()) {
      if (key.slice(0, key.lastIndexOf(' ')) === oldLower) moving.push(key);
    }
    for (const key of moving) {
      const queue = this.ctcpOutstanding.get(key);
      if (!queue) continue;
      const moved = this.ctcpKey(newLower, key.slice(key.lastIndexOf(' ') + 1));
      this.ctcpOutstanding.delete(key);
      const existing = this.ctcpOutstanding.get(moved);
      const merged = existing ? [...existing, ...queue] : queue;
      merged.sort((a, b) => a.seq - b.seq);
      this.ctcpOutstanding.set(moved, merged);
    }
  }

  //
  // `newerMoveSeq` is the move sequence of a non-send move on this nick (a
  // /whois), which the lastUserSendAt gate above is blind to. A request
  // sequenced before it is no longer the user's last move, so it must not claim
  // this numeric — see the 401 bucket. Per-entry rather than a blanket refusal:
  // with two requests outstanding and the whois between them, the NEWER one is
  // still the answer, whether or not they share a type.
  //
  // Null from the send-rejection path on purpose: a 531/404/477 answers a
  // SEND, and the only sends lastNickIntent knows are /raw PRIVMSG lines.
  // Weighing a /whois there would skip a refused /ctcp into the recentUserSend
  // bucket beneath it, which conjures a DM for the failure — the #817 anti-goal.
  //
  // Known and unchanged: takeCommandIntent consumes the whois with the FIRST
  // numeric, so when the server answers both commands (bob is gone and the
  // whois lands inside the PRIVMSG's round trip) the rule swaps them — the
  // request's own 401 falls through, and the whois's is presented as the
  // request's. Both lines show; the buffers are transposed.
  takeCtcpIssuer(nick: string, newerMoveSeq: number | null = null): string | null {
    const now = Date.now();
    this.pruneCtcpOutstanding(now);
    const lower = nick.toLowerCase();
    // ⚠ Claim only while the CTCP is still the user's LAST move on this target
    // — the #434 rule, and for the same reason it had to be learned there: a
    // nick's failure numeric is ambiguous the moment you do two things with the
    // nick. sendCtcpRequest records a NON-conversational send, and say / action /
    // notice / multiline overwrite that with a conversational one, so this reads
    // "the last thing sent here was a probe, not a message". Without it a real
    // /msg to a nick who quit mid-probe would have its 401 pulled into the CTCP's
    // buffer as transient status, losing the persisted row #817 puts in the query
    // — and a plain message refused in a channel we'd CTCP'd would lose the
    // inline error #283 puts there.
    const lastSend = this.lastUserSendAt.get(lower);
    if (!lastSend || lastSend.conversational) return null;
    // ⚠ And only inside the SEND window, not the 60s reply TTL. A reply may
    // legitimately be slow; a refusal comes back on the same round trip, so a
    // numeric arriving a minute later is not this request's answer. The entry
    // lives longer than the claim on purpose: a peer that silently ignores an
    // unsupported type leaves one sitting there, and it must stop being able to
    // catch an unrelated failure long before it stops being able to catch a reply.
    if (now - lastSend.at > SEND_REJECTION_ATTRIBUTION_MS) return null;
    let bestKey: string | null = null;
    let bestIndex = -1;
    let bestSeq = Infinity;
    for (const [key, queue] of this.ctcpOutstanding) {
      // Keys are `<nick-lc> <TYPE>`; sendCtcpRequest guarantees the type is a
      // single token, so the last space splits them unambiguously.
      if (key.slice(0, key.lastIndexOf(' ')) !== lower) continue;
      // Each queue is oldest-first. Its candidate is the first entry still
      // inside the send window and not outranked. The ones before it stay put:
      // past the window or outranked, each can still catch its own late reply,
      // which handleInboundCtcpReply pairs from the head.
      const i = queue.findIndex(
        (e) =>
          now - e.sentAt <= SEND_REJECTION_ATTRIBUTION_MS &&
          (newerMoveSeq == null || e.seq > newerMoveSeq),
      );
      const candidate = i === -1 ? undefined : queue[i];
      if (candidate && candidate.seq < bestSeq) {
        bestSeq = candidate.seq;
        bestKey = key;
        bestIndex = i;
      }
    }
    if (!bestKey) return null;
    const queue = this.ctcpOutstanding.get(bestKey);
    const entry = queue?.splice(bestIndex, 1)[0];
    if (queue && queue.length === 0) this.ctcpOutstanding.delete(bestKey);
    return entry ? this.ctcpIssuingBuffer(entry.issuingTarget) : null;
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
    // ⚠ NOT a channel test (#724): `#` here is the XDCC PACK-NUMBER sigil.
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
      this.surfaceCtcp(this.ctcpIssuingBuffer(pending.issuingTarget), line);
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
    const now = Date.now();
    const seq = ++this.moveSeq;
    // A CTCP type is a single token on the wire — parseCtcp splits the inbound
    // side at the first space. Only the web client's own /ctcp guarantees that
    // shape; iOS and MCP hand us whatever was typed, and a type of "PING FOO"
    // used to build the key `bob PING FOO`, which no lookup could ever match —
    // silently costing the reply AND the failure their routing. Split it the
    // same way the receiving side does, so the extra words become args rather
    // than being dropped.
    const trimmedType = type.trim();
    const sp = trimmedType.indexOf(' ');
    const t = (sp === -1 ? trimmedType : trimmedType.slice(0, sp)).toUpperCase();
    const spilled = sp === -1 ? '' : trimmedType.slice(sp + 1).trim();
    let payload = [spilled, args.trim()].filter(Boolean).join(' ');
    if (t === 'PING' && !payload) payload = String(now);
    // Real enough for the rejection handler to surface a 531, but not a
    // conversation: the outcome belongs in `issuing`, not in a new query.
    this.noteUserSend(target, false);
    if (payload) this.client.ctcpRequest(target, t, payload);
    else this.client.ctcpRequest(target, t);
    this.pruneCtcpOutstanding(now);
    const key = this.ctcpKey(target, t);
    const queue = this.ctcpOutstanding.get(key) ?? [];
    queue.push({ issuingTarget: issuing, sentAt: now, seq });
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
    const inChannel = !!channel && this.isChannelJoined(channel);
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
    // persist a junk config row; #382 review #6). Narrower than isChannelContext's
    // `# & ! +`.
    //
    // ⚠⚠ The ORIGINAL reason for that gap is gone: it read "Lurker's message routing treats
    // `&`/`!`/`+` targets as DMs, so they can never be E2E channels here", which #724 falsified —
    // those targets now route as the channels they are. What keeps this `#`-only today is
    // narrower and deliberate: these tokens are an `/e2e` ARGUMENT LINE that mixes channels,
    // nicks and handle masks, and `nonChannel` below is derived by exclusion from this same
    // test. Widening the prefix set would silently reclassify a mask like `+*!*@host` as a
    // channel and drop it from the peer argument — a misparse with security consequences in the
    // one subsystem where that matters most.
    //
    // ⚠ Known asymmetry this leaves, and the reason it is a follow-up rather than a shrug:
    // `isChannelContext` (e2e/context.ts) and the inbound decrypt gate both accept `&local`, so
    // such a channel can RECEIVE ciphertext it can never be configured to decrypt — `/e2e on`
    // there answers "run this from a channel". Widening wants the arg grammar disambiguated
    // first (positional, or an explicit `--channel`), not a wider prefix test.
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
          // ⚠ `#`-only on purpose (#724), but NOT for the reason it might look like:
          // `matchAutotrustStmt` (db/e2e.ts) is `scope = 'global' OR scope = ?`, a prefix-agnostic
          // exact match that would happily match `&local`. What makes a non-`#` scope dead is
          // upstream — `effectiveMode` gates on `getChannelConfig(...).enabled`, and `/e2e on`
          // above cannot enable a non-`#` channel. So this validator stays aligned with `/e2e on`;
          // widen the two together, and look at the config gate rather than the SQL.
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

  // echo-message ACKed: the server reflects our own PRIVMSG/NOTICE/TAGMSG back,
  // the send path skips its optimistic publish, and the message handler adopts
  // the reflection as the persisted self row (real msgid + server time, #450).
  // When false, ircManager keeps the optimistic local publish and reflections
  // stay deduped — the pre-echo-message behavior.
  //
  // The socket-liveness check is load-bearing: irc-framework clears cap.enabled
  // only on the NEXT 'connecting' event, not on socket close, and its write()
  // silently discards lines on a dead socket. Without the check, a send during
  // the disconnect/backoff window would skip the optimistic publish AND never
  // get an echo — silently lost while send() returns true. Disconnected falls
  // back to the optimistic publish, matching pre-echo behavior.
  echoActive(): boolean {
    if (!this.client.connected) return false;
    const cap = this.client.network?.cap as { enabled?: string[] } | undefined;
    return !!cap?.enabled?.includes('echo-message');
  }

  // Register an E2E ciphertext line just written to the wire, so the message
  // handler can recognize its echo BY CONTENT. Matching on content instead of
  // re-checking channel E2E state at echo time closes the /e2e-off race: state
  // can flip inside the send→echo RTT window, but the set of lines we sent
  // cannot. TTL matches the bouncer's pendingEcho window; cap is a flood
  // backstop (oldest dropped — worst case a stale echo is adopted as text,
  // never lost).
  noteSentCiphertext(line: string): void {
    const now = Date.now();
    const keep = this.sentCiphertext.filter((e) => now - e.at <= SENT_CIPHERTEXT_TTL_MS);
    keep.push({ line, at: now });
    if (keep.length > SENT_CIPHERTEXT_MAX) keep.splice(0, keep.length - SENT_CIPHERTEXT_MAX);
    this.sentCiphertext = keep;
  }

  // True (and consumes the entry) iff `line` is a ciphertext line we recently
  // sent. Consuming keeps a repeated identical ciphertext (can't happen — the
  // wire format nonces every chunk — but cheap insurance) from matching twice.
  consumeSentCiphertext(line: string): boolean {
    const idx = this.sentCiphertext.findIndex((e) => e.line === line);
    if (idx === -1) return false;
    this.sentCiphertext.splice(idx, 1);
    return true;
  }

  // Fold a DM name to the existing buffer row's casing so an echo/notice
  // sourced as "ChanServ" doesn't fork history from a "chanserv" buffer the
  // user started (#289). Falls back to the given casing for first contact.
  canonicalDmTarget(name: string): string {
    return getBuffer(this.network.user_id, this.network.id, name)?.target ?? name;
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
      // Graft the BATCH start line's msgid/@time (stashed by the raw handler)
      // onto the retained first fragment: inner fragments carry only the batch
      // ref, so without this every multiline row loses its msgid and falls
      // back to receive time. Fragment-level tags win if a server sets both.
      const batchTags = this.multilineBatchTags.get(id);
      if (batchTags) {
        this.multilineBatchTags.delete(id);
        const tags = event.tags as Record<string, string> | undefined;
        event = {
          ...event,
          // normalizeEventTime accepts the raw ISO tag string.
          time: event.time ?? batchTags.time,
          tags:
            batchTags.msgid && !tags?.msgid && !tags?.['draft/msgid']
              ? { ...tags, msgid: batchTags.msgid }
              : tags,
        };
      }
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
  noteUserSend(target: string, conversational = true): void {
    const now = Date.now();
    // Prune entries past the attribution window before adding. They can never
    // satisfy recentUserSend again, so keeping them would let the map grow
    // unbounded as the user messages more one-off DM targets over a long-lived
    // connection. The live set is tiny — only targets messaged in the last few
    // seconds — so this stays cheap.
    for (const [key, seen] of this.lastUserSendAt) {
      if (now - seen.at > SEND_REJECTION_ATTRIBUTION_MS) this.lastUserSendAt.delete(key);
    }
    this.lastUserSendAt.set(target.toLowerCase(), { at: now, conversational });
    // A direct message supersedes a channel command's claim on the next 401
    // (#434): messaging someone you just tried to kick means that 401 answers
    // the message, not the kick. say/action/notice all funnel through here, and
    // none of them pass through raw() where noteOutgoingCommand would see them.
    //
    // ⚠ It nulls the command's channel and records NOTHING of its own. A send
    // is not a move takeCtcpIssuer may hold against an outstanding request —
    // every /ctcp is a send, so recording one here (with its own clock reading)
    // let a request outrank ITSELF, and a second request outrank the first,
    // whenever a millisecond boundary fell between the readings: the
    // ctcpWiring CI flake, and in production a /ctcp that silently lost its
    // failure routing. lastNickIntent holds commands only.
    if (!isChannelTarget(target)) {
      const seen = this.lastNickIntent.get(target.toLowerCase());
      if (seen) seen.channel = null;
    }
  }

  recentUserSend(target: string): boolean {
    const seen = this.lastUserSendAt.get(target.toLowerCase());
    return seen != null && Date.now() - seen.at <= SEND_REJECTION_ATTRIBUTION_MS;
  }

  // Narrower than recentUserSend: did the user just say something TO this
  // target, as opposed to probing it? Only this may conjure a DM buffer out of
  // a 401 (#817) — a CTCP already reports into the buffer it was issued from,
  // so answering one with a brand-new query would both fabricate a
  // conversation the user never started and split the exchange in two.
  recentConversationalSend(target: string): boolean {
    const seen = this.lastUserSendAt.get(target.toLowerCase());
    return (
      seen != null && seen.conversational && Date.now() - seen.at <= SEND_REJECTION_ATTRIBUTION_MS
    );
  }

  // Record the user's last move on each nick an outgoing line names, so a 401
  // naming one can be placed (#434). Same shape as noteUserSend, including the
  // prune-before-insert: entries past the window can never match again, and a
  // long-lived connection touching a lot of one-off nicks would otherwise grow
  // the map without bound.
  noteNickIntent(nick: string, channel: string | null): void {
    const now = Date.now();
    for (const [key, seen] of this.lastNickIntent) {
      if (now - seen.at > SEND_REJECTION_ATTRIBUTION_MS) this.lastNickIntent.delete(key);
    }
    this.lastNickIntent.set(nick.toLowerCase(), { channel, at: now, seq: ++this.moveSeq });
  }

  noteOutgoingCommand(line: string): void {
    for (const intent of outgoingNickIntents(line)) {
      this.noteNickIntent(intent.nick, intent.channel);
    }
  }

  // The user's last raw command naming `nick`, CONSUMED: one command produces
  // one bounce, and a spent entry left lying around is exactly what put a
  // query's 401 into the channel the nick was last kicked from. `channel` is
  // where that 401 belongs if the command named one and is still inside the
  // window; `seq` comes back regardless, because ordering the command against
  // an outstanding CTCP request has no window of its own — takeCtcpIssuer
  // applies the send window to the request.
  takeCommandIntent(nick: string): { channel: string | null; seq: number } | null {
    const key = nick.toLowerCase();
    const seen = this.lastNickIntent.get(key);
    if (!seen) return null;
    this.lastNickIntent.delete(key);
    const live = Date.now() - seen.at <= SEND_REJECTION_ATTRIBUTION_MS;
    return { channel: live ? seen.channel : null, seq: seen.seq };
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
    // ⚠ MUST move together with the 401 path above (#821). 401 (the nick isn't
    // there) and 531 (the nick won't take it) are the two ways a /ctcp fails, so
    // fixing only one is worse than fixing neither: the same command would then
    // report in the issuing buffer or in the peer's DM depending on WHY it
    // failed. Ahead of the recentUserSend gate because an outstanding request is
    // the stronger claim — the user asked for this outcome by name, and the two
    // windows are not the same length. No newerMoveSeq here, and not by
    // oversight — see takeCtcpIssuer: letting a /whois outrank a refused send
    // would drop it into the recentUserSend bucket below.
    const ctcpIssuer = this.takeCtcpIssuer(target);
    if (ctcpIssuer) {
      this.surfaceCtcp(ctcpIssuer, sendRejectionText(reason));
      return;
    }
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
    // Same reasoning for the 401 attribution (#434): an intent recorded on the
    // old socket describes a command that died with it, and letting it survive
    // would let a kick nobody ever saw place an unrelated 401 on the new one.
    this.lastNickIntent.clear();
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
    const clean = line.replace(/[\u000d\u000a\u0000]/g, '');
    // Read it before it goes out, so a 401 bouncing back off it can be placed
    // in the channel it was aimed at (#434). Cheap and total: this is the one
    // path every slash command and member-menu action takes.
    this.noteOutgoingCommand(clean);
    this.client.raw(clean);
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

  disconnect(reason?: string, opts: { announceCancelledRetry?: boolean } = {}): void {
    // The user/system asked to disconnect — record intent BEFORE quit() so the
    // 'close' handler doesn't fight them by auto-reconnecting, and drop any
    // pending backoff so an earlier drop's retry can't resurrect the connection.
    this.intentionalDisconnect = true;
    // If we're mid-reconnect (waiting out the backoff, or with a launch already
    // queued in connectScheduler) there is NO live socket, so quit() won't emit a
    // 'close' event and nothing else would move us off 'reconnecting'. Capture
    // that before clearing the timer.
    const noLiveSocketToClose = this.reconnectTimer != null || this.state === 'reconnecting';
    this.clearReconnectTimer();
    this.client.quit(reason ?? this.defaultQuitMessage());
    // Assert the terminal state directly in that case. When a live socket IS
    // closed, its 'close' handler sets 'disconnected' too — setState is
    // change-guarded, so the double-call is a harmless no-op.
    if (noLiveSocketToClose) {
      // Say that the retry ladder stopped, because otherwise nothing does. The
      // outage's first "Reconnecting in Ns (attempt 1)…" is a PERSISTED row, so
      // without this the server buffer's last word on the subject is a promise to
      // retry that we then quietly broke — and the user who just clicked
      // Disconnect has no confirmation it took (#785). Only on the no-live-socket
      // path: a normal /quit closes a healthy socket and was never mid-retry.
      //
      // ⚠ Opt-in rather than automatic, because disconnect() is also how a PAUSE
      // and a shutdown tear connections down. Neither is the user cancelling
      // anything, and both would otherwise write this row into every network that
      // happened to be reconnecting at the time. stopNetwork — whose only two
      // callers are the disconnect endpoint and the disconnect_network verb — is
      // the one path that is always a person asking.
      if (opts.announceCancelledRetry) {
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          notable: false, // status line, like the "Reconnecting in Ns" it answers
          text: 'Reconnecting cancelled — disconnected.',
        });
      }
      this.setState('disconnected');
    }
  }

  // Cancel a pending backoff retry. Idempotent.
  private clearReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Called from the terminal 'close' handler. Decides whether this socket death
  // warrants an auto-reconnect and, if so, schedules one with exponential
  // backoff (routed through connectScheduler so a fleet-wide outage recovery
  // doesn't flood one host). Retries indefinitely for any transient drop; stops
  // only for a disposed connection, a user/system-requested disconnect, or a
  // classified-terminal reason (detected ban / hard SASL auth failure).
  /**
   * Consume a pending SASL rejection at socket-close time (#617).
   *
   * Give up only once the streak runs out. A single rejection is not proof the
   * credentials are the reason THIS socket died — on a network where SASL is
   * optional the server keeps you, and a later drop is unrelated. Retrying
   * settles it far better than any guess at the wire could: if the network
   * really does let us in unauthenticated we register and the streak resets, and
   * if it doesn't we're back here with a higher count.
   *
   * The pending flag is consumed either way — a rejection must not linger to be
   * blamed for a socket death it had nothing to do with.
   */
  private maybePromoteSaslFailure(): void {
    const pending = this.pendingSaslFailure;
    if (!pending) return;
    this.pendingSaslFailure = null;
    if (this.saslFailureStreak >= MAX_CONSECUTIVE_SASL_FAILURES) {
      this.terminalDisconnect = pending;
    }
  }

  /**
   * Promote a ban-classified ERROR to terminal at the close that follows it
   * (#651). No retry streak, unlike SASL: the server's own message is proof —
   * IF it was the link's last line. Any later server line already discarded
   * the flag (see the 'raw' handler), so reaching close with it still set
   * means nothing followed the ERROR: exactly a ban. That ordering signal
   * needs no freshness window, so a blackholed ban (the FIN never arrives and
   * the socket only dies via the ping timeout minutes later, with no lines in
   * between) still promotes — where a wall-clock window would have demoted it
   * to a transient and retried forever against a server that banned us —
   * while a ban-shaped error on a chattering connection can never be blamed
   * for a drop hours later.
   */
  private maybePromoteServerBan(): void {
    if (this.pendingServerBan == null) return;
    this.terminalDisconnect = this.pendingServerBan;
    this.pendingServerBan = null;
  }

  /**
   * Abandon the retry ladder because policy refuses this connection (#616).
   *
   * The state assertion is the load-bearing part. By the time the gate is asked,
   * scheduleReconnectIfWarranted has already announced 'reconnecting' — so
   * silently returning would leave the network pinned on "Reconnecting…" forever,
   * which is exactly the stuck-state edge the auto-reconnect overhaul removed.
   * Inlining the gate checks without this was rejected in review for that reason.
   */
  private stopReconnecting(reason: string): void {
    this.clearReconnectTimer();
    this.publish({
      type: 'error',
      target: this.serverTarget(),
      text: `Not reconnecting automatically: ${reason}.`,
    });
    this.logNet(`Auto-reconnect blocked: ${reason}`, 'warn');
    this.setState('disconnected');
  }

  private scheduleReconnectIfWarranted(): void {
    if (this.disposed || this.intentionalDisconnect) return;
    if (this.reconnectTimer != null) return; // a retry is already pending
    if (this.terminalDisconnect) {
      // Won't self-heal — surface why and stop. A manual reconnect (which
      // rebuilds the connection from scratch) clears this and tries again.
      this.publish({
        type: 'error',
        target: this.serverTarget(),
        text: `Not reconnecting automatically: ${this.terminalDisconnect}. Fix the issue and reconnect manually.`,
      });
      this.logNet(`Auto-reconnect stopped: ${this.terminalDisconnect}`, 'error');
      return;
    }
    const attempt = this.reconnectAttempt;
    const delay = reconnectBackoffMs(attempt);
    this.reconnectAttempt = attempt + 1;
    const seconds = Math.max(1, Math.round(delay / 1000));
    this.setState('reconnecting');
    const reconnectNotice: IrcEvent = {
      type: 'notice',
      target: this.serverTarget(),
      nick: 'lurker',
      notable: false, // #470: status line — not counted as unread
      text: `Reconnecting in ${seconds}s (attempt ${attempt + 1})…`,
    };
    // Persist only the FIRST status line of an outage; a network down for hours
    // would otherwise write a row every backoff tick forever — the same write
    // amplification the 'ping timeout' handler avoids. Later ticks are live-only:
    // the 'state' dot and that first persisted line already anchor history.
    if (attempt === 0) this.publish(reconnectNotice);
    else this.publishEphemeral(reconnectNotice);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Re-check intent/disposal: the user may have stopped the network, or it
      // may have been disposed, during the backoff wait.
      if (this.disposed || this.intentionalDisconnect) return;
      // Stagger the actual launch per destination host (issue #236) so many
      // connections whose backoffs elapse together don't flood one IRC server.
      connectScheduler.schedule(this.network.host, () => {
        if (this.disposed || this.intentionalDisconnect) return;
        // #616: clear the same policy gates every other connect path clears in
        // ircManager.startNetwork. Asked HERE rather than before the backoff so
        // the answer is current at the moment we would open the socket — a user
        // paused mid-wait must not get a connection out of a decision made
        // before they were paused.
        let gate: { ok: true } | { ok: false; reason: string };
        try {
          gate = this.reconnectGate?.() ?? { ok: true as const };
        } catch (err) {
          // The gate reads the DB, so it can throw where a bare connect() never
          // could (SQLITE_BUSY, a closed handle during shutdown). connectScheduler
          // only console.errors a throwing task — and by now the backoff timer is
          // already spent — so letting this escape would strand the network on
          // "Reconnecting…" with nothing left to fire. A failed POLICY READ is not
          // a policy refusal: re-arm and ask again next tick.
          this.logNet(
            `Reconnect gate check failed (${err instanceof Error ? err.message : String(err)}); retrying`,
            'warn',
          );
          this.scheduleReconnectIfWarranted();
          return;
        }
        if (!gate.ok) {
          this.stopReconnecting(gate.reason);
          return;
        }
        this.connect();
      });
    }, delay);
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
    this.clearReconnectTimer();
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
        // See membersPending (#863).
        ...(this.membersPending(ch.name) ? { membersPending: true } : {}),
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
            return this.trackedPeers.has(lower);
          })
          .map((row) => [row.nick.toLowerCase(), row]),
      ),
    };
  }
}

// Pre-005 / malformed-PREFIX fallback for prefixModes(). The widest common set,
// so a member mode isn't misread as a channel flag before ISUPPORT lands; once
// the server declares PREFIX, that wins.
const DEFAULT_PREFIX_MODES = new Set(['q', 'a', 'o', 'h', 'v']);

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

// Does a connect_commands script look like it talks to services? Matched as a
// FAMILY, not a list of bot names — an enumeration keeps missing entries
// (SaslServ, HostServ, and Undernet's `X ... LOGIN`, which uses none of the
// usual verbs). Any `*Serv` pseudo-client counts, plus the identification
// verbs, which is what catches the two networks whose services aren't named
// that way: QuakeNet's `PRIVMSG Q@CServe... :AUTH` and Undernet's X.
//
// Deliberately over-inclusive: `PRIVMSG ChanServ :OP #foo` isn't
// identification, but a script talking to services at all is a script that
// probably identified first, and waiting costs nothing but a retry. Ordinary
// uses — `JOIN #foo`, `PING connectcmd`, `MODE me +x` — carry none of this and
// correctly read as "nothing to wait for".
const SERVICES_IDENTIFY_HINT = /\b(?:\w*serv|identify|auth|login|sasl)\b/i;

// The subset of join rejections that say something durable about US and this
// channel, rather than about the moment. These are the ones worth cancelling
// an auto-rejoin over — see stopAutojoining for why the others are excluded
// and why acting on one rejection is safe.
const PERMANENT_JOIN_REJECTION_TAGS = new Set([
  'invite_only_channel', // 473 (+i) — we are not on the invex
  'banned_from_channel', // 474 (+b) — and retrying reads as ban evasion to ops
  'bad_channel_key', // 475 (+k) — the key we hold is wrong; it will stay wrong
]);

// Why each is durable enough to act on, in one line: for 473 the invex is the
// thing that would let us in and we are not on it; for 474 the ban is; for 475
// the stored key is, and MODE -k is what clears it. None of the three resolves
// by waiting, which is exactly what an auto-rejoin does.
const PERMANENT_JOIN_REJECTION_REASONS: Record<string, string> = {
  invite_only_channel: 'it is invite-only (+i)',
  banned_from_channel: 'you are banned from it (+b)',
  bad_channel_key: 'the saved channel key is wrong (+k)',
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
  if (!target || !isChannelTarget(target)) return target;
  const known = channels.get(target.toLowerCase());
  return known ? known.name : target;
}

// Matches a conventional "[#chan] …" channel-context body prefix, also tolerating
// (#chan), <#chan>, {#chan}. Accepts every channel prefix (#724) — it used to be
// restricted to `#` "to match Lurker's routing, which treats only `#` as a
// channel", which is the misclassification that has since been fixed. Widening
// is safe here for the reason the old comment already gave: the captured name is
// validated against the JOINED set before use, so a bracketed `[+nope]` in an
// ordinary notice still resolves to nothing.
const CHANNEL_CONTEXT_PREFIX = new RegExp(
  `^\\s*[[(<{]\\s*([${CHANNEL_PREFIX_CLASS}][^\\])>}\\s]+)\\s*[\\])>}]`,
);

// A nick-addressed NOTICE sometimes belongs in a channel rather than a DM with
// the sender: services announce per-channel info to your nick (Atheme ENTRYMSG,
// ChanServ welcome) either via the IRCv3 +draft/channel-context client tag or a
// conventional "[#chan] …" body prefix. Mirrors weechat's notice_welcome_redirect
// and irssi's notice_channel_context: redirect to the referenced channel, but ONLY
// when it's a channel we're currently JOINED to (so a stray tag/prefix can't
// fabricate a buffer), returning its canonical (joined) casing. Every channel
// prefix qualifies since #724 — membership, not the prefix set, is the gate. The tag wins over
// the body prefix. Returns null when there's no usable, joined-channel context.
export function resolveChannelContext(
  tags: Record<string, string> | undefined,
  body: string | undefined,
  channels: Map<string, { name: string }>,
): string | null {
  const joinedChannel = (name: string | undefined): string | null => {
    if (!name || !isChannelTarget(name)) return null;
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

// Command-result errors: a numeric that reports why a channel COMMAND failed —
// a kick, an invite, a mode change, a topic set. A third bucket alongside the
// two already here, and the one that had nowhere to go: join rejections (#260)
// belong on a channel with no buffer yet, send rejections (#283) belong where
// the refused message was typed, and these belong in the channel the command
// was run in. Until now they fell through to the generic server-buffer line, so
// the user sat in #channel, ran /kick, saw nothing happen, and the reason was
// buried somewhere they weren't looking (#434).
//
// Indexes are into the RAW wire params, params[0] being our own nick. We read
// the line ourselves rather than take irc-framework's parsed 'irc error' event
// because its generic map is not reliable here, verified against 4.x:
//   - ERR_USERNOTINCHANNEL (441) is off by one against its own 443 mapping. It
//     reports OUR nick as `nick` and the target NICK as `channel`, so routing on
//     event.channel would publish into a buffer named after a user.
//   - ERR_USERONCHANNEL (443) carries no `reason` at all.
//   - ERR_KEYSET (467) and ERR_BANLISTFULL (478) it doesn't model, so they never
//     reach an 'irc error' event in the first place.
// The 'raw' handler sees every line with its params intact, which makes one
// table cover all of them.
//
// The message is ours rather than the server's trailing text, for the same
// reason JOIN_REJECTION_MESSAGES exists: several of these numerics send a
// sentence FRAGMENT meant to be prefixed by a param ("is already on channel"),
// which reads as nonsense on its own. Each entry reads whatever else it needs
// out of the params itself and returns null to decline, since what those params
// mean differs per numeric. The server's own line is still logged verbatim to
// the server buffer by the 'raw' handler, so nothing is lost by not quoting it.
type WireParams = readonly (string | undefined)[];
const nonEmpty = (v: string | undefined): v is string => typeof v === 'string' && v.length > 0;
// A single letter, so a server that omits the list-mode param and leaves the
// trailing reason in its place can't be interpolated into the sentence.
const isModeChar = (v: string | undefined): v is string =>
  typeof v === 'string' && /^[a-zA-Z]$/.test(v);

const COMMAND_RESULT_ERRORS: Record<
  string,
  { channel: number; message: (params: WireParams) => string | null }
> = {
  // ERR_CHANOPRIVSNEEDED — <client> <channel> :You're not channel operator
  '482': { channel: 1, message: () => "You're not a channel operator." },
  // ERR_USERNOTINCHANNEL — <client> <nick> <channel> :They aren't on that channel
  '441': {
    channel: 2,
    message: (p) => (nonEmpty(p[1]) ? `${p[1]} isn't on this channel.` : null),
  },
  // ERR_USERONCHANNEL — <client> <nick> <channel> :is already on channel
  '443': {
    channel: 2,
    message: (p) => (nonEmpty(p[1]) ? `${p[1]} is already on this channel.` : null),
  },
  // ERR_KEYSET — <client> <channel> :Channel key already set
  '467': { channel: 1, message: () => 'The channel key is already set.' },
  // ERR_BANLISTFULL — <client> <channel> <char> :Channel list is full. The char
  // is the list that filled up, and it is not always +b: hitting the
  // invite-exception (+I) or quiet (+q) limit gets the same numeric, so naming
  // bans unconditionally would tell the user about the wrong list.
  '478': {
    channel: 1,
    message: (p) =>
      isModeChar(p[2]) ? `The channel's +${p[2]} list is full.` : 'That channel list is full.',
  },
};

// Resolve a raw numeric into the channel it concerns and the line to show
// there, or null if it isn't one of these / the params don't hold up. Callers
// still have to check we're actually JOINED to the channel before publishing:
// a command aimed at a channel you're not in has no buffer to land in, and
// fabricating one would be worse than the server buffer.
export function commandResultError(
  numeric: string,
  params: WireParams,
): { channel: string; text: string } | null {
  const spec = COMMAND_RESULT_ERRORS[numeric];
  if (!spec) return null;
  const channel = params[spec.channel];
  // Guards the 441-shaped case above from the other direction too: if a server
  // ever ships these params in a different order, a non-channel value here
  // fails the test and the line stays in the server buffer.
  if (typeof channel !== 'string' || !isChannelTarget(channel)) return null;
  const text = spec.message(params);
  return text ? { channel, text } : null;
}

// ERR_NOSUCHNICK (401) is the failure you actually hit first — you kick or
// invite a nick that has since left the network, or you fat-finger it — and it
// is the one numeric in this family that names NO channel, so commandResultError
// can't place it. The only thing that knows which buffer it belongs to is the
// command we just sent, and we sent it: every slash command and member-menu
// action goes out through IrcConnection.raw(), so unlike the client the server
// can read the outgoing line and remember what it aimed at.
//
// What gets remembered is INTENT, not just "a channel command happened": the
// last thing we did that names this nick, and whether it had a channel. That
// distinction is the whole design, because a nick's 401 is ambiguous the moment
// you do two different things with it. Kick fartboy in #chan, then open a query
// and message them: both bounce 401, and only the first belongs in the channel.
// Recording the query send as a channel-less intent — and consuming an intent
// when it is used — is what keeps the second one out of #chan.
//
// A `null` channel therefore is not "nothing to record". It is a positive
// statement that the user's last move on this nick was a direct one, and it has
// to overwrite whatever a channel command left behind.
const NICK_ONLY_COMMANDS = new Set(['WHOIS', 'WHOWAS', 'PRIVMSG', 'NOTICE']);

export function outgoingNickIntents(line: string): Array<{ nick: string; channel: string | null }> {
  const parts = line.trim().split(/ +/);
  const verb = (parts[0] || '').toUpperCase();
  const out: Array<{ nick: string; channel: string | null }> = [];
  const add = (nick: string | undefined, channel: string | null) => {
    if (!nick || isChannelTarget(nick)) return;
    if (channel !== null && !isChannelTarget(channel)) return;
    out.push({ nick, channel });
  };
  if (verb === 'KICK') {
    // KICK <channel>[,<channel>] <user>[,<user>] [:reason] — the reason is
    // never read, so a word in it that happens to be a nick is not a target.
    for (const channel of (parts[1] || '').split(',')) {
      for (const nick of (parts[2] || '').split(',')) add(nick, channel);
    }
  } else if (verb === 'INVITE') {
    // INVITE <nick> <channel> — the operand order is the other way round.
    add(parts[1], parts[2] ?? null);
  } else if (verb === 'MODE') {
    // MODE <channel> <modes> [args…]. Which args are nicks depends on the mode
    // string read against CHANMODES/PREFIX, and we deliberately don't work that
    // out: recording a ban mask or a limit as though it were a nick is inert,
    // because it can only ever match a 401 that names that exact string, and a
    // 401 names a bare nick.
    for (const arg of parts.slice(3)) add(arg, parts[1] ?? null);
  } else if (NICK_ONLY_COMMANDS.has(verb)) {
    // Named the nick with no channel in sight — the superseding case above.
    for (const nick of (parts[1] || '').split(',')) add(nick, null);
  }
  return out;
}

// True for numerics commandResultError owns, keyed by the tag irc-framework
// reports on its 'irc error' event. The routing itself happens on the raw line;
// this exists so the same error doesn't ALSO get written to the server buffer as
// a tag line. That line was always a duplicate of the raw one the 'raw' handler
// logs — routed or not — so suppressing it is not conditional on the routing
// having found a buffer.
const COMMAND_RESULT_ERROR_TAGS = new Set<string>([
  'chanop_privs_needed', // 482
  'user_not_in_channel', // 441
  'user_on_channel', // 443
]);

export function isCommandResultErrorTag(tag: string): boolean {
  return COMMAND_RESULT_ERROR_TAGS.has(tag);
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
