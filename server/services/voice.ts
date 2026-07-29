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

import { AccessToken } from 'livekit-server-sdk';

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
 *  - Channel `#dev` on network 7      → `net-7-c-#dev`
 *  - DM between `Alice` and `bob`     → `net-7-d-alice-bob` (sorted, either end)
 *
 * `self` is the caller's own nick on the network; it is only consulted for DMs,
 * where it is paired with `target` and sorted so both ends agree on one room.
 */
export function roomFor(networkId: number, target: string, self: string): string {
  if (isChannelTarget(target)) {
    return `net-${networkId}-c-${foldAscii(target)}`;
  }
  const a = foldAscii(self);
  const b = foldAscii(target);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return `net-${networkId}-d-${lo}-${hi}`;
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
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  const token = await at.toJwt();
  return { token, room: args.room, url: cfg.wsUrl };
}
