// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice/video calls via a self-hosted LiveKit SFU. Lurker never carries media —
// it is only the *token authority*: it already knows who you are and which
// networks you own, so it is the right place to mint a room-scoped LiveKit
// access token. The desktop client (Scully) holds only the short-lived token,
// never the LiveKit API secret — the same trust split as session tokens.
//
// Gating mirrors DCC (see dccConfig.ts): OFF by default, opt-in for the operator.
// Voice is "enabled" only when BOTH the master switch is on AND the three
// LiveKit connection vars are present. Anything missing → dark, and /api/config
// advertises voiceEnabled: false so the client hides the call UI entirely.
//
// The room-naming rules are pure (no env, no I/O) and unit-tested — they are the
// load-bearing correctness surface. A channel is symmetric (everyone in #dev
// derives the same room), but a DM is not: if A opens a call to B, A's target is
// "B" and B's target is "A". Naming a DM room by (self, target) verbatim would
// put the two ends in two different rooms. So DM rooms are keyed by the
// *canonical* (sorted) nick pair instead.

import crypto from 'crypto';
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import type { WebhookEvent } from 'livekit-server-sdk';
import type { MinJoinMode } from '../db/voicePolicy.js';

// Conventional truthy env values — trimmed + case-insensitive. Matches dccConfig.
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Parse a raw LURKER_VOICE_ENABLED value to a boolean. Pure (no env access) so
 * it can be unit-tested without touching process.env. */
export function parseVoiceEnabled(raw: string | undefined): boolean {
  if (raw == null) return false;
  return TRUTHY.has(raw.trim().toLowerCase());
}

/** The operator master switch. */
export function voiceMasterEnabled(): boolean {
  return parseVoiceEnabled(process.env.LURKER_VOICE_ENABLED);
}

export interface LiveKitConfig {
  /** The wss:// URL the *client* connects to (public origin of the SFU). */
  wsUrl: string;
  apiKey: string;
  apiSecret: string;
}

/** Read the three LiveKit connection vars, or null if any is missing/blank. */
export function liveKitConfig(): LiveKitConfig | null {
  const wsUrl = (process.env.LIVEKIT_WS_URL ?? '').trim();
  const apiKey = (process.env.LIVEKIT_API_KEY ?? '').trim();
  const apiSecret = (process.env.LIVEKIT_API_SECRET ?? '').trim();
  if (!wsUrl || !apiKey || !apiSecret) return null;
  return { wsUrl, apiKey, apiSecret };
}

/** Voice is live only when the operator opted in AND the SFU is configured. */
export function voiceEnabled(): boolean {
  return voiceMasterEnabled() && liveKitConfig() !== null;
}

// IRC channel sigils. A target that starts with one of these is a channel; any
// other target is a nick (a DM peer).
const CHANNEL_SIGILS = new Set(['#', '&', '!', '+']);

export function isChannelTarget(target: string): boolean {
  return target.length > 0 && CHANNEL_SIGILS.has(target[0]!);
}

/** ASCII-fold a host or channel to the key used for room names + policy rows.
 *  Exported so routes fold identically to roomFor(). */
export function foldKey(s: string): string {
  return foldAscii(s);
}

// ASCII-only lowercasing, to match the client's casefold (docs §9.2 — RFC 1459
// casemapping is deliberately absent; we do not fold [] {} etc). We only touch
// A–Z so identity never splits with the server.
function foldAscii(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  }
  return out;
}

/**
 * Derive the LiveKit room name for a call. Pure and deterministic.
 *
 * Keyed on the IRC network's HOST — NOT a local network row id. A networkId is
 * per-account, so two users of the same instance (jawsh + jawsh-qa) on the same
 * channel would otherwise derive different rooms and never connect. Hosts are
 * shared across users, and across *instances* pointed at a common SFU — so a
 * host key is also what makes opt-in cross-instance bridging Just Work.
 *
 *  - Channel `#dev` on irc.libera.chat → `net-irc.libera.chat-c-#dev`
 *  - DM `Alice`↔`bob`                  → `net-irc.libera.chat-d-alice-bob` (sorted, either end)
 *
 * `self` is the caller's own nick on the network; it is only consulted for DMs,
 * where it is paired with `target` and sorted so both ends agree on one room.
 */
export function roomFor(networkKey: string, target: string, self: string): string {
  const net = foldAscii(networkKey);
  if (isChannelTarget(target)) {
    return `net-${net}-c-${foldAscii(target)}`;
  }
  const a = foldAscii(self);
  const b = foldAscii(target);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `net-${net}-d-${lo}-${hi}`;
}

/** Inverse of roomFor for CHANNEL rooms: recover (host, channel) from a room
 *  name, both already ASCII-folded. Returns null for DM rooms (no channel) or
 *  anything unparseable. This lets a webhook resolve presence to a channel even
 *  when the in-memory roomChannel map was never seeded for the room — e.g. after
 *  a Lurker restart mid-call, or a call started on another instance sharing the
 *  SFU. The `-c-` before a channel-prefixed segment is the anchor; the host may
 *  itself contain dashes. */
export function parseRoom(room: string): { host: string; channel: string } | null {
  const m = /^net-(.+)-c-([#&].*)$/.exec(room);
  if (!m) return null;
  return { host: foldAscii(m[1]), channel: foldAscii(m[2]) };
}

export interface MintedToken {
  /** The signed JWT the client passes to LiveKit. */
  token: string;
  /** The room it is scoped to. */
  room: string;
  /** The wss:// URL to connect to. */
  url: string;
}

/**
 * Mint a room-scoped LiveKit access token. Grants join + publish + subscribe on
 * exactly one room and nothing else — a token for `#dev` cannot touch `#ops`.
 * Identity is the caller's IRC nick so remote participants render sensible names.
 * Throws if voice is not configured (callers should have gated on voiceEnabled).
 */
export async function mintVoiceToken(args: {
  identity: string;
  room: string;
  /** false → a listen-only token (guests below the talk threshold). Default true. */
  canPublish?: boolean;
  ttlSeconds?: number;
}): Promise<MintedToken> {
  const cfg = liveKitConfig();
  if (!cfg) throw new Error('voice not configured');

  const at = new AccessToken(cfg.apiKey, cfg.apiSecret, {
    identity: args.identity,
    ttl: args.ttlSeconds ?? 2 * 60 * 60, // 2h; a call outlives a token refresh
  });
  at.addGrant({
    roomJoin: true,
    room: args.room,
    canPublish: args.canPublish !== false,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  return { token, room: args.room, url: cfg.wsUrl };
}

// ─── Channel-mode authority ────────────────────────────────────────────────
// IRC prefix modes, ranked. Owner (q), admin (a) and op (o) all count as the
// top "op" tier; halfop (h) above voice (v). Read from ChannelMember.modes.

const MODE_RANK: Record<MinJoinMode, number> = {
  none: 0,
  voice: 1,
  halfop: 2,
  op: 3,
};
const LETTER_RANK: Record<string, number> = { v: 1, h: 2, o: 3, a: 3, q: 3 };
const MODERATE_LETTERS = new Set(['q', 'a', 'o', 'h']); // may mute/remove in a call
const OP_LETTERS = new Set(['q', 'a', 'o']); // may set policy / mint guest links

/** Does a member holding these prefix modes meet a channel's min join mode? */
export function meetsJoinMode(modes: readonly string[], min: MinJoinMode): boolean {
  const need = MODE_RANK[min] ?? 0;
  if (need === 0) return true;
  let have = 0;
  for (const m of modes) have = Math.max(have, LETTER_RANK[m] ?? 0);
  return have >= need;
}

/** Ops/halfops — allowed to mute or remove others from a call. */
export function canModerateCall(modes: readonly string[]): boolean {
  return modes.some((m) => MODERATE_LETTERS.has(m));
}

/** Ops (q/a/o) — allowed to set the join policy and mint guest links. */
export function canAdminCall(modes: readonly string[]): boolean {
  return modes.some((m) => OP_LETTERS.has(m));
}

/** A safe, namespaced LiveKit identity for a guest so they can never collide
 *  with or impersonate a real IRC nick (all real identities are bare nicks). */
export function guestIdentity(name: string): string {
  const clean =
    foldAscii(name)
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 24) || 'guest';
  return `guest-${clean}-${crypto.randomBytes(4).toString('hex')}`;
}

// ─── Server-side room control (moderation) ─────────────────────────────────
// A fresh RoomServiceClient per call — construction is cheap and this way a
// config change (secret rotation) is always picked up. API host is the wss URL
// mapped to http(s). All these require roomAdmin, which the SDK signs from the
// same api key/secret — clients never receive an admin token.

function roomService(): RoomServiceClient | null {
  const cfg = liveKitConfig();
  if (!cfg) return null;
  return new RoomServiceClient(cfg.wsUrl.replace(/^ws/, 'http'), cfg.apiKey, cfg.apiSecret);
}

/** Force-remove a participant (by identity) from a room. */
export async function removeFromCall(room: string, identity: string): Promise<void> {
  const svc = roomService();
  if (!svc) throw new Error('voice not configured');
  await svc.removeParticipant(room, identity);
}

/** Server-mute all of a participant's published tracks (they cannot self-unmute
 *  a server mute). No-op if they are not currently in the room. */
export async function muteParticipant(room: string, identity: string): Promise<void> {
  const svc = roomService();
  if (!svc) throw new Error('voice not configured');
  const parts = await svc.listParticipants(room);
  const p = parts.find((x) => x.identity === identity);
  if (!p) return;
  for (const t of p.tracks ?? []) {
    await svc.mutePublishedTrack(room, identity, t.sid, true);
  }
}

/** Snapshot every active CHANNEL call the SFU currently knows about, so a
 *  freshly-connected client can hydrate presence badges for calls that started
 *  before it connected — the webhook stream only carries live deltas. LiveKit is
 *  the source of truth, so this is correct across a Lurker restart (unlike the
 *  in-memory registry). Returns [] when voice is unconfigured. */
export async function listActiveCalls(): Promise<
  Array<{ host: string; channel: string; count: number }>
> {
  const svc = roomService();
  if (!svc) return [];
  const rooms = await svc.listRooms();
  const out: Array<{ host: string; channel: string; count: number }> = [];
  for (const r of rooms) {
    const parsed = parseRoom(r.name);
    if (!parsed) continue; // DM rooms + anything unparseable carry no channel badge
    out.push({
      host: parsed.host,
      channel: parsed.channel,
      count: r.numParticipants ?? 0,
    });
  }
  return out;
}

// ─── Call presence registry (fed by LiveKit webhooks) ──────────────────────
// In-memory: which identities are in each room, plus a room → (host, channel)
// map recorded at token mint so a webhook can resolve a room back to its
// channel without parsing the room string. Lost on restart (repopulates as
// tokens are minted / a boot reconcile via listRooms can seed it).

const roomParticipants = new Map<string, Set<string>>();
const roomChannel = new Map<string, { host: string; channel: string }>();

/** Record the (host, channel) a room maps to — call this whenever a token is
 *  minted for the room so the webhook can broadcast presence to that channel. */
export function rememberRoom(room: string, host: string, channel: string): void {
  roomChannel.set(room, { host: foldAscii(host), channel: foldAscii(channel) });
}

export function participantsIn(room: string): number {
  return roomParticipants.get(room)?.size ?? 0;
}

export interface CallPresenceChange {
  room: string;
  host: string;
  channel: string;
  active: boolean;
  count: number;
}

/** Verify + parse a LiveKit webhook body. Null if the signature is invalid or
 *  voice is unconfigured. */
export async function receiveWebhook(
  body: string,
  authHeader: string | undefined,
): Promise<WebhookEvent | null> {
  const cfg = liveKitConfig();
  if (!cfg) return null;
  try {
    return await new WebhookReceiver(cfg.apiKey, cfg.apiSecret).receive(body, authHeader);
  } catch {
    return null;
  }
}

/** Apply a parsed webhook event to the registry. Returns the presence change to
 *  broadcast, or null when the event is irrelevant or the room is unmapped. */
export function applyWebhookEvent(ev: WebhookEvent): CallPresenceChange | null {
  const room = ev.room?.name;
  if (!room) return null;
  const ident = ev.participant?.identity;
  let set = roomParticipants.get(room);
  switch (ev.event) {
    case 'participant_joined':
      if (!ident) return null;
      if (!set) roomParticipants.set(room, (set = new Set()));
      set.add(ident);
      break;
    case 'participant_left':
      if (!ident || !set) return null;
      set.delete(ident);
      if (set.size === 0) roomParticipants.delete(room);
      break;
    case 'room_finished':
      roomParticipants.delete(room);
      break;
    default:
      return null;
  }
  // Prefer the map seeded at token-mint (authoritative host/channel casing), but
  // fall back to parsing the room name so presence survives a restart that
  // cleared the map while a call kept running (the room name encodes both).
  const mapping = roomChannel.get(room) ?? parseRoom(room);
  if (!mapping) return null; // DM room / unparseable → nothing to broadcast
  const count = roomParticipants.get(room)?.size ?? 0;
  return {
    room,
    host: mapping.host,
    channel: mapping.channel,
    active: count > 0,
    count,
  };
}
