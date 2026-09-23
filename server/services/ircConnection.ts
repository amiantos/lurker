// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import IRC, { ircLineParser } from 'irc-framework';
import type { Client as IrcClient, ConnectOptions } from 'irc-framework';
import {
  insertMessage,
  hasMessageForTarget,
  hasConversationForTarget,
  hasMessageWithMsgid,
  hasSameMessageWithMsgid,
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
import { changedSettings, effectiveSetting, effectiveSettings } from './settingsService.js';
import { APP_NAME, APP_VERSION } from '../utils/userAgent.js';
import { findUserById } from '../db/users.js';
import { isNodeMode } from '../utils/edition.js';
import { deriveIdent } from '../../shared/ident.js';
import { validateClientCertPair, isClientCertProblem } from '../utils/clientCert.js';
import { networkProxy } from '../db/networks.js';
import { isProxyProblem } from '../../shared/proxy.js';
import type { ProxyConfig } from '../../shared/proxy.js';
import { mayUseProxy } from './networkPolicy.js';
import { ProxyTransport } from './proxyTransport.js';
import { MonitorList } from './monitorList.js';
import type { MonitorHolder, MonitorSync } from './monitorList.js';
import { ReplyRouter, listModeNumerics } from './replyRouter.js';
import type { Asker, ReplyOwner } from './replyRouter.js';
import { ModeListCollector } from './modeList.js';
import type { ModeListResult } from './modeList.js';
import { classifyModeChange, modeLetter } from '../../shared/modes.js';
import { parseModeSpec, sortByRank } from '../../shared/channelModes.js';
import { unixSecondsToIso } from '../utils/unixTime.js';
import type { ModeSpec } from '../../shared/channelModes.js';
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
  CTCP_ANSWER_SETTINGS,
  CTCP_SOURCE,
  ctcpAnsweredBySettings,
  ctcpInText,
  enabledCtcpTypes,
  formatCtcpForwardedLine,
  formatCtcpReplyLine,
  formatCtcpRequestLine,
  formatCtcpTime,
  isAnswerableCtcp,
  parseCtcp,
  type CtcpAnswerer,
  type CtcpReplyConfig,
} from './ctcp.js';
import { attachedIrcClients } from './attachedIrcClients.js';
import fs from 'fs';
import path from 'path';
import net from 'net';
import {
  buildDccChat,
  buildDccChatPassive,
  buildDccChatReverse,
  crc32Hex,
  encodeDccAddress,
  formatBytes,
  formatDccOfferLine,
  isBlockedDccHost,
  parseCrcFromFilename,
  parseDcc,
  parseDccChatLine,
  PASSIVE_DCC_FAKE_HOST,
} from './dcc.js';
import type { DccAccept, DccChat as DccChatOffer, DccSend } from './dcc.js';
import {
  dccActiveListenAvailable,
  dccAllowPrivateHosts,
  dccEnabledForUser,
  dccExternalHost,
  dccMaxFileBytes,
} from './dccConfig.js';
import { hasFreeSpaceFor, resolveDccDestination } from './dccPaths.js';
import { DccChat } from './dccChat.js';
import { openDccListener, type DccListenHandle } from './dccListener.js';
import {
  dccChatHostFor,
  dccChatKey,
  registerDccChatHost,
  unregisterDccChatHost,
} from './dccChatSessions.js';
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
import {
  isChannelTarget,
  isDccChatTarget,
  CHANNEL_PREFIX_CLASS,
  DCC_CHAT_PREFIX,
} from '../../shared/channels.js';

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
// LURKER_RESTORE_QUIET_MS overrides it, read per restore, so a test can show
// what the restore's own replies do without it.
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

// How long a passive DCC chat offer waits for the peer to reply with a port
// before we stop expecting one. Matches the listener's own default so the two
// halves of an offer time out together.
const PASSIVE_DCC_TIMEOUT_MS = 120_000;

// Bound the dial to a peer's advertised address so an unreachable one fails
// promptly instead of hanging until the OS SYN timeout (~1-2 minutes).
const DCC_CHAT_CONNECT_TIMEOUT_MS = 15_000;

// How long an unsolicited inbound chat offer stays acceptable. Generous, because
// the cost of a stale one is only a dial that fails — but not unbounded, so a
// drive-by offer doesn't sit accepted-able forever.
const INBOUND_DCC_CHAT_OFFER_TTL_MS = 10 * 60_000;

// Matches the rate limiter's own backoff, so the user is told once per period
// rather than once per dropped offer.
const DCC_FLOOD_WARN_GAP_MS = 5 * 60_000;

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
  // Who set the topic and when (ISO), from 333 or a live TOPIC. Null until the
  // server says; 332 clears them because the 333 behind it restates both.
  topicSetBy: string | null;
  topicSetAt: string | null;
  members: Map<string, ChannelMember>;
  modes: Set<string>;
  // Values of the set param modes (`l` → '50'), keyed by letter. NEVER `k`:
  // the key lives encrypted in buffers.key, so channel state (snapshot,
  // channel-modes) never carries it (#727). The MODE row that set it does
  // show it, as every IRC client does to everyone in the channel.
  modeParams: Map<string, string>;
  // Channel creation time (ISO), from 329.
  createdAt: string | null;
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

// "Is this target a nick we could address on the wire?" — NOT merely "is it not
// a channel". Two shapes are buffers without being IRC targets: the `:server:`
// console, and a `=nick` DCC chat.
//
// ⚠⚠ Every caller of this is a place that would otherwise put the target into an
// IRC command: say/action/notice mark a DM peer from it, probePresence feeds it
// to MONITOR, sendTyping puts it in a TAGMSG. Adding a shape here is how a new
// pseudo-target stays off the wire.
function isDmTargetName(target: string | undefined | null): boolean {
  if (!target) return false;
  return !isChannelTarget(target) && !target.startsWith(':server:') && !isDccChatTarget(target);
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
// The largest |ms| a Date can hold (ECMA-262 §21.4.1.1).
const MAX_DATE_MS = 8.64e15;

function normalizeEventTime(t: unknown): string {
  let ms: number | undefined;
  if (typeof t === 'number' && Number.isFinite(t)) ms = t;
  else if (typeof t === 'string' && t) {
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  // Past ±8.64e15 ms toISOString() throws, and every event passes through here.
  // irc-framework can't hand us one (its times come from Date.parse / new Date),
  // but a throw in an IRC handler ends the process, so it isn't worth trusting.
  if (ms === undefined || Math.abs(ms) > MAX_DATE_MS || ms - Date.now() > MAX_FUTURE_TIME_SKEW_MS) {
    return new Date().toISOString();
  }
  return new Date(ms).toISOString();
}

function extractExtras(event: IrcEvent): Record<string, unknown> | null {
  let extras: Record<string, unknown> | null = null;
  switch (event.type) {
    case 'kick':
      // `selfKicked` is persisted alongside the kicked nick so a backlog row
      // carries the same shape the live frame did. It records that the kick
      // was of US at the time, which no later nick comparison can recover.
      extras = { kicked: event.kicked, selfKicked: event.selfKicked };
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

// The watch limit a MONITOR ISUPPORT token gives. irc-framework stores a token
// without a value as `true`, and the spec reads MONITOR with no value as no
// limit. 0 means the network doesn't offer MONITOR.
export function monitorLimitFromIsupport(token: unknown): number {
  if (token === true || token === '') return Infinity;
  const n = Number(token);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Why a nick is on the presence watch list. Only 'dm' today; the reason set is
// reference-counted (see IrcConnection.trackedPeers) so a future second reason
// (e.g. favorites) shares the MONITOR watch + peer_presence_state row.
type TrackReason = 'dm';

interface PeerWatch {
  reasons: Set<TrackReason>;
}

// What makes a registration line the line it is: the command and its params,
// less the target. Tags are per-delivery (time, msgid, batch), the source is the
// server's name, and the target is OUR NICK — a server re-sending its ISUPPORT
// addresses it to the nick of the moment, so without dropping it every line
// would look new after a /nick. The replay rewrites the target anyway
// (bouncer.rewriteNumericTarget).
function burstPayload(line: string): string {
  const afterSpace = (s: string) => {
    const sp = s.indexOf(' ');
    return sp === -1 ? s : s.slice(sp + 1);
  };
  let rest = line;
  if (rest.startsWith('@')) rest = afterSpace(rest);
  if (rest.startsWith(':')) rest = afterSpace(rest);
  const command = rest.indexOf(' ');
  if (command === -1) return rest;
  const target = rest.indexOf(' ', command + 1);
  return target === -1 ? rest.slice(0, command) : rest.slice(0, command) + rest.slice(target);
}

export class IrcConnection {
  network: Network;
  onEvent: (event: EnrichedEvent) => void;
  client: IrcClient;
  state: string;
  /** Mutate only through setChannel/deleteChannel/forgetJoinedChannels —
   *  never `.set`/`.delete`/`.clear` directly — so joinedFoldedCache can't
   *  drift from what's actually in here. Reads (`.get`, `.values()`, `.has()`,
   *  iteration) are fine raw.
   *
   *  The CURRENT socket's membership and nothing else (#908): only our own
   *  JOIN echo (or the engine replay's synthesised one) adds an entry, a reply
   *  that merely names a channel (NAMES, TOPIC) never does, and every entry
   *  goes when the socket does. */
  channels: Map<string, ChannelState>;
  /** Lazily-built per-network-folded index over `channels` for
   *  isChannelJoined. null = rebuild on next probe. Nulled by setChannel/
   *  deleteChannel/forgetJoinedChannels on every mutation, and separately by a
   *  CASEMAPPING change (the folds move even though membership doesn't). */
  joinedFoldedCache: Set<string> | null;
  // Join keys awaiting their echo, keyed by lowercased channel. Nothing is
  // persisted on a join REQUEST (the buffers row is echo-written), so the key
  // rides here until the join lands; a forward (470) discards it, and so does
  // the socket dying (forgetJoinedChannels). Lost on a process restart
  // mid-join — the user just re-/joins with the key.
  private pendingJoinKeys = new Map<string, string>();
  // Channels whose JOIN is on the wire with no answer yet, folded. Membership
  // is echo-written, so between the request and its echo isChannelJoined says
  // "no" for a channel we are about to be in — indistinguishable, to a caller,
  // from one we left. mayBeJoined() is what tells those apart. Emptied by the
  // same four things that answer a JOIN: the echo, a forward (470), a
  // rejection naming the channel, and the socket dying.
  private pendingJoins = new Set<string>();
  // The mirror: channels whose PART is on the wire with no answer yet, folded.
  // Membership is echo-written in BOTH directions, so between a PART and its
  // echo the map still says we are in a channel we have already left — and a
  // caller that acts on that sends a second PART, which the server answers 442
  // (#967). Emptied wherever membership leaves the map (deleteChannel: the
  // echo, a kick, a 442's eviction, the engine's prune) and by a JOIN for the
  // same channel, which supersedes it.
  private pendingParts = new Set<string>();
  userModes: Set<string>;
  awayState: AwayState;
  // Caps this socket's server has answered a REQ for with a NAK. A refusal is
  // an answer, and nothing in irc-framework records one: without this the
  // post-restore REQ (requestUnnegotiatedCaps) would ask again every time the
  // app re-attaches. Kept for the life of this connection object rather than
  // cleared per socket — a fresh dial negotiates from CAP LS anyway, and that
  // path never reads this. (#888)
  private capsRefused: Set<string>;
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
  // Live DCC CHAT sessions, keyed by the peer's lowercased nick. Each is a
  // direct TCP line-chat surfaced as a `=nick` buffer. Process-bound: the socket
  // is independent of the IRC connection (so it survives a reconnect, exactly as
  // irssi's does) but cannot outlive the process, while the buffer and its
  // history persist — hence the once-per-peer notice in dccChatSend when a line
  // is typed into a chat this process no longer holds.
  private readonly dccChats = new Map<string, { nick: string; chat: DccChat }>();
  // Peers we've already told "that chat is gone" since their last live session,
  // so typing repeatedly into a dead `=nick` buffer doesn't repeat the notice.
  private readonly dccChatDeadWarned = new Set<string>();
  // Peer key -> when we last said "too many DCC requests", so the warning about
  // a flood can't itself become one.
  private readonly dccFloodWarnedAt = new Map<string, number>();
  // Listeners for offers we've made that nobody has answered yet; closed on
  // dispose so their bound ports are released rather than leaked.
  // handle -> the peer it was opened for, so /dcc close can cancel it.
  private readonly dccChatListeners = new Map<DccListenHandle, string>();
  // Listener requests still binding a port, keyed by lowercased peer. The value
  // is a per-request token, so a request that was cancelled and then re-made
  // before the first bind returned can't be mistaken for the new one.
  private readonly dccListenerRequests = new Map<string, object>();
  // Inbound chat offers awaiting the user's acceptance, keyed by lowercased
  // nick. ⚠ An offer is NOT auto-accepted: dialling would have this server open
  // a TCP connection to an address a stranger chose, and hand them its IP, on
  // nothing but a PRIVMSG. Both mature references refuse by default too —
  // WeeChat's xfer.file.auto_accept_chats is "off" ("use carefully!",
  // xfer-config.c:333-338) and irssi's dcc_autochat_masks is empty
  // (dcc-chat.c:835) — and Lurker's own file path already requires approval.
  private readonly pendingInboundChats = new Map<
    string,
    { nick: string; offer: DccChatOffer; timer: ReturnType<typeof setTimeout> }
  >();
  // Passive chat offers awaiting the peer's reverse reply, keyed by our token.
  private readonly pendingPassiveChats = new Map<
    number,
    { nick: string; timer: ReturnType<typeof setTimeout> }
  >();
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
  // The last modeSpec sent as a `mode-spec` frame, as JSON (#727).
  private publishedModeSpec: string | null = null;
  // List fetches on the wire, by folded channel + letter (fetchModeList).
  private readonly modeListFetches = new Map<string, Promise<ModeListResult>>();
  pendingMonitorSeed: boolean;
  // The network's MONITOR list: Lurker's nicks plus those of the IRC clients
  // attached through the bouncer (see monitorList.ts and syncMonitor).
  readonly monitor: MonitorList;
  // True once the MOTD (or ERR_NOMOTD) has ended the registration burst, so
  // every 005 has arrived and useMonitor is settled. Reset with the socket.
  isupportComplete: boolean;
  // Nicks watched by MONITOR lines sent raw (connect commands, /quote), kept as
  // a list of their own on the network's list, like a bouncer client's, so a
  // raw MONITOR C can't wipe other watches (see takeRawMonitor). Folded nick →
  // the nick as sent. Cleared with the socket, as the network's list is.
  private readonly rawMonitored = new Map<string, string>();
  private readonly rawMonitorHolder: MonitorHolder = {
    monitorTargets: () => this.rawMonitored.values(),
    onMonitorDropped: (nicks, limit) => this.dropRawMonitors(nicks, limit),
  };
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
  // Who asked for each reply: Lurker, the user, or a bouncer client. Every query
  // goes out through it, one of each kind on the wire at a time (replyRouter.ts).
  readonly replies: ReplyRouter;
  // Who the server line being handled is for, as the router saw it. Set in the
  // raw listener and cleared by the same microtask as lineArrivedAt, so the
  // line's handlers and every bouncer client's relay read one answer: a WHO the
  // user typed renders, Lurker's own and a client's don't (#931). Null outside
  // a line's handlers.
  replyOwner: ReplyOwner | null;
  // Who answers the CTCP request being handled, for a type Lurker can answer
  // (ctcpAnswererFor, #932). Set in the raw listener, before any bouncer
  // client's relay reads it, and cleared with replyOwner. Null for any other
  // line and outside a line's handlers.
  ctcpAnswerer: CtcpAnswerer | null;
  // The command of the server line being handled, for a handler whose event
  // doesn't say which line raised it. Set in the raw listener and cleared with
  // replyOwner; null outside a line's handlers. A batch's lines run when the
  // batch ends, so their handlers read the closing BATCH line's.
  lineCommand: string | null;
  // The raw listener's decisions for CTCP requests inside a batch, in arrival
  // order per batch reference. irc-framework runs a batch's lines only when it
  // ends, after ctcpAnswerer is cleared, so each request's handler takes its
  // line's decision from here instead of deciding, and spending the peer's
  // allowance, a second time. Capped, and cleared with the socket.
  batchedCtcpAnswerers: Map<string, CtcpAnswerer[]>;
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
  // When the server line being handled arrived. An event without server-time
  // takes it as its time, and so does the bouncer's copy of the line, so the
  // stored row and the relayed line agree: a MARKREAD from an attached client
  // names the relayed line's time and has to find that row. soju stamps a line
  // once the same way (upstream.go:679). Null outside a line's handlers, so an
  // event a timer fires later gets the time it happened.
  lineArrivedAt: Date | null;
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
  // Called when a dial is refused for a reason only a config change can fix, so
  // the owner can drop this object rather than keep a corpse that will never
  // retry (see clientCertBlockedReason).
  private readonly onNeedsRebuild: (() => void) | undefined;
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
    onNeedsRebuild,
  }: {
    network: Network;
    onEvent: (event: EnrichedEvent) => void;
    reconnectGate?: ReconnectGate;
    onTakenOver?: () => void;
    onNeedsRebuild?: () => void;
  }) {
    this.network = network;
    this.onEvent = onEvent;
    this.reconnectGate = reconnectGate;
    this.onTakenOver = onTakenOver;
    this.onNeedsRebuild = onNeedsRebuild;
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
    // CAP LS. (#310) The draft name too, for a network that still offers only
    // that one, as soju does.
    this.client.requestCap('extended-monitor');
    this.client.requestCap('draft/extended-monitor');
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
    this.capsRefused = new Set();
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
    this.monitor = new MonitorList((line) => {
      try {
        this.client.raw(line);
      } catch (_) {
        /* ignore */
      }
    });
    this.isupportComplete = false;
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
    this.replies = new ReplyRouter({
      write: (line) => {
        try {
          this.client.raw(line);
        } catch (_) {
          /* ignore */
        }
      },
      canSend: () => this.state === 'connected',
      fold: (name) => foldTargetFor(this.network.id, name),
      isJoined: (channel) => this.isChannelJoined(channel),
      ownNick: () => this.currentNick,
      listModes: () => this.listModes(),
      prefixModes: () => this.prefixModes(),
    });
    this.replyOwner = null;
    this.ctcpAnswerer = null;
    this.lineCommand = null;
    this.batchedCtcpAnswerers = new Map();
    this.multilineBatches = new Map();
    this.multilineBatchTags = new Map();
    this.lineArrivedAt = null;
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
    event = this.normalizeChannelTarget(event);
    const time = normalizeEventTime(event.time ?? this.lineArrivedAt?.getTime());
    if (this.shouldPersist(event) && this.alreadyPersisted(event, time)) return;
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
      time: normalizeEventTime(event.time ?? this.lineArrivedAt?.getTime()),
    });
  }

  // `opts.log`: false skips the system-buffer line for this transition (the
  // state event still goes to clients); a string replaces its text. Neither
  // reaches the wire.
  // `extra.error`: why a connection attempt failed, in the words of the error
  // row the server buffer gets. ircManager keeps the last one for bouncer
  // clients (BOUNCER NETWORK's `error` attribute) until the next connect.
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
  // Silent once disposed, like publish(): the socket's close still runs its
  // handlers after dispose(), and on a deletion the user row is already gone —
  // its "Disconnected" line failed the foreign key and took the process down
  // (#936). A disposal writes its own line (ircManager's "Disposing: …").
  logNet(text: string, level?: string): void {
    if (this.disposed) return;
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
    // Every handler registers through this but the socket's own teardown
    // ('socket close', 'close'), and none of them runs once the connection is
    // disposed (#936). A line the server sent before it read our QUIT still
    // arrives, and plenty of handlers write straight to the DB — a tracked
    // peer's QUIT writes its presence row. On a deletion the network and user
    // rows are already gone, so the write fails its foreign key, and thrown
    // from a socket event that exits the process. The teardown still runs: it
    // releases what the socket held (the identd entry, the restore slot), and
    // everything it writes goes through publish() or logNet(), both silent
    // once disposed.
    // Not an irc-framework raw middleware: middleware-handler runs the rest of
    // the dispatch inside its try/catch, so installing one would turn every
    // handler's exception into a console line instead of the fatal exit.
    const on = (event: string, listener: (payload: never) => void): void => {
      c.on(event, (payload: unknown) => {
        if (!this.disposed) listener(payload as never);
      });
    };

    // The server buffer is the authentic log of everything the server sends:
    // we default to surfacing every numeric here (welcome banner, lusers, SASL
    // confirmation, /who, /whois, /oper, /time, …) and only suppress a small
    // denylist (see isServerBufferDeniedNumeric). This is the single place that
    // sees every numeric — the 'raw' event fires for each wire line regardless
    // of whether irc-framework modeled it, so nothing vanishes the way it did
    // under the old curated allowlist (#342). Pretty surfaces (nicklist, topic
    // bar, whois modal) are rendered additively by their structured handlers;
    // they never replace the raw line here.
    on('raw', (event: { from_server: boolean; line: string }) => {
      if (!event?.from_server || typeof event.line !== 'string') return;
      // One time for everything this line produces (see lineArrivedAt). This
      // listener is registered before any bouncer client's, and irc-framework
      // runs the line's handlers synchronously once its raw listeners return
      // (connection.js emits raw, then message), so they all read this value
      // before the microtask clears it.
      this.lineArrivedAt = new Date();
      queueMicrotask(() => {
        this.lineArrivedAt = null;
        this.replyOwner = null;
        this.ctcpAnswerer = null;
        this.lineCommand = null;
      });
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
      this.lineCommand = rawCommand;
      // Who this line is for, before anything reads it (see replyOwner).
      this.replyOwner = this.replies.noteServerLine(
        event.line.replace(/[\r\n]+$/, ''),
        rawCommand,
        msg?.params ?? [],
        msg?.prefix?.split('!')[0],
      );
      // A list fetch of our own (fetchModeList) collects its lines here. Being
      // its asker already keeps them out of the server buffer and off clients.
      if (this.replyOwner instanceof ModeListCollector) {
        this.replyOwner.take(rawCommand, msg?.params ?? []);
      }
      // Who answers a CTCP request, before any bouncer client's relay passes it
      // on (see ctcpAnswerer).
      this.ctcpAnswerer = rawCommand === 'PRIVMSG' && msg ? this.ctcpAnswererForLine(msg) : null;
      // A batch's lines reach their handlers only when it ends, after the
      // microtask, so a batched request's decision waits for its handler.
      const batchRef = (msg?.tags as Record<string, string> | undefined)?.batch;
      if (this.ctcpAnswerer && batchRef) {
        let queue = this.batchedCtcpAnswerers.get(batchRef);
        if (!queue) {
          // Past the cap the oldest batch goes, most likely one the server never
          // ended. Its requests are decided again if they ever run.
          if (this.batchedCtcpAnswerers.size >= 100) {
            const oldest = this.batchedCtcpAnswerers.keys().next().value;
            if (oldest !== undefined) this.batchedCtcpAnswerers.delete(oldest);
          }
          queue = [];
          this.batchedCtcpAnswerers.set(batchRef, queue);
        }
        queue.push(this.ctcpAnswerer);
      }
      // ERR_MONLISTFULL: the network refused these nicks, so they aren't on its
      // list. irc-framework's 'irc error' for it doesn't say which. The line
      // stays out of the server buffer, since it can name a bouncer client's
      // nick and that client is sent the 734. Lurker's own nicks get a notice.
      if (rawCommand === '734') {
        const refused = String(msg?.params?.[2] ?? '')
          .split(',')
          .filter(Boolean);
        this.monitor.noteRefused(refused);
        const listLimit = msg?.params?.[1] ?? '?';
        const own = refused.filter((n) => this.isOwnMonitorNick(n));
        if (own.length > 0) {
          this.publish({
            type: 'notice',
            target: this.serverTarget(),
            nick: 'lurker',
            notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
            text: `MONITOR limit (${listLimit}) reached; live presence skipped for ${own.join(', ')}.`,
          });
        }
        // A raw MONITOR + (connect command, /quote) failed for these, as a
        // client's would.
        const rawRefused = refused.filter((n) => this.rawMonitored.has(n.toLowerCase()));
        if (rawRefused.length > 0) this.dropRawMonitors(rawRefused, listLimit);
      }
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
      if (rawCommand === '001') {
        this.registrationLines = [burstLine];
      } else if (
        this.registrationLines.length > 0 &&
        (rawCommand === '002' ||
          rawCommand === '003' ||
          rawCommand === '004' ||
          rawCommand === '005')
      ) {
        // Servers repeat these: solanum sends its whole ISUPPORT again after
        // every VERSION (show_isupport in m_version.c), and every attach would
        // replay the pile. A line the burst already holds keeps its one place,
        // moved to the end so the newest copy is the one that lands last — a
        // token that went A → B → A is back at A for the client, where dropping
        // the repeat would leave it at B.
        const payload = burstPayload(burstLine);
        const at = this.registrationLines.findIndex((l) => burstPayload(l) === payload);
        if (at !== -1) this.registrationLines.splice(at, 1);
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
      //
      // One answering a query a bouncer client sent (`MODE #chan e`) is its own.
      const cmdError = commandResultError(rawCommand, msg?.params ?? []);
      const cmdErrorChannel = cmdError ? this.channelState(cmdError.channel) : undefined;
      if (cmdError && cmdErrorChannel && this.replyForUser()) {
        this.publish({
          type: 'error',
          target: cmdErrorChannel.name,
          text: cmdError.text,
          raw: { command: rawCommand, params: msg?.params ?? [] },
        });
      }
      // A reply to the restore step in flight is what releases the next
      // channel's requests. Before the denylist: 366 is exactly the kind of
      // line the server buffer never shows. Only the restore's own: a bouncer
      // client's NAMES for the same channel mustn't move the step on.
      if (this.replyOwner === 'lurker') this.noteRestoreReply(rawCommand, msg?.params?.[1]);
      // The server buffer is the user's. A reply to Lurker's own query (the
      // MODE it sends on a join) or to a bouncer client's isn't history (#931).
      if (!this.replyForUser()) {
        // The restore's own replies still retire their channel's quiet mark, so
        // the user's own /topic or /mode a moment later renders.
        if (this.replyOwner === 'lurker' && RESTORE_QUIET_NUMERICS.has(rawCommand)) {
          this.isRestoreQuiet(rawCommand, rawCommand === '221' ? '*' : msg?.params?.[1]);
        }
        return;
      }
      // NAMES replies are denied because a joined channel's nicklist is where
      // they show. One for a channel we are not in has no nicklist to land in
      // (see 'userlist'), so it renders verbatim like any other numeric.
      const namesChannel =
        rawCommand === '353' ? msg?.params?.[2] : rawCommand === '366' ? msg?.params?.[1] : null;
      const namesElsewhere =
        typeof namesChannel === 'string' && !this.isChannelJoined(namesChannel);
      if (isServerBufferDeniedNumeric(rawCommand) && !namesElsewhere) return;
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
    on('unknown command', (cmd: { command?: string; params?: string[] }) => {
      const command = (cmd?.command || '').toString();
      const params = Array.isArray(cmd?.params) ? (cmd.params as string[]) : [];
      // These numerics arrive as [nick, <target>, reason] — usually a channel,
      // but see the nick case below.
      const channel = typeof params[1] === 'string' ? params[1] : '';
      const reason = params[params.length - 1] || null;
      // The join rejections irc-framework doesn't model arrive here rather than
      // on 'irc error' — 476 and 477 have no entry in its generics, and neither
      // does 403, which answers a JOIN without having a toast of its own. Same
      // rule as there: a rejection ends the JOIN, so the mark goes, and only a
      // numeric that can answer a JOIN clears it.
      if (
        channel &&
        isChannelTarget(channel) &&
        (joinRejectionMessage(command) || command === '403')
      ) {
        this.pendingJoins.delete(foldTargetFor(this.network.id, channel));
      }
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
    on('loggedin', () => {
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
    on('cap nak', (event: Record<string, unknown>) => {
      const caps = (event?.capabilities as Record<string, unknown> | undefined) || {};
      for (const name of Object.keys(caps)) this.capsRefused.add(name);
    });

    on('sasl failed', (event: Record<string, unknown>) => {
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
        // Deliberately not "register it while connected": on a network that
        // REQUIRES SASL this rejection is what stops you connecting, so that
        // advice is a closed loop. Name the way out of it too.
        const advice = usingCert
          ? " — this network doesn't recognise your client certificate. Register its fingerprint with NickServ (CERT ADD); if that means getting in first, remove the certificate here"
          : " — check the network's account credentials";
        this.pendingSaslFailure = `SASL authentication failed${
          reason && reason !== 'fail' ? ` (${reason})` : ''
        }${advice}`;
      }
    });

    on('registered', (event: Record<string, unknown>) => {
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
          // ⚠⚠ Belt to kindForTarget's braces. This loop reads listOpenDms —
          // raw SQL on `kind = 'dm'` — so it never passes through a shape
          // predicate, and it runs on EVERY reconnect with no user action. A
          // `=nick` row minted before the 'dcc' kind existed would still be
          // 'dm' here and would seed `MONITOR + =nick` upstream.
          if (isDccChatTarget(buf.target)) continue;
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
      // Not on a restore: that socket has been told before, and whatever changed
      // while the link was down goes out when the restore completes ('restored').
      if (this.awayState.active && this.awayState.message && !this.restoring) {
        this.sendAwayState();
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
      // Every query went with the socket. A bouncer client still waiting on one
      // is sent its end numeric.
      this.replies.reset();
      this.multilineBatches.clear();
      this.multilineBatchTags.clear();
      this.batchedCtcpAnswerers.clear();
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
      this.monitor.reset();
      this.isupportComplete = false;
      // The next snapshot sends a null spec (clientModeSpec), so the burst's
      // end must send a frame even if the network's spec hasn't changed.
      this.publishedModeSpec = null;
      this.rawMonitored.clear();
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
      // Safety net, like the sweep above: 'socket close' has almost always
      // forgotten the channels already, and a second call is a no-op.
      this.forgetJoinedChannels();
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
    on('nick in use', (event: Record<string, unknown>) => {
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
    on('server options', () => {
      this.publishModeSpecIfChanged();
      // 005 lines arrive in multiple bursts; this handler fires once per
      // line as irc-framework accumulates options. The MONITOR token isn't
      // necessarily in the first line, so only act when we transition
      // from "MONITOR unknown" to "MONITOR confirmed supported". If
      // MONITOR never appears, the deferred flags stay pending forever
      // (harmless — they're just booleans, and trackDmPeer's per-add path
      // also checks useMonitor before sending).
      const opts = this.client.network?.options || {};
      const limit = monitorLimitFromIsupport(opts.MONITOR);
      if (limit === 0 || this.useMonitor) return;
      this.useMonitor = true;
      this.monitorLimit = limit;
      if (!this.restoring) {
        const cap = limit === Infinity ? 'no watch limit' : `watch limit ${limit}`;
        this.logNet(`MONITOR (IRCv3 presence) supported, ${cap}`);
      }
      // The regain nick goes on the list with the seed (ownMonitorNicks).
      this.pendingRegainSetup = false;
      if (this.pendingMonitorSeed) {
        this.pendingMonitorSeed = false;
        const seedCount = this.monitoredNicks().length;
        if (seedCount > 0) {
          this.logNet(
            `Seeding MONITOR with ${seedCount} nick${seedCount === 1 ? '' : 's'} (DM peers)`,
          );
        }
      }
      this.seedMonitorWatch();
    });

    // RPL_MONONLINE — peers in our MONITOR watch list that are currently
    // online. Fires both on initial seed (server replies with the current
    // state of each newly-added nick) and live when a watched peer
    // connects. The regain handler doesn't react to online events, so
    // there's no conflict to filter.
    on('users online', (event: Record<string, unknown>) => {
      // irc-framework raises this for an ISON reply (303) as well as MONITOR's
      // 730, with the same payload. ISON is a poll (/ison, or a bouncer client's
      // notify list on a network without MONITOR) and nothing on such a network
      // ever marks the peer offline again, so a tracked DM peer would read
      // online long after they'd gone (#933). Presence is MONITOR's alone.
      if (this.lineCommand === '303') return;
      const nicks: string[] = Array.isArray(event?.nicks) ? (event.nicks as string[]) : [];
      this.monitor.noteStatus(
        nicks.filter((n) => typeof n === 'string'),
        true,
      );
      // The list also holds bouncer clients' nicks; log only Lurker's own.
      const own = nicks.filter((n) => this.isOwnMonitorNick(n));
      if (own.length > 0) {
        this.logNet(`Presence: ${own.join(', ')} online`);
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
    on('users offline', (event: Record<string, unknown>) => {
      const nicks: string[] = Array.isArray(event?.nicks) ? (event.nicks as string[]) : [];
      this.monitor.noteStatus(
        nicks.filter((n) => typeof n === 'string'),
        false,
      );
      const own = nicks.filter((n) => this.isOwnMonitorNick(n));
      if (own.length > 0) {
        this.logNet(`Presence: ${own.join(', ')} offline`);
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

    on('pong', (event: Record<string, unknown>) => {
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
          // `engineLink`: the IRC socket is up, only our link to it is gone, so
          // a bouncer client hears nothing about it (services/bouncer.ts).
          this.setState('reconnecting', { engineLink: true });
        }
        return;
      }
      const errorText =
        err && (err.message || err.code)
          ? formatSocketCloseErrorMessage(
              err,
              `${this.network.host}:${this.network.port}`,
              this.network.trusted_certificates !== 0,
            )
          : null;
      this.setState('disconnected', errorText ? { error: errorText } : {});
      // The IRC socket itself is gone (the engine-link cases returned above),
      // and the channels we were in went with it.
      this.forgetJoinedChannels();
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
      if (errorText) {
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: errorText,
        });
        this.logNet(errorText, 'error');
      }
    });
    // The 'reconnecting' state + notice are now emitted by our own controller
    // (scheduleReconnectIfWarranted), not the library: irc-framework's
    // auto_reconnect is disabled, so it never fires a 'reconnecting' event.
    // On an attach the state still transitions (clients need the dot), but
    // "Connecting…" in the system buffer would describe a connect that isn't
    // happening; the manager already said "Attaching…" and the engine hook
    // says "Re-attached" when it lands.
    on('connecting', () => {
      // Re-attaching to a connection the engine still holds isn't the network
      // connecting: the same flag, and the same silence for bouncer clients.
      const held = this.engineHoldsUs();
      this.setState('connecting', held ? { engineLink: true } : {}, { log: !held });
    });

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
    on('ping timeout', () => {
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
    on(
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
        // ⚠ Through a proxy, identd is unanswerable and the entry would be a
        // lie (#303). The ircd sends its RFC 1413 query to the address it SEES,
        // which is the proxy's — it never reaches us, and the 4-tuple here is
        // ours-to-the-proxy, so it could not match the query even if it did.
        // Registering anyway would leave a map entry that looks configured and
        // answers nothing.
        if (this.proxyConfig()) return;
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
    on('user info', (event: Record<string, unknown>) => {
      if (!this.isSelfNick(event.nick as string)) return;
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
    on('user updated', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      if (!event.new_hostname && !event.new_ident) return; // SETNAME — not ours
      const eventNick = event.nick as string;
      const lower = eventNick.toLowerCase();
      const isSelf = this.isSelfNick(lower);
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
    on('account', (event: Record<string, unknown>) => {
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

    on('motd', (event: Record<string, unknown>) => {
      // The MOTD, or its absence, ends the registration burst after every 005.
      this.isupportComplete = true;
      this.publishModeSpecIfChanged();
      // irc-framework also fires 'motd' for ERR_NOMOTD (no MOTD configured)
      // with `error` instead of `motd`, and for servers with an empty MOTD
      // file `motd` is just ''. Skip the blank-line publish either way.
      const text = (event.motd as string) || (event.error as string) || '';
      if (!text.trim()) return;
      this.publish({ type: 'motd', target: this.serverTarget(), text });
    });

    on('message', (event: Record<string, unknown>) => {
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
      const me = this.currentNick;
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
      // Only a notice that was stored gets a mirror: a repeat of one already
      // stored gets no second copy.
      if (
        isNotice &&
        !isServer &&
        target !== this.serverTarget() &&
        published &&
        !published.fromIgnored &&
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

    on('batch end draft/multiline', (info: Record<string, unknown>) => {
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
    on('ctcp response', (event: Record<string, unknown>) => {
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
    on('ctcp request', (event: Record<string, unknown>) => {
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

    on('join', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventNick = event.nick as string;
      // Case-insensitive, like the part and kick handlers: a server that echoes
      // our nick in a different case is still telling us about our own join.
      const isSelf = this.isSelfNick(eventNick);
      // Only our own JOIN makes a channel ours (#908). Someone else's updates a
      // channel we are in and creates nothing for one we are not — a backlog
      // line replayed for a channel we have since left, say. Fold-aware, like
      // the NAMES and TOPIC handlers.
      const ch = isSelf ? this.upsertChannel(eventChannel) : this.channelState(eventChannel);
      // extended-join: irc-framework parses the account param when the cap is
      // enabled, and omits the key when it isn't (#508).
      const joinAccount = normalizeAccount(event.account);
      ch?.members.set(eventNick.toLowerCase(), {
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
      if (!isSelf) {
        // JOIN means they're online. If they were marked away and JOIN fires,
        // the away marker stays — markPeerEvent is idempotent against the
        // current state, and 'online' from JOIN doesn't fire if state is
        // already 'online'. (It WILL fire if state is 'offline' or null.)
        // The away-notify 'back' event is the authoritative back signal.
        this.markPeerEvent(eventNick, 'online');
      }
      // Before the restoring arm below returns: any self-JOIN answers the JOIN
      // we sent, replayed or live, so the mark goes either way. Left behind in
      // the replay case it would never be cleared again (only a dial forgets
      // the set, and a re-attach doesn't dial), and a close of that channel
      // would PART it forever after — the 442 this all exists to stop.
      if (isSelf) this.pendingJoins.delete(foldTargetFor(this.network.id, eventChannel));
      if (isSelf && this.restoring) {
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
          this.deleteChannel(eventChannel.toLowerCase());
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
      if (isSelf) {
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
        // the channel's mode flags reach the status bar consistently. The reply
        // is Lurker's own, so no bouncer client sees it (#931).
        this.replies.send('lurker', `MODE ${eventChannel}`);
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
    on('channel_redirect', (event: Record<string, unknown>) => {
      const from = event?.from as string | undefined;
      if (!from) return;
      this.takeStashedJoinKey(from);
      this.pendingJoins.delete(foldTargetFor(this.network.id, from));
      // forget: a channel we were never in must not keep an autojoin or a row
      // with nothing to show.
      this.evictChannel(from, { forget: true });
    });

    on('part', (event: Record<string, unknown>) => {
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
      // Case-insensitive self-match, like the self-kick branch below: this
      // branch now lowers autojoin, so a server that echoes our nick in the
      // PART prefix with different casing must not skip the correction.
      if (this.isSelfNick(eventNick)) {
        this.deleteChannel(eventChannel.toLowerCase());
        // The echo lowers autojoin, not just ircManager.partChannel. That path
        // is the app's own /part and buffer-close, so a PART Lurker did not
        // originate — a raw /quote PART, another client on the bouncer, a
        // script, a server forcing one — left the row flagged for auto-rejoin,
        // and the next reconnect put the user back into a channel they had
        // left. It reads as the part having silently failed. Nothing converged
        // either: the restoring branch in the join handler that sends a late
        // PART for exactly this case reads the same flag, so a row stuck at 1
        // defeats the correction too. Same reasoning as the self-kick below.
        // The second write on the app's own path is idempotent, and this is
        // update-only, so a PART for a channel with no row conjures nothing.
        try {
          setBufferAutojoin(this.network.user_id, this.network.id, channel, false);
        } catch (_) {
          /* ignore */
        }
        this.publish({ type: 'channel-parted', target: channel });
        // No system-buffer "Parted #x" line — symmetric with the join above; the
        // part already shows in the channel buffer (#355).
      }
    });

    on('kick', (event: Record<string, unknown>) => {
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
      // Were WE the one kicked? Decided here because this is the only place
      // that knows both the kicked nick and our current one — decorateMessage
      // sees neither, and a nick comparison made later would answer for the
      // nick we hold THEN, not the one we were wearing when it happened.
      // ⚠ Not `self`, which means "we sent this line": the kicker is someone
      // else. This says the kicked party is us (#968).
      //
      // isSelfNick reads `this.currentNick` — the server-tracked nick — where
      // this used to read `c.user.nick`. The framework lags: it fires the 'all'
      // proxy that routes events to us BEFORE its own listener updates
      // user.nick, which is why RPL_WELCOME and snapshot() already route around
      // it (#362). A nick fallback at registration is the case that bites — the
      // server lands you on `me_`, c.user.nick still says `me`, and a kick of
      // `me_` reads as someone else's: no notification, and the buffer stays
      // styled as joined with its autojoin intact.
      const selfKicked = this.isSelfNick(eventKicked);
      this.publish({
        type: 'kick',
        target: channel,
        nick: eventNick,
        kicked: eventKicked,
        text: event.message as string | undefined,
        userhost: buildUserhost(event),
        time: event.time,
        ...(selfKicked ? { selfKicked: true } : {}),
      });
      // Mirror the self-PART path when we ourselves are the one kicked, so
      // the buffer dims in the sidebar instead of staying styled as joined.
      // Lowering autojoin also prevents the reconnect replay — rejoining a
      // channel that just kicked you reads as ban evasion to ops.
      if (selfKicked) {
        this.deleteChannel(eventChannel.toLowerCase());
        try {
          setBufferAutojoin(this.network.user_id, this.network.id, channel, false);
        } catch (_) {
          /* ignore */
        }
        this.publish({ type: 'channel-parted', target: channel });
      }
    });

    on('invite', (event: Record<string, unknown>) => {
      // irc-framework parses an inbound INVITE as { nick: inviter, invited:
      // target nick, channel }. Three cases land here (#261):
      const inviter = event.nick as string | undefined;
      const invited = event.invited as string | undefined;
      const rawChannel = event.channel as string | undefined;
      if (!inviter || !rawChannel || !invited) return;
      const me = this.currentNick;
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

    on('invited', (event: Record<string, unknown>) => {
      // RPL_INVITING (341): the server confirms OUR /invite was relayed.
      // irc-framework gives { nick: the invited nick, channel }. Render the same
      // persisted channel line as the op-visibility path, attributed to us — so
      // the confirmation shows up in the channel rather than the server buffer,
      // and the invite-notify self-echo above is deduped against it (#261).
      const invited = event.nick as string | undefined;
      const rawChannel = event.channel as string | undefined;
      const me = this.currentNick;
      if (!invited || !rawChannel || !me) return;
      const channel = canonicalChannelTarget(rawChannel, this.channels) ?? rawChannel;
      this.publish({ type: 'invite', target: channel, nick: me, invited, time: event.time });
    });

    on('quit', (event: Record<string, unknown>) => {
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

    on('nick', (event: Record<string, unknown>) => {
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
      //
      // ⚠⚠ …and against OUR nick too, because the framework's copy goes stale
      // and stays stale. client.js:266 refuses to store a nick beginning with a
      // digit ("reserved for uuids... they cannot be used"), which is exactly
      // what a server hands you when it resolves a netsplit nick collision —
      // Libera SAVEs you to your UID ("042AAEL37 Nick collision, forcing nick
      // change to your unique ID"). So `user.nick` keeps the pre-collision nick
      // forever, and the NEXT change — the one taking you back to a real nick —
      // has an old nick that matches neither. Keying on that alone lost the
      // user's identity for the rest of the session: own-nick never updated,
      // the auto-highlight rule kept the old name, and self-echo filtering
      // started treating our own lines as a stranger's.
      //
      // ⚠⚠ And OUR record is the authority, not the framework's. Preferring
      // theirs is not merely less accurate, it is wrong in a way that hands our
      // identity to someone else: while we sit on a UID, their `user.nick` still
      // names our old nick — which is now FREE. A stranger takes it, renames,
      // and we would follow them, because their rename's old nick matches the
      // stale copy. currentNick is seeded in the constructor and never unset, so
      // the framework check is a fallback that should never be needed.
      const isSelfNick = this.isSelfNick(eventNick);
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
          // Drop the regain watch. syncMonitor sends nothing on a server without
          // MONITOR, where no watch was placed and a `MONITOR -` would only draw
          // a 421 (#384). It keeps the nick listed if a bouncer client watches it.
          this.syncMonitor();
        }
        this.currentNick = eventNewNick;
        // Repair the framework's copy when it would otherwise stay behind. Its
        // own rule is kept — a digit-leading UID still isn't stored, because
        // other parts of it treat user.nick as something you could send as —
        // but the moment we're back on a usable nick the two agree again.
        // Without this, ircManager publishes self-messages under `client.user
        // .nick`, so a stale one puts the WRONG name on the user's own lines.
        if (!/^\d/.test(eventNewNick)) c.user.nick = eventNewNick;
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

    on('topic', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string;
      const eventTopic = event.topic as string | undefined;
      // A topic for a channel we are not in answers a query (/topic #elsewhere,
      // which the 'raw' handler already showed in the server buffer); it is not
      // membership (#908). Fold-aware, so a reply spelled #a{b} lands on the
      // #a[b] we joined.
      const ch = this.channelState(eventChannel);
      if (!ch) return;
      ch.topic = eventTopic ?? null;
      if (event.nick) {
        // A live TOPIC names its own setter and time. The row below carries
        // both to clients, so no channel-topic frame is needed.
        ch.topicSetBy = event.nick as string;
        ch.topicSetAt = normalizeEventTime(event.time ?? this.lineArrivedAt?.getTime());
        // Live TOPIC change — persist + render in the message list.
        this.publish({
          type: 'topic',
          target: ch.name,
          nick: event.nick as string,
          text: eventTopic,
          time: event.time,
        });
      } else {
        // RPL_TOPIC on join — sync the topic bar without printing a row, so
        // rejoining an already-open buffer doesn't repeat the same topic line
        // every time. The 333 behind it restates the setter and time; until
        // then the ones we hold may belong to an older topic.
        ch.topicSetBy = null;
        ch.topicSetAt = null;
        this.publishTopic(ch);
      }
    });

    // RPL_TOPICWHOTIME (333): who set the topic and when. Arrives as
    // `<setter> <ts>`, or on some servers `<ts>` alone — irc-framework reads a
    // lone ts as the setter's mask, so it lands in `nick` with `when` unset.
    on('topicsetby', (event: Record<string, unknown>) => {
      const ch = this.channelState(event.channel as string);
      if (!ch) return;
      let setBy = (event.nick as string | undefined) || null;
      let when = event.when as string | undefined;
      if (when == null && setBy && /^\d+$/.test(setBy)) {
        when = setBy;
        setBy = null;
      }
      ch.topicSetBy = setBy;
      ch.topicSetAt = unixSecondsToIso(when);
      this.publishTopic(ch);
    });

    on('mode', (event: Record<string, unknown>) => {
      const target = event.target as string | undefined;

      const eventModes = (event.modes as ModeEntry[] | undefined) || [];
      const eventRawModes = event.raw_modes as string | undefined;
      const eventRawParams = (event.raw_params as string[] | undefined) || [];
      const eventNick = event.nick as string | undefined;

      // Self user-mode change (e.g. server sets +i on connect, /OPER yields +o, etc.)
      if (target && this.isSelfNick(target)) {
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
      // Fold-aware, like the topic handler: on an rfc1459 network a MODE for
      // #a{b} is about the #a[b] we joined.
      const ch = this.channelState(target);
      // Apply per-user prefix modes (+o/-o, +v/-v, etc.) to the member map so
      // the snapshot keeps current modes after page reload.
      let memberModesChanged = false;
      let chanModesChanged = false;
      const spec = this.modeSpec();
      const listModes = new Set(spec.list);
      const prefixModes = new Set(spec.prefix.map((p) => p.mode));
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
            // Rank order, so the array reads highest-first the way a NAMES
            // reply with multi-prefix does — never grant order.
            member.modes = sortByRank([...set], spec.prefix);
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
            // Param values (`+l 50`) for the channel modal — all but the key.
            if (letter !== 'k') {
              if (sign === '+' && m.param) {
                if (ch.modeParams.get(letter) !== m.param) {
                  ch.modeParams.set(letter, m.param);
                  chanModesChanged = true;
                }
              } else if (sign === '-' && ch.modeParams.delete(letter)) {
                chanModesChanged = true;
              }
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
    // requiring us to have observed the +/− history. 324 is the whole state,
    // so the letters and param values replace rather than merge (weechat, soju
    // and ZNC all do).
    //
    // ⚠ It never touches the STORED key, in either direction. The value a 324
    // shows can be a mask — `*`, or InspIRCd's `<key>` to a non-member — and a
    // 324 without `k` may be about a key we still need; only a live MODE ±k
    // (resolveKeyModeChange) writes buffers.key.
    on('channel info', (event: Record<string, unknown>) => {
      const eventChannel = event.channel as string | undefined;
      if (!eventChannel) return;
      const ch = this.channelState(eventChannel);
      if (!ch) return;
      // RPL_CREATIONTIME (329) arrives as its own 'channel info' carrying only
      // `created_at`, in unix seconds.
      if (event.created_at !== undefined) {
        const createdAt = unixSecondsToIso(event.created_at);
        if (createdAt !== ch.createdAt) {
          ch.createdAt = createdAt;
          this.publishChannelModes(ch);
        }
        return;
      }
      const eventModes = event.modes as ModeEntry[] | undefined;
      if (!eventModes) return;
      const listModes = this.listModes();
      const next = new Set<string>();
      const nextParams = new Map<string, string>();
      for (const m of eventModes) {
        if (!m || !m.mode) continue;
        const letter = m.mode.replace(/^[+-]/, '');
        if (!letter || listModes.has(letter)) continue;
        next.add(letter);
        if (letter !== 'k' && m.param) nextParams.set(letter, m.param);
      }
      const before = [...ch.modes].toSorted().join('');
      const after = [...next].toSorted().join('');
      if (before !== after || !sameModeParams(ch.modeParams, nextParams)) {
        ch.modes = next;
        ch.modeParams = nextParams;
        this.publishChannelModes(ch);
      }
    });

    on('userlist', (event: Record<string, unknown>) => {
      const tHandler = Date.now();
      const eventChannel = event.channel as string;
      const eventUsers = (event.users as Record<string, unknown>[]) || [];
      // Only a channel we are in has a nicklist to replace. A NAMES reply for
      // any other — a typed /names #elsewhere, a restore step answered after a
      // KICK — used to create one, and the channel then read as joined with a
      // nicklist that didn't have us in it (#908). The 'raw' handler shows such
      // a reply in the server buffer instead.
      const ch = this.channelState(eventChannel);
      if (!ch) return;
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
      // channel. away-notify keeps it live after this initial sync. The reply is
      // Lurker's own, so the 'wholist' handler takes it in silently instead of
      // echoing every member to the server buffer (#342). Only after the NAMES
      // a JOIN brings or a restore asks for: by the time the user or a bouncer
      // client asks for NAMES, the away state is already live.
      //
      // Exception: on a RESTORE, a very large channel's away-sync WHO is skipped
      // (RESTORE_WHO_MAX_MEMBERS) — its 352-per-member reply is the heaviest part
      // of the reconnect burst. The restore's own NAMES is Lurker's, and
      // restoreQuiet marks the channels whose NAMES the previous process asked
      // for, so this never touches a fresh interactive join (which WHOs in
      // full, any size).
      const owner = this.replyOwner;
      const syncAway = owner === null || owner === 'unasked' || owner === 'lurker';
      const rq = this.restoreQuiet.get(eventChannel.toLowerCase());
      const inRestore = owner === 'lurker' || (!!rq && Date.now() < rq.until);
      const whoMax = reconnectEnvInt('LURKER_RESTORE_WHO_MAX_MEMBERS', RESTORE_WHO_MAX_MEMBERS);
      if (syncAway && inRestore && ch.members.size > whoMax) {
        // Diagnostic only (docker logs), never a server-buffer row: on a big
        // multi-network restore this can fire per channel.
        console.log(
          `[irc] restore: skipped away-sync WHO for ${eventChannel} (${ch.members.size} members > ${whoMax}) ` +
            `on network ${this.network.id}; away-notify keeps it live`,
        );
      } else if (syncAway) {
        this.sendAwaySyncWho(eventChannel);
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

    on('wholist', (event: Record<string, unknown>) => {
      const tHandler = Date.now();
      const eventTarget = event.target as string | undefined;
      const targetKey = eventTarget?.toLowerCase() ?? '';
      const users = (event.users as Record<string, unknown>[]) || [];

      // Render a user-typed /who to the server buffer. The auto-WHO we fire on
      // join is Lurker's own and taken in silently (echoing one line per member
      // would flood the buffer), and a bouncer client's is the client's (#931);
      // the user's surfaces like any other server response (#342). This runs
      // before the channel lookup below so /who <nick> and /who <unjoined-chan>
      // — where we have no tracked channel — still render. Whoever asked, the
      // members' away state below is still news.
      if (this.replyForUser()) {
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
    on('away', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      this.applyMemberAway(event.nick as string, true);
      this.markPeerEvent(event.nick as string, 'away', (event.message as string | null) || null);
    });
    on('back', (event: Record<string, unknown>) => {
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
    on('whois', (event: Record<string, unknown>) => {
      if (!event || !event.nick) return;
      // A bouncer client's /whois is its own, not the profile modal's (#931).
      if (!this.replyForUser()) return;
      this.publishEphemeral({ type: 'whois_result', whois: event });
    });

    // Channel list (`/LIST`). irc-framework batches RPL_LIST every 50 rows and
    // again at RPL_LISTEND. Each batch lands in the per-network SQLite cache;
    // clients only see progress events (running count) — the actual rows are
    // fetched via the chanlist-search WS handler against the cache. Keeps a
    // 6k-row libera.chat list off the wire and out of client memory. Only the
    // user's LIST touches the cache: a bouncer client's used to wipe and
    // rewrite it under the web app (#931).
    on('channel list start', () => {
      if (!this.replyForUser()) return;
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
    on('channel list', (channels: any) => {
      if (!this.replyForUser()) return;
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
    on('channel list end', () => {
      if (!this.replyForUser()) return;
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

    on('irc error', (event: Record<string, unknown>) => {
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
      // A 401 answering a bouncer client's WHOIS is that client's; the raw
      // handler kept it out of the server buffer too (#931).
      if (tag === 'no_such_nick' && !this.replyForUser()) return;
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
      // A 401 nothing above claimed is already reported: the raw handler logged
      // "<nick> No such nick/channel" in the server buffer. The generic line at
      // the bottom would be a second copy, and as an 'error' row it counts
      // toward the server buffer's unread badge — so a /whois for someone
      // offline, whose miss the profile modal already shows, badged the server
      // tab (#904). Same call as the command-result tags below. A 401 is only
      // ever an answer to something we sent, never the killed/banned/dropped
      // class that badge is for.
      if (tag === 'no_such_nick') return;
      // Channel-join rejections (full / invite-only / banned / bad key / too
      // many channels) carry the target in event.channel. Route them to that
      // channel as an ephemeral toast so the failure surfaces where the user
      // tried to join instead of in the server buffer (#260). Toast-only: the
      // client waits for channel-joined before opening the buffer, so on
      // failure there is no buffer to render into.
      const rejectChannel = event?.channel as string | undefined;
      // A rejection of a JOIN ends it, so the mark goes (see pendingJoins) —
      // every join rejection, not just the durable ones below, since a 471 we
      // will retry still ended THIS join.
      //
      // ⚠ Only the ones that can answer a JOIN. `event.channel` is set on
      // plenty of errors that answer something else — a 404 refusing a message
      // to the channel, a 482 refusing a mode — and clearing on those drops a
      // mark for a JOIN still in flight. The close that followed would then
      // send no PART, and the echo would reopen the buffer it had just closed.
      // Being too narrow here is the safer miss: an exotic rejection nobody
      // listed leaves the mark, and the close sends the PART it always used to.
      if (rejectChannel && joinRejectionMessageByTag(tag)) {
        this.pendingJoins.delete(foldTargetFor(this.network.id, rejectChannel));
      }
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
      // ERR_MONLISTFULL is handled off the raw line, which says which nicks.
      if (tag === 'monitor_list_full') return;
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

    on('tagmsg', (event: Record<string, unknown>) => {
      const me = this.currentNick;
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
    const me = this.currentNick;
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

  // Deduped union of the nicks we want MONITORed — every tracked reason shares
  // the one per-connection MONITOR budget.
  monitoredNicks(): string[] {
    return Array.from(this.trackedPeers.keys());
  }

  // Lurker's own nicks for the MONITOR list: the regain nick, then the tracked
  // peers. Bouncer clients' nicks are added after these.
  private ownMonitorNicks(): string[] {
    const nicks = this.monitoredNicks();
    return this.regainNick ? [this.regainNick, ...nicks] : nicks;
  }

  // Whether Lurker itself watches `nick`: a tracked peer or the regain nick.
  private isOwnMonitorNick(nick: unknown): boolean {
    if (typeof nick !== 'string') return false;
    const lower = nick.toLowerCase();
    return this.trackedPeers.has(lower) || this.regainNick?.toLowerCase() === lower;
  }

  // Bring the network's MONITOR list in line with Lurker's nicks and those of
  // every attached bouncer client (see monitorList.ts). Sends nothing until
  // ISUPPORT confirms MONITOR, or while the socket is down; the seed catches up.
  syncMonitor(): MonitorSync | null {
    if (!this.useMonitor || this.state !== 'connected' || this.disposed) return null;
    return this.monitor.sync(this.ownMonitorNicks(), this.monitorLimit);
  }

  // Apply a raw MONITOR +, - or C (a connect command, or /quote) to the raw
  // sender's own list and sync, the way a bouncer client's MONITOR works. Sent
  // verbatim it would change the network's list behind MonitorList's back: a
  // MONITOR C would clear every watch while the list still counted them. L and S
  // go out as sent, and so does anything on a network known to lack MONITOR,
  // which answers 421. True if the line was handled here.
  private takeRawMonitor(line: string): boolean {
    if (!this.applyRawMonitor(line)) return false;
    this.syncMonitor();
    return true;
  }

  // takeRawMonitor's change to the raw sender's list, without the sync. False
  // if the line isn't a MONITOR +, - or C, or has to go out as sent.
  private applyRawMonitor(line: string): boolean {
    const m = /^MONITOR\s+([+\-C])(?:\s+:?(\S+))?\s*$/i.exec(line.trim());
    if (!m || (this.isupportComplete && !this.useMonitor)) return false;
    if (m[1].toUpperCase() === 'C') {
      this.rawMonitored.clear();
    } else {
      for (const target of (m[2] ?? '').split(',').filter(Boolean)) {
        const key = target.toLowerCase();
        if (m[1] === '-') this.rawMonitored.delete(key);
        else if (!this.rawMonitored.has(key)) this.rawMonitored.set(key, target);
      }
    }
    this.monitor.addHolder(this.rawMonitorHolder);
    return true;
  }

  // A raw MONITOR + failed for these nicks, for lack of room or because the
  // network refused them. Stop asking for them and say so, because the 734
  // itself stays out of the server buffer.
  private dropRawMonitors(nicks: string[], limit: number | string): void {
    for (const nick of nicks) this.rawMonitored.delete(nick.toLowerCase());
    this.publish({
      type: 'notice',
      target: this.serverTarget(),
      nick: 'lurker',
      notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
      text: `MONITOR limit (${limit}) reached; not watching ${nicks.join(', ')}.`,
    });
  }

  // Seed the MONITOR list once per connection, from the 'server options' handler
  // after ISUPPORT confirms MONITOR. MonitorList packs the nicks into lines under
  // the 512-byte limit, so a 100-peer seed doesn't trip "Excess Flood" on Libera.
  // Nicks past monitorLimit stay tracked in memory but aren't watched; a notice
  // tells the user live presence is degraded for them.
  seedMonitorWatch(): void {
    // A re-attach finds the socket's list as the last app process left it,
    // nicks its bouncer clients watched included. Start from an empty one. The
    // connect commands don't run again on a re-attach (they ran when the socket
    // registered), so apply their MONITOR lines from the network's config
    // first, or the clear would drop those watches for good.
    if (this.restoring) {
      const commands = this.network.connect_commands;
      if (typeof commands === 'string') {
        for (const line of commands.split(/\r?\n/)) this.applyRawMonitor(line);
      }
      try {
        this.client.raw('MONITOR C');
      } catch (_) {
        /* ignore */
      }
    }
    // MonitorList.sync asks for the state of what it adds with a MONITOR S
    // (#302): the server is only advised to volunteer it in reply to the +, and
    // markPeerEvent's idempotency gate eats duplicate replies.
    const result = this.syncMonitor();
    if (!result) return;
    const overflow = result.skipped.length;
    if (overflow > 0) {
      this.publish({
        type: 'notice',
        target: this.serverTarget(),
        nick: 'lurker',
        notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
        text: `MONITOR limit (${result.limit}) reached; live presence skipped for ${overflow} nick${overflow === 1 ? '' : 's'}.`,
      });
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
    const me = this.currentNick;
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
    const listed = this.monitor.status(nick);
    if (listed === true || listed === false) {
      // A bouncer client already has the nick on the list, and the network
      // won't answer a second add, so use its last answer.
      this.markPeerEvent(nick, listed ? 'online' : 'offline');
      return true;
    }
    if (listed === undefined) {
      const result = this.syncMonitor();
      if (result?.skipped.some((n) => n.toLowerCase() === lower)) {
        // Over-limit add: keep the in-memory tracking but skip MONITOR. Surface
        // once so the user knows live presence is degraded for this nick.
        this.publish({
          type: 'notice',
          target: this.serverTarget(),
          nick: 'lurker',
          notable: false, // #470: status line — not counted as unread (see MessageInput.notable)
          text: `MONITOR limit (${result.limit}) reached; live presence skipped for ${nick}.`,
        });
      }
      // The sync asked for the new nick's state along with its MONITOR +.
      return true;
    }
    // Listed by a bouncer client but not answered yet. Per IRCv3 the server only
    // SHOULD volunteer a nick's state, and a peer left at 'unknown' renders like
    // online until a reconnect re-seeds, so ask (#302). markPeerEvent's
    // idempotency gate eats duplicate replies.
    this.monitor.requestStatus();
    return true;
  }

  // Tear down the shared MONITOR watch + peer_presence_state row for a nick we
  // no longer watch for any reason. Safe on an untracked nick (clears a stale
  // row). The sync keeps the nick listed while a bouncer client still watches it.
  private teardownPeerWatch(nick: string): void {
    this.syncMonitor();
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
    // The retry has to name a key for +k: a bare `/join #x` repeats the JOIN
    // that just failed, with the same stored key or with none. Telling a user
    // to run the command that reproduces their failure is worse than saying
    // nothing.
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
    // sasl_password, not just sasl_account: connect() attempts SASL whenever a
    // PASSWORD is set, falling back to the nick as the authcid — so keying only
    // on the account missed a password-only setup entirely. It matters because
    // identifiedToServices is set by RPL_LOGGEDIN (900) alone, and a server may
    // answer a successful SASL with 903 and no 900 at all; the gate is then the
    // only thing standing between an early 473 and a durable unsubscribe.
    if (this.network.sasl_account || this.network.sasl_password) return true;
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
    this.deleteChannel(name.toLowerCase());
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

  /** Whether we are in `name`, or about to be: membership plus the one state
   *  the channels map can't see, a JOIN we sent whose echo hasn't landed.
   *  Membership is echo-written, so between the request and its echo the map
   *  says "no" for a channel we are about to be in, and a command sent now
   *  reaches the server behind that JOIN.
   *
   *  This is the probe for a caller deciding whether to ACT on the network —
   *  whether a close owes a PART. Being wrong one way leaks a 442 to every
   *  attached client (#967); being wrong the other leaves the user in a
   *  channel they closed. isChannelJoined stays the probe for rendering what
   *  we know now.
   *
   *  ⚠ And a PART on the wire takes it back off. Membership is echo-written in
   *  both directions, so the map still says yes for a channel we have already
   *  parted — from an attached client, from another tab, or from this very
   *  close a moment ago. Acting on that is the second PART and the 442 all over
   *  again, which also makes a close of an already-closed buffer idempotent on
   *  the wire.
   *
   *  ⚠ `restoring` is deliberately NOT part of this. A restore's replayed
   *  self-JOIN already reconciles a channel whose row says autojoin=0 or
   *  closed by PARTing it ("this is that PART, late", in the join handler), so
   *  a caller that also parted would send it twice and the loser would draw
   *  the 442. The replay owns that window; nobody else writes into it. */
  mayBeJoined(name: string): boolean {
    const folded = foldTargetFor(this.network.id, name);
    if (this.pendingParts.has(folded)) return false;
    return this.isChannelJoined(name) || this.pendingJoins.has(folded);
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

  // setChannel and deleteChannel exist so that we don't forget to null
  // joinedFoldedCache.
  private setChannel(key: string, ch: ChannelState): void {
    this.channels.set(key, ch);
    this.joinedFoldedCache = null;
  }

  private deleteChannel(key: string): boolean {
    const folded = foldTargetFor(this.network.id, key);
    // The one place membership leaves the map, so the one place a part awaiting
    // its answer has been answered: the PART echo, a kick, a 442's eviction, the
    // engine's prune on re-attach. Unconditional — the mark must go even when
    // there was no entry to delete, or a PART for a channel we had already left
    // would leave one behind forever.
    this.pendingParts.delete(folded);
    // ⚠ Fold-aware, like isChannelJoined and channelState (#707). Every caller
    // hands this a raw `.toLowerCase()` of whatever the SERVER said, while the
    // map is keyed by the name we joined under — and those differ whenever an
    // ircd echoes a fold variant, `#foo{bar}` for a `#foo[bar]` we are in on an
    // rfc1459 network. An exact-key delete misses that entry, so membership
    // goes on claiming we are in a channel we have left for the life of the
    // connection: the next close sends a second PART, the server answers 442,
    // and that is #967 by another road. Exact hit first, so the ordinary case
    // stays one probe; the fallback scans the joined channels, a handful, for
    // the same reason channelState is deliberately a scan.
    let actual = key;
    if (!this.channels.has(key)) {
      for (const k of this.channels.keys()) {
        if (foldTargetFor(this.network.id, k) === folded) {
          actual = k;
          break;
        }
      }
    }
    const deleted = this.channels.delete(actual);
    if (deleted) this.joinedFoldedCache = null;
    return deleted;
  }

  // The joined set belongs to one socket, so it dies with it (#908). Kept, a
  // channel whose rejoin the server refused — a 477 before services identify
  // us, a ban set while we were away — read as joined for the life of the
  // process: the snapshot said joined, nothing arrived, and a 477 for it was
  // taken for a speak rejection. Each one is announced parted so clients dim
  // it; a rejoin that lands lights it again through its echo.
  //
  // autojoin is deliberately untouched: a dropped socket is not the user
  // leaving, and that flag is what the reconnect's rejoin reads.
  private forgetJoinedChannels(): void {
    // A join key rides until its echo, and no echo comes for a JOIN sent on a
    // dead socket. Left behind, it would be taken by the next echo for that
    // name — a keyless /join on the new socket — and stored as the channel's
    // key. Cleared even with no channels joined: the join that never landed is
    // exactly the case with none.
    this.pendingJoinKeys.clear();
    this.pendingJoins.clear();
    this.pendingParts.clear();
    if (this.channels.size === 0) return;
    const names = Array.from(this.channels.values(), (ch) => ch.name);
    this.channels.clear();
    this.joinedFoldedCache = null;
    for (const name of names) this.publish({ type: 'channel-parted', target: name });
  }

  upsertChannel(name: string): ChannelState {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = {
        name,
        topic: null,
        topicSetBy: null,
        topicSetAt: null,
        members: new Map(),
        modes: new Set(),
        modeParams: new Map(),
        createdAt: null,
      };
      this.setChannel(key, ch);
    }
    if (!ch.modes) ch.modes = new Set();
    return ch;
  }

  /** Mark a JOIN put on the wire, for every channel in a comma list.
   *
   *  A JOIN supersedes a PART still in flight for the same channel: rejoining is
   *  the whole point, and a stale part mark would have the next close send
   *  nothing and leave us in it.
   *
   *  ⚠ And superseding one is itself the reason to track this JOIN. While that
   *  PART is unanswered the map still says joined, so the membership test reads
   *  "already in it" and marks nothing — then the PART echo lands, membership
   *  goes false, and NOTHING says a JOIN is outstanding. A close in that gap
   *  sends no PART and the JOIN echo reopens the buffer it closed. A cycle has
   *  to be tracked even though we look like a member: we are about to stop
   *  being one, briefly.
   *
   *  ⚠ Only a channel whose outcome is UNKNOWN otherwise. A JOIN for one we are
   *  already in is answered by nothing — no echo, as ircManager.joinChannel says
   *  in the branch that sends it — so a mark would never be cleared, and after
   *  the user later parted, mayBeJoined would still say yes and the close would
   *  PART a channel we had left. That is #967 again, from the guard meant to
   *  prevent it. */
  private noteJoinSent(channelList: string): void {
    for (const one of channelList.split(',')) {
      if (!one) continue;
      const folded = foldTargetFor(this.network.id, one);
      const supersededPart = this.pendingParts.delete(folded);
      if (supersededPart || !this.isChannelJoined(one)) this.pendingJoins.add(folded);
    }
  }

  /** Mark a PART put on the wire, for every channel in a comma list. Leaving
   *  also ends any join we were still waiting on: a JOIN the server never
   *  answered leaves its mark behind (nothing else clears one), and the next
   *  close would read it as "maybe in there" and PART again. */
  private notePartSent(channelList: string): void {
    for (const one of channelList.split(',')) {
      if (!one) continue;
      const folded = foldTargetFor(this.network.id, one);
      this.pendingJoins.delete(folded);
      this.pendingParts.add(folded);
    }
  }

  /** The same marks for a JOIN or PART that reaches the socket as a raw line.
   *
   *  ⚠ `/quote PART #x` and `/raw JOIN #x` do not go through part() or join() —
   *  they are handed to raw() verbatim (wsHub's 'raw' verb) — so without this
   *  the marks are simply missing, and a close right after a raw PART sends the
   *  duplicate this all exists to stop. Read on the way out, like
   *  takeRawMonitor and noteOutgoingCommand beside it: raw() is the one path
   *  every slash command and member-menu action takes. */
  private noteRawMembership(line: string): void {
    // The verb, past an IRCv3 tag block the caller may have put in front of it.
    const parsed = /^\s*(?:@\S+\s+)?(JOIN|PART)\s+(\S+)/i.exec(line);
    if (!parsed) return;
    const targets = parsed[2];
    if (parsed[1].toUpperCase() === 'PART') return this.notePartSent(targets);
    // `JOIN 0` leaves every channel at once (RFC 2812 3.2.1) — it is a PART of
    // all of them, and it is what a bouncer client's `JOIN 0` relays to.
    if (targets === '0') {
      for (const ch of this.channels.values()) this.notePartSent(ch.name);
      // Including channels whose own JOIN is still in flight: those are not in
      // the map yet, so the loop above misses them, and the mark left behind
      // would have a close PART the very channel this command is abandoning.
      // Moved rather than dropped, so the answer still holds once their JOIN
      // echo lands and briefly makes them members.
      for (const folded of this.pendingJoins) this.pendingParts.add(folded);
      this.pendingJoins.clear();
      return;
    }
    this.noteJoinSent(targets);
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
      modeParams: Object.fromEntries(ch.modeParams),
      createdAt: ch.createdAt,
    });
  }

  // The topic bar's state, without a history row: 332/331 and 333.
  private publishTopic(ch: ChannelState): void {
    this.publishEphemeral({
      type: 'channel-topic',
      target: ch.name,
      topic: ch.topic,
      setBy: ch.topicSetBy,
      setAt: ch.topicSetAt,
    });
  }

  /**
   * A channel's ban, exception, invite-exception or quiet list, fresh from the
   * server (see modeList.ts). Two asks for the same list while one is out share
   * it.
   */
  fetchModeList(channel: string, letter: string): Promise<ModeListResult> {
    if (!this.modeSpec().list.includes(letter)) {
      return Promise.resolve({ ok: false, error: 'not-a-list-mode' });
    }
    // Lists whose numerics the router doesn't know (InspIRCd's +g, +w, …) would
    // go out untracked and their replies would print as unasked.
    const numerics = listModeNumerics(letter);
    if (!numerics) return Promise.resolve({ ok: false, error: 'unsupported-list-mode' });
    if (this.state !== 'connected') return Promise.resolve({ ok: false, error: 'not-connected' });
    const name = this.channelState(channel)?.name ?? channel;
    const key = `${foldTargetFor(this.network.id, name)} ${letter}`;
    const inFlight = this.modeListFetches.get(key);
    if (inFlight) return inFlight;
    let resolve!: (result: ModeListResult) => void;
    const promise = new Promise<ModeListResult>((r) => (resolve = r));
    // In the map BEFORE the send: a query that can't go out is aborted
    // synchronously, and its settle must find (and remove) this entry.
    this.modeListFetches.set(key, promise);
    const collector = new ModeListCollector(numerics, (result) => {
      if (this.modeListFetches.get(key) === promise) this.modeListFetches.delete(key);
      resolve(result);
    });
    this.raw(`MODE ${name} +${letter}`, collector);
    return promise;
  }

  /** This network's channel-mode vocabulary, from its ISUPPORT (#727). */
  modeSpec(): ModeSpec {
    return parseModeSpec(this.client.network?.options);
  }

  // The spec as clients see it: null until the registration burst has ended.
  // Before then modeSpec() is the RFC defaults, or a half-read 005 (CHANMODES
  // seen, PREFIX not yet), and a client can't tell either from a network that
  // actually said so — /quiet would refuse on Libera for the first second.
  clientModeSpec(): ModeSpec | null {
    return this.isupportComplete ? this.modeSpec() : null;
  }

  // Tell clients when the spec changes: once when the registration burst ends,
  // then on any later 005. irc-framework fires 'server options' once per 005
  // line, so most calls change nothing.
  private publishModeSpecIfChanged(): void {
    const spec = this.clientModeSpec();
    if (!spec) return;
    const json = JSON.stringify(spec);
    if (json === this.publishedModeSpec) return;
    this.publishedModeSpec = json;
    this.publishEphemeral({ type: 'mode-spec', target: this.serverTarget(), modeSpec: spec });
  }

  // List-type channel modes (CHANMODES group A) carry a mask param — bans,
  // ban/invite exceptions, and quiets on ircds that model them as a list — that
  // we don't surface in the status bar. We read the set from the server's
  // ISUPPORT CHANMODES so it's correct per-ircd, falling back to the RFC
  // defaults before 005 has been parsed (a server that legitimately declares
  // an empty group A keeps its empty set rather than the default).
  // This is the same categorisation weechat/irssi/gamja use. Parameter modes
  // like +k/+l are NOT list modes, so they still land in the (+...) display.
  // Member-prefix modes (o/v/h, plus q/a where an ircd uses them as prefixes)
  // are filtered earlier by prefixModes(), so they never reach this set.
  private listModes(): Set<string> {
    return new Set(this.modeSpec().list);
  }

  // Member-prefix (membership) modes, from the server's ISUPPORT PREFIX token —
  // the same 005 origin listModes() reads CHANMODES from, so the two agree
  // per-ircd. irc-framework parses `PREFIX=(ov)@+` into {symbol, mode} pairs
  // (registration.js), and leaves the RAW STRING in place when the token is
  // malformed — which parseModeSpec treats as absent (shared/channelModes.ts).
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
  // listModes). The fallback covers pre-005 and malformed tokens only.
  private prefixModes(): Set<string> {
    return new Set(this.modeSpec().prefix.map((p) => p.mode));
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
    // ⚠ Checked BEFORE the certificate one only because the order has to be
    // stable; both refuse the same way. A proxy that cannot be used stops the
    // dial — see proxyBlockedReason.
    const blocked = this.proxyBlockedReason() ?? this.clientCertBlockedReason();
    if (blocked) {
      // Never dial past this. Connecting without the certificate is not a
      // degraded version of what the user asked for, it is a different
      // identity: they arrive as an unrecognised stranger, +R channels refuse
      // them, and under EXTERNAL the registration fails with a SASL error that
      // points at the wrong thing entirely.
      const text = `Not connecting: ${blocked}.`;
      this.publish({ type: 'error', target: this.serverTarget(), text });
      this.logNet(`Connect blocked: ${blocked}`, 'warn');
      this.setState('disconnected', { error: text });
      // Nothing here will retry — no socket opened, so no 'close' to schedule
      // one from — and every one of these reasons is fixed by editing the
      // network. Ask to be dropped, or the manager's map keeps a connection
      // that no longer matches the row: startNetwork is a documented no-op when
      // one already exists, so /connect would answer ok having done nothing,
      // forever, even after the certificate is removed. Same reasoning as
      // gateReconnect's delete (#616).
      this.onNeedsRebuild?.();
      return;
    }
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
      // Route this network's socket through its proxy (#303). Spread BEFORE
      // engineConnectOptions on purpose: in engine mode the dial happens in
      // another process, so the engine's transport must win — it carries the
      // proxy in its CONNECT frame instead (see engineConnectOptions).
      ...this.proxyConnectOptions(),
      ...this.engineConnectOptions(),
    });
  }

  /** Why this network's proxy cannot be used, or null when there isn't one and
   *  nothing is wrong.
   *
   *  ⚠⚠ EVERY answer here is a refusal to dial, never a fallback to a direct
   *  connection. A proxy is not a preference that degrades gracefully: dialling
   *  direct hands the ircd — and everyone running /whois on it — the address
   *  the user was specifically trying not to expose, with no signal that
   *  anything went wrong, and the connection WORKS, which is the worst possible
   *  outcome. Same shape as clientCertBlockedReason, and for a stronger reason.
   *
   *  Re-validated on every connect rather than trusted from the write path,
   *  because the routes are not the only writer: archive import inserts the
   *  proxy columns verbatim (exportSchema drives its column list), so a
   *  hand-edited archive can plant an unusable proxy that never passed a
   *  route. */
  private proxyBlockedReason(): string | null {
    const proxy = networkProxy(this.network);
    if (!proxy) return null;
    if (isProxyProblem(proxy)) {
      return `this network's proxy is unusable (${proxy.error})`;
    }
    // The instance lockdown applies on the connect path too, not only on write
    // — an admin who closes the instance must close the connections it already
    // has, the same way isNetworkHostAllowed is re-checked here.
    if (!mayUseProxy()) {
      return 'this server does not allow connecting through a proxy of your own';
    }
    // ⚠⚠ Engine mode dials in ANOTHER process. An engine below protocol minor 5
    // has no field to carry the proxy in and would ignore it silently — so the
    // app would report a proxied network while the engine opened a direct
    // socket carrying the user's real address. Worse than the certificate case
    // at minor 2, which at least fails visibly. Only refuse once the engine has
    // actually said hello; before that its minor is unknown, and the transport
    // makes the same check again at frame-build time.
    const link = EngineLink.shared();
    if (engineConfigured() && link.engineMinor !== null && !link.supportsProxy()) {
      return 'the IRC engine this deployment connects through cannot route a connection via a proxy — update the engine, or remove the proxy';
    }
    return null;
  }

  /** This network's usable proxy, or undefined. Only ever reached once
   *  proxyBlockedReason() has passed, so anything here is valid and allowed. */
  private proxyConfig(): ProxyConfig | undefined {
    const proxy = networkProxy(this.network);
    return proxy && !isProxyProblem(proxy) ? proxy : undefined;
  }

  /** DCC cannot be used on a proxied network (#303).
   *
   *  ⚠⚠ DCC bypasses the tunnel completely and in both directions: a receive
   *  dials the peer straight out (`dccReceiver.ts` is a bare `net.connect`),
   *  and an offer advertises an address the peer must be able to reach. So on a
   *  proxied network the first file transfer is the user's real address, out,
   *  with no warning — while every IRC line they send is still going through
   *  the proxy.
   *
   *  Refusing is the honest v1. Routing DCC properly needs passive DCC and
   *  belongs to the DCC milestone, not here. Cheap today: DCC is off by default
   *  and needs both a cell-wide switch and a per-user capability, so the
   *  intersection is small — which is exactly why to close it before someone
   *  ships an fserve on top of it. */
  private dccBlockedByProxy(): boolean {
    return !!this.proxyConfig();
  }

  /** Why an attached CertFP pair cannot be presented on this connect, or null
   *  when there is nothing attached or nothing wrong. Checked before dialing:
   *  every case here would otherwise become a connection that looks fine and
   *  authenticates as nobody.
   *
   *  The PEMs are re-validated on each connect rather than trusted from the
   *  write path, because the routes are not the only writer — archive import
   *  inserts both columns verbatim (exportSchema drives its column list), so a
   *  hand-edited or truncated archive can plant half a pair or an unparseable
   *  key. An unparseable key reaching tls.connect throws SYNCHRONOUSLY out of
   *  client.connect(), and on a backoff retry that is an uncaught exception in
   *  a shared process. */
  private clientCertBlockedReason(): string | null {
    const { client_cert, client_key } = this.network;
    if (!client_cert && !client_key) return null;
    if (!client_cert || !client_key) {
      return 'this network has half a client certificate — a certificate and its key are only usable together';
    }
    const pair = validateClientCertPair(client_cert, client_key);
    if (isClientCertProblem(pair)) {
      return `this network's client certificate is unusable (${pair.error})`;
    }
    if (!this.network.tls) {
      return 'a client certificate can only be presented over TLS — enable TLS for this network, or remove the certificate';
    }
    const link = EngineLink.shared();
    if (engineConfigured() && link.engineMinor !== null && !link.supportsClientCert()) {
      // Engine mode dials in ANOTHER process. An engine below protocol minor 2
      // has no field to carry the certificate in and would ignore it silently,
      // so the app would ask for SASL EXTERNAL over a socket that presented
      // nothing. Only refuse once the engine has actually said hello — before
      // that its minor is unknown, and the transport makes the same check again
      // at frame-build time, where readiness is guaranteed.
      return 'the IRC engine this deployment connects through cannot present a client certificate — update the engine, or remove the certificate';
    }
    return null;
  }

  /** The attached CertFP pair in irc-framework's shape, or undefined. Only ever
   *  reached once clientCertBlockedReason() has passed, so both halves are
   *  present and parse. */
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

  /** Route this network through its proxy (#303).
   *
   *  `proxy` goes out in BOTH modes — in engine mode the transport puts it on
   *  the CONNECT frame and the engine dials through it. Only the transport
   *  override is direct-mode-only: in engine mode this process opens no socket
   *  at all, and engineConnectOptions (spread after this one) sets its own. */
  private proxyConnectOptions(): Partial<ConnectOptions> {
    const proxy = this.proxyConfig();
    if (!proxy) return {};
    if (engineConfigured()) return { proxy };
    return { transport: ProxyTransport as unknown as ConnectOptions['transport'], proxy };
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
        // A new socket. Anything we still think we are in belonged to one that
        // died while our link to the engine was down, so 'socket close' never
        // saw it go.
        this.forgetJoinedChannels();
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
          this.deleteChannel(key);
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
          until: Date.now() + reconnectEnvInt('LURKER_RESTORE_QUIET_MS', RESTORE_QUIET_MS),
          mode: true,
          topic: false,
        });
        this.rawQuiet('MODE', this.currentNick);
        // The account's away state, sent again. This socket missed any change
        // made while the link was down, or while no process was attached, and
        // nothing here knows what it was last told. The 305/306 is Lurker's.
        this.sendAwayState();
        this.requestUnnegotiatedCaps();
        this.restoreQueue = [...this.channels.values()].map((ch) => ch.name);
        // Every queued channel is marked quiet now: the LAST process may have
        // let go with a step in flight, and that step's replies sit in the
        // engine backlog, delivered right after this phase — the size gate on
        // the WHO and the server-buffer filter must read them as the restore's.
        // Nothing in this process asked for them, so the reply router can't
        // tell. The replies to this process's own steps are Lurker's, which
        // both read without a mark (replyRouter.ts).
        for (const name of this.restoreQueue) {
          this.restoreQuiet.set(name.toLowerCase(), {
            until: Date.now() + reconnectEnvInt('LURKER_RESTORE_QUIET_MS', RESTORE_QUIET_MS),
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
  // step the deadline ended without a reply has still not heard anything. The
  // bouncer's attach burst holds such a channel's NAMES back until it has.
  membersPending(name: string): boolean {
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
  // triggers ('userlist'), which waits behind any WHO already on the wire
  // (replyRouter.ts) — and a server that throttles simply sets the pace. The
  // WHO is deliberately NOT part of the gate: a 315 that does not come holds
  // the WHO queue for the router's whole timeout, and a step waiting on it
  // would turn that one lost reply into a wait for every channel after it.
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
  // flight per connection (the router's WHO queue), size-gated, but across
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

  // Caps this app wants that the socket it just re-attached to never
  // negotiated. The engine holds sockets across deploys, so a cap added in a
  // release only reaches a held socket when the user next really reconnects —
  // weeks, on a connection whose whole point is that it doesn't drop. A CAP REQ
  // after registration is legal under CAP 302: the server answers ACK or NAK
  // and no CAP END is owed. The ACK arrives as an ordinary line, and the engine
  // records it so the NEXT re-attach replays it too (#888).
  //
  // Only the caps this app asked for through requestCap(): irc-framework's own
  // want list is internal to its CAP handler, and it cannot drift under a held
  // socket anyway — bumping irc-framework moves the engine image, and an engine
  // recreate is a fresh dial with a fresh negotiation.
  private requestUnnegotiatedCaps(): void {
    const cap = this.client.network?.cap;
    if (!cap) return;
    const enabled = new Set(cap.enabled || []);
    // Only what the server advertised and has not already refused. Both halves
    // matter: a cap the server never listed is a NAK at best, and one it NAKed
    // stays advertised-but-not-enabled for the life of the socket — so without
    // the refusal set this would re-send the identical REQ on every re-attach,
    // which on a socket whose whole point is that it never drops is every
    // deploy and every link blip, forever.
    const missing = (this.client.request_extra_caps || []).filter(
      (name) => cap.available?.has(name) && !enabled.has(name) && !this.capsRefused.has(name),
    );
    if (missing.length === 0) return;
    // One REQ per cap, not one batch: a REQ is all-or-nothing, so a server that
    // would grant `batch` and refuse `draft/multiline` NAKs both — and the NAK
    // names both, which would put a perfectly grantable cap in the refusal set
    // for good. There are only ever a handful.
    for (const name of missing) {
      try {
        this.client.raw(`CAP REQ :${name}`);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // A restore's own request. Its reply is Lurker's, so it reaches neither the
  // server buffer nor a bouncer client (replyRouter.ts).
  private rawQuiet(command: string, arg: string): void {
    this.replies.send('lurker', `${command} ${arg}`);
  }

  // The away-sync WHO, as irc-framework's who() sends it: WHOX where the network
  // has it, with a token irc-framework parses the reply by (it drops a 354 whose
  // token it didn't hand out). The token is taken when the WHO goes out, not
  // when it's queued, so a client's WHOX carrying the same number can't use it
  // up first. Not who() itself: its queue moves on at any WHO's end, a client's
  // included, and stops for good at one that never comes.
  private sendAwaySyncWho(channel: string): void {
    this.replies.send('lurker', `WHO ${channel}`, () =>
      this.client.network.supports('whox')
        ? `WHO ${channel} %tcuhsnfdaor,${this.client.whox_token.next()}`
        : `WHO ${channel}`,
    );
  }

  // Whether the server line being handled is the user's to see: a reply to
  // their own query, or a line nobody asked for. Not a reply to Lurker's own
  // query, to a bouncer client's, or to one nobody here is waiting on (#931).
  // True outside a line's handlers, where nothing says otherwise.
  private replyForUser(): boolean {
    const owner = this.replyOwner;
    return owner === null || owner === 'user' || owner === 'unasked';
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

  // Whether this line is already stored.
  // - By msgid, always. A server can send a message twice with the same msgid
  //   and server-time: that's a match on msgid, buffer, kind, sender and text.
  //   In the catch-up window the msgid counts anywhere on the network. The next
  //   process after an engine hand-over is given lines the last one stored, and
  //   a later line in that backlog can have moved the row: a NICK renames the
  //   DM buffer, and our own NICK routes a notice elsewhere.
  // - Without a msgid, only in the catch-up window: the same buffer, kind,
  //   sender and text within a few seconds. Outside it that would drop real
  //   lines, such as a pasted block of repeated lines stamped in the same
  //   millisecond.
  private alreadyPersisted(event: IrcEvent, time: string): boolean {
    const target = event.target as string;
    const type = event.type;
    if (!target || !type) return false;
    const nick = (event.nick as string | undefined) ?? null;
    const text = (event.text as string | undefined) ?? null;
    if (typeof event.msgid === 'string' && event.msgid !== '') {
      if (this.catchingUp) return hasMessageWithMsgid(this.network.id, event.msgid);
      return hasSameMessageWithMsgid(this.network.id, target, event.msgid, type, nick, text);
    }
    return this.catchingUp && hasRecentMessageLike(this.network.id, target, type, nick, text, time);
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
    // One JOIN can carry many channels: the reconnect rejoin batches them
    // (planChannelRejoins packs `#a,#b,#c` up to the line limit), and an echo
    // names one. Marking the blob would leave an entry no echo ever clears and
    // no lookup ever matches — the guard inert on exactly the path where a
    // close races a join most often.
    //
    // ⚠ Only a channel whose outcome is UNKNOWN is marked. A JOIN for one we
    // are already in is answered by nothing — no echo, as ircManager.joinChannel
    // says in the branch that sends it — so a mark would never be cleared, and
    // after the user later parted, mayBeJoined would still say yes and the
    // close would PART a channel we had left. That is #967 again, from the
    // guard meant to prevent it. We are in it, so membership already answers.
    this.noteJoinSent(channel);
    this.client.join(channel, typeof key === 'string' ? key : undefined);
  }
  part(channel: string, reason?: string): void {
    this.notePartSent(channel);
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
  // One line per backoff window per peer. The limiter's backoff is five minutes,
  // so re-warning on every dropped offer would just move the flood into the
  // user's buffer.
  private warnDccFlood(nick: string, event: Record<string, unknown>): void {
    const key = this.ctcpPeerKey(event);
    const now = Date.now();
    const last = this.dccFloodWarnedAt.get(key);
    if (last !== undefined && now - last < DCC_FLOOD_WARN_GAP_MS) return;
    this.dccFloodWarnedAt.set(key, now);
    this.routeCtcpStatus(
      event,
      `Ignoring further DCC requests from ${nick} for a few minutes — too many arrived at once.`,
    );
  }

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
    // Who answers a type Lurker can answer was decided in the raw listener,
    // before any bouncer client's relay passed the request on. A batched
    // request's decision waited for irc-framework to run its line at the
    // batch's end. Only a request that came through no raw line is decided
    // here, so the peer's allowance goes once.
    const answerer = isAnswerableCtcp(type)
      ? (this.ctcpAnswerer ??
        this.takeBatchedCtcpAnswerer(event) ??
        this.ctcpAnswererFor(type, event))
      : null;
    if (answerer === 'nobody') return;
    // DCC rides CTCP but is never an auto-reply type. When DCC is enabled for
    // this user, hand the offer to the download manager instead of the generic
    // probe path; when disabled, fall through so it surfaces as an ordinary
    // unsupported CTCP ("requested CTCP DCC (no reply)"), unchanged from today.
    //
    // ⚠⚠ Ahead of the shared incoming-CTCP limiter, and with a bucket of its
    // own. That limiter exists to stop us ANSWERING a VERSION/PING storm, and
    // its budget is 3 per minute per peer followed by a five-minute silent
    // backoff — fine for noise nobody asked for, ruinous for a DCC offer, which
    // is a user-facing action the peer will naturally retry while getting their
    // own client configured. Sharing the bucket meant a fourth `/dcc chat` in a
    // minute vanished with no trace on either side, which is exactly how it
    // presented in QA.
    if (type === 'DCC' && dccEnabledForUser(this.network.user_id)) {
      // Say why, rather than letting it fall through to the generic
      // "requested CTCP DCC (no reply)". Only reached when DCC is otherwise
      // enabled for this user, so nobody who never had DCC sees a new line.
      if (this.dccBlockedByProxy()) {
        this.publish({
          type: 'error',
          target: this.serverTarget(),
          text: `Ignored a DCC offer from ${nick}: DCC does not go through this network's proxy, and accepting it would connect directly from this server.`,
        });
        return;
      }
      // Still bounded — a DCC offer flood is a real nuisance vector — but on its
      // own key, and NEVER silently: a dropped offer the user can't see is
      // indistinguishable from a broken feature.
      if (!this.ctcpLimiter.allowIncoming(`dcc:${this.ctcpPeerKey(event)}`)) {
        this.warnDccFlood(nick, event);
        return;
      }
      // DCC handling (parse + DB writes + socket setup) must never throw out of
      // the CTCP event path and disrupt the connection.
      try {
        this.handleInboundDccRequest(nick, args, event);
      } catch (e) {
        // ⚠ Swallowed so a malformed offer can't kill the connection, but say
        // SOMETHING — a bare catch here made a bug in the DCC path look
        // identical to the offer never arriving.
        this.routeCtcpStatus(
          event,
          `Couldn't handle a DCC request from ${nick}: ${(e as Error)?.message || e}`,
        );
      }
      return;
    }
    if (answerer === null && !this.ctcpLimiter.allowIncoming(this.ctcpPeerKey(event))) return;
    if (answerer === 'clients') {
      this.routeCtcpStatus(event, formatCtcpForwardedLine(nick, type));
      return;
    }
    const config = this.ctcpReplyConfig();
    const reply = buildCtcpReply(type, args, config, this.ctcpTemplateVars(config));
    if (reply !== null) this.client.ctcpResponse(nick, type, reply);
    this.routeCtcpStatus(event, formatCtcpRequestLine(nick, type, reply));
  }

  // Who answers a server line's CTCP request, for the raw listener: null for a
  // line that isn't a request Lurker could answer, and for our own.
  private ctcpAnswererForLine(msg: {
    nick?: string;
    ident?: string;
    hostname?: string;
    params?: string[];
  }): CtcpAnswerer | null {
    const ctcp = ctcpInText(String(msg.params?.[1] ?? ''));
    if (!ctcp || !msg.nick || this.isSelfNick(msg.nick)) return null;
    return this.ctcpAnswererFor(ctcp.type, msg);
  }

  // Who answers a CTCP request of `type` from this peer (#932), or null for a
  // type Lurker has no answer for. One side answers, as in ZNC
  // (IRCSock.cpp:550):
  // - nobody, once the peer is over its limit;
  // - Lurker, once the user changed that type's reply or turned replies off;
  // - the IRC clients attached through the bouncer, while one counts as the
  //   user on this network;
  // - Lurker, otherwise.
  // Each call takes one of the peer's allowance.
  private ctcpAnswererFor(type: string, peer: Record<string, unknown>): CtcpAnswerer | null {
    if (!isAnswerableCtcp(type)) return null;
    if (!this.ctcpLimiter.allowIncoming(this.ctcpPeerKey(peer))) return 'nobody';
    const userId = this.network.user_id;
    if (ctcpAnsweredBySettings(type, changedSettings(userId, CTCP_ANSWER_SETTINGS))) {
      return 'lurker';
    }
    return attachedIrcClients(userId, this.network.id) > 0 ? 'clients' : 'lurker';
  }

  // The raw listener's decision for a CTCP request inside a batch, which
  // irc-framework runs only when the batch ends (batchedCtcpAnswerers).
  private takeBatchedCtcpAnswerer(event: Record<string, unknown>): CtcpAnswerer | null {
    const ref = (event.tags as Record<string, string> | undefined)?.batch;
    const queue = ref ? this.batchedCtcpAnswerers.get(ref) : undefined;
    if (!ref || !queue) return null;
    const answerer = queue.shift() ?? null;
    if (queue.length === 0) this.batchedCtcpAnswerers.delete(ref);
    return answerer;
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
    if (!dccEnabledForUser(this.network.user_id) || this.dccBlockedByProxy()) return;
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
    if (parsed.kind === 'chat') {
      this.handleInboundDccChat(nick, parsed, event);
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
    // ⚠⚠ Gated HERE as well as at the offer, because a pending row outlives the
    // setting that let it in: an offer recorded while the network was direct is
    // still sitting in the Transfers view after the user configures a proxy and
    // reconnects, and accepting it dials the peer with a bare net.connect —
    // leaking exactly the address the proxy exists to hide. The offer-side gate
    // stops new ones; this stops the backlog.
    if (this.dccBlockedByProxy()) {
      updateDccTransferState(
        row.id,
        'failed',
        'this network goes through a proxy — a direct file transfer would reveal this server’s address',
      );
      this.publishDcc(row.id);
      return;
    }
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

  // --- DCC CHAT (#270) -------------------------------------------------------
  //
  // A DCC chat is a direct TCP conversation with one peer, surfaced as a `=nick`
  // buffer. Nothing about it touches the IRC connection except the CTCP offer
  // that sets it up, so a live chat survives a reconnect the way irssi's does —
  // but it cannot outlive the process, while the buffer and its history do.
  //
  // ⚠⚠ `=nick` is a buffer name, never an IRC target. ircManager's send paths are
  // the guard that keeps it off the wire; see the note there.

  // Bind a listening port for a chat with `nick`, handing it back only if the
  // chat is still wanted once the port is bound — else null, port released.
  //
  // ⚠⚠ The gap between "may we offer?" and the port actually being bound is
  // real, and everything that ends an offer used to miss it: the listener only
  // joins dccChatListeners once bound, so a `/dcc close chat` landing in the gap
  // found nothing ("no live DCC chat") while the offer went out anyway, and a
  // dispose() there sent the offer on a connection being torn down and leaked
  // the port for its full timeout. So the request is registered BEFORE binding,
  // cancel and teardown remove it, and the resolution re-checks it — along with
  // the link, which a CTCP offer or reverse reply needs and which can drop in
  // the gap too.
  private openDccChatListener(nick: string): Promise<DccListenHandle | null> {
    const key = nick.toLowerCase();
    const request = {};
    this.dccListenerRequests.set(key, request);
    const settle = (): boolean => {
      const current = this.dccListenerRequests.get(key) === request;
      if (current) this.dccListenerRequests.delete(key);
      return current;
    };
    return openDccListener().then(
      (handle) => {
        const current = settle();
        if (current && !this.disposed && this.state === 'connected') return handle;
        handle.close();
        // Cancelled or torn down: nothing to say — the canceller said it. A
        // link that dropped by itself mid-bind would otherwise vanish silently.
        if (current && !this.disposed) {
          this.dccChatNotice(
            nick,
            `Couldn't send the DCC chat offer — ${this.network.name} disconnected.`,
          );
        }
        return null;
      },
      (err) => {
        if (!settle() || this.disposed) return null; // cancelled: stay quiet
        throw err;
      },
    );
  }

  // A token correlating a passive offer with its reverse reply. irssi and
  // repartee both mint `rand() % 64` (dcc-chat.c:527, handlers_dcc.rs:204), and
  // staying in that range keeps us inside what every implementation round-trips.
  private mintDccToken(): number {
    // ⚠ Only 6 bits, so two outstanding passive offers collide about 1 time in
    // 64. Skip a token already in flight: reusing one would have the displaced
    // offer's timer fire against the NEW entry (timing out the wrong chat, and
    // naming the wrong peer), and the real reply arrive with nothing to match.
    for (let i = 0; i < 64; i++) {
      const token = Math.floor(Math.random() * 64);
      if (!this.pendingPassiveChats.has(token)) return token;
    }
    return -1; // every token in flight — caller reports it
  }

  private dccChatTarget(nick: string): string {
    return `${DCC_CHAT_PREFIX}${nick}`;
  }

  // Chat lifecycle status (offered / connected / closed / failed). PERSISTED via
  // publish rather than surfaceCtcp's ephemeral path, and deliberately: the
  // `=nick` buffer only exists because something was written to it, so an
  // ephemeral line would leave a failed or still-pending chat with no buffer at
  // all and the user with no idea what happened.
  private dccChatNotice(nick: string, text: string): void {
    this.publish({ type: 'notice', target: this.dccChatTarget(nick), nick: 'DCC', text });
  }

  // A chat line, persisted + fanned out so the buffer has real history like a DM.
  // `kind: 'dcc-chat'` marks the row's transport; the column is free-form.
  private publishDccChatLine(nick: string, text: string, self: boolean, action = false): void {
    this.publish({
      type: action ? 'action' : 'message',
      target: this.dccChatTarget(nick),
      nick: self ? this.currentNick || 'me' : nick,
      text,
      kind: 'dcc-chat',
      self,
    });
  }

  /** Whether a live DCC chat with `nick` exists. */
  hasDccChat(nick: string): boolean {
    return this.dccChats.has(nick.toLowerCase());
  }

  /** Display nicks of every peer with a live session right now. */
  liveDccChatPeers(): string[] {
    return Array.from(this.dccChats.values(), (e) => e.nick);
  }

  // Tell the client whether the `=nick` buffer has a live session behind it, so
  // it can say so the way a DM says its peer is offline. Ephemeral: the current
  // state also rides every snapshot (ircManager.snapshotForUser), which is what
  // a reloaded tab reads — a live event alone would leave it guessing.
  private publishDccChatState(nick: string, live: boolean): void {
    this.publishEphemeral({
      type: 'dcc-chat-state',
      target: this.serverTarget(),
      from: nick,
      live,
    });
  }

  // Both tiers of the DCC gate plus the proxy rule, checked at every chat entry
  // point. The gate is per-entry-point by doctrine (routes/dcc.ts), and the proxy
  // rule matters because DCC bypasses the tunnel in BOTH directions — a chat dial
  // or listen leaks the real address exactly as a file transfer would.
  // Sending a DCC offer or reverse reply rides the IRC link. During reconnect
  // backoff irc-framework silently DROPS the write, so without this the user
  // was told "offered … waiting for them to connect", a listening port from the
  // configured range was held for the full 120s, and the eventual timeout
  // blamed the peer. Accepting an ACTIVE offer needs no link — it only dials —
  // so this guards the sends alone.
  private dccCanSendOffer(nick: string): boolean {
    if (this.state === 'connected') return true;
    this.dccChatNotice(
      nick,
      `Can't send a DCC chat offer while ${this.network.name} is not connected.`,
    );
    return false;
  }

  private dccChatAllowed(nick: string, verb: string): boolean {
    if (this.disposed) return false;
    if (!dccEnabledForUser(this.network.user_id)) return false;
    if (this.dccBlockedByProxy()) {
      this.dccChatNotice(nick, `Can't ${verb} — DCC does not go through this network's proxy.`);
      return false;
    }
    return true;
  }

  /**
   * Offer a DCC chat to `nick`.
   *
   * Active by default: we listen and advertise a port. Passive (we ask the peer
   * to listen) is opt-in via `/dcc chat -passive`, NOT an automatic fallback —
   * WeeChat leaves the untokenized tail in its port field, so it reads our
   * passive offer's port as 0 and quietly dials nowhere (irc-ctcp.c:1332-1345,
   * :1381), and HexDroid does the same. Silently degrading into that is worse
   * than refusing, so an unconfigured server says so instead.
   */
  offerDccChat(nick: string, opts: { passive?: boolean } = {}): void {
    // ⚠⚠ A peer, never a channel. The offer goes out as a CTCP to `nick`, so a
    // channel name here broadcasts it to everyone in the channel — and an
    // active offer also opens a listening port any of them can race for. All
    // four sigils, via isChannelTarget: a `#`-only test is this codebase's most
    // repeated bug. Guarded here rather than at the route alone because this is
    // where every caller converges.
    if (isChannelTarget(nick)) return;
    if (!this.dccChatAllowed(nick, 'offer a DCC chat')) return;
    const key = nick.toLowerCase();
    // ⚠ Across every owner, not just this connection: after a Disconnect and
    // reconnect the live chat belongs to the OLD connection, and checking only
    // our own map would open a second socket to the same peer.
    if (
      this.dccChats.has(key) ||
      dccChatHostFor(dccChatKey(this.network.user_id, this.network.id), nick)
    ) {
      this.dccChatNotice(nick, `Already in a DCC chat with ${nick}.`);
      return;
    }
    // `/dcc chat <nick>` doubles as "accept the offer they already made", which
    // is how irssi spells it too — making a fresh offer at someone who is
    // already waiting for us would just deadlock the two halves.
    const inbound = this.clearPendingInboundChat(key);
    if (inbound) {
      this.acceptInboundDccChat(inbound.nick, inbound.offer);
      return;
    }
    if (!this.dccCanSendOffer(nick)) return;
    if (opts.passive) {
      this.offerPassiveDccChat(nick);
      return;
    }
    if (!dccActiveListenAvailable()) {
      this.dccChatNotice(
        nick,
        "Can't offer a DCC chat: this server has no public address and listening port range " +
          'configured (LURKER_DCC_EXTERNAL_HOST, LURKER_DCC_LISTEN_PORT_MIN/_MAX). ' +
          `Accepting a chat ${nick} offers you still works. ` +
          '`/dcc chat -passive` asks them to listen instead, but only irssi, HexChat and ' +
          'repartee handle that correctly.',
      );
      return;
    }
    const externalHost = dccExternalHost();
    if (!externalHost || encodeDccAddress(externalHost) === null) {
      this.dccChatNotice(
        nick,
        `DCC chat: LURKER_DCC_EXTERNAL_HOST is not a usable address (${externalHost ?? 'unset'}).`,
      );
      return;
    }
    this.openDccChatListener(nick)
      .then((handle) => {
        if (!handle) return;
        const body = buildDccChat(externalHost, handle.port);
        if (body === null) {
          handle.close();
          this.dccChatNotice(nick, 'DCC chat: external host is misconfigured.');
          return;
        }
        this.dccChatListeners.set(handle, nick);
        this.client.ctcpRequest(nick, 'DCC', body);
        this.dccChatNotice(nick, `Offered a DCC chat to ${nick} — waiting for them to connect…`);
        handle.accepted
          .then((socket) => {
            this.dccChatListeners.delete(handle);
            this.startDccChat(nick, socket);
          })
          .catch((err) => {
            // ⚠ Gone already means someone removed it on purpose — /dcc close chat
            // cancelling the offer, or teardown. Reporting that as "failed: DCC
            // listener closed" right after "Cancelled the pending DCC chat offer"
            // told the user their own cancel had broken something.
            if (!this.dccChatListeners.delete(handle)) return;
            this.dccChatNotice(
              nick,
              `DCC chat offer to ${nick} failed: ${err instanceof Error ? err.message : err}`,
            );
          });
      })
      .catch((err) => {
        this.dccChatNotice(
          nick,
          `Couldn't open a DCC listening port: ${err instanceof Error ? err.message : err}`,
        );
      });
  }

  // Passive/reverse offer: port 0 + a token, and the peer listens. The address we
  // advertise is a placeholder the peer is meant to ignore — irssi and repartee
  // both send 1.1.1.1 (16843009) here, so we match rather than HexChat's `199`,
  // which some receivers reject as unroutable.
  private offerPassiveDccChat(nick: string): void {
    const token = this.mintDccToken();
    if (token < 0) {
      this.dccChatNotice(nick, 'Too many passive DCC chat offers are already pending.');
      return;
    }
    // Always the placeholder. The peer replies with the address to dial and
    // ignores this one — irssi hardcodes 16843009 here — so advertising the
    // real host only added a way to fail: a hostname in LURKER_DCC_EXTERNAL_HOST
    // can't be encoded, and made `-passive`, the mode meant for servers WITHOUT
    // a usable external address, refuse with "misconfigured".
    const body = buildDccChatPassive(PASSIVE_DCC_FAKE_HOST, token);
    if (body === null) {
      this.dccChatNotice(nick, 'DCC chat: external host is misconfigured.');
      return;
    }
    this.client.ctcpRequest(nick, 'DCC', body);
    this.dccChatNotice(
      nick,
      `Offered a passive DCC chat to ${nick} — waiting for them to connect back… ` +
        '(passive chat only works if their client supports it: irssi, HexChat and repartee do; ' +
        'WeeChat and HexDroid do not.)',
    );
    const timer = setTimeout(() => {
      if (this.pendingPassiveChats.delete(token)) {
        this.dccChatNotice(nick, `Passive DCC chat offer to ${nick} timed out.`);
      }
    }, PASSIVE_DCC_TIMEOUT_MS);
    timer.unref?.();
    this.pendingPassiveChats.set(token, { nick, timer });
  }

  /**
   * An inbound `DCC CHAT` offer. Three shapes reach here:
   *   - a reply to OUR passive offer (real port carrying a token we minted) → dial;
   *   - a peer's own passive offer (port 0 + their token) → we listen and reply;
   *   - a plain active offer (real port) → dial.
   *
   * Port 0 with no token never reaches this method: parseDcc refuses it, because
   * it is the one shape that turns into a dial to port 0.
   */
  private handleInboundDccChat(
    nick: string,
    offer: DccChatOffer,
    event: Record<string, unknown>,
  ): void {
    if (!this.dccChatAllowed(nick, 'accept a DCC chat')) return;
    // Our own passive offer being answered? That we DO proceed with — we
    // initiated it, and the token proves this is the reply to ours.
    if (!offer.passive && offer.token !== null) {
      const pending = this.pendingPassiveChats.get(offer.token);
      if (pending && pending.nick.toLowerCase() === nick.toLowerCase()) {
        clearTimeout(pending.timer);
        this.pendingPassiveChats.delete(offer.token);
        this.dialDccChat(nick, offer.host, offer.port);
        return;
      }
    }
    // ⚠⚠ Our OWN offer echoed back to us, which a network with echo-message will
    // do. A token we minted can only appear in a line we sent, so a PASSIVE
    // offer carrying one is ours — note the asymmetry with the branch above,
    // which matches a non-passive REPLY to our offer. Without this the echo
    // fell through as "unsolicited" and prompted the user to accept a chat
    // with themselves, which is how it turned up in QA.
    //
    // Checked on the token rather than the sender because it holds regardless
    // of nick tracking. In the QA case that found this, the generic self-echo
    // guard in handleInboundCtcpRequest missed because currentNick had been
    // lost in a netsplit collision — that root cause is fixed (#972), but the
    // token is proof of authorship that no nick bookkeeping can get wrong, so
    // it stays the decisive check for our own passive offer.
    if (offer.passive && offer.token !== null && this.pendingPassiveChats.has(offer.token)) {
      return;
    }
    // Belt and braces for the active shape, which carries no token of ours.
    //
    // ⚠⚠ isSelfNick — currentNick ONLY, never the configured nick as well.
    // currentNick follows the server, including through a netsplit collision
    // that SAVEs us to our UID (#972), so it names who we are right now. The
    // configured nick names who we ASKED to be, and when that was taken and we
    // registered as `alice_`, the configured `alice` belongs to someone else —
    // treating it as us would silently drop that person's genuine chat offer
    // as if it were our own echo. The token check above covers our own passive
    // offer however we are named.
    if (this.isSelfNick(nick)) return;
    if (this.dccChats.has(nick.toLowerCase())) {
      this.dccChatNotice(nick, `${nick} offered a DCC chat, but one is already open.`);
      return;
    }
    // Anything else is an unsolicited offer: record it and ask. `/dcc chat
    // <nick>` accepts, exactly as it does in irssi.
    const key = nick.toLowerCase();
    const prior = this.pendingInboundChats.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      if (this.clearPendingInboundChat(key)) {
        // Ephemeral, and to the server buffer: the prompt never created a
        // `=nick` buffer, so its expiry must not create one either.
        this.surfaceCtcp(this.serverTarget(), `The DCC chat offer from ${nick} expired.`);
      }
    }, INBOUND_DCC_CHAT_OFFER_TTL_MS);
    timer.unref?.();
    this.pendingInboundChats.set(key, { nick, offer, timer });
    // ⚠ routeCtcpStatus, NOT dccChatNotice: the prompt is a CTCP surface like
    // any other, so it honours ctcp.msgbuffer — and, more to the point, a
    // persisted notice would MINT a `=stranger` buffer into the sidebar on
    // nothing but an unsolicited PRIVMSG. The `=nick` buffer appears when the
    // user accepts, which is also when irssi opens its window.
    this.routeCtcpStatus(
      event,
      `${nick} wants to start a DCC chat — /dcc chat ${nick} to accept` +
        (offer.passive ? ' (they are firewalled, so this server would listen)' : ''),
    );
    // …and an actionable toast, the same shape a channel invite uses: ephemeral,
    // routed through the server pseudo-buffer, read by the client from `from`
    // rather than `target`. An offer is a decision someone has to make, so the
    // client makes this one sticky — which is only safe because the offer's own
    // lifecycle is broadcast too (see clearPendingInboundChat).
    this.publishEphemeral({
      type: 'dcc-chat-offer',
      target: this.serverTarget(),
      from: nick,
      passive: offer.passive,
    });
  }

  // Drop a pending inbound offer and tell the client, whatever the reason —
  // accepted, declined, expired or torn down. ⚠ Without this the sticky toast
  // outlives the offer, and its Accept button silently stops meaning "accept"
  // and starts meaning "make a fresh offer at them", which is a different act.
  private clearPendingInboundChat(key: string): { nick: string; offer: DccChatOffer } | null {
    const pending = this.pendingInboundChats.get(key);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.pendingInboundChats.delete(key);
    this.publishEphemeral({
      type: 'dcc-chat-offer-closed',
      target: this.serverTarget(),
      from: pending.nick,
    });
    return { nick: pending.nick, offer: pending.offer };
  }

  // Accept an offer already recorded by handleInboundDccChat. Active: dial them.
  // Passive: they are firewalled, so we listen and reverse-reply with our port
  // and their token.
  private acceptInboundDccChat(nick: string, offer: DccChatOffer): void {
    if (offer.passive) {
      if (!this.dccCanSendOffer(nick)) return;
      // The peer is firewalled and wants US to listen.
      if (!dccActiveListenAvailable() || offer.token === null) {
        this.dccChatNotice(
          nick,
          `${nick} offered a passive DCC chat, but this server has no listening port range ` +
            'configured so it cannot accept one.',
        );
        return;
      }
      const externalHost = dccExternalHost();
      if (!externalHost) return;
      const token = offer.token;
      // ⚠ No expectPeerHost pin: a passive offer's advertised address is a
      // placeholder (1.1.1.1 / 0.0.0.199) and the peer dials from its real,
      // often NAT'd, source — pinning would reject exactly the peers this path
      // exists for. This is JawshTheDark's fix from #528 (73c76fc4).
      this.openDccChatListener(nick)
        .then((handle) => {
          if (!handle) return;
          const body = buildDccChatReverse(externalHost, handle.port, token);
          if (body === null) {
            handle.close();
            // The active path reports this same condition; staying silent here
            // meant a port was bound, released, and nothing was ever said.
            this.dccChatNotice(nick, 'DCC chat: external host is misconfigured.');
            return;
          }
          this.dccChatListeners.set(handle, nick);
          this.client.ctcpRequest(nick, 'DCC', body);
          this.dccChatNotice(nick, `${nick} wants to DCC chat — waiting for them to connect…`);
          handle.accepted
            .then((socket) => {
              this.dccChatListeners.delete(handle);
              this.startDccChat(nick, socket);
            })
            .catch((err) => {
              // ⚠ Gone already means someone removed it on purpose — /dcc close chat
              // cancelling the offer, or teardown. Reporting that as "failed: DCC
              // listener closed" right after "Cancelled the pending DCC chat offer"
              // told the user their own cancel had broken something.
              if (!this.dccChatListeners.delete(handle)) return;
              this.dccChatNotice(
                nick,
                `DCC chat with ${nick} failed: ${err instanceof Error ? err.message : err}`,
              );
            });
        })
        .catch((err) => {
          this.dccChatNotice(
            nick,
            `Couldn't open a DCC listening port for ${nick}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        });
      return;
    }
    this.dialDccChat(nick, offer.host, offer.port);
  }

  private dialDccChat(nick: string, host: string, port: number): void {
    if (port === 0) return; // parseDcc refuses this; belt and braces
    if (!dccAllowPrivateHosts() && isBlockedDccHost(host)) {
      this.dccChatNotice(
        nick,
        `Refusing a DCC chat with ${nick} — ${host} is a private or reserved address.`,
      );
      return;
    }
    this.dccChatNotice(nick, `Connecting to ${nick} at ${host}:${port} for DCC chat…`);
    const sock = net.connect({ host, port });
    // Bound the connect so an unreachable peer fails promptly and legibly
    // instead of hanging until the OS SYN timeout (~1–2 minutes).
    sock.setTimeout(DCC_CHAT_CONNECT_TIMEOUT_MS);
    const onDialTimeout = (): void => {
      sock.destroy(new Error('connection timed out'));
    };
    sock.once('timeout', onDialTimeout);
    sock.once('connect', () => {
      sock.setTimeout(0);
      // ⚠ These belong to the DIAL. Past connect the socket is DccChat's and it
      // does its own error handling, so leaving ours attached means a peer
      // dropping mid-session prints the real error AND a "couldn't connect,
      // check your port forwarding" paragraph that is nonsense by then.
      sock.off('timeout', onDialTimeout);
      sock.off('error', onDialError);
      this.startDccChat(nick, sock);
    });
    const onDialError = (err: Error): void => {
      // DCC is peer-to-peer and Lurker runs on the SERVER, so the peer's
      // advertised address:port has to be reachable FROM the server. A refusal
      // here is usually a topology problem, not a Lurker one — say so, because
      // the alternative is a user retrying forever.
      this.dccChatNotice(
        nick,
        `Couldn't connect to ${nick} at ${host}:${port} — ${err.message}. ` +
          'DCC connects from the Lurker server, so that address and port must be reachable ' +
          'from it; a peer behind home NAT needs the port forwarded, or must offer a passive ' +
          'chat instead.',
      );
    };
    sock.once('error', onDialError);
  }

  private startDccChat(nick: string, socket: net.Socket): void {
    const key = nick.toLowerCase();
    // ⚠ Glare: we can offer a chat AND accept theirs, so both halves complete
    // and a second socket arrives for a peer we're already chatting with. Keep
    // the established session and drop the newcomer — overwriting the map would
    // orphan the live socket (still publishing into the buffer, never closed)
    // and its eventual onClose would then delete the REPLACEMENT's entry,
    // leaving a live chat that every send reports as dead.
    if (this.dccChats.has(key)) {
      socket.destroy();
      return;
    }
    const chat = new DccChat({
      socket,
      onLine: (line) => {
        const parsed = parseDccChatLine(line);
        this.publishDccChatLine(nick, parsed.text, false, parsed.action);
      },
      onClose: () => {
        if (this.forgetDccChat(key, chat)) {
          this.dccChatNotice(nick, `DCC chat with ${nick} closed.`);
        }
      },
      onError: (err) => {
        if (this.forgetDccChat(key, chat)) {
          this.dccChatNotice(nick, `DCC chat with ${nick} ended: ${err.message}`);
        }
      },
    });
    this.dccChats.set(key, { nick, chat });
    this.dccChatDeadWarned.delete(key);
    // Reachable even after ircManager drops this connection from its map on a
    // user-initiated disconnect — the socket outlives the IRC link, as irssi's
    // does (dcc.c:300-312).
    registerDccChatHost(dccChatKey(this.network.user_id, this.network.id), this);
    chat.start();
    this.dccChatNotice(nick, `DCC chat with ${nick} connected.`);
    this.publishDccChatState(nick, true);
  }

  // Drop `key` only if it still maps to `chat` — an identity check, not a bare
  // delete, so a late callback from a superseded session can't evict the live
  // one (see the glare note in startDccChat).
  private forgetDccChat(key: string, chat: DccChat): boolean {
    const entry = this.dccChats.get(key);
    if (entry?.chat !== chat) return false;
    this.dccChats.delete(key);
    this.releaseDccChatHost();
    this.publishDccChatState(entry.nick, false);
    return true;
  }

  // Stop holding this connection open for DCC once its last chat is gone.
  private releaseDccChatHost(): void {
    if (this.dccChats.size > 0) return;
    unregisterDccChatHost(dccChatKey(this.network.user_id, this.network.id), this);
  }

  /**
   * Send a line in a live DCC chat and echo it into the `=nick` buffer. Returns
   * false when there is no session, which is how the caller distinguishes "typed
   * into a dead chat" from a successful send.
   *
   * An action goes out as bare `\x01ACTION text\x01` — the only form WeeChat,
   * HexChat, HexDroid and repartee parse. irssi's own default is to prefix
   * `CTCP_MESSAGE `, which nothing else understands, but it switches to this
   * form the moment it sees a bare \x01 from us (dcc-chat.c:685-687).
   */
  dccChatSend(nick: string, text: string, opts: { action?: boolean } = {}): boolean {
    // A bare `=` target yields no peer. It must still be refused — it's a
    // pseudo-target, never a wire target — just not announced as a dead chat.
    if (!nick) return false;
    const key = nick.toLowerCase();
    const entry = this.dccChats.get(key);
    if (!entry) {
      // ⚠ A chat dies with the process but its buffer and history persist, so
      // this is the ordinary state of every `=nick` buffer after a restart.
      // Saying nothing leaves the user typing into a buffer that silently eats
      // their lines; the composer's own not-sent toast doesn't explain why.
      if (!this.dccChatDeadWarned.has(key)) {
        this.dccChatDeadWarned.add(key);
        this.dccChatNotice(
          nick,
          `No live DCC chat with ${nick} — a chat ends when this server restarts, and cannot ` +
            `be resumed. \`/dcc chat ${nick}\` starts a new one.`,
        );
      }
      return false;
    }
    const wire = opts.action ? `\u0001ACTION ${text}\u0001` : text;
    if (!entry.chat.send(wire)) return false;
    this.publishDccChatLine(nick, text, true, !!opts.action);
    return true;
  }

  /** Close a live DCC chat (`/dcc close chat <nick>`, irssi's syntax). */
  closeDccChat(nick: string): boolean {
    const key = nick.toLowerCase();
    const entry = this.dccChats.get(key);
    // Also cancels a still-unaccepted inbound offer, which is the other thing
    // "close this chat" can reasonably mean.
    const pending = this.clearPendingInboundChat(key);
    if (pending) {
      this.surfaceCtcp(this.serverTarget(), `Declined the DCC chat offer from ${pending.nick}.`);
      if (!entry) return true;
    }
    // An offer WE made is cancellable too. Without this a mistyped
    // `/dcc chat bbo` holds one of the configured listening ports for the whole
    // 120s timeout, and the range IS the documented concurrency cap.
    // A bind still in flight counts: without this, cancelling in that window
    // answered "no live DCC chat" and the offer went out anyway.
    let cancelledOutgoing = this.dccListenerRequests.delete(key);
    for (const [token, pending] of this.pendingPassiveChats) {
      if (pending.nick.toLowerCase() !== key) continue;
      clearTimeout(pending.timer);
      this.pendingPassiveChats.delete(token);
      cancelledOutgoing = true;
    }
    for (const [handle, forNick] of this.dccChatListeners) {
      if (forNick.toLowerCase() !== key) continue;
      this.dccChatListeners.delete(handle);
      handle.close();
      cancelledOutgoing = true;
    }
    if (cancelledOutgoing) {
      this.dccChatNotice(nick, `Cancelled the pending DCC chat offer to ${nick}.`);
      if (!entry) return true;
    }
    if (!entry) return false;
    this.dccChats.delete(key);
    this.releaseDccChatHost();
    entry.chat.close();
    this.dccChatNotice(entry.nick, `DCC chat with ${entry.nick} closed.`);
    this.publishDccChatState(entry.nick, false);
    return true;
  }

  // A deliberate disconnect (stopNetwork, account suspend, shutdown — never the
  // auto-reconnect ladder, which reuses this object and keeps its place in the
  // map) ends the HANDSHAKES in flight on this connection, but not established
  // chats.
  //
  // ⚠⚠ Why the line falls there. An established chat is a socket that needs no
  // IRC, so it survives, as irssi's does. A pending offer is different: it is
  // only reachable through this connection, and stopNetwork is about to drop
  // it from the map, so after the user reconnects the NEW connection knows
  // nothing about it. Left alone, the offer toast stayed up and its Accept went
  // to the new connection, which found no offer and sent the peer a FRESH one
  // — a different act than the button names. Our own passive offers go too:
  // their reply can only arrive over IRC, and it would land on the new
  // connection, which never minted the token. Ending them here retires the
  // toast immediately and says why; the peer can offer again.
  private endDccChatHandshakes(): void {
    const dropped = this.pendingDccChatOffers();
    for (const key of this.pendingInboundChats.keys()) this.clearPendingInboundChat(key);
    for (const pending of this.pendingPassiveChats.values()) clearTimeout(pending.timer);
    this.pendingPassiveChats.clear();
    this.dccListenerRequests.clear(); // an offer still binding is a handshake too
    for (const nick of dropped) {
      this.surfaceCtcp(
        this.serverTarget(),
        `Dropped the DCC chat offer from ${nick} — ${this.network.name} was disconnected.`,
      );
    }
  }

  /** End every session this connection owns. ircManager's dispose paths call
   *  this through the session registry, because after a user Disconnect the
   *  connection holding a chat is no longer in the map they walk. */
  closeAllDccChats(reason: string): void {
    this.teardownDccChats(reason);
  }

  /** Peers with an offer to us still awaiting an answer. Rides the snapshot so
   *  a client can retire an offer toast whose offer has gone. */
  pendingDccChatOffers(): string[] {
    return Array.from(this.pendingInboundChats.values(), (p) => p.nick);
  }

  // Tear down every chat session, listener and pending passive offer. Called
  // from dispose() — and ⚠ called BEFORE `disposed` is set, because publish()
  // and publishEphemeral() both return silently once it is, which would swallow
  // the very notice that tells the user their chats went away.
  private teardownDccChats(reason: string): void {
    for (const [key, entry] of this.dccChats) {
      this.dccChats.delete(key);
      entry.chat.close();
      this.dccChatNotice(entry.nick, `DCC chat ended — ${reason}.`);
      this.publishDccChatState(entry.nick, false);
    }
    // Deleting the current key mid-iteration is well-defined for a Map, and
    // clearPendingInboundChat is what tells the client to retire its toast —
    // so this must go through it rather than a bare clear().
    for (const key of this.pendingInboundChats.keys()) this.clearPendingInboundChat(key);
    unregisterDccChatHost(dccChatKey(this.network.user_id, this.network.id), this);
    this.dccListenerRequests.clear(); // binds in flight resolve, see this, and release
    for (const handle of this.dccChatListeners.keys()) handle.close();
    this.dccChatListeners.clear();
    for (const pending of this.pendingPassiveChats.values()) clearTimeout(pending.timer);
    this.pendingPassiveChats.clear();
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
      // Without server-time the message would be stored when the batch ends,
      // but each fragment is relayed with the time it arrived. The first
      // fragment's time lets a MARKREAD naming any of them reach the stored row.
      if (event.time == null && this.lineArrivedAt) {
        event = { ...event, time: this.lineArrivedAt.getTime() };
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
  raw(line: string, asker: Asker = 'user'): void {
    // Strip CR/LF/NUL before the line hits the socket. irc-framework's
    // writeLine appends its own \r\n and writes verbatim, so any embedded
    // newline in a caller-built line (a kick reason, topic, ban host, etc.)
    // would split into a second injected IRC command. Sanitizing here covers
    // every raw call site — slash commands and the member-menu op actions
    // alike — rather than scrubbing each interpolated string at its source.
    // Matching control chars is the whole point, so the lint rule is moot here.
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/[\u000d\u000a\u0000]/g, '');
    if (this.takeRawMonitor(clean)) return;
    // Read it before it goes out, so a 401 bouncing back off it can be placed
    // in the channel it was aimed at (#434). Cheap and total: this is the one
    // path every slash command and member-menu action takes.
    this.noteOutgoingCommand(clean);
    // A raw JOIN/PART changes membership just as join()/part() do, and nothing
    // else would record it.
    this.noteRawMembership(clean);
    // A query waits its turn, and its reply goes to `asker` (replyRouter.ts).
    this.replies.send(asker, clean);
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
  // differs from the last (active flips, or a new message while away), and
  // always publishes the away-state event so clients refresh their dividers.
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
      const changed = next.active
        ? !!next.message && (!prev.active || prev.message !== next.message)
        : prev.active;
      // Not during a restore's replay, when this socket is marked connected
      // early: the 'restored' phase sends the final state once.
      if (changed && !this.restoring) this.sendAwayState();
    }
    this.publishAwayState();
  }

  // The account's away state, to the network: `AWAY :<message>`, or a bare
  // `AWAY`. It goes through the router as Lurker's, so its 305/306 reach no
  // bouncer client (each gets its own from the bouncer) and write no row.
  private sendAwayState(): void {
    const { active, message } = this.awayState;
    // A newline would split the line in two, and nothing on this path strips it.
    // eslint-disable-next-line no-control-regex
    const text = (message ?? '').replace(/[\r\n\u0000]/g, ' ').trim();
    // Away, but nothing left to say. A bare AWAY would clear the network's away
    // while the account is still away, so send nothing.
    if (active && !text) return;
    this.replies.send('lurker', active ? `AWAY :${text}` : 'AWAY');
  }

  disconnect(reason?: string, opts: { announceCancelledRetry?: boolean } = {}): void {
    this.endDccChatHandshakes();
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
    const text = `Not reconnecting automatically: ${reason}.`;
    this.publish({ type: 'error', target: this.serverTarget(), text });
    this.logNet(`Auto-reconnect blocked: ${reason}`, 'warn');
    this.setState('disconnected', { error: text });
  }

  private scheduleReconnectIfWarranted(): void {
    if (this.disposed || this.intentionalDisconnect) return;
    if (this.reconnectTimer != null) return; // a retry is already pending
    if (this.terminalDisconnect) {
      // Won't self-heal — surface why and stop. A manual reconnect (which
      // rebuilds the connection from scratch) clears this and tries again.
      const text = `Not reconnecting automatically: ${this.terminalDisconnect}. Fix the issue and reconnect manually.`;
      this.publish({ type: 'error', target: this.serverTarget(), text });
      this.logNet(`Auto-reconnect stopped: ${this.terminalDisconnect}`, 'error');
      // 'socket close' already said disconnected; this says why it stays that way.
      this.setState('disconnected', { error: text });
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
    // ⚠⚠ BEFORE `disposed` is set. publish() and publishEphemeral() both return
    // silently once it is, so a "your chat ended" notice written after the flag
    // is swallowed and the user's `=nick` buffer just goes quiet. DCC chats are
    // the only teardown that has something to say to a buffer, so this is the
    // one place the ordering matters.
    this.teardownDccChats(reason);
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
          if (!this.takeRawMonitor(line)) this.replies.send('user', line);
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
      // Channel-mode vocabulary for the channel modal and rank gating (#727).
      // Null until the registration burst ends (see clientModeSpec); then also
      // sent as a `mode-spec` frame, since 005 follows the 001 that pushes this.
      modeSpec: this.clientModeSpec(),
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
        topicSetBy: ch.topicSetBy ?? null,
        topicSetAt: ch.topicSetAt ?? null,
        modes: [...(ch.modes || [])].join(''),
        modeParams: Object.fromEntries(ch.modeParams ?? []),
        createdAt: ch.createdAt ?? null,
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

function sameModeParams(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [letter, value] of a) if (b.get(letter) !== value) return false;
  return true;
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
  // ⚠ A proxy failure must not be reported as an ircd failure (#303). Without
  // this the user reads "Connection failed (irc.libera.chat:6697): connection
  // refused" when what refused was Tor on their own machine, and they go and
  // debug the wrong host. ProxyDialError already names the proxy and what it
  // said, so it is passed through whole rather than wrapped in an address that
  // was never dialled.
  if (code.startsWith('PROXY_')) return `Connection failed: ${message}.`;
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
  // RPL_MON* and ERR_MONLISTFULL — MONITOR presence, surfaced by the presence
  // rail, not the buffer. A 734 can name a bouncer client's nick, and that
  // client gets it; the 'raw' handler gives Lurker's own nicks a notice.
  '730',
  '731',
  '732',
  '733',
  '734',
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
