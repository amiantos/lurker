// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Derive the keyring "channel" context for a conversation.
//
// Real IRC channels (prefixes # & ! +) pass through unchanged. Private
// messages become the pseudochannel `@<peer_handle>` (architecture spec
// section 6), where peer_handle is the server-stamped ident@host of the
// remote peer — never their nick. Two peers that share a nick across
// different hosts (or one peer reconnecting from a new host) therefore live
// under distinct keyring rows instead of colliding under a bare nick.

const CHANNEL_PREFIXES = ['#', '&', '!', '+'];

/** The single source of truth for "is this RPE2E context a channel (vs a PM)".
 *  Matches the RPE2E protocol's channel-prefix set (repartee parity). Used by
 *  every encrypt/decrypt/handshake call site so the seam can't disagree with
 *  itself about what a channel is. */
export function isChannelContext(target: string): boolean {
  return CHANNEL_PREFIXES.some((p) => target.startsWith(p));
}

/**
 * @param target      the IRC target (channel name or a peer nick)
 * @param peerHandle  the remote peer's server-stamped ident@host (PM only)
 */
export function contextKey(target: string, peerHandle: string): string {
  if (isChannelContext(target)) {
    return target;
  }
  return `@${peerHandle}`;
}
